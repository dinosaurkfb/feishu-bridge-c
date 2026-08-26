/**
 * 发布契约矩阵：**场景 × 入口，由登记状态驱动**。
 *
 * 登记表是 references/publish-entry-status.json。规则：
 *   · migrated —— 跑**全部**适用场景；缺能力而登记表又没申报 not_applicable
 *     就直接红（"翻状态自动启用完整契约"就靠这条）
 *   · **适用性是登记表里的受控申报（not_applicable，带非空理由），
 *     不是 runner 自报** —— 自报能把所有场景报成不适用而 0 行照样绿
 *   · legacy   —— 只跑该实现今天真实满足的申报子集；子集里的名字必须真实存在
 *   · 每份实现归属一个套件（登记表 suite 字段），谁的套件谁执行
 *
 * 场景体只用 runner 的抽象接口，**不摸入口细节** ——
 * 摸了就又是"每个入口一份写法"，矩阵就白建了。
 *
 * runner 接口：
 *   caps: Set<string>            具备的能力（publish / failStates / dryRun / …）
 *   （不适用申报**不在 runner 上** —— 在登记表的 not_applicable 里，见上）
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
  {
    name: "dry-run：预演零改盘、零出网",
    needs: ["publish", "dryRun"],
    run(h, assert) {
      h.seed("预演的那条");
      const before = h.read("预演的那条");
      const { publishCalls } = h.attempt("ok", { dryRun: true });
      assert.equal(publishCalls, 0, "预演不许真的发");
      assert.deepEqual(h.read("预演的那条"), before, "**预演一个字段都不许动**");
    },
  },
  {
    name: "显式重试：失败仍暂停，不许悄悄放回自动队列",
    needs: ["publish", "failStates", "explicitRetry"],
    run(h, assert) {
      h.seed("重试又被拒的那条");
      h.attempt("fail-platform");
      assert.equal(retryProtection(h.read("重试又被拒的那条")).status, "paused", "前提：先暂停");
      h.attempt("fail-platform", { retryRejected: true });
      const rp = retryProtection(h.read("重试又被拒的那条"));
      assert.equal(rp.status, "paused", "**再试还是被拒，就还是暂停**");
      assert.equal(rp.kind, "platform_rejected");
      const { publishCalls } = h.attempt("ok");
      assert.equal(publishCalls, 0, "不带显式重试就仍然不进批次");
    },
  },
  {
    name: "显式重试：成功后落标、保护字段清干净",
    needs: ["publish", "failStates", "explicitRetry"],
    run(h, assert) {
      h.seed("重试后发成的那条");
      h.attempt("fail-platform");
      const { publishCalls } = h.attempt("ok", { retryRejected: true });
      assert.ok(publishCalls >= 1, "显式重试要真的发");
      const rec = h.read("重试后发成的那条");
      assert.match(rec.published_at ?? "", /^\d{4}/u, "发成了要落标");
      assert.equal(retryProtection(rec).status, "clean", "**保护字段要在同一次写里清干净**");
    },
  },
  {
    name: "保护字段损坏：整批不动，一条不发",
    needs: ["publish", "auditGate"],
    run(h, assert) {
      h.seed("好的那条");
      h.seedCorruptProtection("坏形状的那条");
      const { publishCalls } = h.attempt("ok");
      assert.equal(publishCalls, 0, "**说不清就整批不动** —— 好的那条也不许发");
      assert.equal(h.read("好的那条").published_at, null);
      assert.equal(h.read("坏形状的那条").published_at, null, "坏的那条更不许动");
    },
  },
];

/**
 * 登记表 schema 校验。**每个套件都对全表跑一遍** —— 拼错 suite 的实现
 * 会被两边同时跳过（评审实测：suite 写错 → 0 行、静默），
 * 所以合法性必须全局验，不能只看自己认领的那几份。
 */
export function validatePublishRegistry(registry) {
  const problems = [];
  const impls = registry?.implementations;
  if (impls === null || typeof impls !== "object") return ["implementations 不是对象"];
  for (const [entry, meta] of Object.entries(impls)) {
    if (!["legacy", "migrated"].includes(meta?.status)) {
      problems.push(entry + "：status 不合法（" + String(meta?.status) + "）—— 拼错会被当成 legacy 静默生成 0 行");
    }
    if (!["claude", "codex"].includes(meta?.suite)) {
      problems.push(entry + "：suite 不合法（" + String(meta?.suite) + "）—— 拼错会被两个套件同时跳过");
    }
    const na = meta?.not_applicable;
    if (na !== undefined && (na === null || typeof na !== "object" || Array.isArray(na))) {
      problems.push(entry + "：not_applicable 不是对象");
    }
    for (const [name, why] of Object.entries((na && typeof na === "object" && !Array.isArray(na)) ? na : {})) {
      if (!PUBLISH_SCENARIOS.some((sc) => sc.name === name)) {
        problems.push(entry + "：not_applicable 申报了不存在的场景「" + name + "」");
      }
      // **申报必须带理由** —— "不适用"三个字本身不构成契约，理由才可评审。
      if (typeof why !== "string" || why.trim().length === 0) {
        problems.push(entry + "：not_applicable「" + name + "」没有给出非空理由");
      }
    }
  }
  return problems;
}

/**
 * 由登记状态生成本套件要执行的矩阵行。
 *
 * **适用性是登记表里的受控申报（not_applicable），不是 runner 自报** ——
 * runner 自报能把所有场景都报成不适用，0 行照样绿（评审实测）。
 * 登记表进评审、进版本，赖不掉。
 *
 * migrated 缺 runner / status 非法 / 缺能力未申报 / 一行都不执行 → 必红行。
 */
export function matrixRowsFor({ registry, suite, runners, legacySubsets }) {
  // **调用方的 suite 也是受控值。**评审探针：suite 传 "cluade" → 0 行全绿，
  // 整套矩阵静默消失。拼错是调用方代码错误 —— 当场抛，不生成"空矩阵"。
  if (!["claude", "codex"].includes(suite)) {
    throw new TypeError("未知套件：" + String(suite) + " —— 只有 claude / codex");
  }
  const rows = [];
  for (const problem of validatePublishRegistry(registry)) {
    rows.push({ entry: "登记表", status: "invalid", title: problem,
      run: (assert) => assert.fail("登记表不合法：" + problem) });
  }
  for (const [entry, meta] of Object.entries(registry.implementations)) {
    if (meta.suite !== suite) continue;
    const runner = runners[entry];
    const status = meta.status;
    if (!runner) {
      rows.push({ entry, status, title: "登记了却没有 runner",
        run: (assert) => assert.fail(entry + " 在登记表里归 " + suite + " 套件，却没有矩阵 runner") });
      continue;
    }
    if (!["legacy", "migrated"].includes(status)) continue;   // 已由校验行报红
    const na = meta.not_applicable ?? {};
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
    let executable = 0;
    for (const sc of pick) {
      if (status === "migrated" && sc.name in na) continue;    // 受控申报的不适用
      const capable = sc.needs.every((c) => runner.caps.has(c));
      if (!capable) {
        if (status === "migrated") {
          rows.push({ entry, status, title: sc.name,
            run: (assert) => assert.fail(entry + " 是 migrated，场景「" + sc.name +
              "」既没实现也没在登记表申报不适用 —— 翻状态不许跳过完整契约") });
        }
        continue;
      }
      executable += 1;
      rows.push({ entry, status, title: sc.name,
        run: (assert) => sc.run(runner.fixture(), assert) });
    }
    if (status === "migrated" && executable === 0) {
      rows.push({ entry, status, title: "migrated 却一行都不执行",
        run: (assert) => assert.fail(entry +
          " 把所有场景都申报成不适用 —— migrated 至少要执行一个场景，否则状态是空话") });
    }
  }
  // 一个合法套件一份实现都没认领 = 登记表和调用方对不上 —— 同样当场抛。
  if (!Object.values(registry.implementations ?? {}).some((m) => m?.suite === suite)) {
    throw new TypeError("套件 " + suite + " 在登记表里一份实现都没认领 —— 矩阵不许静默为空");
  }
  return rows;
}
