# Sphero BOLT コントローラー（プロトタイプ）

Sphero BOLT をブラウザから直接操作する Web アプリです。Web Bluetooth で BOLT に接続し、
公式アプリ（Sphero Edu）を使わずに走行やライトを制御します。

自作のプログラミング環境を作るための土台として開発しています。

> **非公式プロジェクトです。** Sphero 社とは関係ありません。BOLT の通信仕様は公開されていないため、
> コミュニティによる解析結果（spherov2.py）をもとに実装しています。ファームウェアの更新などで
> 動かなくなる可能性があります。

## できること

- BOLT への接続・切断（Web Bluetooth）
- 走行：速度と向きを指定して走る / 停止 / 現在の向きを正面にする
- ライト：8x8 LED マトリクスの単色点灯、前 LED・後 LED の色指定、すべて消灯
- 電池診断：電圧、BOLT 自身の判定（ok / low / critical）、充電状態
- 通信ログの表示（スリープ通知などの意味も表示）

## 動作環境

- **PC 版の Chrome または Edge**（Web Bluetooth が必要です）
  - Safari、Firefox、iPhone / iPad のブラウザでは動きません
- Node.js 20.9 以上
- Sphero BOLT（BOLT+ は画面が異なるため未対応）

## 使い方

```bash
npm install
npm run dev
```

1. Chrome で http://localhost:3000 を開く
2. 「BOLT に接続」を押し、一覧から `SB-xxxx` を選ぶ
3. 走行ボタンやライトのボタンで操作する

### うまく動かないとき

- **すぐにスリープする / コマンドがタイムアウトする**：電池切れの可能性があります。
  充電台に載せてから「電池を診断」で確認してください（満充電で約 4.2V）。
- **何も操作しないと約 8 分でスリープします。** 「起こす (wake)」を押すか、接続し直してください。
- **初回の接続で `No Services matching UUID` と出る**：もう一度接続すると成功することがあります。
- **開発中にコードを修正したら**、ページを再読み込みして接続し直してください。
  接続中のオブジェクトは修正前の定義のまま残ります。

## 構成

| ファイル | 役割 |
|---|---|
| `lib/bolt/protocol.ts` | Sphero API v2 のパケットの組み立てと解析 |
| `lib/bolt/bolt.ts` | Web Bluetooth での接続と、BOLT の操作 API |
| `app/bolt-controller.tsx` | 操作画面 |

### 通信の概要

- BLE の UART 方式で、1 つの characteristic（`00010002-574f-4f20-5370-6865726f2121`）で送受信します。
- 接続直後に `00020005-…` へ `usetheforce...band` を書き込まないとコマンドを受け付けません。
- BOLT は 2 つのプロセッサを持ち、コマンドごとに送り先が決まっています。
  - `0x11`（primary）：電源、前後 LED
  - `0x12`（secondary）：走行、LED マトリクス、センサー
- 電池残量（%）の取得コマンドには対応していません（`bad_command_id` が返ります）。

## 謝辞

通信プロトコルの実装は [spherov2.py](https://github.com/artificial-intelligence-class/spherov2.py)（MIT License）を
参考にしています。詳細は [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) を参照してください。

## ライセンス

[MIT License](./LICENSE)

Sphero および Sphero BOLT は Sphero, Inc. の商標です。
