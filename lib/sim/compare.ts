// 走行どうしの比較: 今回の接触の多さを、前回とこれまでの最良と比べる。
// AI に任せず、アプリが決まった計算で判定する（AI は判定を受け取って言葉にする）。
//
// 接触の回数は偶然でも揺れる。回数がポアソン分布に従うとみなし、
// 1 分あたりの接触数 r（走行 m 分）のばらつきの目安を √(r / m) とする。

import type { EpisodeMetrics } from "./episode";
import { type AvoidPolicy, POLICY_KEYS } from "./policy";

/** 比べる 1 回分の走行 */
export type RunSummary = { metrics: EpisodeMetrics; policy: AvoidPolicy };

export type VerdictKind = "first" | "improved" | "worse" | "unclear";

export type Verdict = {
  /** 前回と比べてどうだったか */
  kind: VerdictKind;
  /** 説明（画面と AI へのプロンプトに使う） */
  text: string;
  /** 最良の設定より明らかに悪かったので、最良の設定に戻したか */
  reverted: boolean;
  /** これまで（今回を含む）で最も少ない 1 分あたりの接触数 */
  bestRate: number;
};

/** 前回との差がこれ（ばらつきの目安の何倍）を超えたら、良くなった・悪くなったとみなす */
const CHANGE_SIGMA = 1;
/** 最良との差がこれを超えたら、最良の設定に戻す（偶然で戻さないよう、前回比より厳しめ） */
const REVERT_SIGMA = 1.5;

const minutes = (m: EpisodeMetrics) => Math.max(m.durationS / 60, 1 / 60);

/** 2 回の走行の、1 分あたりの接触数の差のばらつきの目安 */
export function sigmaOfDiff(a: EpisodeMetrics, b: EpisodeMetrics): number {
  // 接触 0 回でもばらつきが 0 にならないよう、最低 1 回分とみなす
  return Math.sqrt(Math.max(a.contactsPerMin, 1) / minutes(a) + Math.max(b.contactsPerMin, 1) / minutes(b));
}

export function samePolicy(a: AvoidPolicy, b: AvoidPolicy): boolean {
  return POLICY_KEYS.every((k) => Math.abs(a[k] - b[k]) < 1e-9);
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 今回の走行を、前回とこれまでの最良と比べる。
 * past は新しい順（past[0] が前回）。
 */
export function compareRuns(current: RunSummary, past: RunSummary[]): { verdict: Verdict; best: RunSummary } {
  const cur = current.metrics.contactsPerMin;
  const best = [current, ...past].reduce((a, b) => (b.metrics.contactsPerMin < a.metrics.contactsPerMin ? b : a));
  const prev = past[0];
  if (!prev) {
    return {
      verdict: {
        kind: "first",
        text: `最初の走行です（${cur} 回/分）。比べる相手はまだありません。`,
        reverted: false,
        bestRate: cur,
      },
      best,
    };
  }

  const p = prev.metrics.contactsPerMin;
  const s = sigmaOfDiff(current.metrics, prev.metrics);
  const d = cur - p;
  const kind: VerdictKind = d < -CHANGE_SIGMA * s ? "improved" : d > CHANGE_SIGMA * s ? "worse" : "unclear";
  const vsPrev =
    kind === "improved"
      ? `前回（${p} 回/分）より明らかに減りました（${cur} 回/分、差 ${r1(d)}、ばらつきの目安 ±${r1(s)}）。`
      : kind === "worse"
        ? `前回（${p} 回/分）より明らかに増えました（${cur} 回/分、差 +${r1(d)}、ばらつきの目安 ±${r1(s)}）。`
        : `前回（${p} 回/分）との差 ${d >= 0 ? "+" : ""}${r1(d)} は、ばらつきの目安 ±${r1(s)} の範囲内です（${cur} 回/分）。偶然の差かもしれません。`;

  const bestRate = best.metrics.contactsPerMin;
  const sb = sigmaOfDiff(current.metrics, best.metrics);
  const reverted = best !== current && !samePolicy(best.policy, current.policy) && cur - bestRate > REVERT_SIGMA * sb;
  const vsBest =
    best === current
      ? "これまでで最も少ない走行です。"
      : reverted
        ? `これまでの最良（${bestRate} 回/分）より明らかに多いので、最良のときの設定に戻します。`
        : `これまでの最良は ${bestRate} 回/分です。`;

  return { verdict: { kind, text: `${vsPrev}${vsBest}`, reverted, bestRate }, best };
}
