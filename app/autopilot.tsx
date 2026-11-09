"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { Bolt } from "@/lib/bolt/bolt";
import type { VisionResult } from "./api/vision/route";

// 送る画像の大きさ。Jev の制限（各辺 280〜1568px）に収まり、通信量も小さい
const FRAME_WIDTH = 640;
const FRAME_HEIGHT = 360;
const JPEG_QUALITY = 0.7;
/** 判定の間隔の下限（応答が速くてもこれより頻繁には送らない） */
const MIN_INTERVAL_MS = 300;
/** これ以上「写っている」判定が来なければ止める（見張りタイマー） */
const WATCHDOG_MS = 1500;
/** 走行中に向きを変える間隔 */
const TURN_INTERVAL_MS = 2000;

export type AutopilotState = "off" | "moving" | "stopped" | "waiting";

export type AutopilotStatus = {
  state: AutopilotState;
  visible: number | null;
  latencyMs: number | null;
  reason: string;
};

type Props = {
  boltRef: RefObject<Bolt | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  connected: boolean;
  cameraRunning: boolean;
  onStatus: (s: AutopilotStatus) => void;
};

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

export default function Autopilot({ boltRef, videoRef, connected, cameraRunning, onStatus }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [speed, setSpeed] = useState(40);
  const [threshold, setThreshold] = useState(0.7);
  const [log, setLog] = useState<string[]>([]);

  // ループの中から最新の設定値を読むための参照
  const speedRef = useRef(speed);
  const thresholdRef = useRef(threshold);
  useEffect(() => {
    speedRef.current = speed;
    thresholdRef.current = threshold;
  }, [speed, threshold]);

  const addLog = useCallback((msg: string) => {
    const t = new Date().toLocaleTimeString(undefined, { hour12: false });
    setLog((prev) => [`${t} ${msg}`, ...prev].slice(0, 50));
  }, []);

  const ready = connected && cameraRunning;

  // 準備が崩れたら（切断・カメラ停止）自動操縦を解除する
  useEffect(() => {
    if (!ready && enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEnabled(false);
      addLog("BOLT かカメラが止まったので自動操縦を解除しました");
    }
  }, [ready, enabled, addLog]);

  useEffect(() => {
    if (!enabled) {
      onStatus({ state: "off", visible: null, latencyMs: null, reason: "" });
      return;
    }

    let cancelled = false;
    let moving = false;
    let heading = 0;
    let lastSeen = 0;
    let lastTurn = 0;
    let lastStopSent = 0;
    let visible: number | null = null;
    // 接続し直すと中身が変わるので、使うたびに最新の接続を読む
    const getBolt = () => boltRef.current;
    let latencyMs: number | null = null;
    const canvas = document.createElement("canvas");

    const report = (state: AutopilotState, reason: string) => onStatus({ state, visible, latencyMs, reason });

    const stop = (reason: string) => {
      const now = Date.now();
      // 走行中なら必ず送る。止まっている間も、念のため 2 秒おきに送り直す
      if (moving || now - lastStopSent > 2000) {
        if (moving) addLog(`停止: ${reason}`);
        lastStopSent = now;
        getBolt()
          ?.stop(heading)
          .catch((e) => addLog(`停止コマンド失敗: ${(e as Error).message}`));
      }
      moving = false;
      report("stopped", reason);
    };

    const move = () => {
      const now = Date.now();
      if (!moving || now - lastTurn > TURN_INTERVAL_MS) {
        heading = Math.floor(Math.random() * 360);
        lastTurn = now;
        if (!moving) addLog(`走行開始（向き ${heading}°）`);
        moving = true;
        getBolt()
          ?.roll(speedRef.current, heading)
          .catch((e) => stop(`走行コマンド失敗: ${(e as Error).message}`));
      }
      report("moving", "BOLT が見えています");
    };

    // 見張りタイマー: 判定が途絶えたら止める（通信が遅れても走り続けないように）
    const watchdog = setInterval(() => {
      if (moving && Date.now() - lastSeen > WATCHDOG_MS) stop(`判定が ${WATCHDOG_MS / 1000} 秒以上届いていません`);
    }, 100);

    const loop = async () => {
      report("waiting", "最初の判定を待っています");
      while (!cancelled) {
        const started = Date.now();
        const video = videoRef.current;
        try {
          if (!video || video.readyState < 2) throw new Error("カメラ映像がありません");
          const image = await captureFrame(video, canvas);
          const res = await fetch("/api/vision", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image }),
          });
          const result = (await res.json()) as VisionResult;
          if (cancelled) break;
          if (!result.ok) throw new Error(result.error);

          visible = result.visible;
          latencyMs = result.latencyMs;
          if (result.visible >= thresholdRef.current) {
            lastSeen = Date.now();
            move();
          } else {
            stop(`BOLT が見えません（確率 ${(result.visible * 100).toFixed(0)}%）`);
          }
        } catch (e) {
          if (cancelled) break;
          stop(`判定エラー: ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, 1000)); // エラー時は少し待ってから再試行
        }
        const wait = MIN_INTERVAL_MS - (Date.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    };
    void loop();

    return () => {
      cancelled = true;
      clearInterval(watchdog);
      getBolt()
        ?.stop(heading)
        .catch(() => {});
    };
  }, [enabled, boltRef, videoRef, onStatus, addLog]);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700">
      <h2 className="font-semibold">自動操縦（Jev）</h2>
      <p className="text-sm text-zinc-500">
        カメラに BOLT が写っている間だけ、ランダムな向きに走ります。見えなくなったら止まります。
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          className={enabled ? "btn" : "btn btn-primary"}
          disabled={!ready}
          onClick={() => {
            setEnabled((v) => !v);
            addLog(enabled ? "自動操縦を解除" : "自動操縦を開始");
          }}
        >
          {enabled ? "自動操縦を止める" : "自動操縦を開始"}
        </button>
        {!ready && <span className="text-sm text-zinc-500">BOLT への接続とカメラの開始が必要です</span>}
      </div>
      <label className="flex items-center gap-3 text-sm">
        速度 {speed}
        <input
          type="range"
          min={10}
          max={100}
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="flex-1"
        />
      </label>
      <label className="flex items-center gap-3 text-sm">
        「見えている」とみなす確率 {(threshold * 100).toFixed(0)}%
        <input
          type="range"
          min={0.5}
          max={0.95}
          step={0.05}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="flex-1"
        />
      </label>
      <p className="text-xs text-zinc-500">
        判定の遅れの分だけ進んでしまうため、速度は低めにしてください。止まる側に倒す設計で、通信エラーや判定の途絶でも停止します。
      </p>
      <pre className="h-32 overflow-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
        {log.join("\n") || "（まだありません）"}
      </pre>
    </section>
  );
}
