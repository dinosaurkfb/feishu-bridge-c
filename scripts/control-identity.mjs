/**
 * 控制命令事务的**身份判据**（Claude 侧，非 CLI 层）—— 生产入口（inbound）与维护入口（repair-control-claim）共用同一份。
 *
 *   expectationFromMapping   由一份 mapping 推导 claim 必须满足的身份期望（logical task / binding / 会话）。
 *   claudeControlPrecondition 策略存储层**写锁内**的前置条件：参数是锁内刚读出的记录（项目文件 mapping 或登记表条目），
 *                             用它重新推导身份再读 claim —— 锁外算好的期望在这里不作数；事务核验与策略写入之间换了绑定就拒写。
 */
import { readClaimState } from "./claim.mjs";
import { mappingFromRegistryEntry } from "./project-resolve.mjs";
import { effectiveBindingId } from "./topic-generation.mjs";

/**
 * bindingId 用存储层同一算法 effectiveBindingId(mapping, { root })：旧形状的项目文件没有 binding_id / topic_generation_state 时
 * 得到 `<basename>@project-files`，约束不丢 —— claim 里写的是别的 binding（或没写）都对不上，fail-closed。
 */
export function expectationFromMapping(mapping, { root = null } = {}) {
  return { logicalTaskKey: mapping.logical_task_key, bindingId: effectiveBindingId(mapping, { root }), claudeSessionId: mapping.claude_session_id ?? null };
}

/**
 * （claim 的 logical_task_key 由 key 推导、不可换，所以"锁内身份 vs claim"这一道核对已经蕴含"锁内身份 vs 锁外身份"。）
 */
export function claudeControlPrecondition({ claimsDir, key, root = null }) {
  return (record, meta = {}) => {
    if (!record || typeof record !== "object") return false;
    const live = meta.source === "registry" ? mappingFromRegistryEntry(record) : record;
    return readClaimState({ claimsDir, key, expect: expectationFromMapping(live, { root: meta.root ?? root }) }).status === "valid";
  };
}
