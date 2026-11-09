"use client";

import { useEffect, useRef, useState } from "react";
import { Bolt } from "@/lib/bolt/bolt";

type Status = "idle" | "connecting" | "connected";

const DIRECTIONS = [
  { label: "↑", heading: 0, area: "col-start-2 row-start-1" },
  { label: "←", heading: 270, area: "col-start-1 row-start-2" },
  { label: "→", heading: 90, area: "col-start-3 row-start-2" },
  { label: "↓", heading: 180, area: "col-start-2 row-start-3" },
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

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export default function BoltController() {
  const boltRef = useRef<Bolt | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [logs, setLogs] = useState<string[]>([]);
  const [speed, setSpeed] = useState(80);
  const [matrixColor, setMatrixColor] = useState("#00a0ff");
  const [frontColor, setFrontColor] = useState("#ffffff");
  const [backColor, setBackColor] = useState("#ff0000");
  const [battery, setBattery] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState("");

  const log = (msg: string) =>
    setLogs((prev) => [`${timeFormat.format(new Date())} ${msg}`, ...prev].slice(0, 100));

  useEffect(() => {
    // Web Bluetooth の有無はブラウザでしか判定できないため、マウント後に確認する
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(Bolt.isSupported());
    return () => boltRef.current?.disconnect();
  }, []);

  const run = async (label: string, fn: (b: Bolt) => Promise<unknown>) => {
    const bolt = boltRef.current;
    if (!bolt) return;
    try {
      await fn(bolt);
    } catch (e) {
      log(`${label} 失敗: ${(e as Error).message}`);
    }
  };

  const connect = async () => {
    const bolt = new Bolt(log, () => setStatus("idle"));
    boltRef.current = bolt;
    setStatus("connecting");
    try {
      await bolt.connect();
      setDeviceName(bolt.name ?? "BOLT");
      setStatus("connected");
    } catch (e) {
      log(`接続失敗: ${(e as Error).message}`);
      bolt.disconnect();
      setStatus("idle");
    }
  };

  const connected = status === "connected";

  if (supported === false) {
    return (
      <p className="rounded-lg border border-amber-400 bg-amber-50 p-4 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
        このブラウザは Web Bluetooth に対応していません。PC 版の Chrome または Edge で開いてください。
      </p>
    );
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <section className="flex flex-wrap items-center gap-3">
        {connected ? (
          <button className="btn" onClick={() => boltRef.current?.disconnect()}>
            切断
          </button>
        ) : (
          <button className="btn btn-primary" onClick={connect} disabled={status === "connecting"}>
            {status === "connecting" ? "接続中…" : "BOLT に接続"}
          </button>
        )}
        <span className="text-sm text-zinc-500">
          {connected ? `接続中: ${deviceName}` : "未接続"}
        </span>
        {connected && (
          <>
            <button
              className="btn"
              onClick={() =>
                run("電池診断", async (b) => {
                  // 未対応のコマンドがあっても他の項目は表示したいので個別に取得する
                  const tryGet = async <T,>(fn: () => Promise<T>) => {
                    try {
                      return String(await fn());
                    } catch (e) {
                      return `取得失敗(${(e as Error).message})`;
                    }
                  };
                  const voltage = await tryGet(async () => (await b.getBatteryVoltage()).toFixed(2));
                  const state = await tryGet(() => b.getBatteryVoltageState());
                  const charger = await tryGet(() => b.getChargerState());
                  const summary = `電圧 ${voltage} V / 判定 ${state} / 充電 ${charger}`;
                  setBattery(summary);
                  log(`電池診断: ${summary}`);
                })
              }
            >
              電池を診断
            </button>
            <button className="btn" onClick={() => run("起こす", (b) => b.wake())}>
              起こす (wake)
            </button>
          </>
        )}
        {connected && battery && <p className="w-full text-sm">{battery}</p>}
      </section>

      <fieldset disabled={!connected} className="grid gap-6 disabled:opacity-40 sm:grid-cols-2">
        <section className="flex flex-col gap-3">
          <h2 className="font-semibold">走行</h2>
          <label className="flex items-center gap-3 text-sm">
            速度 {speed}
            <input
              type="range"
              min={0}
              max={255}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
              className="flex-1"
            />
          </label>
          <div className="grid w-48 grid-cols-3 grid-rows-3 gap-2">
            {DIRECTIONS.map((d) => (
              <button
                key={d.label}
                className={`btn aspect-square text-xl ${d.area}`}
                onPointerDown={() => run("走行", (b) => b.roll(speed, d.heading))}
                onPointerUp={() => run("停止", (b) => b.stop(d.heading))}
                onPointerLeave={(e) => e.buttons && run("停止", (b) => b.stop(d.heading))}
              >
                {d.label}
              </button>
            ))}
            <button
              className="btn col-start-2 row-start-2 text-xs"
              onClick={() => run("停止", (b) => b.stop())}
            >
              停止
            </button>
          </div>
          <p className="text-xs text-zinc-500">矢印を押している間だけ走ります。向きは接続時の正面基準です。</p>
          <button className="btn w-fit" onClick={() => run("向きリセット", (b) => b.resetYaw())}>
            現在の向きを正面にする
          </button>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="font-semibold">ライト</h2>
          <label className="flex items-center gap-3 text-sm">
            <input type="color" value={matrixColor} onChange={(e) => setMatrixColor(e.target.value)} />
            LED マトリクス
            <button
              className="btn ml-auto"
              onClick={() => run("マトリクス", (b) => b.setMatrixColor(...hexToRgb(matrixColor)))}
            >
              点灯
            </button>
          </label>
          <label className="flex items-center gap-3 text-sm">
            <input type="color" value={frontColor} onChange={(e) => setFrontColor(e.target.value)} />
            前 LED
            <button className="btn ml-auto" onClick={() => run("前LED", (b) => b.setFrontLed(hexToRgb(frontColor)))}>
              点灯
            </button>
          </label>
          <label className="flex items-center gap-3 text-sm">
            <input type="color" value={backColor} onChange={(e) => setBackColor(e.target.value)} />
            後 LED
            <button
              className="btn ml-auto"
              onClick={() =>
                run("後LED", (b) => b.setBackLed(hexToRgb(backColor)))
              }
            >
              点灯
            </button>
          </label>
          <button
            className="btn w-fit"
            onClick={() =>
              run("消灯", async (b) => {
                await b.setMatrixColor(0, 0, 0);
                await b.setFrontBackLeds([0, 0, 0], [0, 0, 0]);
              })
            }
          >
            すべて消灯
          </button>
        </section>
      </fieldset>

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">ログ</h2>
        <pre className="h-48 overflow-auto rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
          {logs.join("\n") || "（まだありません）"}
        </pre>
      </section>
    </div>
  );
}
