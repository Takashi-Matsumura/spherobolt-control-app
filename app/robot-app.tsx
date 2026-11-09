"use client";

import { useCallback, useRef, useState } from "react";
import type { Bolt } from "@/lib/bolt/bolt";
import AutopilotTab from "./autopilot-tab";
import ConnectionBar from "./connection-bar";
import ManualControl from "./manual-control";

type Tab = "autopilot" | "manual";

const TABS: { id: Tab; label: string; description: string }[] = [
  { id: "autopilot", label: "自動操縦", description: "カメラの映像を AI（Jev）が判定し、BOLT を自動で動かします" },
  { id: "manual", label: "手動操作", description: "ボタンで BOLT を走らせ、ライトを操作します" },
];

// タイムゾーンを指定しないと、ブラウザ（= OS の地域設定）のタイムゾーンで表示される
const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

/** BOLT への接続を共通部分に置き、自動操縦と手動操作の 2 画面を切り替える */
export default function RobotApp() {
  const boltRef = useRef<Bolt | null>(null);
  const [tab, setTab] = useState<Tab>("autopilot");
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  // BOLT の向きの基準が変わるたびに増える番号（接続し直す・正面をリセットする）。
  // 自動操縦の向き合わせは、この番号が変わると無効になる。
  const [headingEpoch, setHeadingEpoch] = useState(0);

  const log = useCallback(
    (msg: string) => setLogs((prev) => [`${timeFormat.format(new Date())} ${msg}`, ...prev].slice(0, 100)),
    [],
  );
  const onConnectedChange = useCallback((c: boolean) => {
    setConnected(c);
    if (c) setHeadingEpoch((n) => n + 1);
  }, []);
  const onHeadingReset = useCallback(() => setHeadingEpoch((n) => n + 1), []);

  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div className="flex flex-col gap-6">
      <ConnectionBar boltRef={boltRef} onConnectedChange={onConnectedChange} log={log} />

      <div className="flex flex-col gap-2">
        <div role="tablist" className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? "bg-white shadow-sm dark:bg-zinc-700"
                  : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-zinc-500">{current.description}</p>
      </div>

      {/* 自動操縦の画面は隠しても残しておく（カメラと向き合わせの結果を保つため）。隠れている間は自動操縦を解除する */}
      <div role="tabpanel" hidden={tab !== "autopilot"}>
        <AutopilotTab boltRef={boltRef} connected={connected} active={tab === "autopilot"} headingEpoch={headingEpoch} />
      </div>
      {tab === "manual" && (
        <div role="tabpanel">
          <ManualControl boltRef={boltRef} connected={connected} log={log} onHeadingReset={onHeadingReset} />
        </div>
      )}

      <details className="rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
        <summary className="cursor-pointer text-sm font-semibold">通信ログ</summary>
        <pre className="mt-2 h-48 overflow-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
          {logs.join("\n") || "（まだありません）"}
        </pre>
      </details>
    </div>
  );
}
