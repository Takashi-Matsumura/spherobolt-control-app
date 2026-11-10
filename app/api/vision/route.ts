// カメラ画像を TypeSafe Jev に送り、「BOLT が写っているか」の確率を返す。
// API キーはサーバ側（TYPESAFE_API_KEY）だけで扱い、ブラウザには渡さない。
// 仕様: https://docs.typesafe.ai/api, https://docs.typesafe.ai/images.md, https://docs.typesafe.ai/primitives/noul.md

import type { Box, VisionResult } from "@/lib/vision/types";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.14.0";
const TIMEOUT_MS = 5000;
// 640×360 の JPEG を想定。余裕を見て 2MB（base64 で約 2.7MB）まで受け付ける
const MAX_BASE64_LENGTH = 2_800_000;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_BODY_BYTES = MAX_BASE64_LENGTH + 1024;

// 料金の上限として、プロセス全体で 1 秒あたりの呼び出し回数を制限する。
// 自動操縦は最大でも約 3 回/秒なので、通常の利用では超えない。
const RATE_LIMIT_PER_SEC = 5;
const recentCalls: number[] = [];

function rateLimited(): boolean {
  const now = Date.now();
  while (recentCalls.length && now - recentCalls[0] > 1000) recentCalls.shift();
  if (recentCalls.length >= RATE_LIMIT_PER_SEC) return true;
  recentCalls.push(now);
  return false;
}

/** 上限を超えた時点で読むのをやめる（巨大なボディを全部メモリに載せない） */
async function readBodyLimited(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseBox(answer: unknown): Box | null {
  const a = answer as { box?: Record<string, unknown>; confidence?: unknown } | undefined;
  const b = a?.box;
  if (!b) return null;
  const edges = [b.top, b.bottom, b.left, b.right];
  if (!edges.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const [top, bottom, left, right] = edges as number[];
  // Box の confidence はドキュメント上「0〜1」だが、OpenAPI では null もあり得る
  const confidence = typeof a?.confidence === "number" ? a.confidence : null;
  return { top, bottom, left, right, confidence };
}

function fail(error: string, status: number) {
  return Response.json({ ok: false, error } satisfies VisionResult, { status });
}

export async function POST(request: Request) {
  // 他サイトのページ（ブラウザ）からこの API を呼ばれて課金されないよう、同一オリジンからの呼び出しだけ受け付ける。
  // ただし Origin / Host は curl などでは偽装できるため、認証の代わりにはならない。
  // ローカル利用が前提で、外部に公開する場合は認証を追加すること（README 参照）。
  const origin = request.headers.get("origin");
  if (!origin || !URL.canParse(origin) || new URL(origin).host !== request.headers.get("host")) {
    return fail("forbidden", 403);
  }

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return fail("TYPESAFE_API_KEY が設定されていません（.env.local を確認してください）", 500);

  if (rateLimited()) return fail("呼び出しが多すぎます", 429);

  const text = await readBodyLimited(request, MAX_BODY_BYTES);
  if (text === null) return fail("リクエストが大きすぎます", 413);

  let image: unknown;
  try {
    ({ image } = JSON.parse(text));
  } catch {
    return fail("リクエストが JSON ではありません", 400);
  }
  if (typeof image !== "string" || image.length > MAX_BASE64_LENGTH || !BASE64_RE.test(image)) {
    return fail("image は data: 接頭辞なしの base64 文字列で送ってください", 400);
  }

  const assetKey = crypto.randomUUID();
  const body = {
    model: MODEL,
    // 質問文から「photo」で画像を指せるよう、state をオブジェクトにする
    state: { photo: assetKey },
    assets: { [assetKey]: { type: "image", format: "jpeg", data_base64: image } },
    questions: {
      visible: {
        type: "noul",
        instructions:
          "Is a Sphero BOLT robot visible in photo? It is a small transparent spherical robot ball " +
          "(about 7 cm) with visible electronics and glowing LEDs inside.",
        criteria: {
          true: "The robot ball is visible in the image, even if only partially or at the edge of the frame.",
          false: "The robot ball is not in the image.",
        },
      },
      // Box は「見つからない」と答えず常に枠を返すので、visible と組み合わせて使う
      position: {
        type: "box",
        instructions: "the Sphero BOLT robot ball (small transparent sphere with glowing LEDs) in photo",
      },
    },
  };

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "TypeSafe-Danger-Zone-Images": "true",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return fail(`Jev に接続できません: ${(e as Error).message}`, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // エラー本文に入力が含まれることがあるので短く切る
    return fail(`Jev エラー ${res.status}: ${detail.slice(0, 300)}`, 502);
  }

  const json = (await res.json()) as {
    model?: string;
    answers?: { visible?: { noul?: unknown }; position?: unknown };
  };
  const visible = json.answers?.visible?.noul;
  if (typeof visible !== "number" || !Number.isFinite(visible)) {
    return fail("Jev の応答に判定が含まれていません", 502);
  }
  return Response.json({
    ok: true,
    visible,
    box: parseBox(json.answers?.position),
    latencyMs: Date.now() - started,
    model: json.model ?? MODEL,
  } satisfies VisionResult);
}
