// /api/vision（サーバ）と自動操縦（ブラウザ）で共有する、判定結果の型。

/** 0〜1 の比率（left/right は幅、top/bottom は高さに対する割合） */
export type Box = { top: number; bottom: number; left: number; right: number; confidence: number | null };

export type VisionResult =
  | { ok: true; visible: number; box: Box | null; latencyMs: number; model: string }
  | { ok: false; error: string };
