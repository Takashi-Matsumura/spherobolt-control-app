"use client";

import { useRef, useState } from "react";
import type { Bolt } from "@/lib/bolt/bolt";
import Autopilot, { type AutopilotStatus } from "./autopilot";
import BoltController from "./bolt-controller";
import CameraView from "./camera-view";

const STATE_STYLE: Record<AutopilotStatus["state"], string> = {
  off: "",
  waiting: "bg-zinc-700/80",
  moving: "bg-emerald-600/85",
  stopped: "bg-red-600/85",
};

const STATE_LABEL: Record<AutopilotStatus["state"], string> = {
  off: "",
  waiting: "判定待ち",
  moving: "走行中",
  stopped: "停止中",
};

/** 「目」（カメラ）と「体」（BOLT）を束ね、自動操縦に両方を渡す */
export default function RobotApp() {
  const boltRef = useRef<Bolt | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [connected, setConnected] = useState(false);
  const [cameraRunning, setCameraRunning] = useState(false);
  const [status, setStatus] = useState<AutopilotStatus>({ state: "off", visible: null, latencyMs: null, reason: "" });

  const overlay =
    status.state === "off" ? null : (
      <div className={`absolute left-3 top-3 rounded-md px-3 py-2 text-sm text-white ${STATE_STYLE[status.state]}`}>
        <div className="font-semibold">
          {STATE_LABEL[status.state]}
          {status.visible !== null && ` ・ BOLT ${(status.visible * 100).toFixed(0)}%`}
          {status.latencyMs !== null && ` ・ ${status.latencyMs}ms`}
        </div>
        <div className="text-xs opacity-90">{status.reason}</div>
      </div>
    );

  return (
    <>
      <CameraView videoRef={videoRef} onRunningChange={setCameraRunning} overlay={overlay} />
      <Autopilot
        boltRef={boltRef}
        videoRef={videoRef}
        connected={connected}
        cameraRunning={cameraRunning}
        onStatus={setStatus}
      />
      <BoltController boltRef={boltRef} onConnectedChange={setConnected} />
    </>
  );
}
