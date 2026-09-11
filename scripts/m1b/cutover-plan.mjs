/**
 * m1b cutover plan 交叉等式校验器（T4/M1b 第二单，§4.1 4c/4f + §5）。
 *
 * 在「authority cutover」提交点**之前**核 cutover plan 与首次 prepared journal 锚
 * 及第二次对账结果的交叉等式。五条等式 + 4f 五源 endpoint 相等：
 *
 *   ① plan.operation_token === doc.token；plan.endpoint_id === 受验账本顶层 endpoint_id
 *   ② 每个 sidecar：plan.sidecars[name].sha256 === step.intended_blob.sha256 === step.intended_after.sha256；
 *      调用方提供 onDiskSidecars（锁内 fd 受验读的现场身份，与 converge 同一读法）时，加核**现场**等式：
 *      每键 present ∧ 无 problem ∧ 现场 sha256 === plan.sidecars[key].sha256（PK2-F5：4c-3 判据收编，一个出处）
 *   ③ plan.ledger === ledgerStep.before（首次 reconciler 的账本身份）
 *   ④ plan.digest === ledgerStep.intended_after.bijection_digest
 *      === reconcile.digest；canonKey(reconcile.snapshot_identity) === canonKey(plan.snapshot_identity)；
 *      reconcile.ledger === plan.ledger（同快照同 revision 重验四件相等；**锁内 rawSha256 随 reconcile.ledger
 *      进这条 CAS** —— 旁路纯字节改也当场拒，PK2-F5：4c-1 pre-SHA CAS 判据收编）；
 *      reconcile.cutover_blockers 非空 → cutover_blocked（PK2-F5：4c-2 硬门收编，与编排层二次重验同名同门）
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
import { canonKey, fingerprintOf } from "../topic-agent-ledger.mjs";
import { planProblem } from "./staged-plan.mjs";

const SIDE_CAR_PAIRS = [["expiry", "expiry"], ["pending_claims", "pending-claims"], ["policy", "policy"]];

export function verifyCutoverPlan({ planBytes, doc, ledgerStep, sidecarSteps, ledgerEndpointId, reconcile, onDiskSidecars }) {
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
  // ②-b（PK2-F5 收编 4c-3）：sidecar **现场**等式 —— 只判传入的锁内 fd 受验读结果（与 converge 同一读法），
  // 本函数仍不做 IO；未提供（旧调用方/单元）不核。现场缺席/形状坏/SHA ≠ plan 锚（与 ② 的 step 锚已互等）都拒。
  if (onDiskSidecars !== undefined) {
    for (const [key, fileBase] of SIDE_CAR_PAIRS) {
      const cur = onDiskSidecars?.[key];
      if (!cur || cur.present !== true || cur.problem !== undefined || cur.sha256 !== plan.sidecars[key].sha256) {
        return { ok: false, reason: "sidecar_sha_mismatch", why: fileBase + " 现场与 plan 锚不一致（" + (!cur || !cur.present ? "absent" : (cur.problem ?? "sha 不等")) + "）" };
      }
    }
  }
  // ③
  if (plan.ledger.revision !== ledgerStep?.before?.revision || plan.ledger.sha256 !== ledgerStep?.before?.ledger_sha256) {
    return { ok: false, reason: "ledger_identity_mismatch", why: "plan.ledger 与 prepared before 不一致" };
  }
  // ④
  if (plan.digest !== ledgerStep?.intended_after?.bijection_digest) return { ok: false, reason: "digest_mismatch", why: "plan.digest 与 bijection_digest 不一致" };
  // blockers 硬门（PK2-F5 收编 4c-2，先于 ok 判 —— 与提交点旧序一致）：待修项非空直接点名，
  // 与编排层二次重验（convergeSidecars）同名同门。字段缺席（旧单元最小 reconcile）视为空。
  if ((reconcile?.cutover_blockers?.length ?? 0) > 0) {
    return { ok: false, reason: "cutover_blocked", why: "提交点对账发现待修项（" + reconcile.cutover_blockers.length + " 条）" };
  }
  if (reconcile?.ok !== true) return { ok: false, reason: "reconcile_not_ok" };
  if (reconcile.digest !== plan.digest) return { ok: false, reason: "digest_mismatch", why: "重验 digest 与 plan 不一致" };
  // 快照身份全量等价（P1-3）：plan 的身份现在由 identityOf 在受验读时点自带封闭域 source 标注，
  // 编排层不再二次盖章——所以这里逐键（source+path+sha256）比较，任何一项被换都是 mismatch。
  if (canonKey(reconcile.snapshot_identity ?? null) !== canonKey(plan.snapshot_identity)) return { ok: false, reason: "snapshot_identity_mismatch" };
  if (reconcile.ledger?.revision !== plan.ledger.revision || reconcile.ledger?.sha256 !== plan.ledger.sha256) {
    return { ok: false, reason: "ledger_identity_mismatch", why: "重验账本 CAS（revision/sha 变了）" };
  }
  // sidecar 四件同证（P1-3）：二次对账必须携带同源渲染字节，逐键 sha256 对 plan 锚——
  // 只回 digest 的对账结果在这里过不去（渲染依据被换时能当场暴露）。
  // R45 二轮 P1-1：字节引用改走 {sha256, bytes}（prepareLegacyCutoverEndpoint 私有面），不再收裸字节。
  for (const [key] of SIDE_CAR_PAIRS) {
    const bytes = reconcile.sidecars?.[key]?.bytes;
    if (!(bytes instanceof Uint8Array)) return { ok: false, reason: "sidecar_reconcile_mismatch", why: key + " 缺同源渲染字节" };
    if (createHash("sha256").update(bytes).digest("hex") !== plan.sidecars[key].sha256) {
      return { ok: false, reason: "sidecar_reconcile_mismatch", why: key };
    }
  }
  // ⑤
  if (ledgerStep?.intended_after?.plan_sha256 !== planSha) return { ok: false, reason: "plan_anchor_mismatch" };
  // 4f 指纹复核（P1-6）：账本 step 两锚的 fingerprint 必须都能由 plan 字段独立重算——
  // 自证（拿 fingerprintEndpointId 对拍 plan.endpoint_id）换成对七键输入的真重算。
  const fp = fingerprintOf("authority_cutover", {
    request_key: plan.operation_token,
    endpoint_id: plan.endpoint_id,
    bijection_digest: plan.digest,
    pre_cutover_ledger_sha: plan.ledger.sha256,
    expiry_sha256: plan.sidecars.expiry.sha256,
    pending_claims_sha256: plan.sidecars.pending_claims.sha256,
    policy_sha256: plan.sidecars.policy.sha256,
  });
  if (ledgerStep?.before?.fingerprint !== fp || ledgerStep?.intended_after?.fingerprint !== fp) {
    return { ok: false, reason: "endpoint_cross_mismatch", why: "fingerprint 重算与账本 step 锚不等" };
  }
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
