// 判定の遅れを補う、BOLT の現在地の予測。
//
// Jev の判定は 0.2〜0.4 秒前に撮ったコマのもの。その間も BOLT は走っているので、
// 自分が出した走行命令（いつ・どの向きに・どの速さで）から「撮った時刻から今までに進んだ分」を足す。
// 座標は Box と同じ 0〜1 の比率（x は幅、y は高さに対する割合）。

import { type Calibration, type Edges, type Point, center } from "./geometry";

/** 止まっている状態から走らせたとき、動き出すまでの遅れ（加速をまとめて遅れとして扱う） */
export const START_LAG_MS = 300;
/** 止める・向きを少し変えるときの遅れ（減速・惰性をまとめて遅れとして扱う） */
export const STOP_LAG_MS = 150;
/** この角度以上向きを変えるときは、いったん止まってから向きを変えるとみなす */
export const TURN_STOP_DEG = 30;
/** 180° 向きを変えるのにかかる時間（角度に比例させる） */
export const TURN_MS_PER_180 = 600;
/** これより先は予測しない（判定が途絶えたときに枠が飛んでいかないように） */
export const MAX_PREDICT_MS = 1000;

/** ある時刻から始まる速度（比率/ミリ秒）。止まる命令は速度 0 */
export type Segment = { t: number; vx: number; vy: number; speed: number };

/** 直前に出した走行命令 */
export type Command = { speed: number; heading: number };

/** heading の向きに進むときの、映像の中での単位ベクトル（比率の座標に直したもの） */
export function directionOf(heading: number, cal: Calibration, aspect: number): Point {
  const phi = ((cal.theta0 + cal.sign * heading) * Math.PI) / 180;
  // 角度は縦横比を補正した空間のものなので、x を縦横比で割って比率の座標に戻す
  return { x: Math.cos(phi) / aspect, y: Math.sin(phi) };
}

/** 2 つの向きの差（0〜180°） */
export function headingDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * 走行命令から、速度の区間を作る。
 * gain は「速度 1 あたり、映像の中を 1 ミリ秒に進む距離（高さを 1 とした単位）」。
 *
 * - 止める: STOP_LAG_MS 後に速度 0
 * - 止まっている状態から走る: START_LAG_MS 後に動き出す
 * - 走りながら少し向きを変える: STOP_LAG_MS 後に新しい向き
 * - 大きく向きを変える: STOP_LAG_MS 後にいったん止まり、角度に比例した時間をかけて向きを変えてから動き出す
 */
export function segmentsFor(
  t: number,
  prev: Command | null,
  next: Command,
  cal: Calibration,
  gain: number,
  aspect: number,
): Segment[] {
  if (next.speed <= 0) return [{ t: t + STOP_LAG_MS, vx: 0, vy: 0, speed: 0 }];
  const d = directionOf(next.heading, cal, aspect);
  const m = gain * next.speed;
  const run = (at: number): Segment => ({ t: at, vx: d.x * m, vy: d.y * m, speed: next.speed });
  if (!prev || prev.speed <= 0) return [run(t + START_LAG_MS)];
  const turn = headingDiff(prev.heading, next.heading);
  if (turn < TURN_STOP_DEG) return [run(t + STOP_LAG_MS)];
  const stopAt = t + STOP_LAG_MS;
  return [
    { t: stopAt, vx: 0, vy: 0, speed: 0 },
    run(stopAt + (TURN_MS_PER_180 * turn) / 180),
  ];
}

/**
 * 区間の履歴に新しい区間を足す。まだ始まっていない古い区間は、新しい命令で取り消されたものとして捨てる。
 * 古すぎる区間も捨てる（ただし今も続いている区間は残す）。
 */
export function pushSegments(history: Segment[], added: Segment[], now: number, keepMs: number): Segment[] {
  if (added.length === 0) return history;
  const first = added[0].t;
  const kept = history.filter((s) => s.t < first);
  const all = [...kept, ...added];
  const cutoff = now - keepMs;
  while (all.length > 1 && all[1].t < cutoff) all.shift();
  return all;
}

/**
 * 試走（speed で durationMs 走って止める）で dist 進んだときの gain。
 * 予測と同じ遅れの考え方（動き出しに START_LAG_MS、止まるのに STOP_LAG_MS）で割るので、
 * 同じ試走を予測すると、ちょうど dist 進む。
 */
export function gainFromPulse(dist: number, durationMs: number, speed: number): number {
  const moving = Math.max(durationMs - START_LAG_MS + STOP_LAG_MS, 1);
  return dist / moving / speed;
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

/** 予測した移動量がこれより小さいときは、学び直しに使わない（判定の揺れに埋もれるため） */
const MIN_LEARN_DISTANCE = 0.03;

/**
 * 連続する 2 回の判定から、gain を学び直す。
 * 「予測した移動量」に対して「実際の移動量」がどれだけだったかを、予測した向きに沿って比べる。
 * 向きを変えている途中の観測も使えるが、外れ値は捨てる。
 */
export function updateGain(
  gain: number,
  segments: Segment[],
  prev: { p: Point; t: number },
  cur: { p: Point; t: number },
  aspect: number,
): number {
  const pred = displacement(segments, prev.t, cur.t);
  const px = pred.x * aspect;
  const py = pred.y;
  const len2 = px * px + py * py;
  if (len2 < MIN_LEARN_DISTANCE * MIN_LEARN_DISTANCE) return gain;
  const ox = (cur.p.x - prev.p.x) * aspect;
  const oy = cur.p.y - prev.p.y;
  const ratio = (ox * px + oy * py) / len2;
  if (!Number.isFinite(ratio) || ratio < 0.25 || ratio > 4) return gain; // 判定の揺れによる外れ値
  return gain * (0.7 + 0.3 * ratio);
}
