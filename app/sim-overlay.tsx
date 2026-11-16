"use client";

import { useEffect, useRef } from "react";
import { ASPECT, type Obstacle, type SimWorld } from "@/lib/sim/world";
import RunProgress from "./run-progress";
import { RUN_MS } from "./use-learning";

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

/** 丸い物体（中心 x, y は比率、半径 r は映像の高さを 1 とした単位）を、要素の位置と大きさに直す */
function place(el: HTMLElement, x: number, y: number, r: number) {
  el.style.left = pct(x - r / ASPECT);
  el.style.top = pct(y - r);
  el.style.width = pct((2 * r) / ASPECT);
  el.style.height = pct(2 * r);
}

type Props = {
  world: SimWorld;
  /** 描く障害物（置いたり消したりしたら、親が新しい一覧を渡す） */
  obstacles: Obstacle[];
  /** 1 分走行の終わる時刻（走行中でなければ null） */
  deadline: number | null;
  /** 映像の上をクリックしたとき（座標は 0〜1 の比率） */
  onClick: (x: number, y: number) => void;
};

/**
 * シミュレーションの世界をカメラ映像に重ねて描く。
 * 障害物はクリックで置いたり消したりする。ゴーストと接触回数は、毎フレーム要素を直接書き換える。
 */
export default function SimOverlay({ world, obstacles, deadline, onClick }: Props) {
  const ghostRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLDivElement>(null);
  const contactsRef = useRef<HTMLSpanElement>(null);
  const boltRef = useRef<HTMLDivElement>(null);
  const boltRingRef = useRef<HTMLDivElement>(null);
  const aheadRef = useRef<HTMLDivElement>(null);
  const remainRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = world.ghost;
      const el = ghostRef.current;
      if (el) {
        el.style.display = g ? "" : "none";
        if (g) {
          place(el, g.p.x, g.p.y, g.r);
          // BOLT に触れたら赤、避けているときは水色、ふだんはピンク
          const hit = world.ghostHit();
          el.classList.toggle("border-red-500", hit);
          el.classList.toggle("bg-red-500/60", hit);
          el.classList.toggle("border-cyan-300", !hit && g.avoiding);
          el.classList.toggle("border-fuchsia-300", !hit && !g.avoiding);
          el.classList.toggle("bg-fuchsia-400/30", !hit);
        }
      }
      if (arrowRef.current && g) arrowRef.current.style.transform = `rotate(${g.angle}deg)`;
      // BOLT が避けるときに使う、先読みしたゴーストの位置（先読みしないときは出さない）
      const ahead = aheadRef.current;
      if (ahead) {
        const a = g && world.policy.lookaheadMs > 0 ? world.bodiesForBolt().find((b) => b.kind === "ghost") : null;
        ahead.style.display = a ? "" : "none";
        if (a) place(ahead, a.p.x, a.p.y, a.r);
      }
      if (contactsRef.current) {
        contactsRef.current.textContent =
          String(world.contacts) + (world.jumpContacts ? `（位置補正 ${world.jumpContacts}）` : "");
      }
      if (remainRef.current && deadline !== null) {
        remainRef.current.textContent = String(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
      }
      // シミュレーションが BOLT だと思っている位置と大きさ、その外側の「この輪に入ったら避ける」範囲
      const b = world.bolt();
      for (const [ref, extra] of [
        [boltRef, 0],
        [boltRingRef, world.policy.clearance],
      ] as const) {
        const e = ref.current;
        if (!e) continue;
        e.style.display = b ? "" : "none";
        if (b) place(e, b.p.x, b.p.y, b.r + extra);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [world, deadline]);

  return (
    <div
      className="absolute inset-0 cursor-crosshair"
      title="クリックで仮想の障害物を置く / 消す"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onClick((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
      }}
    >
      {/* 仮想の障害物 */}
      {obstacles.map((o) => (
        <div
          key={o.id}
          className="pointer-events-none absolute rounded-full border-2 border-orange-400 bg-orange-400/25"
          style={{
            left: pct(o.p.x - o.r / ASPECT),
            top: pct(o.p.y - o.r),
            width: pct((2 * o.r) / ASPECT),
            height: pct(2 * o.r),
          }}
        />
      ))}
      {/* シミュレーションの中の BOLT（実線）と、障害物やゴーストの縁がここに入ったら避ける範囲（点線） */}
      <div ref={boltRef} className="pointer-events-none absolute rounded-full border-2 border-sky-300" />
      <div
        ref={boltRingRef}
        className="pointer-events-none absolute rounded-full border border-dashed border-sky-300/70"
      />
      <div
        ref={aheadRef}
        className="pointer-events-none absolute rounded-full border border-dashed border-fuchsia-300/80"
      />
      {/* ゴースト（仮想の Sphero Mini）。中の線は進む向き */}
      <div
        ref={ghostRef}
        className="pointer-events-none absolute rounded-full border-2 border-fuchsia-300 bg-fuchsia-400/30"
      >
        <div ref={arrowRef} className="absolute inset-0">
          <div className="absolute left-1/2 top-1/2 h-0.5 w-1/2 bg-fuchsia-100" />
        </div>
      </div>
      <RunProgress deadline={deadline} runMs={RUN_MS} preparing={false} reflecting={false} compact />
      {deadline !== null && (
        <div className="pointer-events-none absolute right-3 top-3 rounded-md bg-cyan-600/85 px-3 py-2 text-sm font-semibold text-white">
          記録中・残り <span ref={remainRef} /> 秒
        </div>
      )}
      <div className="pointer-events-none absolute bottom-2 right-3 flex gap-3 rounded bg-black/50 px-2 py-1 text-[10px] text-zinc-200">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-orange-400" />
          障害物
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-fuchsia-300" />
          ゴースト
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-sky-300" />
          BOLT（避ける範囲は点線）
        </span>
        <span>
          接触 <span ref={contactsRef}>0</span> 回
        </span>
      </div>
    </div>
  );
}
