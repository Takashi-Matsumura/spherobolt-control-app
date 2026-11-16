"use client";

import { useEffect, useRef } from "react";

const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

type Props = {
  /** 1 分走行の終わる時刻（記録していなければ null） */
  deadline: number | null;
  runMs: number;
  /** 自動操縦は動いているが、まだ記録を始めていない（向き合わせ中・BOLT を探している） */
  preparing: boolean;
  reflecting: boolean;
  /** 映像の上に重ねる細い帯として描く */
  compact?: boolean;
};

/**
 * 1 分走行の進み具合。記録中は経過時間の棒を毎フレーム伸ばす（React の再描画は起こさない）。
 * 記録の前後は、今なにを待っているかを文字で出す。
 */
export default function RunProgress({ deadline, runMs, preparing, reflecting, compact = false }: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (deadline === null) return;
    let raf = 0;
    const tick = () => {
      const left = deadline - Date.now();
      const elapsed = Math.min(runMs, runMs - left);
      if (barRef.current) barRef.current.style.width = `${(elapsed / runMs) * 100}%`;
      if (textRef.current) textRef.current.textContent = `${fmtTime(elapsed)} / ${fmtTime(runMs)}`;
      if (left > 0) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [deadline, runMs]);

  if (compact) {
    // 映像の上端に沿った細い帯（記録中だけ）
    if (deadline === null) return null;
    return (
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1.5 bg-black/40">
        <div ref={barRef} className="h-full bg-cyan-400" style={{ width: 0 }} />
      </div>
    );
  }

  const label =
    deadline !== null
      ? "記録中"
      : preparing
        ? "準備中: 走り出したら 1 分の記録を始めます（向き合わせ中・BOLT を探しています）"
        : reflecting
          ? "1 分の走行が終わりました。振り返り中です"
          : null;
  if (!label) return null;
  return (
    <div className="flex items-center gap-3 rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs">
      <span className="shrink-0 font-semibold text-cyan-700 dark:text-cyan-300">{label}</span>
      {deadline !== null && (
        <>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-300 dark:bg-zinc-700">
            <div ref={barRef} className="h-full rounded-full bg-cyan-500" style={{ width: 0 }} />
          </div>
          <span ref={textRef} className="shrink-0 font-mono" />
        </>
      )}
    </div>
  );
}
