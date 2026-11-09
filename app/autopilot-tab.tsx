"use client";

import { type RefObject, useRef, useState } from "react";
import type { Bolt } from "@/lib/bolt/bolt";
import Autopilot, { type AutopilotStatus } from "./autopilot";
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
    box: null,
    edgeMargin: 0.2,
  });

  const box = status.box;
  const showBox = box && status.visible !== null && status.visible >= 0.5;
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
          <div
            className="pointer-events-none absolute border-2 border-emerald-400"
            style={{
              left: pct(box.left),
              top: pct(box.top),
              width: pct(box.right - box.left),
              height: pct(box.bottom - box.top),
            }}
          />
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
