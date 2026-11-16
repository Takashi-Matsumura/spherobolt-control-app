// API ルートで共通に使う、リクエストの確かめ方と読み方（サーバ側）。

/**
 * 同一オリジン（このアプリのページ）からの呼び出しか。
 * 他サイトのページ（ブラウザ）から API を呼ばれないようにするためのもの。
 * Origin / Host は curl などでは偽装できるため、認証の代わりにはならない。
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !!origin && URL.canParse(origin) && new URL(origin).host === request.headers.get("host");
}

/** 上限を超えた時点で読むのをやめる（巨大なボディを全部メモリに載せない） */
export async function readBodyLimited(request: Request, limit: number): Promise<string | null> {
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
