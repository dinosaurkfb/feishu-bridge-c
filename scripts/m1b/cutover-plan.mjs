/**
 * m1b cutover plan 交叉等式校验器（T4/M1b 第二单，§4.1 4c/4f + §5）。
 *
 * 在「authority cutover」提交点**之前**核 cutover plan 与首次 prepared journal 锚
 * 及第二次对账结果的交叉等式。五条等式 + 4f 五源 endpoint 相等：
 *
 *   ① plan.operation_token === doc.token；plan.endpoint_id === 受验账本顶层 endpoint_id
 *   ② 每个 sidecar：plan.sidecars[name].sha256 === step.intended_blob.sha256 === step.intended_after.sha256
 *   ③ plan.ledger === ledgerStep.before（首次 reconciler 的账本身份）
 *   ④ plan.digest === ledgerStep.intended_after.bijection_digest
 *      === reconcile.digest；canonKey(reconcile.snapshot_identity) === canonKey(plan.snapshot_identity)；
 *      reconcile.ledger === plan.ledger（同快照同 revision 重验四件相等）
 *   ⑤ ledgerStep.intended_after.plan_sha256 === sha256(planBytes)
 *
 *   4f 五源 endpoint 相等：受验账本顶层 endpoint_id（①）、蓝图 fingerprint 输入
 *   endpoint_id、ledger step（id/target）、三条 sidecar step 的 id/target（target 按
 *   ledger/<ep>/<name>.json 重算）。
 *
 * 纯校验：只读入参，不做 IO。plan 自身形状经 planProblem（读侧不信任 staged 写面）；
 * journal / staged blob 的自身形状归 readJournal / verifyStagedPlan，这里只核**交叉**等式。
 */
import { createHash } from "node:crypto";
import { canonKey } from "../topic-agent-ledger.mjs";
import { planProblem } from "./staged-plan.mjs";

const SIDE_CAR_PAIRS = [["expiry", "expiry"], ["pending_claims", "pending-claims"], ["policy", "policy"]];

export function verifyCutoverPlan({ planBytes, doc, ledgerStep, sidecarSteps, ledgerEndpointId, fingerprintEndpointId, reconcile }) {
  if (!(planBytes instanceof Uint8Array) || planBytes.length === 0) return { ok: false, reason: "plan_bytes_missing" };
  const planSha = createHash("sha256").update(planBytes).digest("hex");
  let plan;
  try { plan = JSON.parse(Buffer.from(planBytes).toString("utf-8")); }
  catch (err) { return { ok: false, reason: "plan_shape", why: "plan.json 不是 JSON：" + String(err?.code ?? err?.message ?? err) }; }
  const shape = planProblem(plan);
  if (shape !== null) return { ok: false, reason: "plan_shape", why: shape };
  if (doc?.operation_kind !== "ledger_cutover") return { ok: false, reason: "not_a_cutover" };
  // ①
  if (plan.operation_token !== doc.token) return { ok: false, reason: "token_mismatch" };
  if (plan.endpoint_id !== ledgerEndpointId) return { ok: false, reason: "endpoint_mismatch" };
  // ②
  const steps = Array.isArray(sidecarSteps) ? sidecarSteps : [];
  for (const [key, fileBase] of SIDE_CAR_PAIRS) {
    const st = steps.find((s) => s?.id === "sidecar:" + fileBase + ":" + plan.endpoint_id);
    if (!st) return { ok: false, reason: "sidecar_sha_mismatch", why: "缺 " + fileBase + " 的 sidecar step" };
    if (plan.sidecars[key].sha256 !== st.intended_blob?.sha256 || plan.sidecars[key].sha256 !== st.intended_after?.sha256) {
      return { ok: false, reason: "sidecar_sha_mismatch", why: fileBase };
    }
  }
  // ③
  if (plan.ledger.revision !== ledgerStep?.before?.revision || plan.ledger.sha256 !== ledgerStep?.before?.ledger_sha256) {
    return { ok: false, reason: "ledger_identity_mismatch", why: "plan.ledger 与 prepared before 不一致" };
  }
  // ④
  if (plan.digest !== ledgerStep?.intended_after?.bijection_digest) return { ok: false, reason: "digest_mismatch", why: "plan.digest 与 bijection_digest 不一致" };
  if (reconcile?.ok !== true) return { ok: false, reason: "reconcile_not_ok" };
  if (reconcile.digest !== plan.digest) return { ok: false, reason: "digest_mismatch", why: "重验 digest 与 plan 不一致" };
  // 快照身份的语义核是 path+sha256（内容与位置）；source 是 planProblem 要求的标注域，不参与身份等价。
  const identityCore = (arr) => Array.isArray(arr) ? arr.map((x) => ({ path: x?.path ?? null, sha256: x?.sha256 ?? null })) : arr ?? null;
  if (canonKey(identityCore(reconcile.snapshot_identity ?? null)) !== canonKey(identityCore(plan.snapshot_identity))) return { ok: false, reason: "snapshot_identity_mismatch" };
  if (reconcile.ledger?.revision !== plan.ledger.revision || reconcile.ledger?.sha256 !== plan.ledger.sha256) {
    return { ok: false, reason: "ledger_identity_mismatch", why: "重验账本 CAS（revision/sha 变了）" };
  }
  // ⑤
  if (ledgerStep?.intended_after?.plan_sha256 !== planSha) return { ok: false, reason: "plan_anchor_mismatch" };
  // 4f
  if (fingerprintEndpointId !== plan.endpoint_id) return { ok: false, reason: "endpoint_cross_mismatch", why: "fingerprint 输入 endpoint" };
  const ledgerEp = /^ledger:(endpoint_[0-9a-f]{24}):cutover$/.exec(String(ledgerStep?.id ?? ""))?.[1] ?? null;
  if (ledgerEp !== plan.endpoint_id || ledgerStep?.target !== plan.endpoint_id) return { ok: false, reason: "endpoint_cross_mismatch", why: "ledger step" };
  for (const [, fileBase] of SIDE_CAR_PAIRS) {
    const st = steps.find((s) => s?.id === "sidecar:" + fileBase + ":" + plan.endpoint_id);
    if (st?.target !== "ledger/" + plan.endpoint_id + "/" + fileBase + ".json") {
      return { ok: false, reason: "endpoint_cross_mismatch", why: fileBase };
    }
  }
  return { ok: true, planSha };
}
