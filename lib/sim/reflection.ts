// 振り返り: 走行記録を AI に読ませ、教訓と「判断の基準」を言葉にし、回避の基準（数値）を見直す。
// 型と、サーバ・ブラウザ間でやりとりする形をここにまとめる。

import type { Episode, EpisodeMetrics } from "./episode";
import type { AvoidPolicy, PolicyKey } from "./policy";

/** 数値の 1 つの変更 */
export type PolicyChange = {
  param: PolicyKey;
  from: number;
  to: number;
  reason: string;
};

/** 1 回の振り返りの結果 */
export type Reflection = {
  at: number;
  metrics: EpisodeMetrics;
  /** 記録から読み取ったこと */
  observations: string[];
  /** 今回の教訓 */
  lessons: string[];
  /** これまでを踏まえた判断の基準（毎回、全体を書き直す） */
  criteria: string[];
  changes: PolicyChange[];
  /** 次の走行で期待すること */
  expectation: string;
  policyBefore: AvoidPolicy;
  policyAfter: AvoidPolicy;
  model: string;
  latencyMs: number;
};

/** 振り返りの API に送る、過去の振り返りの要約（プロンプトを長くしすぎないため） */
export type PastReflection = Pick<Reflection, "metrics" | "lessons" | "changes" | "expectation">;

export type ReflectRequest = {
  episode: Episode;
  criteria: string[];
  history: PastReflection[];
};

export type ReflectResponse =
  ({ ok: true } & Omit<Reflection, "at" | "metrics" | "policyBefore">) | { ok: false; error: string };
