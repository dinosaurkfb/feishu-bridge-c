/**
 * 绑定到期预警。
 *
 * 配额闸退役之后，有效期是入站唯一的闸。一条一年后到期的绑定，到期那天不会有任何人记得
 * 它存在 —— Frank 只会发现「我发指令它不理我了」，然后得自己想到来查 mapping。
 * 那正是「需要他先开口问的环节算设计失败」。
 *
 * 所以预警走 outbox：会话结束钩子每次顺手看一眼，到窗口就记一条，
 * 和别的进展一起发到话题里。他什么都不用做。
 *
 * 提前量分两档而不是一档：一档太容易被当时正忙的人划掉，两档给一次挽回机会。
 * 文案里刻意**不写「还剩几天」** —— outbox 按内容指纹判重，写了天数就变成每天一条新的，
 * 一周能刷七次。写死到期日，同一档只会发一次。
 */

import fs from "node:fs";
import path from "node:path";

export const WARN_DAYS = [30, 7];
const DAY_MS = 24 * 60 * 60 * 1000;

export function checkBinding({ root, now = Date.now() }) {
  let mapping;
  try {
    mapping = JSON.parse(
      fs.readFileSync(path.join(root, ".runtime-data", "inbound", "active-mapping.json"), "utf-8"),
    );
  } catch {
    // 读不到不预警：没接入站的项目、还没绑定的项目都会走到这里，不是异常。
    return { state: "absent" };
  }

  const expiresAt = Date.parse(mapping.expires_at ?? "");
  if (!Number.isFinite(expiresAt)) return { state: "malformed", expiresAtRaw: mapping.expires_at ?? null };

  const day = new Date(expiresAt).toISOString().slice(0, 10);
  if (now >= expiresAt) return { state: "expired", expiresAt, day };

  const msLeft = expiresAt - now;
  // 取命中的最小窗口：跨进 7 天档时不该再报 30 天那条。
  const window = WARN_DAYS.filter((d) => msLeft <= d * DAY_MS).sort((a, b) => a - b)[0];
  if (window === undefined) return { state: "ok", expiresAt, day };

  return { state: "expiring", expiresAt, day, window };
}

/** 把体检结果翻成一条 outbox 事件；没什么要说的就返回 null。 */
export function bindingWarning(health) {
  if (health.state === "expiring") {
    return {
      kind: "pending",
      text:
        "话题绑定 " + health.day + " 到期（剩不到 " + health.window + " 天）。" +
        "到期后你在话题里发的指令会被全部拒绝，但出站还会继续发进展 —— 会变成我能说、你不能回。" +
        "续期就是改 active-mapping.json 的 expires_at。",
    };
  }
  if (health.state === "expired") {
    return {
      kind: "risk",
      text:
        "话题绑定已于 " + health.day + " 过期，入站指令现在一律被拒（回执写「绑定关系已过期」）。" +
        "出站不受影响，所以你还能收到进展，但回话回不进来。",
    };
  }
  if (health.state === "malformed") {
    return {
      kind: "risk",
      text: "话题绑定的 expires_at 读不出日期（当前值：" + JSON.stringify(health.expiresAtRaw) +
        "），入站会一律判过期拒绝。",
    };
  }
  return null;
}
