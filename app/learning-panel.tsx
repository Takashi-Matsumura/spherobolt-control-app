"use client";

import type { VerdictKind } from "@/lib/sim/compare";
import type { Notebook } from "@/lib/sim/notebook";
import { DEFAULT_POLICY, POLICY_KEYS, POLICY_SPEC } from "@/lib/sim/policy";
import { PILL_BUTTON } from "./handheld/controls";

export type LearningStatus = {
  kind: "idle" | "reflecting" | "error" | "info";
  message?: string;
};

type Props = {
  notebook: Notebook;
  status: LearningStatus;
  onUndo: () => void;
  onReset: () => void;
};

const VERDICT_LABEL: Record<VerdictKind, string> = {
  first: "最初",
  improved: "改善",
  worse: "悪化",
  unclear: "誤差",
};
const VERDICT_STYLE: Record<VerdictKind, string> = {
  first: "text-zinc-500",
  improved: "text-emerald-600 dark:text-emerald-400",
  worse: "text-red-500",
  unclear: "text-zinc-500",
};

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, ""));

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold text-zinc-500">{title}</h4>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

/** 振り返りの結果と、これまでの成長の記録 */
export default function LearningPanel({ notebook, status, onUndo, onReset }: Props) {
  const latest = notebook.history[0];
  return (
    <details className="rounded-lg border border-zinc-300 p-3 dark:border-zinc-700" open>
      <summary className="cursor-pointer text-sm font-semibold">成長の記録（シミュレーションの振り返り）</summary>
      <p className="mt-2 text-xs text-zinc-500">
        シミュレーションを ON にして自動操縦を走らせ、止めると、ローカルの AI が走行記録（接触・回避）を振り返ります。
        教訓と判断の基準を言葉にまとめ、回避の基準（下の数値）を見直して、次の走行に使います。
      </p>

      {status.kind !== "idle" && (
        <p
          className={`mt-2 rounded px-2 py-1 text-xs ${
            status.kind === "error"
              ? "bg-red-500/15 text-red-500"
              : status.kind === "reflecting"
                ? "animate-pulse bg-cyan-500/15 text-cyan-600 dark:text-cyan-300"
                : "bg-zinc-500/15 text-zinc-500"
          }`}
        >
          {status.message}
        </p>
      )}

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <div>
            <h4 className="text-xs font-semibold text-zinc-500">今の回避の基準</h4>
            <table className="mt-1 w-full text-sm">
              <tbody>
                {POLICY_KEYS.map((k) => {
                  const v = notebook.policy[k];
                  const changed = Math.abs(v - DEFAULT_POLICY[k]) > 1e-9;
                  return (
                    <tr key={k} title={POLICY_SPEC[k].description}>
                      <td className="py-0.5 pr-2">{POLICY_SPEC[k].label}</td>
                      <td
                        className={`py-0.5 text-right font-mono ${changed ? "text-cyan-600 dark:text-cyan-300" : ""}`}
                      >
                        {fmt(v)}
                      </td>
                      <td className="py-0.5 pl-2 text-right font-mono text-xs text-zinc-500">
                        {changed && `初期 ${fmt(DEFAULT_POLICY[k])}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <List title="判断の基準（振り返りのたびに書き直す）" items={notebook.criteria} />
          <div className="flex flex-wrap gap-2">
            <button className={PILL_BUTTON} disabled={!latest} onClick={onUndo}>
              直前の振り返りを取り消す
            </button>
            <button className={PILL_BUTTON} disabled={!latest} onClick={onReset}>
              記録を消して初期値に戻す
            </button>
          </div>
        </div>

        <div className="space-y-3">
          {latest ? (
            <>
              <h4 className="text-xs font-semibold text-zinc-500">
                最新の振り返り（
                {new Date(latest.at).toLocaleString(undefined, {
                  hour12: false,
                })}
                ・{latest.model}・{Math.round(latest.latencyMs / 1000)} 秒）
              </h4>
              {latest.verdict && (
                <div>
                  <h4 className="text-xs font-semibold text-zinc-500">前回・最良との比較（アプリの判定）</h4>
                  <p className="mt-1 text-sm">
                    <span className={`font-semibold ${VERDICT_STYLE[latest.verdict.kind]}`}>
                      {VERDICT_LABEL[latest.verdict.kind]}
                    </span>
                    {latest.verdict.reverted && (
                      <span className="font-semibold text-amber-500"> ・最良の設定に戻した</span>
                    )}
                    <span className="text-zinc-500">　{latest.verdict.text}</span>
                  </p>
                </div>
              )}
              <List title="気づいたこと" items={latest.observations} />
              <List title="教訓" items={latest.lessons} />
              <div>
                <h4 className="text-xs font-semibold text-zinc-500">変えた数値</h4>
                {latest.changes.length ? (
                  <ul className="mt-1 space-y-0.5 text-sm">
                    {latest.changes.map((c) => (
                      <li key={c.param}>
                        {POLICY_SPEC[c.param].label}:{" "}
                        <span className="font-mono">
                          {fmt(c.from)} → {fmt(c.to)}
                        </span>
                        <span className="text-zinc-500">（{c.reason}）</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-sm text-zinc-500">なし（今の基準のまま）</p>
                )}
              </div>
              {latest.expectation && <List title="次に期待すること" items={[latest.expectation]} />}
            </>
          ) : (
            <p className="text-sm text-zinc-500">まだ振り返りはありません。</p>
          )}
        </div>
      </div>

      {notebook.history.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <h4 className="text-xs font-semibold text-zinc-500">これまでの走行（新しい順）</h4>
          <table className="mt-1 w-full min-w-[32rem] text-xs">
            <thead className="text-zinc-500">
              <tr className="text-right">
                <th className="py-1 text-left font-normal">回</th>
                <th className="py-1 font-normal">時間</th>
                <th className="py-1 font-normal">接触</th>
                <th className="py-1 font-normal" title="位置補正による接触（予測のずれ。評価には使わない）">
                  補正
                </th>
                <th className="py-1 font-normal">接触/分</th>
                <th className="py-1 font-normal">気づく前</th>
                <th className="py-1 font-normal">回避中</th>
                <th className="py-1 font-normal">回避</th>
                <th className="py-1 font-normal">ニアミス</th>
                <th className="py-1 font-normal">変更</th>
                <th className="py-1 font-normal">判定</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {notebook.history.map((h, i) => (
                <tr key={h.at} className="border-t border-zinc-200 text-right dark:border-zinc-800">
                  <td className="py-1 text-left">{notebook.history.length - i}</td>
                  <td className="py-1">{h.metrics.durationS}s</td>
                  <td className="py-1">{h.metrics.contacts}</td>
                  <td className="py-1 text-zinc-500">{h.metrics.contactsJump ?? "-"}</td>
                  <td className="py-1">{h.metrics.contactsPerMin}</td>
                  <td className="py-1">{h.metrics.contactsUnaware}</td>
                  <td className="py-1">{h.metrics.contactsWhileAvoiding}</td>
                  <td className="py-1">{h.metrics.avoids}</td>
                  <td className="py-1">{h.metrics.nearMisses}</td>
                  <td className="py-1">{h.changes.length}</td>
                  <td className={`py-1 ${h.verdict ? VERDICT_STYLE[h.verdict.kind] : ""}`}>
                    {h.verdict ? VERDICT_LABEL[h.verdict.kind] + (h.verdict.reverted ? "・戻" : "") : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
