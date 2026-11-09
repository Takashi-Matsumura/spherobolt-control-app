"use client";

import { type RefObject, useEffect, useState } from "react";
import { Bolt } from "@/lib/bolt/bolt";

type Status = "idle" | "connecting" | "connected";

type Props = {
  /** 自動操縦・手動操作の両方から同じ接続を使えるように親が持つ */
  boltRef: RefObject<Bolt | null>;
  onConnectedChange: (connected: boolean) => void;
  log: (msg: string) => void;
};

/** 両方の画面に共通する、BOLT との接続と電池まわり */
export default function ConnectionBar({ boltRef, onConnectedChange, log }: Props) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [battery, setBattery] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState("");

  useEffect(() => {
    // Web Bluetooth の有無はブラウザでしか判定できないため、マウント後に確認する
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(Bolt.isSupported());
    return () => boltRef.current?.disconnect();
  }, [boltRef]);

  useEffect(() => {
    onConnectedChange(status === "connected");
  }, [status, onConnectedChange]);

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
      setBattery(null);
      setStatus("connected");
    } catch (e) {
      log(`接続失敗: ${(e as Error).message}`);
      bolt.disconnect();
      setStatus("idle");
    }
  };

  const diagnoseBattery = () =>
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
    });

  if (supported === false) {
    return (
      <p className="rounded-lg border border-amber-400 bg-amber-50 p-4 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
        このブラウザは Web Bluetooth に対応していません。PC 版の Chrome または Edge で開いてください。
      </p>
    );
  }

  const connected = status === "connected";

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            connected ? "bg-emerald-500" : status === "connecting" ? "bg-amber-400" : "bg-zinc-400"
          }`}
          aria-hidden
        />
        <span className="text-sm font-medium">
          {connected ? `${deviceName} に接続中` : status === "connecting" ? "接続中…" : "BOLT 未接続"}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {connected ? (
            <>
              <button className="btn" onClick={diagnoseBattery}>
                電池を診断
              </button>
              <button className="btn" onClick={() => run("起こす", (b) => b.wake())}>
                起こす (wake)
              </button>
              <button className="btn" onClick={() => boltRef.current?.disconnect()}>
                切断
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={connect} disabled={status === "connecting"}>
              BOLT に接続
            </button>
          )}
        </div>
      </div>
      {connected && battery && <p className="text-sm text-zinc-600 dark:text-zinc-400">{battery}</p>}
    </section>
  );
}
