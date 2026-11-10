"use client";

import { useEffect, useRef } from "react";

/** 押しっぱなしで繰り返す（最初の 1 回 → 0.4 秒後から 0.1 秒おき） */
export function useRepeatPress(action: () => void) {
  const actionRef = useRef(action);
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; repeat?: ReturnType<typeof setInterval> }>({});

  useEffect(() => {
    actionRef.current = action;
  }, [action]);

  const release = () => {
    clearTimeout(timers.current.delay);
    clearInterval(timers.current.repeat);
  };

  useEffect(() => release, []);

  const press = () => {
    release();
    actionRef.current();
    timers.current.delay = setTimeout(() => {
      timers.current.repeat = setInterval(() => actionRef.current(), 100);
    }, 400);
  };

  return {
    onPointerDown: press,
    onPointerUp: release,
    onPointerLeave: release,
    onPointerCancel: release,
  };
}

export type Dir = "up" | "down" | "left" | "right";

export type PressHandlers = {
  onPointerDown: () => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
};

/** 押している間だけ動き、離したら止まる操作用 */
export function holdHandlers(onPress: () => void, onRelease: () => void): PressHandlers {
  return {
    onPointerDown: onPress,
    onPointerUp: onRelease,
    onPointerLeave: onRelease,
    onPointerCancel: onRelease,
  };
}

/** マウスを乗せたとき（キーボードでフォーカスしたとき）に出る小さな説明 */
export function Tip({
  text,
  children,
  className = "relative inline-flex",
}: {
  text?: React.ReactNode;
  children: React.ReactNode;
  /** 位置決めのクラス（既定は relative） */
  className?: string;
}) {
  return (
    <span className={`group/tip ${className}`}>
      {children}
      {text && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-max max-w-[16rem] -translate-x-1/2 whitespace-pre-line rounded-md bg-zinc-950 px-2.5 py-1.5 text-left text-[11px] font-normal leading-snug tracking-normal text-zinc-100 opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity group-focus-within/tip:opacity-100 group-hover/tip:opacity-100 group-hover/tip:delay-150"
        >
          {text}
        </span>
      )}
    </span>
  );
}

/** 十字キーの矢印（上向きを回して使う） */
export function ChevronIcon({ dir, className = "h-5 w-5" }: { dir: Dir; className?: string }) {
  const rotate = { up: 0, right: 90, down: 180, left: 270 }[dir];
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: `rotate(${rotate}deg)` }}
      aria-hidden
    >
      <path d="m6 15 6-6 6 6" />
    </svg>
  );
}

/** 電源アイコン */
export function PowerIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
    </svg>
  );
}

const arm =
  "flex h-full w-full items-center justify-center bg-zinc-800 text-zinc-300 shadow-[inset_0_-3px_0_rgb(0_0_0/0.35)] " +
  "active:translate-y-px active:shadow-none active:bg-zinc-900 select-none touch-none dark:bg-zinc-950 " +
  "disabled:opacity-40 disabled:cursor-not-allowed";

const ARM_POS: Record<Dir, string> = {
  up: "left-[var(--s)] top-0",
  down: "bottom-0 left-[var(--s)]",
  left: "left-0 top-[var(--s)]",
  right: "right-0 top-[var(--s)]",
};
const ARM_ROUND: Record<Dir, string> = {
  up: "rounded-t-md",
  down: "rounded-b-md",
  left: "rounded-l-md",
  right: "rounded-r-md",
};

type DpadProps = {
  /** 方向ごとのイベント（押しっぱなしで繰り返す設定用など） */
  handlers?: Record<Dir, Partial<PressHandlers>>;
  /** 押している間だけ動く操作用: 押したとき・離したとき */
  onPress?: (d: Dir) => void;
  onRelease?: (d: Dir) => void;
  labels: Record<Dir, string>;
  /** 中央を押したとき（省略時は飾り） */
  onCenter?: () => void;
  centerLabel?: string;
  disabled?: boolean;
};

/** 十字キー */
export function Dpad({ handlers, onPress, onRelease, labels, onCenter, centerLabel, disabled }: DpadProps) {
  return (
    <div className="relative h-[7.8rem] w-[7.8rem]" style={{ ["--s" as string]: "2.6rem" }}>
      {(Object.keys(ARM_POS) as Dir[]).map((d) => (
        <Tip key={d} text={labels[d]} className={`absolute flex h-[var(--s)] w-[var(--s)] ${ARM_POS[d]}`}>
          <button
            aria-label={labels[d]}
            disabled={disabled}
            {...(handlers?.[d] ??
              (onPress && onRelease ? holdHandlers(() => onPress(d), () => onRelease(d)) : {}))}
            className={`${arm} ${ARM_ROUND[d]}`}
          >
            <ChevronIcon dir={d} />
          </button>
        </Tip>
      ))}
      {onCenter ? (
        <Tip text={centerLabel} className="absolute left-[var(--s)] top-[var(--s)] flex h-[var(--s)] w-[var(--s)]">
          <button
            aria-label={centerLabel}
            disabled={disabled}
            onClick={onCenter}
            className="flex h-full w-full items-center justify-center bg-zinc-800 disabled:opacity-40 dark:bg-zinc-950"
          >
            <span className="h-5 w-5 rounded-full bg-red-700 shadow-[inset_0_-2px_0_rgb(0_0_0/0.4)] active:translate-y-px" />
          </button>
        </Tip>
      ) : (
        <div className="absolute left-[var(--s)] top-[var(--s)] flex h-[var(--s)] w-[var(--s)] items-center justify-center bg-zinc-800 dark:bg-zinc-950">
          <span className="h-4 w-4 rounded-full bg-zinc-700 dark:bg-zinc-900" />
        </div>
      )}
    </div>
  );
}

type RepeatDpadProps = {
  onUp: () => void;
  onDown: () => void;
  onLeft: () => void;
  onRight: () => void;
  labels: Record<Dir, string>;
};

/** 押しっぱなしで値が続けて変わる十字キー（設定用） */
export function RepeatDpad({ onUp, onDown, onLeft, onRight, labels }: RepeatDpadProps) {
  const up = useRepeatPress(onUp);
  const down = useRepeatPress(onDown);
  const left = useRepeatPress(onLeft);
  const right = useRepeatPress(onRight);
  return <Dpad handlers={{ up, down, left, right }} labels={labels} />;
}

type ActionButtonProps = {
  letter: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone: "primary" | "secondary";
  /** マウスを乗せたときの説明（省略時は label） */
  tip?: React.ReactNode;
  size?: "md" | "sm";
};

/** 丸い押しボタン（A / B） */
export function ActionButton({ letter, label, onClick, disabled, tone, tip, size = "md" }: ActionButtonProps) {
  const color =
    tone === "primary"
      ? "bg-amber-500 text-amber-950 shadow-[inset_0_-4px_0_rgb(0_0_0/0.25)]"
      : "bg-zinc-700 text-zinc-100 shadow-[inset_0_-4px_0_rgb(0_0_0/0.35)] dark:bg-zinc-600";
  return (
    <Tip text={tip ?? label}>
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={`flex ${size === "md" ? "h-14 w-14 text-lg" : "h-11 w-11 text-base"} select-none items-center justify-center rounded-full font-bold ${color} active:translate-y-px active:shadow-none disabled:cursor-not-allowed disabled:opacity-40`}
      >
        {letter}
      </button>
    </Tip>
  );
}

/** 液晶風の小さな表示窓 */
export function Lcd({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full rounded-md border-2 border-zinc-400 bg-slate-900 px-3 py-2 font-mono text-xs leading-relaxed text-cyan-200 shadow-[inset_0_2px_6px_rgb(0_0_0/0.6)] dark:border-zinc-700">
      {children}
    </div>
  );
}

/** スピーカーの穴 */
export function SpeakerGrille() {
  return (
    <div className="grid grid-cols-4 gap-1.5" aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <span key={i} className="h-1.5 w-1.5 rounded-full bg-zinc-400 dark:bg-zinc-950" />
      ))}
    </div>
  );
}

type ShellProps = {
  left: React.ReactNode;
  right: React.ReactNode;
  /** 画面の中身 */
  children: React.ReactNode;
  /** 画面枠の右上に出す名前 */
  screenLabel: string;
  /** POWER ランプを点けるか */
  power: boolean;
  /** BOLT に接続中か。接続中は本体色を変えて、接続忘れに気づけるようにする */
  connected: boolean;
};

/** 携帯ゲーム機風の本体: 左グリップ・画面・右グリップ */
export function HandheldShell({ left, right, children, screenLabel, power, connected }: ShellProps) {
  // 大きい画面では左右のグリップを画面と同じ高さに伸ばし、液晶を上端・スピーカーを下端に揃える
  const grip = "flex flex-col items-center gap-5 lg:self-stretch lg:justify-between lg:py-6";
  return (
    <div
      data-connected={connected}
      className={`rounded-[2.5rem] p-5 shadow-[0_20px_40px_-20px_rgb(0_0_0/0.5),inset_0_2px_0_rgb(255_255_255/0.6)] ring-1 ring-black/10 lg:p-7 dark:shadow-[0_20px_40px_-20px_rgb(0_0_0/0.9),inset_0_1px_0_rgb(255_255_255/0.08)] ${
        connected
          ? "shell-metal"
          : "bg-gradient-to-b from-zinc-200 to-zinc-300 dark:from-zinc-700 dark:to-zinc-800"
      }`}
    >
      <div className="grid items-center gap-6 lg:grid-cols-[12rem_minmax(0,1fr)_12rem]">
        <div className={`${grip} order-2 lg:order-1`}>
          {left}
          <SpeakerGrille />
        </div>
        <div className="order-1 rounded-2xl bg-zinc-900 p-3 shadow-[inset_0_2px_8px_rgb(0_0_0/0.8)] lg:order-2">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.2em] text-zinc-500">
              <span
                className={`h-2 w-2 rounded-full ${
                  power ? "bg-emerald-400 shadow-[0_0_6px_rgb(52_211_153)]" : "bg-zinc-600"
                }`}
              />
              POWER
            </span>
            <span className="text-[10px] font-semibold tracking-[0.3em] text-zinc-500">{screenLabel}</span>
          </div>
          {children}
        </div>
        <div className={`${grip} order-3`}>
          {right}
          <SpeakerGrille />
        </div>
      </div>
    </div>
  );
}
