// 走行記録をローカルの AI（llama-server などの OpenAI 互換 API）に読ませ、
// 気づき・教訓・判断の基準を言葉にさせ、回避の基準（数値）を見直させる。
// 接続先は環境変数 LOCAL_LLM_URL（既定は http://127.0.0.1:8080）。ブラウザからは指定できない。

import { type RunSummary, type Verdict, compareRuns } from "@/lib/sim/compare";
import { type Episode, type EpisodeMetrics, metricsOf } from "@/lib/sim/episode";
import { type AvoidPolicy, POLICY_KEYS, POLICY_SPEC, type PolicyKey, clampPolicy } from "@/lib/sim/policy";
import type { PastReflection, PolicyChange, ReflectRequest, ReflectResponse } from "@/lib/sim/reflection";
import { isSameOrigin, readBodyLimited } from "@/lib/server/request";

const LLM_URL = process.env.LOCAL_LLM_URL ?? "http://127.0.0.1:8080";
/** ローカルの AI は遅いので長めに待つ */
const TIMEOUT_MS = 180_000;
const MAX_BODY_BYTES = 200_000;
/** プロンプトに載せる接触・回避の件数の上限（新しいものを優先） */
const MAX_EVENTS = 25;
/** 1 回の振り返りで、各数値を範囲の何割まで動かしてよいか（急に変えすぎない） */
const MAX_STEP_RATIO = 0.25;
const MAX_CHANGES = 3;

let busy = false;

function fail(error: string, status: number) {
  return Response.json({ ok: false, error } satisfies ReflectResponse, {
    status,
  });
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3));

function buildPrompt(ep: Episode, criteria: string[], history: PastReflection[], verdict: Verdict): string {
  const m = metricsOf(ep);
  const params = POLICY_KEYS.map(
    (k) =>
      `- ${k}（${POLICY_SPEC[k].label}）= ${fmt(ep.policy[k])}　範囲 ${POLICY_SPEC[k].min}〜${POLICY_SPEC[k].max}。${POLICY_SPEC[k].description}`,
  ).join("\n");
  // 位置補正による接触は回避の仕方では防げないので、AI には件数だけ伝える
  const contacts = ep.contacts
    .filter((c) => !c.jump)
    .slice(-MAX_EVENTS)
    .map((c) => ({
      経過秒: +(c.t / 1000).toFixed(1),
      相手: c.with,
      BOLTの状態: c.boltState,
      避け始めてからms: c.avoidingForMs,
      最後の判定からms: c.sinceJudgmentMs,
      判定の応答ms: c.latencyMs,
      ゴーストの向きとBOLTへの向きの差_度: c.ghostHeadingOffBolt,
    }));
  const avoids = ep.avoids.slice(-MAX_EVENTS).map((a) => ({
    経過秒: +(a.t / 1000).toFixed(1),
    相手: a.with,
    続いたms: a.durationMs,
    最も近づいた隙間: a.minGap,
    接触した: a.contacted,
  }));
  const past = history.length
    ? history
        .map(
          (h, i) =>
            `${i + 1} 回前: 接触 ${h.metrics.contacts} 回（${h.metrics.contactsPerMin} 回/分、気づく前 ${h.metrics.contactsUnaware}・回避中 ${h.metrics.contactsWhileAvoiding}）` +
            ` 変更: ${h.changes.map((c) => `${c.param} ${fmt(c.from)}→${fmt(c.to)}`).join(", ") || "なし"}` +
            ` 期待: ${h.expectation}`,
        )
        .join("\n")
    : "（今回が最初の振り返り）";

  return `あなたは、カメラで見下ろした床の上を走るロボット（Sphero BOLT）の自動操縦を、走行のたびに振り返って改善する担当です。
床には、映像の上にだけ存在する仮想の障害物と、仮想のロボット「ゴースト」がいます。BOLT はそれらにぶつからないように走るのが目標です。

## 仕組み
- BOLT の位置は、AI がカメラ画像を判定して求めます。判定には数百ミリ秒かかり、その間は走行命令から位置を予測します。
- BOLT は判定のたびに、相手との隙間が「避け始める隙間」より狭ければ、相手から離れる向きに走ります。
- ゴーストは${ep.ghostYields ? " BOLT を避けます" : " BOLT を避けず、気ままに走ります"}。

## 今の回避の基準（変えられる数値）
${params}

## 今回の走行（${m.durationS} 秒）
- 接触 ${m.contacts} 回（${m.contactsPerMin} 回/分）
  - 避けていない状態での接触（気づくのが遅れた）: ${m.contactsUnaware} 回
  - 避けている最中の接触: ${m.contactsWhileAvoiding} 回。避け始める隙間を広げると回避中の時間が長くなり、この数は増えやすくなる点に注意
- 位置補正による接触（上の接触数には含めない）: ${m.contactsJump ?? 0} 回。新しい判定で BOLT の位置が飛んだ結果の重なりで、予測のずれが原因。回避の数値では防げない
- 回避 ${m.avoids} 回、そのうちニアミス（接触はしなかったが隙間 0.03 未満）${m.nearMisses} 回
- 判定 ${ep.judgments} 回、平均の応答 ${m.avgLatencyMs ?? "不明"} ms

接触の記録:
${JSON.stringify(contacts)}

回避の記録:
${JSON.stringify(avoids)}

## 前回・最良との比較（アプリが計算した判定）
${verdict.text}
接触の回数は偶然でも揺れるので、「ばらつきの範囲内」の差は変更の効果とはみなさないこと。

## これまでの振り返り（新しい順）
${past}

## これまでの判断の基準
${criteria.length ? criteria.map((c) => `- ${c}`).join("\n") : "（まだありません）"}

## お願い
1. 記録から読み取れることを observations に書く（1〜4 個）。数字を根拠にする。
2. 今回の教訓を lessons に書く（1〜3 個）。
3. これまでの判断の基準を見直し、次から守る基準を criteria に書き直す（最大 5 個）。前回の変更で良くなったか悪くなったかも考える。
${
  verdict.reverted
    ? "4. 今回はアプリが最良の設定に戻すので、changes は空にする。"
    : `4. 数値の変更を changes に書く（0〜${MAX_CHANGES} 個）。1 回で大きく変えすぎない。比較の判定をもとに、悪くなった変更は戻し、差がばらつきの範囲内なら変えずにもう一度試すことも選べる。数値は下げてもよい。理由も書く。`
}
5. 次の走行で期待することを expectation に 1 文で書く。
すべて日本語で、短く具体的に書く。`;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    observations: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 4,
    },
    lessons: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 3,
    },
    criteria: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 5,
    },
    changes: {
      type: "array",
      maxItems: MAX_CHANGES,
      items: {
        type: "object",
        properties: {
          param: { type: "string", enum: POLICY_KEYS },
          value: { type: "number" },
          reason: { type: "string" },
        },
        required: ["param", "value", "reason"],
      },
    },
    expectation: { type: "string" },
  },
  required: ["observations", "lessons", "criteria", "changes", "expectation"],
};

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.slice(0, 300))
        .slice(0, max)
    : [];

/** AI の提案を、範囲と 1 回の変更幅に収めて適用する */
function applyChanges(policy: AvoidPolicy, raw: unknown): { policy: AvoidPolicy; changes: PolicyChange[] } {
  const next = { ...policy };
  const changes: PolicyChange[] = [];
  if (!Array.isArray(raw)) return { policy: next, changes };
  for (const c of raw.slice(0, MAX_CHANGES) as {
    param?: unknown;
    value?: unknown;
    reason?: unknown;
  }[]) {
    if (typeof c?.param !== "string" || !(POLICY_KEYS as string[]).includes(c.param)) continue;
    if (typeof c.value !== "number" || !Number.isFinite(c.value)) continue;
    const k = c.param as PolicyKey;
    const { min, max } = POLICY_SPEC[k];
    const step = (max - min) * MAX_STEP_RATIO;
    const from = policy[k];
    const to = clampPolicy({ [k]: Math.min(from + step, Math.max(from - step, c.value)) }, next)[k];
    if (Math.abs(to - from) < 1e-9) continue;
    next[k] = to;
    changes.push({
      param: k,
      from,
      to,
      reason: typeof c.reason === "string" ? c.reason.slice(0, 300) : "",
    });
  }
  return { policy: next, changes };
}

/** ブラウザから届いた過去の走行を、比較に使える形だけ残す */
function sanitizeRuns(raw: unknown): RunSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: RunSummary[] = [];
  for (const r of raw.slice(0, 30) as { metrics?: Partial<EpisodeMetrics>; policy?: unknown }[]) {
    const m = r?.metrics;
    if (!m || typeof m.contactsPerMin !== "number" || typeof m.durationS !== "number") continue;
    out.push({ metrics: m as EpisodeMetrics, policy: clampPolicy((r.policy ?? {}) as Record<string, unknown>) });
  }
  return out;
}

/** from から to への変更を、PolicyChange の一覧にする */
function revertTo(
  from: AvoidPolicy,
  to: AvoidPolicy,
  reason: string,
): { policy: AvoidPolicy; changes: PolicyChange[] } {
  const changes = POLICY_KEYS.filter((k) => Math.abs(from[k] - to[k]) > 1e-9).map((k) => ({
    param: k,
    from: from[k],
    to: to[k],
    reason,
  }));
  return { policy: { ...to }, changes };
}

export async function POST(request: Request) {
  // ローカル利用が前提。他サイトのページから呼ばれないよう、同一オリジンだけ受け付ける
  if (!isSameOrigin(request)) return fail("forbidden", 403);
  if (busy) return fail("振り返りの最中です", 429);

  const text = await readBodyLimited(request, MAX_BODY_BYTES);
  if (text === null) return fail("リクエストが大きすぎます", 413);
  let req: ReflectRequest;
  try {
    req = JSON.parse(text) as ReflectRequest;
  } catch {
    return fail("リクエストが JSON ではありません", 400);
  }
  const ep = req.episode;
  if (!ep || !Array.isArray(ep.contacts) || !Array.isArray(ep.avoids) || typeof ep.durationMs !== "number") {
    return fail("走行記録の形が正しくありません", 400);
  }
  ep.policy = clampPolicy(ep.policy ?? {});
  const criteria = strings(req.criteria, 5);
  const history = Array.isArray(req.history) ? req.history.slice(0, 5) : [];
  const runs = sanitizeRuns(req.runs);
  const current: RunSummary = { metrics: metricsOf(ep), policy: ep.policy };
  const { verdict, best } = compareRuns(current, runs);

  busy = true;
  const started = Date.now();
  try {
    let res: Response;
    try {
      res = await fetch(new URL("/v1/chat/completions", LLM_URL), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: buildPrompt(ep, criteria, history, verdict) }],
          temperature: 0.4,
          max_tokens: 2000,
          // gemma4 などの「考えてから答える」モデルは、考える部分で時間を使い切らないように切る
          chat_template_kwargs: { enable_thinking: false },
          response_format: {
            type: "json_schema",
            json_schema: { name: "reflection", schema: RESPONSE_SCHEMA },
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      return fail(`ローカルの AI（${LLM_URL}）に接続できません: ${(e as Error).message}`, 502);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return fail(`ローカルの AI のエラー ${res.status}: ${detail.slice(0, 300)}`, 502);
    }
    const json = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    let out: Record<string, unknown>;
    try {
      out = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return fail(`ローカルの AI の答えを読めませんでした: ${content.slice(0, 200)}`, 502);
    }
    // 最良より明らかに悪ければ、AI の提案は使わず最良の設定に戻す
    const { policy, changes } = verdict.reverted
      ? revertTo(ep.policy, best.policy, `最良（${best.metrics.contactsPerMin} 回/分）のときの設定に戻す`)
      : applyChanges(ep.policy, out.changes);
    const criteriaOut = strings(out.criteria, 5);
    return Response.json({
      ok: true,
      observations: strings(out.observations, 4),
      lessons: strings(out.lessons, 3),
      criteria: criteriaOut.length ? criteriaOut : criteria,
      changes,
      expectation: typeof out.expectation === "string" ? out.expectation.slice(0, 300) : "",
      policyAfter: policy,
      verdict,
      // llama-server はモデルのファイルパスを返すので、ファイル名だけにする
      model: (json.model ?? "local").split("/").pop() ?? "local",
      latencyMs: Date.now() - started,
    } satisfies ReflectResponse);
  } finally {
    busy = false;
  }
}
