// 回避の基準（ふるまいを決める数値）。振り返りのたびに AI が見直し、次の走行に使う。
// サーバ（振り返りの API）とブラウザの両方から使うので、ブラウザ専用の API は使わない。

export type AvoidPolicy = {
  /** 相手との隙間がこれより狭くなったら避け始める（映像の高さを 1 とした単位） */
  clearance: number;
  /** 避け始めたら、隙間が clearance のこの倍率まで広がるまで避け続ける */
  untilFactor: number;
  /** 押し返しを、行きたい向きより何倍強く効かせるか */
  repulsionWeight: number;
  /** ゴーストの位置を、今の進み方でこれだけ先まで先読みして避ける（ミリ秒） */
  lookaheadMs: number;
  /** 避けている間の速さの倍率 */
  avoidSpeedFactor: number;
};

export type PolicyKey = keyof AvoidPolicy;

export const DEFAULT_POLICY: AvoidPolicy = {
  clearance: 0.12,
  untilFactor: 1.5,
  repulsionWeight: 2,
  lookaheadMs: 0,
  avoidSpeedFactor: 1,
};

/** 各数値の範囲と説明（AI への説明と、画面の表示に使う） */
export const POLICY_SPEC: Record<PolicyKey, { min: number; max: number; label: string; description: string }> = {
  clearance: {
    min: 0.04,
    max: 0.3,
    label: "避け始める隙間",
    description:
      "相手との縁と縁の隙間がこれより狭くなったら避け始める。映像の高さを 1 とした単位。大きいほど早めに避ける",
  },
  untilFactor: {
    min: 1,
    max: 2.5,
    label: "避け終える倍率",
    description: "隙間が「避け始める隙間 × この倍率」まで広がったら避けるのをやめる。大きいほど長く避け続ける",
  },
  repulsionWeight: {
    min: 0.5,
    max: 6,
    label: "押し返しの強さ",
    description: "相手から離れる向きを、本来進みたい向きの何倍強く効かせるか。大きいほど相手から真っすぐ離れる",
  },
  lookaheadMs: {
    min: 0,
    max: 1500,
    label: "ゴーストの先読み（ms）",
    description: "ゴーストが今の向きと速さで進み続けたときの、この時間後の位置を使って避ける。判定の遅れを補う",
  },
  avoidSpeedFactor: {
    min: 0.5,
    max: 2,
    label: "回避中の速さの倍率",
    description: "避けている間だけ、走行の速さにこの倍率を掛ける。大きいほど素早く逃げる",
  },
};

export const POLICY_KEYS = Object.keys(DEFAULT_POLICY) as PolicyKey[];

/** 範囲に収める。数でなければ fallback の値を使う */
export function clampPolicy(
  p: Partial<Record<PolicyKey, unknown>>,
  fallback: AvoidPolicy = DEFAULT_POLICY,
): AvoidPolicy {
  const out = { ...fallback };
  for (const k of POLICY_KEYS) {
    const v = p[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const { min, max } = POLICY_SPEC[k];
    out[k] = Math.min(max, Math.max(min, v));
  }
  return out;
}
