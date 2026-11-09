// カメラ映像の中の方向と、BOLT の向き（heading）を対応づける計算。
// 座標は Jev の Box と同じ 0〜1 の比率（x は右向き、y は下向き）。

export type Point = { x: number; y: number };
export type Edges = { top: number; bottom: number; left: number; right: number };

/**
 * 向き合わせの結果。
 * 映像の中での角度 = theta0 + sign × heading（度、y 下向きの atan2）
 */
export type Calibration = {
  /** heading 0° で走ったときに、映像の中で動いた方向（度） */
  theta0: number;
  /** heading を増やしたとき映像の中で時計回りなら 1、反時計回りなら -1 */
  sign: 1 | -1;
  /** heading 90° の実測が、理想の ±90° からどれだけずれたか（度）。大きいほど当てにならない */
  error: number;
};

export function center(b: Edges): Point {
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 };
}

/** -180〜180 に正規化 */
export function norm180(deg: number): number {
  const d = ((deg % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

/** 0〜359 に正規化 */
export function norm360(deg: number): number {
  return ((Math.round(deg) % 360) + 360) % 360;
}

/**
 * from から to へ向かう、映像の中での角度（度）。
 * 比率の座標を実際の画素の比に直すため、x に縦横比を掛ける。
 */
export function imageAngle(from: Point, to: Point, aspect: number): number {
  return (Math.atan2(to.y - from.y, (to.x - from.x) * aspect) * 180) / Math.PI;
}

/** 映像の中での移動距離（高さを 1 とした単位） */
export function imageDistance(from: Point, to: Point, aspect: number): number {
  return Math.hypot((to.x - from.x) * aspect, to.y - from.y);
}

/** heading 0° と 90° で走ったときの映像の中の角度から、向き合わせの結果を作る */
export function calibrate(theta0: number, theta90: number): Calibration {
  const d = norm180(theta90 - theta0);
  return { theta0, sign: d >= 0 ? 1 : -1, error: Math.abs(Math.abs(d) - 90) };
}

/** 映像の中で phi 度の方向へ進むための heading */
export function headingFor(phi: number, cal: Calibration): number {
  return norm360(cal.sign * (phi - cal.theta0));
}

/** 画面の端から margin 以内にいるか */
export function isNearEdge(p: Point, margin: number): boolean {
  return p.x < margin || p.x > 1 - margin || p.y < margin || p.y > 1 - margin;
}
