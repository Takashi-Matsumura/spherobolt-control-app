// 判定の遅れを補う、BOLT の現在地の予測。
//
// Jev の判定は 0.2〜0.4 秒前に撮ったコマのもの。その間も BOLT は走っているので、
// 自分が出した走行命令（いつ・どの向きに・どの速さで）から「撮った時刻から今までに進んだ分」を足す。
// 座標は Box と同じ 0〜1 の比率（x は幅、y は高さに対する割合）。

import { type Calibration, type Edges, type Point, center, imageDistance } from "./geometry";

/** 走行命令が実際の動きに反映されるまでの遅れ（加速・減速をまとめて遅れとして扱う） */
export const MOTION_LAG_MS = 150;
/** これより先は予測しない（判定が途絶えたときに枠が飛んでいかないように） */
export const MAX_PREDICT_MS = 1000;

/** ある時刻から始まる速度（比率/ミリ秒）。止まる命令は速度 0 */
export type Segment = { t: number; vx: number; vy: number; speed: number };

/** heading の向きに進むときの、映像の中での単位ベクトル（比率の座標に直したもの） */
export function directionOf(heading: number, cal: Calibration, aspect: number): Point {
  const phi = ((cal.theta0 + cal.sign * heading) * Math.PI) / 180;
  // 角度は縦横比を補正した空間のものなので、x を縦横比で割って比率の座標に戻す
  return { x: Math.cos(phi) / aspect, y: Math.sin(phi) };
}

/**
 * 走行命令から速度の区間を作る。
 * gain は「速度 1 あたり、映像の中を 1 ミリ秒に進む距離（高さを 1 とした単位）」。
 */
export function segmentFor(
  t: number,
  speed: number,
  heading: number,
  cal: Calibration,
  gain: number,
  aspect: number,
): Segment {
  if (speed <= 0) return { t: t + MOTION_LAG_MS, vx: 0, vy: 0, speed: 0 };
  const d = directionOf(heading, cal, aspect);
  const m = gain * speed;
  return { t: t + MOTION_LAG_MS, vx: d.x * m, vy: d.y * m, speed };
}

/** from から to までに進む量（区間をまたいで積算する） */
export function displacement(segments: Segment[], from: number, to: number): Point {
  let dx = 0;
  let dy = 0;
  if (to <= from) return { x: 0, y: 0 };
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const end = i + 1 < segments.length ? segments[i + 1].t : Infinity;
    const a = Math.max(from, s.t);
    const b = Math.min(to, end);
    if (b > a) {
      dx += s.vx * (b - a);
      dy += s.vy * (b - a);
    }
  }
  return { x: dx, y: dy };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** capturedAt に撮ったコマの位置 box を、now の時点まで進めた位置 */
export function predictBox<T extends Edges>(box: T, capturedAt: number, now: number, segments: Segment[]): T {
  const to = Math.min(now, capturedAt + MAX_PREDICT_MS);
  const d = displacement(segments, capturedAt, to);
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  // 枠の大きさは保ったまま、中心が画面の外へ出ないように動かす
  const cx = clamp01((box.left + box.right) / 2 + d.x);
  const cy = clamp01((box.top + box.bottom) / 2 + d.y);
  return { ...box, left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
}

export function predictCenter(box: Edges, capturedAt: number, now: number, segments: Segment[]): Point {
  return center(predictBox(box, capturedAt, now, segments));
}

/** 同じ速度で走り続けている区間の中か（加速が終わってから） */
function steadySegment(segments: Segment[], t1: number, t2: number): Segment | null {
  let seg: Segment | null = null;
  for (const s of segments) {
    if (s.t <= t1) seg = s;
    else if (s.t < t2) return null; // 途中で命令が変わった
  }
  if (!seg || seg.speed <= 0 || t1 - seg.t < 250) return null;
  return seg;
}

/**
 * 連続する 2 回の判定から、速度 1 あたりの進み方（gain）を学び直す。
 * 同じ命令で走り続けている間の観測だけを使い、外れ値は捨てる。
 */
export function updateGain(
  gain: number,
  segments: Segment[],
  prev: { p: Point; t: number },
  cur: { p: Point; t: number },
  aspect: number,
): number {
  const seg = steadySegment(segments, prev.t, cur.t);
  const dt = cur.t - prev.t;
  if (!seg || dt < 100) return gain;
  const observed = imageDistance(prev.p, cur.p, aspect) / dt / seg.speed;
  if (!Number.isFinite(observed) || observed <= 0) return gain;
  if (observed > gain * 4 || observed < gain / 4) return gain; // 判定の揺れによる外れ値
  return gain * 0.7 + observed * 0.3;
}
