"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { predictBox } from "@/lib/autopilot/tracker";
import type { Bolt } from "@/lib/bolt/bolt";
import Autopilot, { type AutopilotStatus, type Track } from "./autopilot";
import CameraView from "./camera-view";

const STATE_STYLE: Record<AutopilotStatus["state"], string> = {
  off: "",
  waiting: "bg-zinc-700/80",
  calibrating: "bg-sky-600/85",
  moving: "bg-emerald-600/85",
  returning: "bg-amber-600/85",
  stopped: "bg-red-600/85",
};

const STATE_LABEL: Record<AutopilotStatus["state"], string> = {
  off: "",
  waiting: "判定待ち",
  calibrating: "向き合わせ中",
  moving: "走行中",
  returning: "引き返し中",
  stopped: "停止中",
};

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * 予測した現在地の枠。判定を待たずに毎フレーム動かす。
 * 60fps で React の再描画を起こさないよう、要素の位置を直接書き換える。
 */
function PredictedBox({ track }: { track: Track }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = ref.current;
      if (el) {
        const b = predictBox(track.box, track.capturedAt, Date.now(), track.segments);
        el.style.left = pct(b.left);
        el.style.top = pct(b.top);
        el.style.width = pct(b.right - b.left);
        el.style.height = pct(b.bottom - b.top);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [track]);
  return <div ref={ref} className="pointer-events-none absolute border-2 border-emerald-400" />;
}

type Props = {
  boltRef: RefObject<Bolt | null>;
  connected: boolean;
  /** この画面が表示されているか。隠れたら自動操縦を解除する */
  active: boolean;
  headingEpoch: number;
};

/** 自動操縦の画面: 目（カメラ）と自動操縦 */
export default function AutopilotTab({ boltRef, connected, active, headingEpoch }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraRunning, setCameraRunning] = useState(false);
  const [status, setStatus] = useState<AutopilotStatus>({
    state: "off",
    visible: null,
    latencyMs: null,
    reason: "",
    track: null,
    edgeMargin: 0.2,
  });

  const track = status.track;
  const showBox = track && status.visible !== null && status.visible >= 0.5;
  const m = status.edgeMargin;
  const overlay =
    status.state === "off" ? null : (
      <>
        {/* この線より外側に入ると引き返す */}
        <div
          className="pointer-events-none absolute border border-dashed border-white/50"
          style={{ left: pct(m), top: pct(m), right: pct(m), bottom: pct(m) }}
        />
        {showBox && (
          <>
            {/* Jev が判定したときの位置（少し前のコマ） */}
            <div
              className="pointer-events-none absolute border border-dashed border-emerald-300/60"
              style={{
                left: pct(track.box.left),
                top: pct(track.box.top),
                width: pct(track.box.right - track.box.left),
                height: pct(track.box.bottom - track.box.top),
              }}
            />
            {/* そこから今までに進んだ分を足した、現在地の予測 */}
            <PredictedBox track={track} />
            <div className="pointer-events-none absolute bottom-2 left-3 flex gap-3 rounded bg-black/50 px-2 py-1 text-[10px] text-zinc-200">
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-3.5 border-2 border-emerald-400" />
                現在地（予測）
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-2.5 w-3.5 border border-dashed border-emerald-300/80" />
                判定したときの位置
              </span>
            </div>
          </>
        )}
        <div className={`absolute left-3 top-3 rounded-md px-3 py-2 text-sm text-white ${STATE_STYLE[status.state]}`}>
          <div className="font-semibold">
            {STATE_LABEL[status.state]}
            {status.visible !== null && ` ・ BOLT ${(status.visible * 100).toFixed(0)}%`}
            {status.latencyMs !== null && ` ・ ${status.latencyMs}ms`}
          </div>
          <div className="text-xs opacity-90">{status.reason}</div>
        </div>
      </>
    );

  return (
    <Autopilot
      boltRef={boltRef}
      videoRef={videoRef}
      connected={connected}
      cameraRunning={cameraRunning}
      active={active}
      headingEpoch={headingEpoch}
      onStatus={setStatus}
    >
      <CameraView videoRef={videoRef} onRunningChange={setCameraRunning} overlay={overlay} />
    </Autopilot>
  );
}
