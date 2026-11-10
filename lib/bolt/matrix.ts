// BOLT の 8x8 マトリクスにマークを描く。
//
// 1 回の命令は応答を待ってから次を送るので（走行命令と同じ列に並ぶ）、命令の数をできるだけ減らす。
// - 前の絵との差が少なければ、変わった点だけを 1 点ずつ描く
// - 差が多ければ、いったん消して、横に続く点を線でまとめて描く
// 命令は 1 つずつ送るので、走行命令が後ろに長く待たされることはない（最大で 1 命令分）。

import type { Bolt } from "./bolt";

export type Rgb = [number, number, number];

/** 8 行 × 8 文字。"#" が点灯、それ以外が消灯 */
export type Rows = readonly string[];

const SIZE = 8;
const OFF = 0;

const pack = ([r, g, b]: Rgb) => ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
const unpack = (c: number): Rgb => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];

/**
 * マークの絵を 64 点の色に直す（BOLT 側の座標は x = 列、y = 行）。
 *
 * マトリクスは BOLT の中の機械に載っていて、進む向きと一緒に回る。
 * 実機で確かめると、マトリクスの 0 行目の側が進む向きの「後ろ」だったので、
 * 絵を 180° 回して描く。これで、絵の上側がいつも進む向きになる。
 */
export function toPixels(rows: Rows | null, color: Rgb): Int32Array<ArrayBuffer> {
  const px = new Int32Array(SIZE * SIZE);
  if (!rows) return px;
  const c = pack(color);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (rows[y]?.[x] === "#") px[(SIZE - 1 - y) * SIZE + (SIZE - 1 - x)] = c;
    }
  }
  return px;
}

type Op =
  | { kind: "clear" }
  | { kind: "pixel"; x: number; y: number; c: number }
  | { kind: "line"; x1: number; x2: number; y: number; c: number };

/** 消してから描き直す場合の命令（横に続く同じ色の点を 1 本の線にまとめる） */
function redrawOps(target: Int32Array): Op[] {
  const ops: Op[] = [{ kind: "clear" }];
  for (let y = 0; y < SIZE; y++) {
    let x = 0;
    while (x < SIZE) {
      const c = target[y * SIZE + x];
      if (c === OFF) {
        x++;
        continue;
      }
      let end = x;
      while (end + 1 < SIZE && target[y * SIZE + end + 1] === c) end++;
      ops.push(end === x ? { kind: "pixel", x, y, c } : { kind: "line", x1: x, x2: end, y, c });
      x = end + 1;
    }
  }
  return ops;
}

/** 今の絵から目標の絵にするための命令（少ないほうを選ぶ） */
export function planOps(current: Int32Array | null, target: Int32Array): Op[] {
  const redraw = redrawOps(target);
  if (!current) return redraw;
  const diff: Op[] = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (current[i] !== target[i]) diff.push({ kind: "pixel", x: i % SIZE, y: Math.floor(i / SIZE), c: target[i] });
  }
  return diff.length <= redraw.length ? diff : redraw;
}

function applyOp(model: Int32Array, op: Op) {
  if (op.kind === "clear") model.fill(OFF);
  else if (op.kind === "pixel") model[op.y * SIZE + op.x] = op.c;
  else for (let x = op.x1; x <= op.x2; x++) model[op.y * SIZE + x] = op.c;
}

function sendOp(bolt: Bolt, op: Op) {
  if (op.kind === "clear") return bolt.setMatrixColor(0, 0, 0);
  if (op.kind === "pixel") return bolt.setMatrixPixel(op.x, op.y, unpack(op.c));
  return bolt.drawMatrixLine(op.x1, op.y, op.x2, op.y, unpack(op.c));
}

/** マトリクスの今の状態を覚えておき、目標の絵との差だけを送る */
export class MatrixPainter {
  /** BOLT に描かれているはずの絵。分からないときは null（次は消してから描く） */
  private current: Int32Array | null = null;
  private target: Int32Array = new Int32Array(SIZE * SIZE);
  private version = 0;
  private running = false;
  /** 描くのをやめたか（手動で色を変えたときなど） */
  private halted = false;

  constructor(
    private getBolt: () => Bolt | null,
    private onError: (e: Error) => void = () => {},
  ) {}

  show(rows: Rows | null, color: Rgb = [0, 0, 0]) {
    this.target = toPixels(rows, color);
    this.halted = false;
    this.version++;
    void this.flush();
  }

  clear() {
    this.show(null);
  }

  /**
   * 描きかけの絵をあきらめる。手動で色を変えたときなど、描かれている絵が分からなくなったときに呼ぶ。
   * 次に show() したときは、消してから描き直す。
   */
  halt() {
    this.halted = true;
    this.current = null;
    this.version++;
  }

  private async flush() {
    if (this.running) return;
    this.running = true;
    try {
      let version = -1;
      let ops: Op[] = [];
      while (true) {
        const bolt = this.getBolt();
        if (!bolt) {
          this.current = null;
          return;
        }
        // 途中で目標が変わったら、今の状態から計画を立て直す
        if (this.halted) return;
        if (version !== this.version) {
          version = this.version;
          ops = planOps(this.current, this.target);
        }
        const op = ops.shift();
        if (!op) return;
        await sendOp(bolt, op);
        if (this.halted) return;
        this.current ??= new Int32Array(SIZE * SIZE);
        applyOp(this.current, op);
      }
    } catch (e) {
      this.current = null;
      this.onError(e as Error);
    } finally {
      this.running = false;
    }
  }
}

// ---- マーク ----
// 絵の上側が、BOLT の進む向き（toPixels で 180° 回して描く）

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
export function autopilotFrame(state: string, tick: number): Frame {
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
    default:
      return { rows: null, color: [0, 0, 0] };
  }
}

/** 動きのある状態（コマを進める必要がある状態） */
const ANIMATED = new Set(["waiting", "calibrating"]);
export const FRAME_MS = 250;

/** 状態に合わせてマークを出し続ける。同じ状態が続く間は送り直さない */
export class StatusMarks {
  private state = "";
  private tick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private painter: MatrixPainter,
    private frame: (state: string, tick: number) => Frame = autopilotFrame,
  ) {}

  set(state: string) {
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
    this.state = "";
    this.painter.halt();
  }

  /** 表示をやめて消す */
  dispose() {
    this.stopTimer();
    this.state = "";
    this.painter.clear();
  }

  private draw() {
    const f = this.frame(this.state, this.tick);
    this.painter.show(f.rows, f.color);
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
