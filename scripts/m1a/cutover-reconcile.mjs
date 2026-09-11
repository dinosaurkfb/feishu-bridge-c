/**
 * cutover 对账的**固定维护适配器**（R69 返修一 P1-2）。
 *
 * 对账依据（legacy 快照来源）是**权威事实**：它绝不能由调用方以函数形式递进来 —— 持 operation 租约的调用方
 * 传一个恒真 reconciler，就能把"切权威"的证据换成谎话（旧形 `capability.reconcile` 只被核 typeof function）。
 * 所以来源在此**固定**：路径一律由 env 派生（env 覆盖是测试/运维唯一的隔离点，与 doctor/prepareFor 同一来源），
 * 只经这两个薄壳暴露给维护编排与账本提交点 —— **同一份，不留第二套**。
 *
 * 面：`reconcileForCutover` 返回 `prepareLegacyCutoverEndpoint` 的**私有面**（安全结果 ∪ 三条 sidecar 的
 * `{sha256, bytes}`）——账本锁内的 `verifyCutoverPlan` 要拿同源渲染字节逐条核 plan 锚，只有 sha256 的公共面
 * 过不去（那正是"拿旧 sidecar 切权威"的可乘之隙）。
 */
import path from "node:path";

import { collectClaudeLegacySnapshot, collectCodexLegacySnapshot } from "./legacy-snapshot.mjs";
import { prepareLegacyCutoverEndpoint } from "./reconcile.mjs";
import { loadLedger, resolveEndpointDir } from "../topic-agent-ledger.mjs";
import { realUserHome } from "../maintenance-gate-core.mjs";
import { bridgeHome } from "../codex/state.mjs";

/** 维护上下文的 home（与 `maintenanceContext({ home = os.homedir() })` 同一来源）：会话内一致，取不到才用
 *  passwd 里的真实 home —— 维护 CLI 与测试的隔离点都是 env.HOME，别在这里发明第二套。 */
const homeOf = (env) => {
  const h = env.HOME;
  if (typeof h === "string" && h.length > 0) return h;
  const real = realUserHome();
  return typeof real === "string" ? real : null;
};

/** registry.json 与 chain-config.json 同属一个 bridge home（`<bridge>/registry.json`、`<bridge>/chain-config.json`）：
 *  `FEISHU_BRIDGE_REGISTRY` 指到哪儿，链模板就跟到哪儿（两者是同一份现场）；没有覆盖才回落到 home。
 *  取不到 → null（调用方折成 fail-closed）。 */
const claudeBridgeHome = (env) => {
  const reg = env.FEISHU_BRIDGE_REGISTRY;
  if (typeof reg === "string" && reg.length > 0) return path.dirname(reg);
  const home = homeOf(env);
  return home === null ? null : path.join(home, ".claude", "feishu-bridge");
};

/** 固定维护适配器的 legacy 采集（两种链的路径都由 env 派生，不接受调用方自述路径）。 */
export function collectLegacyForCutover({ chain, env = process.env } = {}) {
  if (chain === "claude") {
    const bridge = claudeBridgeHome(env);
    if (bridge === null) return { ok: false, reason: "legacy_source_unreadable", source: "args", why: "claude bridge home 说不清（env.HOME 与真实用户 home 都取不到且无 env 覆盖）" };
    return collectClaudeLegacySnapshot({
      registryFile: path.join(bridge, "registry.json"),
      templateFile: env.FEISHU_BRIDGE_CHAIN_TEMPLATE ?? path.join(bridge, "chain-config.json"),
    });
  }
  try {
    return collectCodexLegacySnapshot({ home: bridgeHome(env) });
  } catch (err) {
    return { ok: false, reason: "legacy_source_unreadable", source: "args", why: "codex bridge home 说不清：" + String(err?.message ?? err) };
  }
}

/** 固定维护适配器（私有面）：账本目录由受验目录派生推得，不接受调用方给的账本位置。 */
export function reconcileForCutover({ endpointId, chain, env = process.env } = {}) {
  return prepareLegacyCutoverEndpoint({
    endpointId, chain,
    collectLegacy: () => collectLegacyForCutover({ chain, env }),
    loadLedgerFn: () => {
      const d = resolveEndpointDir(endpointId, { env });
      return d.ok ? loadLedger(d.dir, { endpointId }) : d;
    },
  });
}
