// 自動操縦の状態。画面（app/）・マトリクスのマーク（lib/bolt/marks.ts）からも使う。

import type { Box } from "@/lib/vision/types";
import type { Segment } from "./tracker";

export type AutopilotState = "off" | "waiting" | "calibrating" | "moving" | "returning" | "stopped";

/** 判定した位置と、そこから現在地を予測するための材料 */
export type Track = {
  /** 判定に使ったコマでの BOLT の位置 */
  box: Box;
  /** そのコマを撮った時刻（Date.now()） */
  capturedAt: number;
  /** 走行命令から求めた速度の区間 */
  segments: Segment[];
};

/** 画面に出す自動操縦の様子 */
export type AutopilotStatus = {
  state: AutopilotState;
  /** BOLT が写っている確率（0〜1）。まだ判定していなければ null */
  visible: number | null;
  latencyMs: number | null;
  /** 状態の説明（画面の左上に出す） */
  reason: string;
  track: Track | null;
  /** 引き返しを始める境界（画面の端からの割合） */
  edgeMargin: number;
};
