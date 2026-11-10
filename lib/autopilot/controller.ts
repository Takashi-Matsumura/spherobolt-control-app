// 自動操縦の本体: 判定 → 向き合わせ → 走行・引き返し・停止 を繰り返すループ。
// React には依存しない。画面（app/autopilot.tsx）が startAutopilot() で始め、返り値の関数で止める。

import type { Bolt } from "@/lib/bolt/bolt";
import { MatrixPainter } from "@/lib/bolt/matrix";
import { StatusMarks } from "@/lib/bolt/marks";
import {
  type Calibration,
  type Point,
  calibrate,
  center,
  headingFor,
  imageAngle,
  imageDistance,
  isNearEdge,
} from "./geometry";
import {
  type Command,
  type Segment,
  displacement,
  gainFromPulse,
  predictCenter,
  pushSegments,
  segmentsFor,
  updateGain,
} from "./tracker";
import type { AutopilotState, AutopilotStatus } from "./types";
import { FRAME_HEIGHT, FRAME_WIDTH, type Judgment, judgeFrame } from "./vision-client";

/** 判定の間隔の下限（応答が速くてもこれより頻繁には送らない） */
const MIN_INTERVAL_MS = 300;
/** これ以上「写っている」判定が来なければ止める（見張りタイマー） */
const WATCHDOG_MS = 1500;
/** 走行中に向きを変える間隔 */
const TURN_INTERVAL_MS = 2000;
/** 止まっている間も、念のため停止命令を送り直す間隔 */
const STOP_RESEND_MS = 2000;

/** 画面の端からこの割合以内に入ったら、中央へ引き返す */
export const EDGE_MARGIN = 0.2;
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
/** 向き合わせの誤差がこれより大きければ注意を出す（度） */
const CAL_WARN_ERROR = 45;

/** 予測に使う走行命令の履歴を、どれだけ前まで残すか */
const SEGMENT_HISTORY_MS = 3000;
/** 予測のずれをログに出す間隔 */
const ERROR_LOG_MS = 5000;

/** 映像の縦横比（判定に送るコマの大きさで決まる） */
const ASPECT = FRAME_WIDTH / FRAME_HEIGHT;

/** 自動操縦が止まっているときの表示 */
export const OFF_STATUS: AutopilotStatus = {
  state: "off",
  visible: null,
  latencyMs: null,
  reason: "",
  track: null,
  edgeMargin: EDGE_MARGIN,
};

/** ループの中から最新の値を読み書きするための入れ物（React の ref をそのまま渡せる） */
type Ref<T> = { current: T };

export type AutopilotOptions = {
  /** 接続し直すと中身が変わるので、使うたびに最新の接続を読む */
  getBolt: () => Bolt | null;
  getVideo: () => HTMLVideoElement | null;
  /** 走行の速さ（画面で変えられる） */
  speed: Ref<number>;
  /** 「見えている」とみなす確率（画面で変えられる） */
  threshold: Ref<number>;
  /** 向き合わせの結果。null なら、次に見えたときに向き合わせる */
  calibration: Ref<Calibration | null>;
  /** 速度 1 あたり映像の中を 1 ミリ秒に進む距離。向き合わせで初期値を測り、走りながら学び直す */
  gain: Ref<number | null>;
  /** 向き合わせが終わったときに呼ぶ（自動操縦を止めても結果を残すため、保存は画面側で行う） */
  saveCalibration: (c: Calibration, gain: number) => void;
  onStatus: (s: AutopilotStatus) => void;
  log: (msg: string) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 自動操縦を始める。返り値の関数を呼ぶと止まる（BOLT も止め、マトリクスを消す） */
export function startAutopilot(o: AutopilotOptions): () => void {
  const { getBolt, log } = o;

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
  let lastCmd: Command | null = null;
  // 予測のずれの集計（前回の判定から予測した位置と、今回判定した位置の差）
  let errStats = { pred: 0, none: 0, n: 0, since: Date.now() };
  const canvas = document.createElement("canvas");

  // マトリクスに状態のマークを出す。表示に失敗しても走行は続ける（ログは 1 回だけ）
  let matrixFailed = false;
  const marks = new StatusMarks(
    new MatrixPainter(getBolt, (e) => {
      if (matrixFailed) return;
      matrixFailed = true;
      log(`マトリクス表示に失敗しました（走行は続けます）: ${e.message}`);
    }),
  );

  const report = (state: AutopilotState, reason: string) => {
    marks.set(state);
    o.onStatus({
      state,
      visible: last?.visible ?? null,
      latencyMs: last?.latencyMs ?? null,
      reason,
      track: last?.box ? { box: last.box, capturedAt: last.capturedAt, segments: [...segments] } : null,
      edgeMargin: EDGE_MARGIN,
    });
  };

  // ---- 走行命令 ----

  /** 走行命令を予測用の履歴に積む（向き合わせ前は速さが分からないので積まない） */
  const recordCommand = (speed: number, h: number) => {
    const cal = o.calibration.current;
    const gain = o.gain.current;
    const prev = lastCmd;
    const next = { speed, heading: h };
    lastCmd = next;
    if (!cal || gain === null) return;
    const now = Date.now();
    segments = pushSegments(segments, segmentsFor(now, prev, next, cal, gain, ASPECT), now, SEGMENT_HISTORY_MS);
  };

  const stop = (reason: string) => {
    const now = Date.now();
    // 走行中なら必ず送る。止まっている間も、念のためときどき送り直す
    if (moving || now - lastStopSent > STOP_RESEND_MS) {
      if (moving) log(`停止: ${reason}`);
      lastStopSent = now;
      recordCommand(0, heading);
      getBolt()
        ?.stop(heading)
        .catch((e) => log(`停止コマンド失敗: ${(e as Error).message}`));
    }
    moving = false;
    returning = false;
    prevObs = null;
    report("stopped", reason);
  };

  const roll = (h: number) => {
    heading = h;
    moving = true;
    recordCommand(o.speed.current, h);
    getBolt()
      ?.roll(o.speed.current, h)
      .catch((e) => stop(`走行コマンド失敗: ${(e as Error).message}`));
  };

  // 見張りタイマー: 判定が途絶えたら止める（通信が遅れても走り続けないように）
  const watchdog = setInterval(() => {
    if (moving && Date.now() - lastSeen > WATCHDOG_MS) stop(`判定が ${WATCHDOG_MS / 1000} 秒以上届いていません`);
  }, 100);

  // ---- 判定 ----

  const judge = async (): Promise<Judgment> => {
    last = await judgeFrame(o.getVideo(), canvas);
    return last;
  };

  /** 見えていて、位置も当てになるときだけ中心を返す */
  const positionOf = (j: Judgment): Point | null => {
    if (j.visible < o.threshold.current || !j.box) return null;
    if (j.box.confidence !== null && j.box.confidence < MIN_BOX_CONFIDENCE) return null;
    return center(j.box);
  };

  /** 前回の判定から予測した位置と、今回判定した位置のずれを集計し、ときどきログに出す */
  const measureError = (prev: { p: Point; t: number }, cur: { p: Point; t: number }) => {
    const d = displacement(segments, prev.t, cur.t);
    errStats.pred += imageDistance({ x: prev.p.x + d.x, y: prev.p.y + d.y }, cur.p, ASPECT);
    errStats.none += imageDistance(prev.p, cur.p, ASPECT);
    errStats.n += 1;
    const now = Date.now();
    if (now - errStats.since >= ERROR_LOG_MS && errStats.n >= 3) {
      const f = (v: number) => `${((v / errStats.n) * 100).toFixed(1)}%`;
      log(
        `予測のずれ: 平均 ${f(errStats.pred)}（予測なしなら ${f(errStats.none)}）` +
          `、画面の高さに対する割合・${errStats.n} 回分`,
      );
      errStats = { pred: 0, none: 0, n: 0, since: now };
    }
  };

  /** 走りながら、実際の進み方で速さ（gain）を学び直す */
  const learn = (j: Judgment, p: Point) => {
    if (!o.calibration.current || o.gain.current === null) return;
    const obs = { p, t: j.capturedAt };
    if (prevObs) {
      measureError(prevObs, obs);
      o.gain.current = updateGain(o.gain.current, segments, prevObs, obs, ASPECT);
    }
    prevObs = obs;
  };

  // ---- 向き合わせ ----

  const calSpeed = () => Math.max(o.speed.current, CAL_MIN_SPEED);

  /** 決まった時間だけ走って止まり、止まった後の位置を測る */
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

  /** from から to へ動いた距離が、方向を測れるだけあるか確かめる */
  const assertMoved = (from: Point, to: Point): number => {
    const d = imageDistance(from, to, ASPECT);
    if (d < CAL_MIN_DISTANCE) throw new Error(`動きが小さすぎて方向を測れません（${d.toFixed(2)}）`);
    return d;
  };

  /**
   * 向き合わせ: heading 0° と 90° で少しずつ走らせ、映像の中でどちらへ動いたかを測る。
   * 毎回、逆向きに同じだけ走って元の位置へ戻す。
   */
  const runCalibration = async (start: Point) => {
    report("calibrating", "向き合わせ中: 0° に試走");
    log("向き合わせを開始");
    const p0 = await pulseAndMeasure(0);
    const d0 = assertMoved(start, p0);
    const theta0 = imageAngle(start, p0, ASPECT);

    report("calibrating", "向き合わせ中: 元の位置へ戻る");
    const back = await pulseAndMeasure(180);

    report("calibrating", "向き合わせ中: 90° に試走");
    const p90 = await pulseAndMeasure(90);
    const d90 = assertMoved(back, p90);
    const theta90 = imageAngle(back, p90, ASPECT);

    report("calibrating", "向き合わせ中: 元の位置へ戻る");
    await pulseAndMeasure(270);

    const cal = calibrate(theta0, theta90);
    // 試走で進んだ距離から、速度 1 あたりの進み方の初期値を求める
    // 予測と同じ遅れの考え方で割るので、同じ試走を予測するとちょうど同じだけ進む
    const gain = gainFromPulse((d0 + d90) / 2, CAL_PULSE_MS, calSpeed());
    o.calibration.current = cal;
    o.gain.current = gain;
    o.saveCalibration(cal, gain);
    segments = [];
    lastCmd = { speed: 0, heading: 0 };
    log(
      `向き合わせ完了: 0° は映像の ${Math.round(theta0)}° 方向、` +
        `${cal.sign === 1 ? "時計回り" : "反時計回り"}（誤差 ${Math.round(cal.error)}°）`,
    );
    if (cal.error > CAL_WARN_ERROR) log("注意: 誤差が大きいので、引き返しの方向がずれる可能性があります");
  };

  /** まだ向き合わせていなければ試す（失敗したら、しばらく待ってから次を試す） */
  const tryCalibration = async (p: Point) => {
    if (Date.now() - calFailedAt <= CAL_RETRY_MS) return;
    stop("向き合わせの準備");
    try {
      await runCalibration(p);
    } catch (e) {
      calFailedAt = Date.now();
      if (cancelled) return;
      getBolt()
        ?.stop(heading)
        .catch(() => {});
      log(`向き合わせ失敗: ${(e as Error).message}`);
      report("stopped", `向き合わせ失敗: ${(e as Error).message}`);
    }
  };

  // ---- 走行 ----

  /** 現在地 p から、ランダムに走るか中央へ引き返すかを決めて走らせる */
  const drive = (p: Point) => {
    const cal = o.calibration.current!;
    const now = Date.now();
    if (returning && !isNearEdge(p, RETURN_UNTIL_MARGIN)) {
      returning = false;
      log("中央付近に戻りました");
    } else if (!returning && isNearEdge(p, EDGE_MARGIN)) {
      returning = true;
      log("画面の端に近づいたので中央へ引き返します");
    }

    if (returning) {
      // 判定のたびに、現在地から中央への方向に向け直す
      roll(headingFor(imageAngle(p, { x: 0.5, y: 0.5 }, ASPECT), cal));
      report("returning", "画面の端に近いので中央へ戻っています");
      return;
    }
    if (!moving || now - lastTurn > TURN_INTERVAL_MS) {
      lastTurn = now;
      if (!moving) log("走行開始");
      roll(Math.floor(Math.random() * 360));
    }
    report("moving", "BOLT が見えています");
  };

  // ---- ループ ----

  const loop = async () => {
    report("waiting", "最初の判定を待っています");
    while (!cancelled) {
      const started = Date.now();
      try {
        const j = await judge();
        if (cancelled) break;
        const p = positionOf(j);
        if (p) learn(j, p);
        if (!p) {
          stop(
            j.visible < o.threshold.current
              ? `BOLT が見えません（確率 ${(j.visible * 100).toFixed(0)}%）`
              : "BOLT の位置が分かりません",
          );
        } else if (!o.calibration.current) {
          await tryCalibration(p);
          if (cancelled) break;
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
    // 停止命令の後に消す
    marks.dispose();
  };
}
