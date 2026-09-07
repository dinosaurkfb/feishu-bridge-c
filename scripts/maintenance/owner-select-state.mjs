/**
 * R50: owner-select campaign / writer-state 文件合同与读写原语
 * （只做合同与校验器，不做 operation A/B 执行器）
 */
import path from "node:path";
import { canonKey, sha256, ledgerRootFor } from "../topic-agent-ledger.mjs";

export const CAMPAIGN_FILE = "owner-select-campaign.json";
export const WRITER_STATE_FILE = "owner-select-writer-state.json";
export const CAMPAIGN_SCHEMA = "owner-select-campaign-1";
export const WRITER_STATE_SCHEMA = "owner-select-writer-state-1";
export const CAMPAIGN_STATES = Object.freeze(["open", "sealed", "complete"]);
export const WRITER_STATES = Object.freeze(["off", "partial", "on"]);
export const MEMBER_SCHEMAS = Object.freeze(["1.0", "1.1-transition", "1.1"]);

export const campaignIdFor = (token) => { throw new Error("not implemented"); };
export const endpointsDigest = (endpoints) => { throw new Error("not implemented"); };

export const campaignPath = (env = process.env) => null;
export const writerStatePath = (env = process.env) => null;

export const campaignDocProblem = (doc) => "not implemented";
export const writerStateDocProblem = (doc) => "not implemented";

export const readCampaignState = (env = process.env) => { throw new Error("not implemented"); };
export const readWriterState = (env = process.env) => { throw new Error("not implemented"); };

export const writeCampaignState = (opts) => { throw new Error("not implemented"); };
export const writeWriterState = (opts) => { throw new Error("not implemented"); };
