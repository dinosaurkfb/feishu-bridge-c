/**
 * 发布契约矩阵：**场景 × 入口，由登记状态驱动**。
 *
 * 登记表是 references/publish-entry-status.json。规则：
 *   · migrated —— 跑**全部**适用场景；runner 缺能力又没申报 notApplicable
 *     就直接红（"翻状态自动启用完整契约"就靠这条）
 *   · legacy   —— 只跑该实现今天真实满足的申报子集；子集里的名字必须真实存在
 *   · 每份实现归属一个套件（登记表 suite 字段），谁的套件谁执行
 *
 * 场景体只用 runner 的抽象接口，**不摸入口细节** ——
 * 摸了就又是"每个入口一份写法"，矩阵就白建了。
 *
 * runner 接口：
 *   caps: Set<string>            具备的能力（publish / failStates / dryRun / …）
 *   notApplicable: {场景名: 理由}  migrated 时对不适用场景的显式申报
 *   fixture() => h：
 *     h.seed(text)               放一条待发记录
 *     h.seedPaused(text)         放一条已暂停（platform_rejected）的记录
 *     h.attempt(behavior, opts)  按行为触发一次发布尝试：
 *                                ok / fail-opaque / fail-platform / fail-silent-echo
 *                                返回 { publishCalls }（本次真实发布调用数）
 *     h.read(text)               读该记录当前的磁盘状态（解析后的 JSON）
 */

import { MAX_AUTO_PUBLISH_ATTEMPTS, retryProtection } from "../outbox.mjs";

export const PUBLISH_SCENARIOS = [
  {
    name: "基本发布：待发的发出去并落标",
    needs: ["publish"],
    run(h, assert) {
      h.seed("正文甲");
      const { publishCalls } = h.attempt("ok");
      assert.ok(publishCalls >= 1, "要真的调发布");
      assert.match(h.read("正文甲").published_at ?? "", /^\d{4}/u, "发出去就要落标");
    },
  },
  {
    name: "已暂停的不进批次，也不从视野消失",
    needs: ["publish"],
    run(h, assert) {
      h.seed("好的那条");
      h.seedPaused("停着的那条");
      h.attempt("ok");
      assert.match(h.read("好的那条").published_at ?? "", /^\d{4}/u, "正常那条照发");
      const held = h.read("停着的那条");
      assert.equal(held.published_at, null, "**已暂停的不许被发出去**");
      assert.equal(retryProtection(held).status, "paused", "也不许被动到");
    },
  },
  {
    name: "认不出来的失败：逐次累计，第五次暂停，之后不再自动重试",
    needs: ["publish", "failStates"],
    run(h, assert) {
      h.seed("屡败的那条");
      for (let i = 1; i <= MAX_AUTO_PUBLISH_ATTEMPTS; i += 1) {
        h.attempt("fail-opaque");
        const rp = retryProtection(h.read("屡败的那条"));
        if (i < MAX_AUTO_PUBLISH_ATTEMPTS) {
          assert.deepEqual(rp, { status: "retrying", attempts: i }, "第 " + i + " 次该只累计");
        } else {
          assert.equal(rp.status, "paused", "第 " + i + " 次该暂停");
          assert.equal(rp.kind, "retry_exhausted", "认不出来 = 预算耗尽，不是平台拒绝");
        }
      }
      // 落盘的 reason 是给人看的：平台说的话要在，命令回显（含正文）不许漏进去。
      // 读法走投影 —— 摸裸字段刚被 token 守卫按住过一次（就是写这段的时候）。
      const pausedRp = retryProtection(h.read("屡败的那条"));
      assert.match(pausedRp.reason, /boom-opaque/u, "stderr 那句要在 reason 里");
      assert.equal(pausedRp.reason.includes("屡败的那条"), false,
        "**卡片正文不许漏进落盘的 reason**");
      const { publishCalls } = h.attempt("fail-opaque");
      assert.equal(publishCalls, 0, "**暂停之后一次都不许再发** —— 实际 " + publishCalls);
    },
  },
  {
    name: "平台拒绝：第一次就暂停，成因是 platform_rejected",
    needs: ["publish", "failStates"],
    run(h, assert) {
      h.seed("被平台拒的那条");
      h.attempt("fail-platform");
      const rp = retryProtection(h.read("被平台拒的那条"));
      assert.equal(rp.status, "paused");
      assert.equal(rp.kind, "platform_rejected");
      assert.equal(rp.attempts, 1, "认出来的永久错误第一次就停");
    },
  },
  {
    name: "伪造内容：正文带错误码但无可信响应，只算暂时失败",
    needs: ["publish", "failStates"],
    run(h, assert) {
      h.seed("正文里写着 ErrCode: 11310 的一条");
      h.attempt("fail-silent-echo");
      assert.deepEqual(retryProtection(h.read("正文里写着 ErrCode: 11310 的一条")),
        { status: "retrying", attempts: 1 },
        "**正文里的错误码不许把自己判成平台拒绝**");
    },
  },
];

/**
 * 由登记状态生成本套件要执行的矩阵行。
 * migrated 缺能力未申报 → 生成一条必红的行，翻状态就藏不住没接线。
 */
export function matrixRowsFor({ registry, suite, runners, legacySubsets }) {
  const rows = [];
  for (const [entry, meta] of Object.entries(registry.implementations)) {
    if (meta.suite !== suite) continue;
    const runner = runners[entry];
    const status = meta.status;
    if (!runner) {
      rows.push({ entry, status, title: "登记了却没有 runner",
        run: (assert) => assert.fail(entry + " 在登记表里归 " + suite + " 套件，却没有矩阵 runner") });
      continue;
    }
    const pick = status === "migrated"
      ? PUBLISH_SCENARIOS
      : PUBLISH_SCENARIOS.filter((sc) => (legacySubsets[entry] ?? []).includes(sc.name));
    if (status === "legacy") {
      for (const name of legacySubsets[entry] ?? []) {
        if (!PUBLISH_SCENARIOS.some((sc) => sc.name === name)) {
          rows.push({ entry, status, title: "legacy 子集申报了不存在的场景",
            run: (assert) => assert.fail(entry + " 申报了不存在的场景：" + name) });
        }
      }
    }
    for (const sc of pick) {
      const capable = sc.needs.every((c) => runner.caps.has(c));
      if (!capable) {
        if (status === "migrated" && !(sc.name in (runner.notApplicable ?? {}))) {
          rows.push({ entry, status, title: sc.name,
            run: (assert) => assert.fail(entry + " 是 migrated，场景「" + sc.name +
              "」既没实现也没申报不适用 —— 翻状态不许跳过完整契约") });
        }
        continue;
      }
      rows.push({ entry, status, title: sc.name,
        run: (assert) => sc.run(runner.fixture(), assert) });
    }
  }
  return rows;
}
