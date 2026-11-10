"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { PowerIcon, Tip } from "./handheld/controls";

// macOS の連係カメラでは、iPhone は「<名前>のカメラ」「iPhone Camera」などのラベルで見える
const isIPhone = (d: MediaDeviceInfo) => /iphone/i.test(d.label);

type Props = {
  /** 自動操縦がフレームを取り出せるように親が持つ */
  videoRef: RefObject<HTMLVideoElement | null>;
  onRunningChange: (running: boolean) => void;
  /** 映像の上に重ねて表示するもの（自動操縦の状態など） */
  overlay?: React.ReactNode;
};

export default function CameraView({ videoRef, onRunningChange, overlay }: Props) {
  const streamRef = useRef<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [resolution, setResolution] = useState("");

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setRunning(false);
    setResolution("");
  }, [videoRef]);

  const listCameras = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    const cams = all.filter((d) => d.kind === "videoinput");
    setDevices(cams);
    return cams;
  }, []);

  const start = useCallback(
    async (id?: string) => {
      setError("");
      stop();
      try {
        let stream = await navigator.mediaDevices.getUserMedia({
          video: id
            ? { deviceId: { exact: id }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });

        // カメラのラベルは許可を得た後でないと取れないため、許可後に一覧を取り直す。
        // 機種を指定せずに始めた場合は、iPhone があればそちらに切り替える。
        const cams = await listCameras();
        const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
        const iphone = cams.find(isIPhone);
        if (!id && iphone && iphone.deviceId !== current) {
          stream.getTracks().forEach((t) => t.stop());
          stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: iphone.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
        }

        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const s = track.getSettings();
        setDeviceId(s.deviceId ?? "");
        setResolution(s.width && s.height ? `${s.width}×${s.height}` : "");
        track.addEventListener("ended", () => {
          setError("カメラが切断されました（iPhone のケーブルや連係カメラの状態を確認してください）");
          stop();
        });
        if (videoRef.current) videoRef.current.srcObject = stream;
        setRunning(true);
      } catch (e) {
        const err = e as DOMException;
        setError(
          err.name === "NotAllowedError"
            ? "カメラの使用が許可されませんでした。アドレスバーのカメラアイコンから許可してください。"
            : err.name === "NotFoundError" || err.name === "OverconstrainedError"
              ? "カメラが見つかりません。iPhone が接続され、ロックが解除されているか確認してください。"
              : `カメラを開始できません: ${err.message}`,
        );
      }
    },
    [listCameras, stop, videoRef],
  );

  useEffect(() => {
    onRunningChange(running);
  }, [running, onRunningChange]);

  useEffect(() => {
    const onChange = () => void listCameras();
    navigator.mediaDevices?.addEventListener("devicechange", onChange);
    return () => {
      navigator.mediaDevices?.removeEventListener("devicechange", onChange);
      stop();
    };
  }, [listCameras, stop]);

  const pill =
    "rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 shadow-[inset_0_-2px_0_rgb(0_0_0/0.4)] " +
    "hover:bg-zinc-700 active:translate-y-px disabled:opacity-40";

  return (
    <section className="flex flex-col gap-2">
      {/* 画面 */}
      <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
        <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-contain" />
        {running && overlay}
        {!running && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-zinc-400">
            <p className="text-sm">カメラは停止中です</p>
          </div>
        )}
      </div>
      {/* 画面の下の小さなボタン列 */}
      <div className="flex flex-wrap items-center gap-2">
        <Tip
          text={
            running
              ? "電源を切る（カメラを止める）"
              : "電源を入れる（カメラを開始）\niPhone が見つかれば自動で選びます。iPhone のロックを解除し、Mac と同じ Apple アカウントでサインインしておいてください（macOS の連係カメラ）。"
          }
        >
          <button
            aria-label={running ? "カメラを止める" : "カメラを開始"}
            aria-pressed={running}
            onClick={running ? stop : () => start(deviceId || undefined)}
            className={`flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800 shadow-[inset_0_-2px_0_rgb(0_0_0/0.4)] hover:bg-zinc-700 active:translate-y-px ${
              running ? "text-emerald-400 drop-shadow-[0_0_4px_rgb(52_211_153)]" : "text-zinc-400"
            }`}
          >
            <PowerIcon />
          </button>
        </Tip>
        {devices.length > 0 && (
          <select
            className={`${pill} max-w-[14rem] truncate`}
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value);
              if (running) void start(e.target.value);
            }}
          >
            {devices.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `カメラ ${i + 1}`}
              </option>
            ))}
          </select>
        )}
        {resolution && <span className="font-mono text-xs text-zinc-500">{resolution}</span>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </section>
  );
}
