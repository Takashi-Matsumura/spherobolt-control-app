// Web Bluetooth で Sphero BOLT を操作する最小クライアント。
// UUID・コマンド ID は spherov2.py（非公式）を参照。実機で未検証の値を含む。

import { encode, ErrorNames, Packet, PacketCollector, Target } from "./protocol";

const API_SERVICE = "00010001-574f-4f20-5370-6865726f2121";
const API_CHAR = "00010002-574f-4f20-5370-6865726f2121"; // 送受信兼用（UART）
const DFU_SERVICE = "00020001-574f-4f20-5370-6865726f2121";
const ANTI_DOS_CHAR = "00020005-574f-4f20-5370-6865726f2121";
const ANTI_DOS_KEY = new TextEncoder().encode("usetheforce...band");

const Device = { power: 0x13, drive: 0x16, io: 0x1a } as const;

const RESPONSE_TIMEOUT_MS = 3000;

type Pending = { resolve: (p: Packet) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export type LogFn = (msg: string) => void;

export class Bolt {
  private device?: BluetoothDevice;
  private char?: BluetoothRemoteGATTCharacteristic;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private log: LogFn = () => {}, private onDisconnect: () => void = () => {}) {}

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  get name(): string | undefined {
    return this.device?.name;
  }

  async connect(): Promise<void> {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "SB-" }],
      optionalServices: [API_SERVICE, DFU_SERVICE],
    });
    this.device = device;
    device.addEventListener("gattserverdisconnected", () => {
      this.log("切断されました");
      this.rejectAll(new Error("切断されました"));
      this.char = undefined;
      this.onDisconnect();
    });

    this.log(`${device.name} に接続中…`);
    const server = await device.gatt!.connect();

    const dfu = await server.getPrimaryService(DFU_SERVICE);
    const antiDos = await dfu.getCharacteristic(ANTI_DOS_CHAR);
    await antiDos.writeValueWithResponse(ANTI_DOS_KEY);

    const api = await server.getPrimaryService(API_SERVICE);
    const char = await api.getCharacteristic(API_CHAR);
    const collector = new PacketCollector(
      (p) => this.handlePacket(p),
      (e) => this.log(`受信エラー: ${e.message}`),
    );
    char.addEventListener("characteristicvaluechanged", (ev) => {
      const v = (ev.target as BluetoothRemoteGATTCharacteristic).value!;
      collector.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    });
    await char.startNotifications();
    this.char = char;

    await this.wake();
    this.log("接続完了");
  }

  disconnect() {
    this.device?.gatt?.disconnect();
  }

  // ---- 高レベル API ----

  wake() {
    return this.send(Device.power, 0x0d);
  }

  sleep() {
    return this.send(Device.power, 0x01);
  }

  async getBatteryVoltage(): Promise<number> {
    const p = await this.send(Device.power, 0x03);
    return ((p.data[0] << 8) | p.data[1]) / 100;
  }

  /** 電圧状態（BOLT 自身の判定） */
  async getBatteryVoltageState(): Promise<string> {
    const v = (await this.send(Device.power, 0x17)).data[0];
    return ["unknown", "ok", "low", "critical"][v] ?? `不明(${v})`;
  }

  /** 充電状態 */
  async getChargerState(): Promise<string> {
    const v = (await this.send(Device.power, 0x1f)).data[0];
    return ["unknown", "not_charging", "charging", "charged"][v] ?? `不明(${v})`;
  }

  /** 8x8 マトリクス全体を単色にする */
  setMatrixColor(r: number, g: number, b: number) {
    return this.send(Device.io, 0x2f, [r, g, b], Target.secondary);
  }

  /** マトリクスの 1 点（x = 列、y = 行。0-7） */
  setMatrixPixel(x: number, y: number, [r, g, b]: [number, number, number]) {
    return this.send(Device.io, 0x2d, [x, y, r, g, b], Target.secondary);
  }

  /** マトリクスに線を引く（両端を含む） */
  drawMatrixLine(x1: number, y1: number, x2: number, y2: number, [r, g, b]: [number, number, number]) {
    return this.send(Device.io, 0x3d, [x1, y1, x2, y2, r, g, b], Target.secondary);
  }

  /**
   * 前後の LED（各 RGB）。mask の bit0-2 = 前 RGB、bit3-5 = 後 RGB。
   * 値は mask で立てたビットの分だけ、ビット順に並べる。
   */
  private setLeds(mask: number, values: number[]) {
    return this.send(Device.io, 0x1a, [0, 0, 0, mask, ...values], Target.primary);
  }

  setFrontLed(rgb: [number, number, number]) {
    return this.setLeds(0b000111, rgb);
  }

  setBackLed(rgb: [number, number, number]) {
    return this.setLeds(0b111000, rgb);
  }

  setFrontBackLeds(front: [number, number, number], back: [number, number, number]) {
    return this.setLeds(0b111111, [...front, ...back]);
  }

  /** speed: 0-255, heading: 0-359 度, reverse: 後退 */
  roll(speed: number, heading: number, reverse = false) {
    const h = ((Math.round(heading) % 360) + 360) % 360;
    const s = Math.max(0, Math.min(255, Math.round(speed)));
    return this.send(Device.drive, 0x07, [s, h >> 8, h & 0xff, reverse ? 0x01 : 0x00], Target.secondary);
  }

  stop(heading = 0) {
    return this.roll(0, heading);
  }

  resetYaw() {
    return this.send(Device.drive, 0x06, [], Target.secondary);
  }

  // ---- 低レベル ----

  /** コマンドを直列に送り、応答を待つ */
  send(did: number, cid: number, data: number[] = [], tid?: number): Promise<Packet> {
    const run = () => this.sendNow(did, cid, data, tid);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  private async sendNow(did: number, cid: number, data: number[], tid?: number): Promise<Packet> {
    if (!this.char) throw new Error("未接続です");
    const seq = this.seq;
    this.seq = (this.seq + 1) % 0xff;
    const bytes = encode({ did, cid, seq, data, tid });
    const key = `${did}:${cid}:${seq}`;

    const response = new Promise<Packet>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`応答タイムアウト (did=0x${hex(did)} cid=0x${hex(cid)})`));
      }, RESPONSE_TIMEOUT_MS);
      this.pending.set(key, { resolve, reject, timer });
    });

    // BLE の1回の書き込みは 20 バイトまでに分割する（spherov2.py と同じ）
    for (let i = 0; i < bytes.length; i += 20) {
      await this.char.writeValueWithResponse(bytes.slice(i, i + 20));
    }
    return response;
  }

  private handlePacket(p: Packet) {
    const key = `${p.did}:${p.cid}:${p.seq}`;
    const pending = this.pending.get(key);
    if (!pending) {
      const name = NOTIFY_NAMES[`${p.did}:${p.cid}`];
      this.log(
        `通知 did=0x${hex(p.did)} cid=0x${hex(p.cid)}${name ? `（${name}）` : ""} data=[${p.data.map(hex).join(" ")}]`,
      );
      return;
    }
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (p.err) pending.reject(new Error(`エラー応答: ${ErrorNames[p.err] ?? p.err}`));
    else pending.resolve(p);
  }

  private rejectAll(e: Error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(e);
    }
    this.pending.clear();
  }
}

// spherov2.py の定義より
const NOTIFY_NAMES: Record<string, string> = {
  [`${Device.power}:${0x06}`]: "電池状態が変化",
  [`${Device.power}:${0x19}`]: "まもなくスリープ",
  [`${Device.power}:${0x1a}`]: "スリープしました",
  [`${Device.power}:${0x1c}`]: "電圧状態が変化",
  [`${Device.power}:${0x21}`]: "充電状態が変化",
};

function hex(n: number) {
  return n.toString(16).padStart(2, "0");
}
