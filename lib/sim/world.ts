// シミュレーションの世界: カメラ映像の上に置く仮想の障害物と、仮想のロボット（ゴースト）。
//
// 実機の BOLT は、自動操縦が判定した位置（と、そこからの予測）でこの世界に入る。
// ゴーストは Sphero Mini を想定した大きさ・速さで、BOLT と同じ計算（steer.ts）でぶつからないように走る。
// React には依存しない。画面は毎フレーム、この世界の値を読んで描く。

import { type Point, imageAngle, isNearEdge } from "@/lib/autopilot/geometry";
import { predictCenter } from "@/lib/autopilot/tracker";
import type { Track } from "@/lib/autopilot/types";
import { FRAME_HEIGHT, FRAME_WIDTH } from "@/lib/autopilot/vision-client";
import { type Body, type Repulsion, angleVec, gapBetween, repulsion, steerAngle } from "./steer";

/** 映像の縦横比（判定に送るコマと同じ） */
export const ASPECT = FRAME_WIDTH / FRAME_HEIGHT;

/** 仮想の障害物の半径（映像の高さを 1 とした単位） */
export const OBSTACLE_RADIUS = 0.06;
/** BOLT の大きさが分からないときの、BOLT の半径 */
const DEFAULT_BOLT_RADIUS = 0.06;
/** ゴーストは Sphero Mini（直径 約 4cm）を想定し、BOLT（約 7.3cm）に対する比で大きさを決める */
const MINI_TO_BOLT = 4 / 7.3;
/** ゴーストの速さ（映像の高さを 1 として、1 秒に進む距離） */
const GHOST_SPEED_PER_S = 0.12;
/** ゴーストが 1 秒に向きを変えられる角度（急に向きが変わらないように） */
const GHOST_TURN_DEG_PER_S = 240;
/** ゴーストがランダムに向きを変える間隔 */
const GHOST_WANDER_MS = 2500;
/** ゴーストが中央へ引き返し始める、画面の端からの割合 */
const GHOST_EDGE_MARGIN = 0.12;
/** ゴーストが相手との間に空けようとする隙間 */
export const GHOST_CLEARANCE = 0.08;
/** 1 フレームの経過時間の上限（タブが裏に回って戻ったときに飛ばないように） */
const MAX_STEP_MS = 100;

export type Obstacle = Body & { id: number };

export type Ghost = Body & {
  /** 映像の中で進んでいる角度（度） */
  angle: number;
  /** 気ままに向かおうとしている角度（度） */
  wander: number;
  /** 次に wander を選び直す時刻 */
  nextWanderAt: number;
  /** 何かを避けているところか */
  avoiding: boolean;
};

/** Box の大きさから BOLT の半径を求める（幅と高さの平均の半分） */
export function boltRadius(box: { left: number; right: number; top: number; bottom: number }): number {
  return ((box.right - box.left) * ASPECT + (box.bottom - box.top)) / 4;
}

export class SimWorld {
  obstacles: Obstacle[] = [];
  ghost: Ghost | null = null;
  /** BOLT とゴースト・障害物がぶつかった回数（重なり始めた回数） */
  contacts = 0;

  private boltTrack: Track | null = null;
  private touching = new Set<string>();
  private nextId = 1;
  private raf = 0;
  private lastStep = 0;

  /** 自動操縦が判定した BOLT の位置。見えていなければ null（そのときゴーストは BOLT を気にしない） */
  setBoltTrack(track: Track | null) {
    this.boltTrack = track;
  }

  /** 今この瞬間の BOLT（判定した位置に、その後の走行命令で進む分を足した予測） */
  bolt(now = Date.now()): Body | null {
    const t = this.boltTrack;
    if (!t) return null;
    return { kind: "bolt", p: predictCenter(t.box, t.capturedAt, now, t.segments), r: boltRadius(t.box) };
  }

  /** BOLT がぶつからないようにすべき相手（障害物とゴースト） */
  bodiesForBolt(): Body[] {
    return this.ghost ? [...this.obstacles, this.ghost] : [...this.obstacles];
  }

  /** p に障害物があれば消し、なければ置く。置いたら true */
  toggleObstacleAt(p: Point): boolean {
    const hit = this.obstacles.find((o) => gapBetween(o, { kind: "obstacle", p, r: 0 }, ASPECT) < 0);
    if (hit) {
      this.obstacles = this.obstacles.filter((o) => o !== hit);
      return false;
    }
    this.obstacles = [...this.obstacles, { id: this.nextId++, kind: "obstacle", p, r: OBSTACLE_RADIUS }];
    return true;
  }

  clearObstacles() {
    this.obstacles = [];
  }

  /** ゴーストを、BOLT や障害物から離れた場所に置き直す */
  placeGhost() {
    const now = Date.now();
    const bolt = this.bolt(now);
    const r = (bolt?.r ?? DEFAULT_BOLT_RADIUS) * MINI_TO_BOLT;
    const others = bolt ? [...this.obstacles, bolt] : this.obstacles;
    let p: Point = { x: 0.5, y: 0.5 };
    // 空いている場所を何回か探す（見つからなければ最後の候補に置く）
    for (let i = 0; i < 30; i++) {
      p = { x: 0.25 + Math.random() * 0.5, y: 0.25 + Math.random() * 0.5 };
      if (others.every((o) => gapBetween({ kind: "ghost", p, r }, o, ASPECT) > GHOST_CLEARANCE * 2)) break;
    }
    const angle = Math.random() * 360;
    this.ghost = { kind: "ghost", p, r, angle, wander: angle, nextWanderAt: now + GHOST_WANDER_MS, avoiding: false };
    this.contacts = 0;
    this.touching.clear();
  }

  /** ゴーストを動かし始める（毎フレーム step する） */
  start() {
    if (this.raf) return;
    if (!this.ghost) this.placeGhost();
    this.lastStep = Date.now();
    const tick = () => {
      const now = Date.now();
      this.step(Math.min(now - this.lastStep, MAX_STEP_MS), now);
      this.lastStep = now;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.boltTrack = null;
  }

  /** dt ミリ秒ぶん世界を進める */
  step(dt: number, now: number) {
    const g = this.ghost;
    const bolt = this.bolt(now);
    if (g) {
      if (bolt) g.r = bolt.r * MINI_TO_BOLT;
      this.moveGhost(g, bolt, dt, now);
    }
    this.countContacts(bolt);
  }

  private moveGhost(g: Ghost, bolt: Body | null, dt: number, now: number) {
    if (now >= g.nextWanderAt) {
      g.wander = g.angle + (Math.random() - 0.5) * 240;
      g.nextWanderAt = now + GHOST_WANDER_MS;
    }
    // 行きたい向き: 端に近ければ中央、そうでなければ気ままな向き
    const goal = isNearEdge(g.p, GHOST_EDGE_MARGIN) ? imageAngle(g.p, { x: 0.5, y: 0.5 }, ASPECT) : g.wander;
    const others = bolt ? [...this.obstacles, bolt] : this.obstacles;
    // 避け始めたら、隙間が少し広がるまで避け続ける（行ったり来たりを防ぐ）
    const rep: Repulsion | null = repulsion(g, others, ASPECT, GHOST_CLEARANCE * (g.avoiding ? 1.5 : 1));
    g.avoiding = rep !== null;
    const target = rep ? steerAngle(angleVec(goal), rep) : goal;
    if (rep) g.wander = target; // 避け終わったら、避けた向きのまま進む

    // 向きは少しずつしか変えられない
    const diff = ((((target - g.angle) % 360) + 540) % 360) - 180;
    const maxTurn = (GHOST_TURN_DEG_PER_S * dt) / 1000;
    g.angle += Math.max(-maxTurn, Math.min(maxTurn, diff));

    const d = angleVec(g.angle);
    const step = (GHOST_SPEED_PER_S * dt) / 1000;
    const rx = g.r / ASPECT;
    g.p = {
      x: Math.min(1 - rx, Math.max(rx, g.p.x + (d.x * step) / ASPECT)),
      y: Math.min(1 - g.r, Math.max(g.r, g.p.y + d.y * step)),
    };
  }

  /** BOLT が何かと重なり始めた回数を数える */
  private countContacts(bolt: Body | null) {
    if (!bolt) {
      this.touching.clear();
      return;
    }
    const now = new Set<string>();
    if (this.ghost && gapBetween(bolt, this.ghost, ASPECT) < 0) now.add("ghost");
    for (const o of this.obstacles) if (gapBetween(bolt, o, ASPECT) < 0) now.add(`obstacle-${o.id}`);
    for (const k of now) if (!this.touching.has(k)) this.contacts += 1;
    this.touching = now;
  }
}
