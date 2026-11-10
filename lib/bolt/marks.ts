// BOLT のマトリクスに出すマーク（自動操縦・手動操作の状態ごとの絵）と、それを出し続ける StatusMarks。
// 絵の上側が、BOLT の進む向き（matrix.ts の toPixels で 180° 回して描く）。

import type { AutopilotState } from "@/lib/autopilot/types";
import { type MatrixPainter, type Rgb, type Rows, SIZE } from "./matrix";

export const MARKS = {
  /** 目（判定待ち・探している） */
  eye: [
    "........",
    "..####..",
    ".#....#.",
    "#..##..#",
    "#..##..#",
    ".#....#.",
    "..####..",
    "........",
  ],
  /** 目を閉じたところ（まばたき） */
  eyeClosed: [
    "........",
    "..####..",
    ".#....#.",
    "#......#",
    "#......#",
    ".#....#.",
    "..####..",
    "........",
  ],
  /** 進む向きを指す矢印（走行中） */
  arrow: [
    "...##...",
    "..####..",
    ".######.",
    "########",
    "...##...",
    "...##...",
    "...##...",
    "...##...",
  ],
  /** U ターンの矢印（引き返し中）。先端は進む向きの逆を指す */
  uturn: [
    ".####...",
    "#....#..",
    "#....#..",
    "#....#..",
    "#..#####",
    "#...###.",
    "#....#..",
    "#.......",
  ],
  /** ✕（止まった・見失った） */
  cross: [
    "#......#",
    ".#....#.",
    "..#..#..",
    "...##...",
    "...##...",
    "..#..#..",
    ".#....#.",
    "#......#",
  ],
} as const satisfies Record<string, Rows>;

/** 向き合わせ中のくるくる: 円の上の 8 点を、尾を引いて回る */
const SPINNER: [number, number][] = [
  [3, 0],
  [6, 1],
  [7, 4],
  [6, 6],
  [4, 7],
  [1, 6],
  [0, 3],
  [1, 1],
];

export function spinnerFrame(step: number): Rows {
  const grid = Array.from({ length: SIZE }, () => Array<string>(SIZE).fill("."));
  for (const k of [step, step - 1]) {
    const [x, y] = SPINNER[((k % SPINNER.length) + SPINNER.length) % SPINNER.length];
    grid[y][x] = "#";
  }
  return grid.map((r) => r.join(""));
}

export const COLORS = {
  blue: [0, 90, 255],
  purple: [170, 0, 255],
  green: [0, 200, 40],
  yellow: [255, 170, 0],
  red: [255, 0, 0],
} as const satisfies Record<string, Rgb>;

/** 1 コマ分の絵（null は消灯） */
export type Frame = { rows: Rows | null; color: Rgb };

/** 自動操縦の状態ごとの表示。tick は 250ms ごとに 1 増える */
export function autopilotFrame(state: AutopilotState, tick: number): Frame {
  switch (state) {
    case "waiting":
      // 2.5 秒ごとに 1 コマだけ目を閉じる
      return { rows: tick % 10 === 9 ? MARKS.eyeClosed : MARKS.eye, color: COLORS.blue };
    case "calibrating":
      return { rows: spinnerFrame(tick), color: COLORS.purple };
    case "moving":
      return { rows: MARKS.arrow, color: COLORS.green };
    case "returning":
      return { rows: MARKS.uturn, color: COLORS.yellow };
    case "stopped":
      return { rows: MARKS.cross, color: COLORS.red };
    case "off":
      return { rows: null, color: [0, 0, 0] };
  }
}

// ---- 手動操作のマーク ----

/** 矢印の頭の高さ。残りの行が軸になる */
const HEAD_ROWS = 3;
/** 速さの段階の数（軸の長さ 0〜5 行） */
export const SPEED_LEVELS = SIZE - HEAD_ROWS + 1;

/** 手動操作で走っているときの状態名（速さを段階にしたもの） */
export type ManualDriveState = `manual-drive-${number}`;
export const MANUAL_STOP = "manual-stop";

/** マトリクスに出せる状態: 自動操縦の状態と、手動操作の状態 */
export type MarkState = AutopilotState | ManualDriveState | typeof MANUAL_STOP;

export function manualDriveState(speed: number): ManualDriveState {
  const level = Math.min(SPEED_LEVELS, Math.max(1, Math.ceil((speed / 255) * SPEED_LEVELS)));
  return `${MANUAL_DRIVE_PREFIX}${level}`;
}

/** 速さの矢印: 先端は進む向き（絵の上）の端に固定し、速いほど軸が後ろへ長く伸びる */
export function speedArrowFrame(level: number): Rows {
  const head = ["...##...", "..####..", ".######."];
  const shaft = level - 1;
  return Array.from({ length: SIZE }, (_, y) =>
    y < HEAD_ROWS ? head[y] : y < HEAD_ROWS + shaft ? "...##..." : "........",
  );
}

/** 停止: 中央の四角 */
const STOP_SQUARE: Rows = [
  "........",
  "........",
  "..####..",
  "..####..",
  "..####..",
  "..####..",
  "........",
  "........",
];

const MANUAL_DRIVE_PREFIX = "manual-drive-";
const isManualDrive = (s: MarkState): s is ManualDriveState => s.startsWith(MANUAL_DRIVE_PREFIX);

/** 状態ごとの表示（手動操作の状態と、自動操縦の状態） */
export function markFrame(state: MarkState, tick: number): Frame {
  if (isManualDrive(state)) {
    return { rows: speedArrowFrame(Number(state.slice(MANUAL_DRIVE_PREFIX.length))), color: COLORS.green };
  }
  if (state === MANUAL_STOP) return { rows: STOP_SQUARE, color: COLORS.red };
  return autopilotFrame(state, tick);
}

/** 動きのある状態（コマを進める必要がある状態） */
const ANIMATED = new Set<MarkState>(["waiting", "calibrating"]);
export const FRAME_MS = 250;

/** 状態に合わせてマークを出し続ける。同じ状態が続く間は送り直さない */
export class StatusMarks {
  /** 今出している状態。何も出していなければ null */
  private state: MarkState | null = null;
  private tick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private painter: MatrixPainter,
    private frame: (state: MarkState, tick: number) => Frame = markFrame,
  ) {}

  set(state: MarkState) {
    if (state === this.state) return;
    this.state = state;
    this.tick = 0;
    this.stopTimer();
    this.draw();
    if (ANIMATED.has(state)) {
      this.timer = setInterval(() => {
        this.tick++;
        this.draw();
      }, FRAME_MS);
    }
  }

  /** 表示をやめる（消さずに、そのままにする） */
  halt() {
    this.stopTimer();
    this.state = null;
    this.painter.halt();
  }

  /** 表示をやめて消す */
  dispose() {
    this.stopTimer();
    this.state = null;
    this.painter.clear();
  }

  private draw() {
    if (this.state === null) return;
    const f = this.frame(this.state, this.tick);
    this.painter.show(f.rows, f.color);
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
