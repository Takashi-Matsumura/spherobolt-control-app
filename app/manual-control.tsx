"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { Bolt } from "@/lib/bolt/bolt";
import { MANUAL_STOP, MatrixPainter, StatusMarks, manualDriveState } from "@/lib/bolt/matrix";
import {
  ActionButton,
  type Dir,
  Dpad,
  HandheldShell,
  Lcd,
  Tip,
  useRepeatPress,
} from "./handheld/controls";

const HEADING: Record<Dir, number> = { up: 0, right: 90, down: 180, left: 270 };
const DIR_NAME: Record<Dir, string> = { up: "前進", right: "右", down: "後退", left: "左" };
const KEY_DIR: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

/** 「マークを試す」で順に出す、自動操縦の状態ごとのマーク */
const TEST_MARKS: { state: string; label: string }[] = [
  { state: "waiting", label: "判定待ち（青い目）" },
  { state: "calibrating", label: "向き合わせ中（紫のくるくる）" },
  { state: "moving", label: "走行中（緑の矢印）" },
  { state: "returning", label: "引き返し中（黄色の U ターン）" },
  { state: "stopped", label: "止まった（赤の ✕）" },
  { state: "off", label: "消灯" },
];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

type Props = {
  boltRef: RefObject<Bolt | null>;
  connected: boolean;
  log: (msg: string) => void;
  /** 正面をリセットすると、自動操縦の向き合わせが無効になるので知らせる */
  onHeadingReset: () => void;
};

/** 手動操作の画面: 左の十字キーで走行、右のボタンでライト */
export default function ManualControl({ boltRef, connected, log, onHeadingReset }: Props) {
  const [speed, setSpeed] = useState(80);
  const [matrixColor, setMatrixColor] = useState("#00a0ff");
  const [frontColor, setFrontColor] = useState("#ffffff");
  const [backColor, setBackColor] = useState("#ff0000");
  const [driving, setDriving] = useState<Dir | null>(null);
  const [lastAction, setLastAction] = useState("");

  // キーボード操作の中から最新の値を読むための参照
  const speedRef = useRef(speed);
  const drivingRef = useRef<Dir | null>(null);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  // 自動操縦で使うマークを、走らせずに確かめる
  const marksRef = useRef<StatusMarks | null>(null);
  const testIndex = useRef(-1);
  const getMarks = useCallback(
    () =>
      (marksRef.current ??= new StatusMarks(
        new MatrixPainter(
          () => boltRef.current,
          (e) => log(`マーク表示 失敗: ${e.message}`),
        ),
      )),
    [boltRef, log],
  );
  useEffect(() => () => marksRef.current?.halt(), []);
  const testNextMark = () => {
    testIndex.current = (testIndex.current + 1) % TEST_MARKS.length;
    const m = TEST_MARKS[testIndex.current];
    setLastAction(`マーク: ${m.label}`);
    getMarks().set(m.state);
  };
  /** 手動でマトリクスの色を変える前に、マークの表示を止める */
  const haltMarks = () => marksRef.current?.halt();

  const run = useCallback(
    async (label: string, fn: (b: Bolt) => Promise<unknown>) => {
      const bolt = boltRef.current;
      if (!bolt) return;
      setLastAction(label);
      try {
        await fn(bolt);
      } catch (e) {
        log(`${label} 失敗: ${(e as Error).message}`);
        setLastAction(`${label} 失敗`);
      }
    },
    [boltRef, log],
  );

  // マトリクスに走行の様子を出す（走行命令の後に送るので、走り出しは遅れない）
  const drive = useCallback(
    (d: Dir) => {
      drivingRef.current = d;
      setDriving(d);
      void run(`${DIR_NAME[d]}（${HEADING[d]}°）`, (b) => b.roll(speedRef.current, HEADING[d]));
      getMarks().set(manualDriveState(speedRef.current));
    },
    [run, getMarks],
  );

  const stop = useCallback(() => {
    const d = drivingRef.current;
    drivingRef.current = null;
    setDriving(null);
    void run("停止", (b) => b.stop(d ? HEADING[d] : 0));
    getMarks().set(MANUAL_STOP);
  }, [run, getMarks]);

  // 走っている間に速さを変えたら、バーの長さも変える
  useEffect(() => {
    if (drivingRef.current) marksRef.current?.set(manualDriveState(speed));
  }, [speed]);

  // 十字キーは押している間だけ走る。離したとき、別の方向に切り替わっていたら止めない
  const releaseDir = useCallback((d: Dir) => drivingRef.current === d && stop(), [stop]);

  // キーボード: 矢印キーで走行（離すと停止）、Space で停止
  useEffect(() => {
    if (!connected) return;
    const isTyping = (e: KeyboardEvent) => (e.target as HTMLElement).closest("input, select, textarea");
    const down = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const d = KEY_DIR[e.key];
      if (d) {
        e.preventDefault();
        if (!e.repeat) drive(d);
      } else if (e.key === " ") {
        e.preventDefault();
        stop();
      }
    };
    const up = (e: KeyboardEvent) => {
      const d = KEY_DIR[e.key];
      if (d) releaseDir(d);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [connected, drive, stop, releaseDir]);

  // 画面を離れる（タブを切り替える）ときは止める
  useEffect(() => () => void boltRef.current?.stop().catch(() => {}), [boltRef]);

  const speedDown = useRepeatPress(() => setSpeed((v) => Math.max(0, v - 10)));
  const speedUp = useRepeatPress(() => setSpeed((v) => Math.min(255, v + 10)));
  const speedButton =
    "flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800 text-base font-medium leading-none text-zinc-200 " +
    "shadow-[inset_0_-2px_0_rgb(0_0_0/0.4)] hover:bg-zinc-700 active:translate-y-px select-none touch-none";
  const pill =
    "rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 shadow-[inset_0_-2px_0_rgb(0_0_0/0.4)] " +
    "hover:bg-zinc-700 active:translate-y-px disabled:opacity-40 select-none touch-none";

  return (
    <HandheldShell
      power={connected}
      connected={connected}
      screenLabel="BOLT PILOT · MANUAL"
      left={
        <>
          <Lcd>
            <div className="flex justify-between">
              <span>SPEED</span>
              <span>{speed}</span>
            </div>
            <div className="flex justify-between">
              <span>DRIVE</span>
              <span className={driving ? "text-emerald-300" : "text-zinc-500"}>
                {driving ? `${HEADING[driving]}°` : "STOP"}
              </span>
            </div>
          </Lcd>
          <Dpad
            onPress={drive}
            onRelease={releaseDir}
            labels={{
              up: "前進（押している間だけ・↑ キー）",
              down: "後退（押している間だけ・↓ キー）",
              left: "左へ（押している間だけ・← キー）",
              right: "右へ（押している間だけ・→ キー）",
            }}
            onCenter={stop}
            centerLabel="停止（Space キー）"
            disabled={!connected}
          />
          <div className="flex flex-col items-center gap-1.5">
            <div className="flex items-center gap-2">
              <Tip text="速度を下げる">
                <button className={speedButton} {...speedDown} aria-label="速度を下げる">
                  −
                </button>
              </Tip>
              <Tip text="速度を上げる">
                <button className={speedButton} {...speedUp} aria-label="速度を上げる">
                  +
                </button>
              </Tip>
            </div>
            {/* 本体に刻印したようなラベル */}
            <span className="text-[10px] font-semibold tracking-[0.2em] text-zinc-500">SPEED</span>
          </div>
        </>
      }
      right={
        <>
          {/* 菱形に並べたボタン */}
          <div className="grid grid-cols-3 grid-rows-3 place-items-center gap-x-1 gap-y-0">
            <div className="col-start-2 row-start-1">
              <ActionButton
                size="sm"
                letter="X"
                label="前 LED"
                tip={"前 LED を点灯\n色は画面のライトを押して選びます"}
                tone="secondary"
                disabled={!connected}
                onClick={() => run("前 LED 点灯", (b) => b.setFrontLed(hexToRgb(frontColor)))}
              />
            </div>
            <div className="col-start-1 row-start-2">
              <ActionButton
                size="sm"
                letter="Y"
                label="後 LED"
                tip={"後 LED を点灯\n色は画面のライトを押して選びます"}
                tone="secondary"
                disabled={!connected}
                onClick={() => run("後 LED 点灯", (b) => b.setBackLed(hexToRgb(backColor)))}
              />
            </div>
            <div className="col-start-3 row-start-2">
              <ActionButton
                size="sm"
                letter="A"
                label="マトリクス"
                tip={"マトリクスを点灯\n色は画面のライトを押して選びます"}
                tone="primary"
                disabled={!connected}
                onClick={() => {
                  haltMarks();
                  void run("マトリクス点灯", (b) => b.setMatrixColor(...hexToRgb(matrixColor)));
                }}
              />
            </div>
            <div className="col-start-2 row-start-3">
              <ActionButton
                size="sm"
                letter="B"
                label="すべて消灯"
                tone="secondary"
                disabled={!connected}
                onClick={() => {
                  haltMarks();
                  void run("すべて消灯", async (b) => {
                    await b.setMatrixColor(0, 0, 0);
                    await b.setFrontBackLeds([0, 0, 0], [0, 0, 0]);
                  });
                }}
              />
            </div>
          </div>
          <button
            className={pill}
            disabled={!connected}
            onClick={() =>
              run("現在の向きを正面にする", async (b) => {
                await b.resetYaw();
                onHeadingReset();
              })
            }
          >
            現在の向きを正面にする
          </button>
          <button className={pill} disabled={!connected} onClick={testNextMark}>
            マークを試す
          </button>
        </>
      }
    >
      <ManualScreen
        connected={connected}
        speed={speed}
        driving={driving}
        lastAction={lastAction}
        matrixColor={matrixColor}
        frontColor={frontColor}
        backColor={backColor}
        onMatrixColor={setMatrixColor}
        onFrontColor={setFrontColor}
        onBackColor={setBackColor}
      />
    </HandheldShell>
  );
}

type ScreenProps = {
  connected: boolean;
  speed: number;
  driving: Dir | null;
  lastAction: string;
  matrixColor: string;
  frontColor: string;
  backColor: string;
  onMatrixColor: (c: string) => void;
  onFrontColor: (c: string) => void;
  onBackColor: (c: string) => void;
};

/** 画面: 走行の向きと速度、ライトの色 */
function ManualScreen(p: ScreenProps) {
  const heading = p.driving ? HEADING[p.driving] : null;
  return (
    <div className="relative grid aspect-video w-full grid-cols-2 gap-4 overflow-hidden rounded-md bg-slate-950 p-5 font-mono text-cyan-200">
      {/* 左: 向きと速度 */}
      <div className="flex flex-col items-center justify-center gap-3">
        <svg viewBox="-50 -50 100 100" className="h-auto w-full max-w-[12rem]" aria-label="走行の向き">
          <circle r="44" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
          {[0, 90, 180, 270].map((a) => (
            <line
              key={a}
              x1="0"
              y1="-44"
              x2="0"
              y2="-38"
              stroke="currentColor"
              strokeOpacity="0.5"
              transform={`rotate(${a})`}
            />
          ))}
          <text y="-30" textAnchor="middle" fontSize="7" fill="currentColor" fillOpacity="0.6">
            正面
          </text>
          {heading !== null ? (
            <polygon
              points="0,-34 7,-14 0,-19 -7,-14"
              fill="rgb(52 211 153)"
              transform={`rotate(${heading})`}
            />
          ) : (
            <rect x="-7" y="-7" width="14" height="14" rx="2" fill="rgb(239 68 68)" fillOpacity="0.8" />
          )}
        </svg>
        <div className="text-sm">{p.driving ? `${DIR_NAME[p.driving]} ${heading}°` : "停止中"}</div>
        <div className="w-full max-w-[12rem]">
          <div className="mb-1 flex justify-between text-[10px] opacity-70">
            <span>SPEED</span>
            <span>{p.speed} / 255</span>
          </div>
          <div className="h-2 overflow-hidden rounded bg-slate-800">
            <div className="h-full bg-cyan-400" style={{ width: `${(p.speed / 255) * 100}%` }} />
          </div>
        </div>
      </div>

      {/* 右: ライト（押すと色を選べる） */}
      <div className="flex flex-col items-center justify-center gap-4">
        <label className="flex cursor-pointer flex-col items-center gap-1.5" title="押して色を選ぶ">
          <div className="grid grid-cols-8 gap-[3px] rounded bg-slate-900 p-1.5 ring-1 ring-cyan-900 hover:ring-cyan-500">
            {Array.from({ length: 64 }, (_, i) => (
              <span key={i} className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: p.matrixColor }} />
            ))}
          </div>
          <span className="text-[10px] opacity-70">MATRIX (A)</span>
          <input
            type="color"
            className="sr-only"
            value={p.matrixColor}
            onChange={(e) => p.onMatrixColor(e.target.value)}
          />
        </label>
        <div className="flex gap-6">
          {(
            [
              ["FRONT (X)", p.frontColor, p.onFrontColor],
              ["BACK (Y)", p.backColor, p.onBackColor],
            ] as const
          ).map(([name, color, set]) => (
            <label key={name} className="flex cursor-pointer flex-col items-center gap-1.5" title="押して色を選ぶ">
              <span
                className="h-7 w-7 rounded-full ring-2 ring-cyan-900 hover:ring-cyan-500"
                style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}` }}
              />
              <span className="text-[10px] opacity-70">{name}</span>
              <input type="color" className="sr-only" value={color} onChange={(e) => set(e.target.value)} />
            </label>
          ))}
        </div>
      </div>

      {p.lastAction && (
        <div className="absolute bottom-2 left-3 text-[10px] opacity-60">&gt; {p.lastAction}</div>
      )}
      {!p.connected && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 text-sm text-zinc-300">
          上の「BOLT に接続」を押してください
        </div>
      )}
    </div>
  );
}
