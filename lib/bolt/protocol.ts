// Sphero API v2 パケットのエンコード/デコード。
// 仕様は公式ドキュメントが無いため、spherov2.py（非公式・解析ベース）の実装に準拠している。
// [SOP, FLAGS, TID?, SID?, DID, CID, SEQ, ERR?(応答のみ), DATA..., CHK, EOP]

export const SOP = 0x8d;
export const EOP = 0xd8;
const ESC = 0xab;
const ESC_ESC = 0x23;
const ESC_SOP = 0x05;
const ESC_EOP = 0x50;

export const Flags = {
  isResponse: 0x01,
  requestsResponse: 0x02,
  requestsOnlyErrorResponse: 0x04,
  resetsInactivityTimeout: 0x08,
  hasTargetId: 0x10,
  hasSourceId: 0x20,
} as const;

/** BOLT は2つのプロセッサを持ち、コマンドごとに送り先が決まっている */
export const Target = {
  primary: 0x11, // Nordic（BLE・電源・前後LED）
  secondary: 0x12, // ST（走行・LEDマトリクス・センサー）
} as const;

export interface Packet {
  flags: number;
  tid?: number;
  sid?: number;
  did: number;
  cid: number;
  seq: number;
  err?: number;
  data: number[];
}

export function checksum(bytes: number[]): number {
  let sum = 0;
  for (const b of bytes) sum += b;
  return 0xff - (sum & 0xff);
}

export function encode(p: Omit<Packet, "flags" | "err"> & { flags?: number }): Uint8Array {
  let flags = p.flags ?? Flags.requestsResponse | Flags.resetsInactivityTimeout;
  if (p.tid !== undefined) flags |= Flags.hasTargetId | Flags.hasSourceId;

  const body: number[] = [flags];
  if (p.tid !== undefined) body.push(p.tid, p.sid ?? 0x01);
  body.push(p.did, p.cid, p.seq & 0xff, ...p.data);
  body.push(checksum(body));

  const out: number[] = [SOP];
  for (const b of body) {
    if (b === ESC) out.push(ESC, ESC_ESC);
    else if (b === SOP) out.push(ESC, ESC_SOP);
    else if (b === EOP) out.push(ESC, ESC_EOP);
    else out.push(b);
  }
  out.push(EOP);
  return Uint8Array.from(out);
}

/** SOP〜EOP を含む1パケット分のバイト列をデコードする */
export function decode(raw: number[]): Packet {
  if (raw[0] !== SOP || raw[raw.length - 1] !== EOP) {
    throw new Error("パケットの開始/終了バイトが不正です");
  }
  const bytes: number[] = [];
  for (let i = 1; i < raw.length - 1; i++) {
    let b = raw[i];
    if (b === ESC) {
      const n = raw[++i];
      b = n === ESC_ESC ? ESC : n === ESC_SOP ? SOP : n === ESC_EOP ? EOP : -1;
      if (b < 0) throw new Error("不正なエスケープシーケンスです");
    }
    bytes.push(b);
  }
  const chk = bytes.pop();
  if (checksum(bytes) !== chk) throw new Error("チェックサム不一致");

  let i = 0;
  const flags = bytes[i++];
  const tid = flags & Flags.hasTargetId ? bytes[i++] : undefined;
  const sid = flags & Flags.hasSourceId ? bytes[i++] : undefined;
  const did = bytes[i++];
  const cid = bytes[i++];
  const seq = bytes[i++];
  const err = flags & Flags.isResponse ? bytes[i++] : undefined;
  return { flags, tid, sid, did, cid, seq, err, data: bytes.slice(i) };
}

/** BLE 通知は任意の位置で分割されて届くため、EOP 単位で組み立て直す */
export class PacketCollector {
  private buf: number[] = [];
  private onPacket: (p: Packet) => void;
  private onError: (e: Error) => void;

  constructor(onPacket: (p: Packet) => void, onError: (e: Error) => void) {
    this.onPacket = onPacket;
    this.onError = onError;
  }

  push(chunk: Uint8Array) {
    for (const b of chunk) {
      if (b === SOP) this.buf = [];
      this.buf.push(b);
      if (b === EOP) {
        const pkt = this.buf;
        this.buf = [];
        try {
          this.onPacket(decode(pkt));
        } catch (e) {
          this.onError(e as Error);
        }
      }
    }
  }
}

export const ErrorNames: Record<number, string> = {
  0x00: "success",
  0x01: "bad_device_id",
  0x02: "bad_command_id",
  0x03: "not_yet_implemented",
  0x04: "command_is_restricted",
  0x05: "bad_data_length",
  0x06: "command_failed",
  0x07: "bad_parameter_value",
  0x08: "busy",
  0x09: "bad_target_id",
  0x0a: "target_unavailable",
};
