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

/** 一台机器的控制面目录（`<home>/.claude/feishu-bridge`）——与 doctor.machineContext 的 `bridge` 同一表达式。
 *  取不到 home → null（调用方折成 fail-closed）。 */
const claudeBridgeHome = (env) => {
  const home = homeOf(env);
  return home === null ? null : path.join(home, ".claude", "feishu-bridge");
};

/** 非空 env 覆盖，否则默认 —— 与 doctor/chain-template 的 `env.X || 默认` 同语义（空串按没设）。 */
const envOr = (v, fallback) => (typeof v === "string" && v.length > 0 ? v : fallback);

/** 控制面两份来源：registry 与 chain template **各自独立解析**（与 doctor.machineContext 的 registryFile
 *  同一表达式）。**与 doctor ⑭ / chain-template.templatePath() 同一覆盖表达式**：模板 =
 *  `env.FEISHU_BRIDGE_CHAIN_TEMPLATE || bridge 下的 chain-config.json` —— doctor ⑭ 直接调本函数，一个出处
 *  （不引 chain-template.templatePath()：它在模块加载期读 os.homedir，注入 env 时错）。
 *  两份文件同属一个 bridge home，但**覆盖一个不等于覆盖另一个**：只设 `FEISHU_BRIDGE_REGISTRY` 时 template
 *  仍走 home 下的默认路径（返修一曾把 template 隐式挪到 registry 同目录 —— 探针一设就露）。 */
export const claudeSources = (env, bridge) => ({
  registryFile: envOr(env.FEISHU_BRIDGE_REGISTRY, path.join(bridge, "registry.json")),
  templateFile: envOr(env.FEISHU_BRIDGE_CHAIN_TEMPLATE, path.join(bridge, "chain-config.json")),
});

/** 固定维护适配器的 legacy 采集（两种链的路径都由 env 派生，不接受调用方自述路径）。 */
export function collectLegacyForCutover({ chain, env = process.env } = {}) {
  if (chain === "claude") {
    const bridge = claudeBridgeHome(env);
    if (bridge === null) return { ok: false, reason: "legacy_source_unreadable", source: "args", why: "claude bridge home 说不清（env.HOME 与真实用户 home 都取不到且无 env 覆盖）" };
    return collectClaudeLegacySnapshot(claudeSources(env, bridge));
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
