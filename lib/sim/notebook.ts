// 成長の記録: 今の回避の基準・判断の基準・これまでの振り返りを、このブラウザに保存する。
// 保存できない環境（シークレットウィンドウの制限など）でも動くよう、読み書きの失敗は無視する。

import { type AvoidPolicy, DEFAULT_POLICY, clampPolicy } from "./policy";
import type { Reflection } from "./reflection";

export type Notebook = {
  policy: AvoidPolicy;
  criteria: string[];
  /** 新しい順 */
  history: Reflection[];
};

const KEY = "bolt-pilot.learning.v1";
const MAX_HISTORY = 30;

export const EMPTY_NOTEBOOK: Notebook = {
  policy: DEFAULT_POLICY,
  criteria: [],
  history: [],
};

export function loadNotebook(): Notebook {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY_NOTEBOOK;
    const n = JSON.parse(raw) as Partial<Notebook>;
    return {
      policy: clampPolicy(n.policy ?? {}),
      criteria: Array.isArray(n.criteria) ? n.criteria.filter((c) => typeof c === "string") : [],
      history: Array.isArray(n.history) ? n.history.slice(0, MAX_HISTORY) : [],
    };
  } catch {
    return EMPTY_NOTEBOOK;
  }
}

export function saveNotebook(n: Notebook) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...n, history: n.history.slice(0, MAX_HISTORY) }));
  } catch {
    // 保存できなくても、今のページの中では使い続けられる
  }
}

/** 振り返りの結果を加える */
export function addReflection(n: Notebook, r: Reflection): Notebook {
  return {
    policy: r.policyAfter,
    criteria: r.criteria,
    history: [r, ...n.history].slice(0, MAX_HISTORY),
  };
}

/** 直前の振り返りを取り消し、その前の基準に戻す */
export function undoReflection(n: Notebook): Notebook {
  const [latest, ...rest] = n.history;
  if (!latest) return n;
  return {
    policy: latest.policyBefore,
    criteria: rest[0]?.criteria ?? [],
    history: rest,
  };
}
