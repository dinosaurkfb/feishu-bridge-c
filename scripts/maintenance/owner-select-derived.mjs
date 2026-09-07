/**
 * owner-select 派生函数与基本形状常量（下沉为无环小模块，消解 journal <-> owner-select-state 环路）
 */
import { canonKey, sha256 } from "../topic-agent-ledger.mjs";

export const CAMPAIGN_STATES = Object.freeze(["open", "sealed", "complete"]);
export const WRITER_STATES = Object.freeze(["off", "partial", "on"]);
export const CAMPAIGN_ID_SHAPE = /^osc_[0-9a-f]{32}$/u;

/** campaignId 派生公式（§二.1）："osc_" + sha256(canonKey({domain:"owner_select_campaign_v1", token})).slice(0,32) */
export const campaignIdFor = (token) =>
  "osc_" + sha256(canonKey({ domain: "owner_select_campaign_v1", token })).slice(0, 32);

/** endpointsDigest 派生公式（§二.1）：sha256(canonKey(endpoints))（endpoints 已排序去重） */
export const endpointsDigest = (endpoints) => {
  if (!Array.isArray(endpoints)) throw new Error("endpoints 必须是数组");
  return sha256(canonKey(endpoints));
};
