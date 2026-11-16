"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type Episode, metricsOf } from "@/lib/sim/episode";
import {
  EMPTY_NOTEBOOK,
  type Notebook,
  addReflection,
  loadNotebook,
  saveNotebook,
  undoReflection,
} from "@/lib/sim/notebook";
import type { ReflectRequest, ReflectResponse, Reflection } from "@/lib/sim/reflection";
import type { AutopilotState } from "@/lib/autopilot/types";
import type { SimWorld } from "@/lib/sim/world";
import type { LearningStatus } from "./learning-panel";

/** シミュレーションの 1 回の走行の長さ。毎回同じ長さにして、走行どうしを比べやすくする */
export const RUN_MS = 60_000;
/** 記録を始める状態（向き合わせや判定待ちの時間は、走行の長さに数えない） */
const DRIVING_STATES: AutopilotState[] = ["moving", "returning", "avoiding"];
/** 振り返りに渡す、過去の振り返りの数 */
const HISTORY_FOR_PROMPT = 5;

/**
 * 走行記録 → 振り返り → 回避の基準の更新 を受け持つ。
 *
 * シミュレーション中に自動操縦が走り始めたら（noteState で走行中の状態が来たら）記録を始め、
 * RUN_MS たったら stopAutopilot で自動操縦を止めて振り返る。途中で止めた走行は長さが揃わないので振り返らない。
 */
export function useLearning(world: SimWorld, simOnRef: { current: boolean }, stopAutopilot: () => void) {
  const [notebook, setNotebook] = useState<Notebook>(EMPTY_NOTEBOOK);
  const [status, setStatus] = useState<LearningStatus>({ kind: "idle" });
  const notebookRef = useRef(notebook);
  /** 1 分走行の終わる時刻（記録していなければ null）。画面の残り時間の表示にも使う */
  const [deadline, setDeadline] = useState<number | null>(null);
  const deadlineRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const completedRef = useRef(false);

  /** 記録を差し替える: 回避の基準を世界に反映し、save なら保存もする */
  const commit = useCallback(
    (next: Notebook, save = true) => {
      notebookRef.current = next;
      world.setPolicy(next.policy);
      if (save) saveNotebook(next);
      setNotebook(next);
    },
    [world],
  );

  // 保存した記録はブラウザにしか無いので、表示が始まってから読む
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    commit(loadNotebook(), false);
  }, [commit]);

  const reflect = useCallback(
    async (episode: Episode) => {
      const nb = notebookRef.current;
      const m = metricsOf(episode);
      setStatus({
        kind: "reflecting",
        message: `振り返り中…（${m.durationS} 秒の走行で接触 ${m.contacts} 回。ローカルの AI が考えています。30 秒〜1 分ほどかかります）`,
      });
      const body: ReflectRequest = {
        episode,
        criteria: nb.criteria,
        history: nb.history.slice(0, HISTORY_FOR_PROMPT).map(({ metrics, lessons, changes, expectation }) => ({
          metrics,
          lessons,
          changes,
          expectation,
        })),
      };
      try {
        const res = await fetch("/api/reflect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const r = (await res.json()) as ReflectResponse;
        if (!r.ok) throw new Error(r.error);
        const { ok: _ok, ...rest } = r;
        void _ok;
        const reflection: Reflection = {
          ...rest,
          at: Date.now(),
          metrics: m,
          policyBefore: episode.policy,
        };
        commit(addReflection(notebookRef.current, reflection));
        setStatus({
          kind: "info",
          message: `振り返りました。数値の変更 ${reflection.changes.length} 件を次の走行から使います。`,
        });
      } catch (e) {
        setStatus({
          kind: "error",
          message: `振り返りに失敗しました: ${(e as Error).message}`,
        });
      }
    },
    [commit],
  );

  const setRunDeadline = (d: number | null) => {
    deadlineRef.current = d;
    setDeadline(d);
  };

  /** 自動操縦の状態が変わるたびに呼ぶ。走り始めたら 1 分走行の記録を始める */
  const noteState = useCallback(
    (state: AutopilotState) => {
      if (!runningRef.current || !simOnRef.current || world.recorder.recording) return;
      if (!DRIVING_STATES.includes(state)) return;
      world.recorder.begin(world.policy, world.ghostYields);
      completedRef.current = false;
      setRunDeadline(Date.now() + RUN_MS);
      setStatus({ kind: "info", message: `1 分間の走行を記録しています（終わると自動で止まり、振り返ります）。` });
    },
    [world, simOnRef],
  );

  // 1 分たったら自動操縦を止める（止まったら onAutopilotRunning(false) で振り返る）
  useEffect(() => {
    if (deadline === null) return;
    const timer = setTimeout(() => {
      completedRef.current = true;
      stopAutopilot();
    }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline, stopAutopilot]);

  const onAutopilotRunning = useCallback(
    (running: boolean) => {
      runningRef.current = running;
      if (running) return;
      setRunDeadline(null);
      const ep = world.recorder.end();
      if (!ep) return;
      if (!completedRef.current) {
        setStatus({
          kind: "info",
          message: `1 分たつ前に止まったので、この走行は振り返りませんでした（走行の長さを揃えるため）。`,
        });
        return;
      }
      completedRef.current = false;
      void reflect(ep);
    },
    [world, reflect],
  );

  const undo = useCallback(() => {
    commit(undoReflection(notebookRef.current));
    setStatus({
      kind: "info",
      message: "直前の振り返りを取り消し、その前の基準に戻しました。",
    });
  }, [commit]);

  const reset = useCallback(() => {
    commit(EMPTY_NOTEBOOK);
    setStatus({
      kind: "info",
      message: "記録を消し、回避の基準を初期値に戻しました。",
    });
  }, [commit]);

  return { notebook, status, deadline, noteState, onAutopilotRunning, undo, reset };
}
