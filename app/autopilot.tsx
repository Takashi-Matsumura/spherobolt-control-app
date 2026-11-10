"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { Bolt } from "@/lib/bolt/bolt";
import { OFF_STATUS, startAutopilot } from "@/lib/autopilot/controller";
import type { Calibration } from "@/lib/autopilot/geometry";
import type { AutopilotStatus } from "@/lib/autopilot/types";
import {
  ActionButton,
  ChevronIcon,
  HandheldShell,
  Lcd,
  LcdRow,
  RepeatDpad,
  isTypingTarget,
} from "./handheld/controls";

const SPEED_MIN = 10;
const SPEED_MAX = 100;
const SPEED_STEP = 5;
/** 「見えている」とみなす確率の範囲（%） */
const THRESHOLD_MIN = 50;
const THRESHOLD_MAX = 95;
const THRESHOLD_STEP = 5;
const LOG_LINES = 50;

type Props = {
  boltRef: RefObject<Bolt | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  connected: boolean;
  cameraRunning: boolean;
  /** 自動操縦の画面が表示されているか */
  active: boolean;
  /** BOLT の向きの基準が変わるたびに増える番号。向き合わせの有効性の判定に使う */
  headingEpoch: number;
  onStatus: (s: AutopilotStatus) => void;
  /** 中央に置くカメラ映像 */
  children: React.ReactNode;
};

type StoredCalibration = Calibration & { headingEpoch: number };

/** 液晶の項目名の前に出す、十字キーの向き */
function DpadHint({ dirs, children }: { dirs: ["up", "down"] | ["left", "right"]; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex" aria-hidden>
        {dirs.map((d) => (
          <ChevronIcon key={d} dir={d} className="h-3.5 w-3.5" />
        ))}
      </span>
      {children}
    </span>
  );
}

/** 自動操縦の画面の操作部（ゲーム機の本体）とログ。走らせる処理は lib/autopilot/controller.ts */
export default function Autopilot({
  boltRef,
  videoRef,
  connected,
  cameraRunning,
  active,
  headingEpoch,
  onStatus,
  children,
}: Props) {
  const [enabled, setEnabled] = useState(false);
  const [speed, setSpeed] = useState(40);
  const [threshold, setThreshold] = useState(0.7);
  const [log, setLog] = useState<string[]>([]);
  const [stored, setStored] = useState<StoredCalibration | null>(null);
  // 向きの基準が変わる前に測った結果は使わない
  const calibration = stored?.headingEpoch === headingEpoch ? stored : null;

  // ループの中から最新の値を読むための参照
  const speedRef = useRef(speed);
  const thresholdRef = useRef(threshold);
  const calibrationRef = useRef<Calibration | null>(null);
  const headingEpochRef = useRef(headingEpoch);
  useEffect(() => {
    speedRef.current = speed;
    thresholdRef.current = threshold;
    calibrationRef.current = calibration;
    headingEpochRef.current = headingEpoch;
  }, [speed, threshold, calibration, headingEpoch]);

  // 速度 1 あたり映像の中を 1 ミリ秒に進む距離。向き合わせで初期値を測り、走りながら学び直す。
  // 自動操縦を止めても残すため、ここで持つ
  const gainRef = useRef<number | null>(null);

  const saveCalibration = useCallback((c: Calibration | null, gain: number | null = null) => {
    const value = c && { ...c, headingEpoch: headingEpochRef.current };
    calibrationRef.current = value;
    gainRef.current = gain;
    setStored(value);
  }, []);

  const addLog = useCallback((msg: string) => {
    const t = new Date().toLocaleTimeString(undefined, { hour12: false });
    setLog((prev) => [`${t} ${msg}`, ...prev].slice(0, LOG_LINES));
  }, []);

  const ready = connected && cameraRunning && active;

  // 準備が崩れたら（切断・カメラ停止）自動操縦を解除する
  useEffect(() => {
    if (!ready && enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEnabled(false);
      addLog(active ? "BOLT かカメラが止まったので自動操縦を解除しました" : "画面を切り替えたので自動操縦を解除しました");
    }
  }, [ready, enabled, active, addLog]);

  useEffect(() => {
    if (!enabled) {
      onStatus(OFF_STATUS);
      return;
    }
    return startAutopilot({
      getBolt: () => boltRef.current,
      getVideo: () => videoRef.current,
      speed: speedRef,
      threshold: thresholdRef,
      calibration: calibrationRef,
      gain: gainRef,
      saveCalibration,
      onStatus,
      log: addLog,
    });
  }, [enabled, boltRef, videoRef, onStatus, addLog, saveCalibration]);

  const adjustSpeed = useCallback(
    (d: number) => setSpeed((v) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, v + d))),
    [],
  );
  // 0.05 刻みの小数は誤差が溜まるので、100 倍した整数で計算する
  const adjustThreshold = useCallback(
    (d: number) =>
      setThreshold((v) => Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, Math.round(v * 100) + d)) / 100),
    [],
  );

  const toggle = useCallback(() => {
    addLog(enabled ? "自動操縦を解除" : "自動操縦を開始");
    setEnabled(!enabled);
  }, [enabled, addLog]);

  // キーボード: 矢印キー = 十字キー、Esc = 自動操縦を止める（自動操縦の画面が表示されている間だけ）
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      const map: Record<string, () => void> = {
        ArrowUp: () => adjustSpeed(SPEED_STEP),
        ArrowDown: () => adjustSpeed(-SPEED_STEP),
        ArrowRight: () => adjustThreshold(THRESHOLD_STEP),
        ArrowLeft: () => adjustThreshold(-THRESHOLD_STEP),
        Escape: () => {
          if (enabled) addLog("Esc キーで自動操縦を解除");
          setEnabled(false);
        },
      };
      const fn = map[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, enabled, addLog, adjustSpeed, adjustThreshold]);

  return (
    <div className="flex flex-col gap-4">
      {/* 本体 */}
      <HandheldShell
        power={enabled}
        connected={connected}
        screenLabel="BOLT PILOT · JEV VISION"
        left={
          <>
            <Lcd>
              <LcdRow label={<span>AUTO</span>}>
                <span className={enabled ? "text-emerald-300" : "text-zinc-500"}>{enabled ? "ON" : "OFF"}</span>
              </LcdRow>
              <LcdRow label={<span>CAL</span>}>
                <span className={calibration ? "text-emerald-300" : "text-amber-300"}>
                  {calibration ? `±${Math.round(calibration.error)}°` : "----"}
                </span>
              </LcdRow>
            </Lcd>
            <div className="flex items-end gap-5">
              <div className="translate-y-4">
                <ActionButton
                  letter="B"
                  label="向き合わせ やり直し"
                  tip={calibration ? "向き合わせをやり直す\n（次に見えたときに測り直します）" : "向き合わせ やり直し\n（まだ向き合わせていません）"}
                  tone="secondary"
                  disabled={!calibration}
                  onClick={() => {
                    saveCalibration(null);
                    addLog("向き合わせをリセットしました（次に見えたときにやり直します）");
                  }}
                />
              </div>
              <ActionButton
                letter="A"
                label={enabled ? "自動操縦を止める" : "自動操縦を開始"}
                tone="primary"
                disabled={!ready && !enabled}
                tip={
                  enabled
                    ? "自動操縦を止める（Esc キーでも止められます）"
                    : ready
                      ? "自動操縦を開始"
                      : "自動操縦を開始\nBOLT への接続とカメラの開始が必要です"
                }
                onClick={toggle}
              />
            </div>
          </>
        }
        right={
          <>
            <Lcd>
              <LcdRow label={<DpadHint dirs={["up", "down"]}>SPEED</DpadHint>}>
                <span>{speed}</span>
              </LcdRow>
              <LcdRow label={<DpadHint dirs={["left", "right"]}>CONF</DpadHint>}>
                <span>{(threshold * 100).toFixed(0)}%</span>
              </LcdRow>
            </Lcd>
            <RepeatDpad
              onUp={() => adjustSpeed(SPEED_STEP)}
              onDown={() => adjustSpeed(-SPEED_STEP)}
              onRight={() => adjustThreshold(THRESHOLD_STEP)}
              onLeft={() => adjustThreshold(-THRESHOLD_STEP)}
              labels={{
                up: "速度を上げる（低めがおすすめ）",
                down: "速度を下げる（低めがおすすめ）",
                right: "「見えている」とみなす確率を上げる",
                left: "「見えている」とみなす確率を下げる",
              }}
            />
          </>
        }
      >
        {children}
      </HandheldShell>

      {/* 本体の下: ログと説明 */}
      <details className="rounded-lg border border-zinc-300 p-3 dark:border-zinc-700" open>
        <summary className="cursor-pointer text-sm font-semibold">自動操縦のログ</summary>
        <p className="mt-2 text-xs text-zinc-500">
          BOLT が写っている間だけランダムに走り、画面の端（点線）に近づくと中央へ引き返します。見えなくなったとき、
          エラーや判定の途絶でも止まります。最初に少しずつ走らせて、映像の中の方向と BOLT の向きを対応づけます（向き合わせ）。
        </p>
        <pre className="mt-2 h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-100 p-2 text-xs dark:bg-zinc-900">
          {log.join("\n") || "（まだありません）"}
        </pre>
      </details>
    </div>
  );
}
