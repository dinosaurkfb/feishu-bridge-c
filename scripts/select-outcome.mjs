/**
 * R57b 返修二 P2：选择收口结果分类（纯函数叶子模块）。
 * 从 select-admission.mjs 搬出——原 select-admission → reaffirm-intents → select-admission 是 ESM 循环；
 * 本模块无反向依赖，reaffirm-intents.mjs 与 select-admission.mjs 共同 import 它。
 * 返回 consumed / control-committed-unclean / failed 三态 + 各分量。
 */
export function classifySelectOutcome({
  ledger = null,
  intentCleanup = null,
  locks = null,
} = {}) {
  let ledgerStatus = "not_committed";
  if (typeof ledger === "string") {
    if (["clean", "unclean", "not_committed"].includes(ledger)) {
      ledgerStatus = ledger;
    }
  } else if (ledger && typeof ledger === "object") {
    const isCleanCommit = ledger.ok === true &&
      ["committed_clean", "replayed", "already"].includes(ledger.commit) &&
      (!ledger.residue || ledger.residue.length === 0) &&
      !ledger.lockUncleared &&
      ledger.lock_state !== "unclear";

    if (isCleanCommit) {
      ledgerStatus = "clean";
    } else if (
      ledger.commit === "committed_durability_uncertain" ||
      ledger.commit === "committed_with_residue" ||
      (typeof ledger.commit === "string" && ledger.commit.startsWith("committed")) ||
      ledger.lockUncleared != null ||
      ledger.lock_state === "unclear" ||
      (ledger.residue && ledger.residue.length > 0)
    ) {
      ledgerStatus = "unclean";
    } else {
      ledgerStatus = "not_committed";
    }
  }

  let intentStatus = "unclear";
  if (intentCleanup === "cleared" || intentCleanup === true) {
    intentStatus = "cleared";
  } else if (intentCleanup === "unclear" || intentCleanup === false || intentCleanup === null) {
    intentStatus = "unclear";
  }

  const outerLock = locks?.outer ?? "released";
  const intentLock = locks?.intent ?? "released";
  const locksStatus = {
    outer: ["released", "residue", "unclear"].includes(outerLock) ? outerLock : "unclear",
    intent: ["released", "residue", "unclear"].includes(intentLock) ? intentLock : "unclear",
  };

  const isAllClean =
    ledgerStatus === "clean" &&
    intentStatus === "cleared" &&
    locksStatus.outer === "released" &&
    locksStatus.intent === "released";

  if (isAllClean) {
    return {
      ok: true,
      status: "consumed",
      ledger: ledgerStatus,
      intent_cleanup: intentStatus,
      locks: locksStatus,
    };
  }

  if (ledgerStatus === "clean" || ledgerStatus === "unclean") {
    return {
      ok: false,
      status: "control-committed-unclean",
      ledger: ledgerStatus,
      intent_cleanup: intentStatus,
      locks: locksStatus,
      reason: "control_committed_unclean",
      why: "已写入但收口不干净（" +
        (ledgerStatus !== "clean" ? "账本未净: " + ledgerStatus : "") +
        (intentStatus !== "cleared" ? "；intent未清" : "") +
        (locksStatus.outer !== "released" ? "；outer锁: " + locksStatus.outer : "") +
        (locksStatus.intent !== "released" ? "；intent锁: " + locksStatus.intent : "") +
        "）",
    };
  }

  return {
    ok: false,
    status: "failed",
    ledger: ledgerStatus,
    intent_cleanup: intentStatus,
    locks: locksStatus,
    reason: (typeof ledger === "object" && ledger?.reason) ? ledger.reason : "not_committed",
    why: (typeof ledger === "object" && ledger?.why) ? ledger.why : null,
  };
}
