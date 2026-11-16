// ぶつからないための向きの計算。BOLT（実機）とゴースト（仮想）で同じ計算を使う。
//
// 座標は Box と同じ 0〜1 の比率（x は幅、y は高さに対する割合）。
// 距離と半径は「映像の高さを 1 とした単位」で扱うため、x の差には縦横比を掛ける。

import type { Point } from "@/lib/autopilot/geometry";

/** ぶつかる相手の種類（ログや画面の説明に使う） */
export type BodyKind = "bolt" | "ghost" | "obstacle";

/** 丸い物体。r は映像の高さを 1 とした半径 */
export type Body = { kind: BodyKind; p: Point; r: number };

/** 映像の高さを 1 とした空間でのベクトル（x も高さ基準。角度の計算にそのまま使える） */
export type Vec = { x: number; y: number };

/** 押し返しの結果 */
export type Repulsion = {
  /** 相手から離れる向きの合計。近いほど大きい（重なると 1 を超える） */
  v: Vec;
  /** いちばん近い相手 */
  nearest: Body;
  /** いちばん近い相手との隙間（負なら重なっている） */
  gap: number;
};

/** 縁と縁の隙間（負なら重なっている） */
export function gapBetween(a: Body, b: Body, aspect: number): number {
  return Math.hypot((a.p.x - b.p.x) * aspect, a.p.y - b.p.y) - a.r - b.r;
}

/**
 * 隙間が clearance より狭い相手から離れる向きを合計する。近い相手がいなければ null。
 * 押し返しの強さは、隙間 clearance で 0、接したところで 1 になる直線。
 */
export function repulsion(self: Body, others: Body[], aspect: number, clearance: number): Repulsion | null {
  let vx = 0;
  let vy = 0;
  let nearest: Body | null = null;
  let nearestGap = Infinity;
  for (const o of others) {
    const dx = (self.p.x - o.p.x) * aspect;
    const dy = self.p.y - o.p.y;
    const d = Math.hypot(dx, dy);
    const gap = d - self.r - o.r;
    if (gap >= clearance) continue;
    const w = (clearance - gap) / clearance;
    // 中心が完全に重なっていたら、向きが決まらないので適当な向きへ逃げる
    const [ux, uy] = d > 1e-6 ? [dx / d, dy / d] : [1, 0];
    vx += ux * w;
    vy += uy * w;
    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = o;
    }
  }
  return nearest ? { v: { x: vx, y: vy }, nearest, gap: nearestGap } : null;
}

/** 押し返しを、行きたい向き goal（長さ 1）より何倍強く効かせるか */
export const REPULSION_WEIGHT = 2;

/**
 * 行きたい向き goal に押し返しを足した、映像の中で進む角度（度、y 下向きの atan2）。
 * geometry.ts の imageAngle と同じ角度の測り方。
 */
export function steerAngle(goal: Vec, rep: Repulsion): number {
  const x = goal.x + rep.v.x * REPULSION_WEIGHT;
  const y = goal.y + rep.v.y * REPULSION_WEIGHT;
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** 映像の中の角度（度）を、長さ 1 のベクトルにする */
export function angleVec(deg: number): Vec {
  const a = (deg * Math.PI) / 180;
  return { x: Math.cos(a), y: Math.sin(a) };
}

/** 説明用の名前 */
export const BODY_NAME: Record<BodyKind, string> = {
  bolt: "BOLT",
  ghost: "ゴースト",
  obstacle: "仮想の障害物",
};
