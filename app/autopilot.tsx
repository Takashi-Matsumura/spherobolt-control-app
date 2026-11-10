"use client";

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { Bolt } from "@/lib/bolt/bolt";
import {
  type Calibration,
  type Point,
  calibrate,
  center,
  headingFor,
  imageAngle,
  imageDistance,
  isNearEdge,
} from "@/lib/autopilot/geometry";
import { type Segment, predictCenter, segmentFor, updateGain } from "@/lib/autopilot/tracker";
import type { Box, VisionResult } from "./api/vision/route";
import { ActionButton, ChevronIcon, HandheldShell, Lcd, RepeatDpad } from "./handheld/controls";

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

/** 画面の端からこの割合以内に入ったら、中央へ引き返す */
const EDGE_MARGIN = 0.2;
/** 引き返しは、端からこの割合より内側に戻るまで続ける（行ったり来たりを防ぐ） */
const RETURN_UNTIL_MARGIN = 0.35;
/** Box の確信度がこれ未満なら、位置は当てにしない */
const MIN_BOX_CONFIDENCE = 0.3;
/** 向き合わせの 1 回の試走 */
const CAL_PULSE_MS = 800;
const CAL_MIN_SPEED = 35;
/** 試走後、止まりきるまで待つ時間 */
const CAL_SETTLE_MS = 400;
/** 試走で映像の中を最低これだけ動かないと、方向を測れない（高さを 1 とした単位） */
const CAL_MIN_DISTANCE = 0.05;
/** 向き合わせに失敗したら、次に試すまで待つ時間 */
const CAL_RETRY_MS = 3000;

export type AutopilotState = "off" | "waiting" | "calibrating" | "moving" | "returning" | "stopped";

/** 判定した位置と、そこから現在地を予測するための材料 */
export type Track = {
  /** 判定に使ったコマでの BOLT の位置 */
  box: Box;
  /** そのコマを撮った時刻（Date.now()） */
  capturedAt: number;
  /** 走行命令から求めた速度の区間 */
  segments: Segment[];
};

export type AutopilotStatus = {
  state: AutopilotState;
  visible: number | null;
  latencyMs: number | null;
  reason: string;
  track: Track | null;
  edgeMargin: number;
};

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

type Judgment = { visible: number; box: Box | null; latencyMs: number; capturedAt: number };

/** 予測に使う走行命令の履歴を、どれだけ前まで残すか */
const SEGMENT_HISTORY_MS = 3000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  // 速度 1 あたり映像の中を 1 ミリ秒に進む距離。向き合わせで初期値を測り、走りながら学び直す
  const gainRef = useRef<number | null>(null);

  const saveCalibration = useCallback((c: Calibration | null, gain: number | null = null) => {
    const value = c && { ...c, headingEpoch: headingEpochRef.current };
    calibrationRef.current = value;
    gainRef.current = gain;
    setStored(value);
  }, []);

  const addLog = useCallback((msg: string) => {
    const t = new Date().toLocaleTimeString(undefined, { hour12: false });
    setLog((prev) => [`${t} ${msg}`, ...prev].slice(0, 50));
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
      onStatus({ state: "off", visible: null, latencyMs: null, reason: "", track: null, edgeMargin: EDGE_MARGIN });
      return;
    }

    let cancelled = false;
    let moving = false;
    let returning = false;
    let heading = 0;
    let lastSeen = 0;
    let lastTurn = 0;
    let lastStopSent = 0;
    let calFailedAt = 0;
    let last: Judgment | null = null;
    let segments: Segment[] = [];
    let prevObs: { p: Point; t: number } | null = null;
    // 接続し直すと中身が変わるので、使うたびに最新の接続を読む
    const getBolt = () => boltRef.current;
    const canvas = document.createElement("canvas");
    const aspect = FRAME_WIDTH / FRAME_HEIGHT;

    const report = (state: AutopilotState, reason: string) =>
      onStatus({
        state,
        visible: last?.visible ?? null,
        latencyMs: last?.latencyMs ?? null,
        reason,
        track: last?.box ? { box: last.box, capturedAt: last.capturedAt, segments: [...segments] } : null,
        edgeMargin: EDGE_MARGIN,
      });

    /** 走行命令を予測用の履歴に積む（向き合わせ前は速さが分からないので積まない） */
    const recordCommand = (speed: number, h: number) => {
      const cal = calibrationRef.current;
      const gain = gainRef.current;
      if (!cal || gain === null) return;
      const now = Date.now();
      segments.push(segmentFor(now, speed, h, cal, gain, aspect));
      // 古い区間は捨てる（ただし今も続いている区間は残す）
      const cutoff = now - SEGMENT_HISTORY_MS;
      while (segments.length > 1 && segments[1].t < cutoff) segments.shift();
    };

    const stop = (reason: string) => {
      const now = Date.now();
      // 走行中なら必ず送る。止まっている間も、念のため 2 秒おきに送り直す
      if (moving || now - lastStopSent > 2000) {
        if (moving) addLog(`停止: ${reason}`);
        lastStopSent = now;
        recordCommand(0, heading);
        getBolt()
          ?.stop(heading)
          .catch((e) => addLog(`停止コマンド失敗: ${(e as Error).message}`));
      }
      moving = false;
      returning = false;
      prevObs = null;
      report("stopped", reason);
    };

    const roll = (h: number) => {
      heading = h;
      moving = true;
      recordCommand(speedRef.current, h);
      getBolt()
        ?.roll(speedRef.current, h)
        .catch((e) => stop(`走行コマンド失敗: ${(e as Error).message}`));
    };

    // 見張りタイマー: 判定が途絶えたら止める（通信が遅れても走り続けないように）
    const watchdog = setInterval(() => {
      if (moving && Date.now() - lastSeen > WATCHDOG_MS) stop(`判定が ${WATCHDOG_MS / 1000} 秒以上届いていません`);
    }, 100);

    const judge = async (): Promise<Judgment> => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) throw new Error("カメラ映像がありません");
      const capturedAt = Date.now();
      const image = await captureFrame(video, canvas);
      const res = await fetch("/api/vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      const result = (await res.json()) as VisionResult;
      if (!result.ok) throw new Error(result.error);
      last = { visible: result.visible, box: result.box, latencyMs: result.latencyMs, capturedAt };
      return last;
    };

    /** 見えていて、位置も当てになるときだけ中心を返す */
    const positionOf = (j: Judgment): Point | null => {
      if (j.visible < thresholdRef.current || !j.box) return null;
      if (j.box.confidence !== null && j.box.confidence < MIN_BOX_CONFIDENCE) return null;
      return center(j.box);
    };

    /** 決まった時間だけ走って止まり、止まった後の位置を測る */
    const calSpeed = () => Math.max(speedRef.current, CAL_MIN_SPEED);

    const pulseAndMeasure = async (h: number): Promise<Point> => {
      const bolt = getBolt();
      if (!bolt) throw new Error("BOLT が接続されていません");
      await bolt.roll(calSpeed(), h);
      await sleep(CAL_PULSE_MS);
      await bolt.stop(h);
      await sleep(CAL_SETTLE_MS);
      if (cancelled) throw new Error("中断しました");
      const p = positionOf(await judge());
      if (!p) throw new Error("試走のあと BOLT を見失いました");
      return p;
    };

    /**
     * 向き合わせ: heading 0° と 90° で少しずつ走らせ、映像の中でどちらへ動いたかを測る。
     * 毎回、逆向きに同じだけ走って元の位置へ戻す。
     */
    const runCalibration = async (start: Point) => {
      report("calibrating", "向き合わせ中: 0° に試走");
      addLog("向き合わせを開始");
      const p0 = await pulseAndMeasure(0);
      const d0 = imageDistance(start, p0, aspect);
      if (d0 < CAL_MIN_DISTANCE) throw new Error(`動きが小さすぎて方向を測れません（${d0.toFixed(2)}）`);
      const theta0 = imageAngle(start, p0, aspect);

      report("calibrating", "向き合わせ中: 元の位置へ戻る");
      const back = await pulseAndMeasure(180);

      report("calibrating", "向き合わせ中: 90° に試走");
      const p90 = await pulseAndMeasure(90);
      const d90 = imageDistance(back, p90, aspect);
      if (d90 < CAL_MIN_DISTANCE) throw new Error(`動きが小さすぎて方向を測れません（${d90.toFixed(2)}）`);
      const theta90 = imageAngle(back, p90, aspect);

      report("calibrating", "向き合わせ中: 元の位置へ戻る");
      await pulseAndMeasure(270);

      const cal = calibrate(theta0, theta90);
      // 試走で進んだ距離から、速度 1 あたりの進み方の初期値を求める（加速・減速を含むので少なめに出る）
      const gain = (d0 + d90) / 2 / CAL_PULSE_MS / calSpeed();
      saveCalibration(cal, gain);
      segments = [];
      addLog(
        `向き合わせ完了: 0° は映像の ${Math.round(theta0)}° 方向、` +
          `${cal.sign === 1 ? "時計回り" : "反時計回り"}（誤差 ${Math.round(cal.error)}°）`,
      );
      if (cal.error > 45) addLog("注意: 誤差が大きいので、引き返しの方向がずれる可能性があります");
    };

    const drive = (p: Point) => {
      const cal = calibrationRef.current!;
      const now = Date.now();
      if (returning && !isNearEdge(p, RETURN_UNTIL_MARGIN)) {
        returning = false;
        addLog("中央付近に戻りました");
      } else if (!returning && isNearEdge(p, EDGE_MARGIN)) {
        returning = true;
        addLog("画面の端に近づいたので中央へ引き返します");
      }

      if (returning) {
        // 判定のたびに、現在地から中央への方向に向け直す
        roll(headingFor(imageAngle(p, { x: 0.5, y: 0.5 }, aspect), cal));
        report("returning", "画面の端に近いので中央へ戻っています");
        return;
      }
      if (!moving || now - lastTurn > TURN_INTERVAL_MS) {
        lastTurn = now;
        if (!moving) addLog("走行開始");
        roll(Math.floor(Math.random() * 360));
      }
      report("moving", "BOLT が見えています");
    };

    const loop = async () => {
      report("waiting", "最初の判定を待っています");
      while (!cancelled) {
        const started = Date.now();
        try {
          const j = await judge();
          if (cancelled) break;
          const p = positionOf(j);
          if (p && calibrationRef.current && gainRef.current !== null) {
            // 走りながら、実際の進み方で速さを学び直す
            const obs = { p, t: j.capturedAt };
            if (prevObs) gainRef.current = updateGain(gainRef.current, segments, prevObs, obs, aspect);
            prevObs = obs;
          }
          if (!p) {
            stop(
              j.visible < thresholdRef.current
                ? `BOLT が見えません（確率 ${(j.visible * 100).toFixed(0)}%）`
                : "BOLT の位置が分かりません",
            );
          } else if (!calibrationRef.current) {
            if (Date.now() - calFailedAt > CAL_RETRY_MS) {
              stop("向き合わせの準備");
              try {
                await runCalibration(p);
              } catch (e) {
                calFailedAt = Date.now();
                if (cancelled) break;
                getBolt()
                  ?.stop(heading)
                  .catch(() => {});
                addLog(`向き合わせ失敗: ${(e as Error).message}`);
                report("stopped", `向き合わせ失敗: ${(e as Error).message}`);
              }
            }
          } else {
            lastSeen = Date.now();
            // 判定は撮った時点の位置なので、そこから今までに進んだ分を足した現在地で判断する
            drive(predictCenter(j.box!, j.capturedAt, Date.now(), segments));
          }
        } catch (e) {
          if (cancelled) break;
          stop(`判定エラー: ${(e as Error).message}`);
          await sleep(1000); // エラー時は少し待ってから再試行
        }
        const wait = MIN_INTERVAL_MS - (Date.now() - started);
        if (wait > 0) await sleep(wait);
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
  }, [enabled, boltRef, videoRef, onStatus, addLog, saveCalibration]);

  const SPEED_MIN = 10;
  const SPEED_MAX = 100;
  const adjustSpeed = useCallback(
    (d: number) => setSpeed((v) => Math.min(SPEED_MAX, Math.max(SPEED_MIN, v + d))),
    [],
  );
  // 0.05 刻みの小数は誤差が溜まるので、100 倍した整数で計算する
  const adjustThreshold = useCallback(
    (d: number) => setThreshold((v) => Math.min(95, Math.max(50, Math.round(v * 100) + d)) / 100),
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
      const t = e.target as HTMLElement;
      if (t.closest("input, select, textarea")) return;
      const map: Record<string, () => void> = {
        ArrowUp: () => adjustSpeed(5),
        ArrowDown: () => adjustSpeed(-5),
        ArrowRight: () => adjustThreshold(5),
        ArrowLeft: () => adjustThreshold(-5),
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
        screenLabel="BOLT PILOT · JEV VISION"
        left={
          <>
            <Lcd>
              <div className="flex justify-between">
                <span>AUTO</span>
                <span className={enabled ? "text-emerald-300" : "text-zinc-500"}>{enabled ? "ON" : "OFF"}</span>
              </div>
              <div className="flex justify-between">
                <span>CAL</span>
                <span className={calibration ? "text-emerald-300" : "text-amber-300"}>
                  {calibration ? `±${Math.round(calibration.error)}°` : "----"}
                </span>
              </div>
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
              <div className="flex justify-between">
                <span className="flex items-center gap-1.5">
                  <span className="flex" aria-hidden>
                    <ChevronIcon dir="up" className="h-3.5 w-3.5" />
                    <ChevronIcon dir="down" className="h-3.5 w-3.5" />
                  </span>
                  SPEED
                </span>
                <span>{speed}</span>
              </div>
              <div className="flex justify-between">
                <span className="flex items-center gap-1.5">
                  <span className="flex" aria-hidden>
                    <ChevronIcon dir="left" className="h-3.5 w-3.5" />
                    <ChevronIcon dir="right" className="h-3.5 w-3.5" />
                  </span>
                  CONF
                </span>
                <span>{(threshold * 100).toFixed(0)}%</span>
              </div>
            </Lcd>
            <RepeatDpad
              onUp={() => adjustSpeed(5)}
              onDown={() => adjustSpeed(-5)}
              onRight={() => adjustThreshold(5)}
              onLeft={() => adjustThreshold(-5)}
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
