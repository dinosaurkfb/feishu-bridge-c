/**
 * 自动发布一个 Codex task 中已经取得发布资格的 outbox 事件。
 *
 * 资格是事件级的：本地 Stop 可以直接授予；飞书入站回合必须由严格 watcher 在终局确认后
 * 授予。这样升级前的历史积压、失败 run 的半成品答复都不会被下一轮顺带发出。
 */

import { publishDraft } from "../outbound.mjs";
import { publishOutboxAttempt } from "../publish-attempt.mjs";
import { codexRotationBatchHook } from "./rotation-hook.mjs";
import fs from "node:fs";
import { assertPublishIdentity, resolveLarkIdentity } from "../chain-template.mjs";
import { composeCodexOutboundCard, outboundCardBatches } from "./outbound-card.mjs";
import {
  bridgeHome, resolveTask, resolveTaskOutboundGeneration, taskPaths,
} from "./state.mjs";

// groupByTargetGeneration 已收归 publish-attempt.mjs（此前四处各抄一份）。

/**
 * 发送之前必须成立的每一件事 —— **不碰 outbox、不发任何东西**。
 *
 * 抽出来是因为兜底调度器的启用门槛要验"这条链跑不跑得通"。
 * 上一版那道门槛把整个 publishEligibleTaskEvents 换成假的，于是它验的是
 * "我的假函数能被调用"，跟真实链路无关：评审实测同一个 task 门禁报 ok，
 * 真实路径却是 template_unusable。**替换掉被测对象的检查等于没有检查。**
 *
 * 主链自己也走这个函数 —— 分成两份写的话，门槛迟早验的是另一件事。
 */
export function preflightTask({ task, home = bridgeHome() } = {}) {
  if (!task || task.auto_publish_on_completion !== true) {
    return { ok: false, status: "disabled", reason: "auto_publish_disabled" };
  }
  const resolved = resolveTask(task, { home });
  if (!resolved.ok) return { ok: false, status: "error", reason: resolved.reason };
  if (resolved.mapping.status !== "active" || !resolved.mapping.feishu_root_message_id_reference) {
    return { ok: false, status: "skipped", reason: "mapping_not_active" };
  }
  // **resolveLarkIdentity 只是拼路径，它永远返回对象。**
  // 上一版拿它当身份检查，于是 lark-cli 不存在、凭据目录读不出来、
  // profile 不在、凭据的 app id 跟配置对不上 —— 一律"通过"。
  // 评审用不存在的二进制和凭据目录实测，门槛照样报 ok:true。
  //
  // 真正的检查是 assertPublishIdentity（"我手上这份凭据确实属于我以为的那个应用"），
  // 加上 lark-cli 本身可不可执行。**发之前会做的，门槛就得做。**
  let identity;
  try {
    identity = resolveLarkIdentity(resolved.template);
  } catch (err) {
    return { ok: false, status: "error", reason: "identity_unresolved",
      error: String(err?.message ?? err).slice(0, 200) };
  }
  const bin = identity?.bin;
  if (typeof bin !== "string" || bin.length === 0) {
    return { ok: false, status: "error", reason: "lark_cli_unset" };
  }
  // **X_OK 对目录也成立** —— 目录的"可执行"是"可进入"。
  // 只查 X_OK 的话，lark_cli_bin 指到一个目录也算通过，真到发的时候才炸。
  try {
    if (!fs.statSync(bin).isFile()) {
      return { ok: false, status: "error", reason: "lark_cli_not_a_file" };
    }
    fs.accessSync(bin, fs.constants.X_OK);
  } catch {
    return { ok: false, status: "error", reason: "lark_cli_not_executable" };
  }
  const checked = assertPublishIdentity(identity);
  if (!checked?.ok) {
    return { ok: false, status: "error",
      reason: checked?.reason ?? "identity_mismatch" };
  }
  return { ok: true, resolved, identity };
}

export function publishEligibleTaskEvents({ task, home = bridgeHome(), timeoutMs = 12_000 } = {}) {
  const pre = preflightTask({ task, home });
  if (!pre.ok) return { status: pre.status, reason: pre.reason };
  const resolved = pre.resolved;
  const paths = taskPaths(task, home);

  // 锁外速查只为省一次锁竞争；真正的选择在事务锁内快照上按
  // authorized_only 策略做 —— **授权判据只有 hasPublishAuthorization 一份**
  //（此前这里是"非空字符串"，正是第 5 层要收敛的分叉；事务接入后结构性消失）。
  const identity = resolveLarkIdentity(resolved.template);
  const r = publishOutboxAttempt({
    outboxDir: paths.outbox,
    lockDir: paths.publishLock,
    policy: "authorized_only",
    batchCards: outboundCardBatches,
    resolveTarget: (generationKey) => resolveTaskOutboundGeneration(task, generationKey),
    composeCard: (batch) => composeCodexOutboundCard(batch, { taskName: task.task_display_name }),
    publishBatch: ({ target, card }) => publishDraft({
      profile: identity.profile,
      rootMessageId: target.rootMessageId,
      card,
      larkBin: identity.bin,
      larkHome: identity.configDir,
      expectedAppId: identity.expectedAppId,
      timeoutMs,
    }),
    onBatchPublished: codexRotationBatchHook({
      root: task.root, threadId: task.codex_thread_id, home,
    }),
  });
  // 旧契约映射：锁忙叫 deferred（Stop/watcher 稍后再试）。
  if (r.status === "skipped") return { status: "deferred", reason: r.reason };
  return r;
}
