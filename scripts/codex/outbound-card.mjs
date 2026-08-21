/** Codex 兼容入口；卡片合同由 Claude / Codex 共享实现。 */

import {
  composeOutboundCard, neutralizeCardMentions, outboundCardBatches, validateOutboundCard,
} from "../outbound-card.mjs";

export { neutralizeCardMentions, outboundCardBatches };
export const validateCodexOutboundCard = validateOutboundCard;
export const composeCodexOutboundCard = (records, options = {}) =>
  composeOutboundCard(records, { ...options, runtime: "codex" });
