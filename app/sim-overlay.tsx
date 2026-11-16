"use client";

import { useEffect, useRef } from "react";
import { ASPECT, type Obstacle, type SimWorld } from "@/lib/sim/world";

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
  /** 映像の上をクリックしたとき（座標は 0〜1 の比率） */
  onClick: (x: number, y: number) => void;
};

/**
 * シミュレーションの世界をカメラ映像に重ねて描く。
 * 障害物はクリックで置いたり消したりする。ゴーストと接触回数は、毎フレーム要素を直接書き換える。
 */
export default function SimOverlay({ world, obstacles, onClick }: Props) {
  const ghostRef = useRef<HTMLDivElement>(null);
  const arrowRef = useRef<HTMLDivElement>(null);
  const contactsRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = world.ghost;
      const el = ghostRef.current;
      if (el) {
        el.style.display = g ? "" : "none";
        if (g) {
          place(el, g.p.x, g.p.y, g.r);
          el.classList.toggle("border-cyan-300", g.avoiding);
          el.classList.toggle("border-fuchsia-300", !g.avoiding);
        }
      }
      if (arrowRef.current && g) arrowRef.current.style.transform = `rotate(${g.angle}deg)`;
      if (contactsRef.current) contactsRef.current.textContent = String(world.contacts);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [world]);

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
      {/* ゴースト（仮想の Sphero Mini）。中の線は進む向き */}
      <div
        ref={ghostRef}
        className="pointer-events-none absolute rounded-full border-2 border-fuchsia-300 bg-fuchsia-400/30"
      >
        <div ref={arrowRef} className="absolute inset-0">
          <div className="absolute left-1/2 top-1/2 h-0.5 w-1/2 bg-fuchsia-100" />
        </div>
      </div>
      <div className="pointer-events-none absolute bottom-2 right-3 flex gap-3 rounded bg-black/50 px-2 py-1 text-[10px] text-zinc-200">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-orange-400" />
          障害物
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-fuchsia-300" />
          ゴースト
        </span>
        <span>
          接触 <span ref={contactsRef}>0</span> 回
        </span>
      </div>
    </div>
  );
}
