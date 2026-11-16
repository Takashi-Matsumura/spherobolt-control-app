// シミュレーションの走行記録（1 回の自動操縦 = 1 エピソード）。振り返りの材料になる。
//
// 自動操縦（controller.ts）が BOLT の状態を、シミュレーションの世界（world.ts）が接触と隙間を知らせる。
// サーバにも送るので、記録はそのまま JSON にできる形で持つ。

import type { AutopilotState } from "@/lib/autopilot/types";
import type { AvoidPolicy } from "./policy";
import type { BodyKind } from "./steer";

/** 1 回の接触 */
export type ContactEvent = {
  /** エピソード開始からの経過（ミリ秒） */
  t: number;
  with: BodyKind;
  /** 接触したときの BOLT の状態 */
  boltState: AutopilotState;
  /** 避け始めてから何ミリ秒後の接触か。避けていなければ null（＝気づくのが遅れた） */
  avoidingForMs: number | null;
  /** 最後の判定（BOLT の位置を Jev が見たコマ）から何ミリ秒たっていたか */
  sinceJudgmentMs: number | null;
  /** 最後の判定の応答時間 */
  latencyMs: number | null;
  /** ゴーストの進む向きと、ゴーストから BOLT への向きの差（度）。0 に近いほどゴーストが BOLT へ向かってきていた */
  ghostHeadingOffBolt: number | null;
};

/** 1 回の回避（避け始めてから避け終えるまで） */
export type AvoidEvent = {
  t: number;
  durationMs: number;
  with: BodyKind;
  /** 回避中に最も近づいたときの隙間（負なら重なった） */
  minGap: number;
  /** 回避中に接触したか */
  contacted: boolean;
};

export type Episode = {
  startedAt: number;
  durationMs: number;
  policy: AvoidPolicy;
  contacts: ContactEvent[];
  avoids: AvoidEvent[];
  judgments: number;
  avgLatencyMs: number | null;
  /** ゴーストが BOLT を避けていたか */
  ghostYields: boolean;
};

/** 振り返りに使う集計 */
export type EpisodeMetrics = {
  durationS: number;
  contacts: number;
  contactsPerMin: number;
  /** 避けていない状態での接触（気づくのが遅れた） */
  contactsUnaware: number;
  /** 避けている最中の接触（避け方が足りなかった） */
  contactsWhileAvoiding: number;
  avoids: number;
  /** 接触はしなかったが、隙間が 0.03 未満まで近づいた回避 */
  nearMisses: number;
  avgLatencyMs: number | null;
};

const NEAR_MISS_GAP = 0.03;

export function metricsOf(e: Episode): EpisodeMetrics {
  const min = e.durationMs / 60000;
  return {
    durationS: Math.round(e.durationMs / 1000),
    contacts: e.contacts.length,
    contactsPerMin: min > 0 ? Math.round((e.contacts.length / min) * 10) / 10 : 0,
    contactsUnaware: e.contacts.filter((c) => c.avoidingForMs === null).length,
    contactsWhileAvoiding: e.contacts.filter((c) => c.avoidingForMs !== null).length,
    avoids: e.avoids.length,
    nearMisses: e.avoids.filter((a) => !a.contacted && a.minGap < NEAR_MISS_GAP).length,
    avgLatencyMs: e.avgLatencyMs,
  };
}

type BoltNote = {
  state: AutopilotState;
  judgedAt: number | null;
  latencyMs: number | null;
};

export class EpisodeRecorder {
  private ep: Episode | null = null;
  private bolt: BoltNote = { state: "off", judgedAt: null, latencyMs: null };
  private avoid: {
    start: number;
    with: BodyKind;
    minGap: number;
    contacted: boolean;
  } | null = null;
  private latencySum = 0;
  private latencyN = 0;
  private lastJudgedAt: number | null = null;

  get recording(): boolean {
    return this.ep !== null;
  }

  begin(policy: AvoidPolicy, ghostYields: boolean) {
    this.ep = {
      startedAt: Date.now(),
      durationMs: 0,
      policy: { ...policy },
      contacts: [],
      avoids: [],
      judgments: 0,
      avgLatencyMs: null,
      ghostYields,
    };
    this.avoid = null;
    this.latencySum = 0;
    this.latencyN = 0;
    this.lastJudgedAt = null;
  }

  /** 記録を終えて返す（記録していなければ null） */
  end(): Episode | null {
    const ep = this.ep;
    if (!ep) return null;
    this.avoidEnd();
    ep.durationMs = Date.now() - ep.startedAt;
    ep.avgLatencyMs = this.latencyN ? Math.round(this.latencySum / this.latencyN) : null;
    this.ep = null;
    return ep;
  }

  /** 自動操縦が状態を報告するたびに呼ぶ */
  noteBolt(n: BoltNote) {
    this.bolt = n;
    if (!this.ep || n.judgedAt === null || n.judgedAt === this.lastJudgedAt) return;
    this.lastJudgedAt = n.judgedAt;
    this.ep.judgments += 1;
    if (n.latencyMs !== null) {
      this.latencySum += n.latencyMs;
      this.latencyN += 1;
    }
  }

  avoidStart(withKind: BodyKind) {
    if (!this.ep || this.avoid) return;
    this.avoid = {
      start: Date.now(),
      with: withKind,
      minGap: Infinity,
      contacted: false,
    };
  }

  avoidEnd() {
    const a = this.avoid;
    if (!this.ep || !a) return;
    this.ep.avoids.push({
      t: a.start - this.ep.startedAt,
      durationMs: Date.now() - a.start,
      with: a.with,
      minGap: Number.isFinite(a.minGap) ? Math.round(a.minGap * 1000) / 1000 : 0,
      contacted: a.contacted,
    });
    this.avoid = null;
  }

  /** 世界が毎フレーム、BOLT と最も近い相手との隙間を知らせる */
  observeGap(gap: number) {
    if (this.avoid) this.avoid.minGap = Math.min(this.avoid.minGap, gap);
  }

  /** 世界が、BOLT が何かと重なり始めたときに呼ぶ */
  contact(withKind: BodyKind, ghostHeadingOffBolt: number | null) {
    const ep = this.ep;
    if (!ep) return;
    const now = Date.now();
    if (this.avoid) this.avoid.contacted = true;
    ep.contacts.push({
      t: now - ep.startedAt,
      with: withKind,
      boltState: this.bolt.state,
      avoidingForMs: this.avoid ? now - this.avoid.start : null,
      sinceJudgmentMs: this.bolt.judgedAt !== null ? now - this.bolt.judgedAt : null,
      latencyMs: this.bolt.latencyMs,
      ghostHeadingOffBolt: ghostHeadingOffBolt === null ? null : Math.round(ghostHeadingOffBolt),
    });
  }
}
