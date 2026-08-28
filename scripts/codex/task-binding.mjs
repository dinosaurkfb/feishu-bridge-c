/**
 * 把一条 Codex task 的状态，整理成**四层状态渲染器认得的那个形状**。
 *
 * 为什么要这一层：`composeLayeredStatus` 是两条链共用的渲染器，它要的 `st`
 * 是 Claude 侧 `currentBinding()` 的返回形状。Codex 侧的模型是 task，不是项目 ——
 * 差别只在"怎么找到这条绑定"，找到之后要报的事实是同一套。
 *
 * **所以这里只做翻译，不新增判断。**每个字段都来自 task 自己的状态；
 * 算不出来的一律给 null，让渲染层去说"不可用"——
 * 在这里替它填一个默认值，就是让状态页声称一件没查过的事。
 */

import { activeGeneration, pendingGeneration,
  TOPIC_GENERATION_AUTO_ROTATE_MESSAGES,
} from "../topic-generation.mjs";
import { interactionPolicySummary } from "../interaction-policy.mjs";
import { listPending } from "../outbox.mjs";
import { bridgeHome, interactionPolicyForTask, taskPaths, topicStateForTask } from "./state.mjs";

/**
 * @returns 与 currentBinding() 同形状的对象；失败时 { ok: false, reason }。
 */
export function taskBindingFacts({ task, home = bridgeHome() } = {}) {
  if (!task) return { ok: false, reason: "task_missing" };

  const topic = topicStateForTask(task);
  if (!topic.ok) return { ok: false, reason: topic.reason ?? "topic_state_unreadable" };
  const activeTopic = activeGeneration(topic.state);
  const pendingTopic = pendingGeneration(topic.state);

  const interaction = interactionPolicyForTask(task);
  if (!interaction.ok) return { ok: false, reason: interaction.reason ?? "policy_unreadable" };

  let pending = 0;
  try { pending = listPending({ outboxDir: taskPaths(task, home).outbox }).length; }
  catch { return { ok: false, reason: "outbox_unreadable" }; }

  const status = task.status ?? "active";
  return {
    ok: true,
    // 字段名是核对过真实 makeTaskEntry 产物的，不是猜的：task 上就叫 root。
    root: task.root ?? null,
    source: "codex-task",
    // **读不到就给 null，不许默认成开启。**Claude 侧为这条付过代价：
    // 配置关掉了状态页照样显示"每轮自动发布"。
    autoPublish: typeof task.auto_publish_on_completion === "boolean"
      ? task.auto_publish_on_completion : null,
    // Codex 一条 task 就是一条工作线，没有"项目级/会话级"之分。
    level: "task",
    claudeSessionId: null,
    status,
    suspended: status !== "active",
    inboundBound: task.inbound_state === "bound",
    expiresAt: task.expires_at ?? null,
    displayName: task.task_display_name ?? task.logical_task_key ?? null,
    pending,
    activeGeneration: activeTopic?.generation ?? null,
    activeGenerationMessages: activeTopic?.activity?.message_count ?? 0,
    activeGenerationThreshold: activeTopic?.activity?.auto_rotate_threshold ?? TOPIC_GENERATION_AUTO_ROTATE_MESSAGES,
    pendingGeneration: pendingTopic?.generation ?? null,
    pendingGenerationExpiresAt: pendingTopic?.claim_expires_at ?? null,
    pendingGenerationCreatedAt: pendingTopic?.created_at ?? null,
    readOnlyGenerations: topic.state.generations
      .filter((generation) => generation.status === "read-only").length,
    policy: interactionPolicySummary(interaction.state),
  };
}
