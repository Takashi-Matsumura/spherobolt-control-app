// カメラの 1 コマを JPEG にして /api/vision に送り、判定結果を受け取る（ブラウザ側）。

import type { Box, VisionResult } from "@/lib/vision/types";

// 送る画像の大きさ。Jev の制限（各辺 280〜1568px）に収まり、通信量も小さい
export const FRAME_WIDTH = 640;
export const FRAME_HEIGHT = 360;
const JPEG_QUALITY = 0.7;

/** 1 回の判定結果 */
export type Judgment = { visible: number; box: Box | null; latencyMs: number; capturedAt: number };

async function captureFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): Promise<string> {
  canvas.width = FRAME_WIDTH;
  canvas.height = FRAME_HEIGHT;
  canvas.getContext("2d")!.drawImage(video, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("フレームを取得できません");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1); // Jev は data: 接頭辞なしの base64 を受け取る
}

/** 今のコマを判定する。canvas は使い回し用（毎回作らない） */
export async function judgeFrame(video: HTMLVideoElement | null, canvas: HTMLCanvasElement): Promise<Judgment> {
  if (!video || video.readyState < 2) throw new Error("カメラ映像がありません");
  const capturedAt = Date.now();
  const image = await captureFrame(video, canvas);
  const res = await fetch("/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image }),
  });
  const result = (await res.json()) as VisionResult;
  if (!result.ok) throw new Error(result.error);
  return { visible: result.visible, box: result.box, latencyMs: result.latencyMs, capturedAt };
}
