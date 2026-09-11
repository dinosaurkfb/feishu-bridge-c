/**
 * m1b cutover plan 交叉等式校验器（T4/M1b 第二单，§4.1 4c/4f + §5）。
 *
 * 在「authority cutover」提交点**之前**核 cutover plan 与首次 prepared journal 锚
 * 及第二次对账结果的交叉等式。五条等式 + 4f 五源 endpoint 相等：
 *
 *   ① plan.operation_token === doc.token；plan.endpoint_id === 受验账本顶层 endpoint_id
 *   ② 每个 sidecar：plan.sidecars[name].sha256 === step.intended_blob.sha256 === step.intended_after.sha256
 *   ②b 现场 sidecar（`currentSidecars`，调用方 fd 受验读出的值）：三键 SHA === plan.sidecars[*].sha256
 *   ②c reconcile.cutover_blockers 非空 → cutover_blocked
 *   ③ plan.ledger === ledgerStep.before（首次 reconciler 的账本身份）
 *   ④ plan.digest === ledgerStep.intended_after.bijection_digest
 *      === reconcile.digest；canonKey(reconcile.snapshot_identity) === canonKey(plan.snapshot_identity)；
 *      reconcile.ledger === plan.ledger（同快照同 revision 重验四件相等）；reconcile.ok 非 true → 拒
 *   ⑤ ledgerStep.intended_after.plan_sha256 === sha256(planBytes)
 *
 * **封闭理由码表（唯一的 reason 出处，PK2-F5）**：plan_bytes_missing / plan_shape / not_a_cutover / token_mismatch /
 * endpoint_mismatch / sidecar_sha_mismatch（②锚、②b 现场、②c 之后的现场读数形状）/ cutover_blocked /
 * ledger_identity_mismatch（③ 与 ④ 的账本 CAS）/ digest_mismatch / reconcile_not_ok / snapshot_identity_mismatch /
 * sidecar_reconcile_mismatch / plan_anchor_mismatch / endpoint_cross_mismatch。
 * 提交点（`authorityCutover` 的 mutate）与门内二次重验（`convergeSidecars`）都只能从这份表里拿到拒因，
 * 不许另立同义不同名的第二套。
 *
 *   4f 五源 endpoint 相等：受验账本顶层 endpoint_id（①）、蓝图 fingerprint 输入
 *   endpoint_id、ledger step（id/target）、三条 sidecar step 的 id/target（target 按
 *   ledger/<ep>/<name>.json 重算）。
 *
 * 纯校验：只读入参，不做 IO。plan 自身形状经 planProblem（读侧不信任 staged 写面）；
 * journal / staged blob 的自身形状归 readJournal / verifyStagedPlan，这里只核**交叉**等式。
 *
 * **一个出处（PK2-F5）**：cutover 提交点的全部交叉等式只在这一个函数里（包括现场 sidecar 与 blockers 硬门）。
 * 从前 `authorityCutover` 的 mutate 在调本函数之前又手写了三段同等式短路（pre-SHA / blockers / 现场 sidecar），
 * 同一事实两套判据、两套 reason，改一处漏一处（R69 一轮/二轮各中一次）。现场读盘归调用方（本函数收值不收路径）：
 * IO 在提交点一处，判据在这里一处。
 */
import { createHash } from "node:crypto";
import { canonKey, fingerprintOf } from "../topic-agent-ledger.mjs";
import { planProblem } from "./staged-plan.mjs";

/** 三条 sidecar：`key` = plan.sidecars 的键，`fileBase` = journal step 名与盘上文件名。
 *  导出给调用方拼 `currentSidecars` 与读盘文件名 —— 键↔文件名的映射也只有这一份（PK2-F5）。 */
export const SIDE_CAR_PAIRS = Object.freeze([["expiry", "expiry"], ["pending_claims", "pending-claims"], ["policy", "policy"]]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const SHA_SHAPE = /^[0-9a-f]{64}$/u;

export function verifyCutoverPlan({ planBytes, doc, ledgerStep, sidecarSteps, ledgerEndpointId, reconcile, currentSidecars }) {
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
  // 现场读数（②b）缺席 / 不是一个对象 → 当场拒（fail-closed）：这是提交点必供的一项，
  // 不给「忘了传就静默跳过」留口。
  if (!isObj(currentSidecars)) {
    return { ok: false, reason: "sidecar_sha_mismatch", why: "缺现场 sidecar 读数（currentSidecars：fd 受验读出的三条现场 SHA）" };
  }
  for (const [key, fileBase] of SIDE_CAR_PAIRS) {
    const st = steps.find((s) => s?.id === "sidecar:" + fileBase + ":" + plan.endpoint_id);
    if (!st) return { ok: false, reason: "sidecar_sha_mismatch", why: "缺 " + fileBase + " 的 sidecar step" };
    if (plan.sidecars[key].sha256 !== st.intended_blob?.sha256 || plan.sidecars[key].sha256 !== st.intended_after?.sha256) {
      return { ok: false, reason: "sidecar_sha_mismatch", why: fileBase };
    }
    // ②b：盘上那份现场的 SHA === plan 锚。②的两侧都是冻结值（staged plan 字节 / journal step），
    //   **看不见盘上第三份** —— 这一支才是「拿旧 sidecar 切权威」的封口。
    const cur = currentSidecars[key];
    if (!(isObj(cur) && cur.present === true && cur.problem === undefined
      && typeof cur.sha256 === "string" && SHA_SHAPE.test(cur.sha256))) {
      return { ok: false, reason: "sidecar_sha_mismatch",
        why: fileBase + ".json 现场读数不合法（" + (!isObj(cur) || cur.present !== true ? "缺席" : (cur.problem !== undefined ? String(cur.problem) : "无可用 SHA")) + "）" };
    }
    if (cur.sha256 !== plan.sidecars[key].sha256) {
      return { ok: false, reason: "sidecar_sha_mismatch", why: fileBase + ".json 现场 SHA 与 plan 锚不一致" };
    }
  }
  // ②c 对账待修项硬门（PK2-F5：从提交点搬进来 —— 从前 mutate 先判一次、这里看不见，同一事实两套 reason）。
  //   注意顺序：blockers 先于 digest / ok / 身份。blocker 支的 ok 可能是 true（如 retired binding 被排除出投影，
  //   digest 两边都是空集），只有这一支拦得住「带着待修项切权威」。
  //   why 带 code 列表（PK2-F9）：blocker code 是**封闭枚举**（不带 binding/路径明文），操作员靠它知道该清哪一类；
  //   铸 plan 前那道硬门与 doctor ⑭ 也这么报 —— 信息量只放这一处，不在调用方再拼第二份。
  if ((reconcile?.cutover_blockers?.length ?? 0) > 0) {
    const codes = reconcile.cutover_blockers.map((b) => b?.code ?? "unknown").join("、");
    return { ok: false, reason: "cutover_blocked", why: "提交前对账发现待修项（" + reconcile.cutover_blockers.length + " 条：" + codes + "）" };
  }
  // ③
  if (plan.ledger.revision !== ledgerStep?.before?.revision || plan.ledger.sha256 !== ledgerStep?.before?.ledger_sha256) {
    return { ok: false, reason: "ledger_identity_mismatch", why: "plan.ledger 与 prepared before 不一致" };
  }
  // ④
  if (plan.digest !== ledgerStep?.intended_after?.bijection_digest) return { ok: false, reason: "digest_mismatch", why: "plan.digest 与 bijection_digest 不一致" };
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
