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
import type { SimWorld } from "@/lib/sim/world";
import type { LearningStatus } from "./learning-panel";

/** これより短い走行は、材料が少なすぎるので振り返らない */
const MIN_EPISODE_MS = 15_000;
/** 振り返りに渡す、過去の振り返りの数 */
const HISTORY_FOR_PROMPT = 5;

/**
 * 走行記録 → 振り返り → 回避の基準の更新 を受け持つ。
 * 自動操縦の開始・停止を onAutopilotRunning で知らせると、シミュレーション中の走行を記録し、止めたときに振り返る。
 */
export function useLearning(world: SimWorld, simOnRef: { current: boolean }) {
  const [notebook, setNotebook] = useState<Notebook>(EMPTY_NOTEBOOK);
  const [status, setStatus] = useState<LearningStatus>({ kind: "idle" });
  const notebookRef = useRef(notebook);

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

  const onAutopilotRunning = useCallback(
    (running: boolean) => {
      if (running) {
        if (simOnRef.current) world.recorder.begin(world.policy, world.ghostYields);
        return;
      }
      const ep = world.recorder.end();
      if (!ep) return;
      if (ep.durationMs < MIN_EPISODE_MS) {
        setStatus({
          kind: "info",
          message: `走行が ${MIN_EPISODE_MS / 1000} 秒より短かったので、振り返りませんでした。`,
        });
        return;
      }
      void reflect(ep);
    },
    [world, simOnRef, reflect],
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

  return { notebook, status, onAutopilotRunning, undo, reset };
}
