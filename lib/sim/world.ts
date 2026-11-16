// シミュレーションの世界: カメラ映像の上に置く仮想の障害物と、仮想のロボット（ゴースト）。
//
// 実機の BOLT は、自動操縦が判定した位置（と、そこからの予測）でこの世界に入る。
// ゴーストは Sphero Mini を想定した大きさ・速さで、BOLT と同じ計算（steer.ts）でぶつからないように走る。
// React には依存しない。画面は毎フレーム、この世界の値を読んで描く。

import { type Point, imageAngle, isNearEdge } from "@/lib/autopilot/geometry";
import { predictCenter } from "@/lib/autopilot/tracker";
import type { Track } from "@/lib/autopilot/types";
import { FRAME_HEIGHT, FRAME_WIDTH } from "@/lib/autopilot/vision-client";
import { EpisodeRecorder } from "./episode";
import { type AvoidPolicy, DEFAULT_POLICY } from "./policy";
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
/** ゴーストが BOLT に触れたあと、赤く光り続ける最短の時間（一瞬の接触でも見えるように） */
const GHOST_HIT_SHOW_MS = 800;
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
  /** BOLT とゴースト・障害物がぶつかった回数（重なり始めた回数。位置補正によるものは除く） */
  contacts = 0;
  /** 新しい判定で BOLT の位置が飛んだ結果、重なった回数（予測のずれ。回避の仕方では防げない） */
  jumpContacts = 0;
  /** ゴーストが BOLT を避けるか。false なら障害物だけ避け、BOLT には構わず進む（BOLT の回避を試すとき用） */
  ghostYields = false;
  /** BOLT の回避の基準。振り返りのたびに更新される */
  policy: AvoidPolicy = { ...DEFAULT_POLICY };
  /** 走行記録（自動操縦の開始から停止まで） */
  readonly recorder = new EpisodeRecorder();

  private boltTrack: Track | null = null;
  /** 新しい判定が届く直前の Track。次のフレームで、位置の飛びによる接触かを見分けるのに使う */
  private replacedTrack: Track | null = null;
  private touching = new Set<string>();
  private ghostHitAt = -Infinity;
  private nextId = 1;
  private raf = 0;
  private lastStep = 0;

  /** 自動操縦が判定した BOLT の位置。見えていなければ null（そのときゴーストは BOLT を気にしない） */
  setBoltTrack(track: Track | null) {
    const prev = this.boltTrack;
    // 判定（撮った時刻）が変わったときだけ「位置が飛んだかもしれない」として前の Track を覚えておく
    if (track && prev && track.capturedAt !== prev.capturedAt) this.replacedTrack = prev;
    this.boltTrack = track;
  }

  /** 今この瞬間の BOLT（判定した位置に、その後の走行命令で進む分を足した予測） */
  bolt(now = Date.now()): Body | null {
    return this.boltFrom(this.boltTrack, now);
  }

  private boltFrom(t: Track | null, now: number): Body | null {
    if (!t) return null;
    return {
      kind: "bolt",
      p: predictCenter(t.box, t.capturedAt, now, t.segments),
      r: boltRadius(t.box),
    };
  }

  /**
   * BOLT がぶつからないようにすべき相手（障害物とゴースト）。
   * ゴーストは、今の向きと速さで lookaheadMs だけ進んだ先の位置にする（判定の遅れを補う先読み）。
   */
  bodiesForBolt(lookaheadMs = this.policy.lookaheadMs): Body[] {
    const g = this.ghost;
    if (!g) return [...this.obstacles];
    const d = angleVec(g.angle);
    const ahead = (GHOST_SPEED_PER_S * lookaheadMs) / 1000;
    const p = { x: g.p.x + (d.x * ahead) / ASPECT, y: g.p.y + d.y * ahead };
    return [...this.obstacles, { kind: "ghost", p, r: g.r }];
  }

  /** ゴーストが BOLT に触れているか（離れてからも少しの間は true） */
  ghostHit(now = Date.now()): boolean {
    return this.touching.has("ghost") || now - this.ghostHitAt < GHOST_HIT_SHOW_MS;
  }

  setGhostYields(v: boolean) {
    this.ghostYields = v;
  }

  setPolicy(p: AvoidPolicy) {
    this.policy = { ...p };
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
    this.ghost = {
      kind: "ghost",
      p,
      r,
      angle,
      wander: angle,
      nextWanderAt: now + GHOST_WANDER_MS,
      avoiding: false,
    };
    this.contacts = 0;
    this.jumpContacts = 0;
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
    this.countContacts(bolt, now);
    this.replacedTrack = null;
  }

  private moveGhost(g: Ghost, bolt: Body | null, dt: number, now: number) {
    if (now >= g.nextWanderAt) {
      g.wander = g.angle + (Math.random() - 0.5) * 240;
      g.nextWanderAt = now + GHOST_WANDER_MS;
    }
    // 行きたい向き: 端に近ければ中央、そうでなければ気ままな向き
    const goal = isNearEdge(g.p, GHOST_EDGE_MARGIN) ? imageAngle(g.p, { x: 0.5, y: 0.5 }, ASPECT) : g.wander;
    const others = bolt && this.ghostYields ? [...this.obstacles, bolt] : this.obstacles;
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

  /** BOLT が何かと重なり始めた回数を数え、走行記録に残す */
  private countContacts(bolt: Body | null, at: number) {
    if (!bolt) {
      this.touching.clear();
      return;
    }
    const g = this.ghost;
    const now = new Set<string>();
    let minGap = Infinity;
    if (g) {
      const gap = gapBetween(bolt, g, ASPECT);
      minGap = gap;
      if (gap < 0) now.add("ghost");
    }
    for (const o of this.obstacles) {
      const gap = gapBetween(bolt, o, ASPECT);
      minGap = Math.min(minGap, gap);
      if (gap < 0) now.add(`obstacle-${o.id}`);
    }
    if (Number.isFinite(minGap)) this.recorder.observeGap(minGap);
    // 新しい判定が届いたフレームなら、前の判定のままの予測でも重なっていたかを調べる。
    // 前の予測では重なっていなかったのに重なったなら、BOLT が動いたのではなく位置が補正で飛んだ結果
    const before = this.boltFrom(this.replacedTrack, at);
    for (const k of now) {
      if (this.touching.has(k)) continue;
      const other = k === "ghost" ? g : this.obstacles.find((o) => `obstacle-${o.id}` === k);
      const jump = !!(before && other && gapBetween(before, other, ASPECT) >= 0);
      if (jump) this.jumpContacts += 1;
      else this.contacts += 1;
      if (k === "ghost" && g) {
        // ゴーストが BOLT へ向かってきていたか（進む向きと、BOLT への向きの差）
        const toBolt = imageAngle(g.p, bolt.p, ASPECT);
        const off = Math.abs(((((g.angle - toBolt) % 360) + 540) % 360) - 180);
        this.recorder.contact("ghost", off, jump);
        this.ghostHitAt = Date.now();
      } else {
        this.recorder.contact("obstacle", null, jump);
      }
    }
    this.touching = now;
  }
}
