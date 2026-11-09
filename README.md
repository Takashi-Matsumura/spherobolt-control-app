# Sphero BOLT コントローラー（プロトタイプ）

Sphero BOLT をブラウザから直接操作する Web アプリです。Web Bluetooth で BOLT に接続し、
公式アプリ（Sphero Edu）を使わずに走行やライトを制御します。
さらに iPhone のカメラを「目」として使い、AI（TypeSafe Jev）の判定で BOLT を自動操縦できます。

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
- **目（カメラ）**：Mac に接続した iPhone のカメラ映像を表示（macOS の連係カメラ）
- **自動操縦（Jev）**：カメラに BOLT が写っている間だけランダムに走り、見えなくなったら止まる

## 動作環境

- **PC 版の Chrome または Edge**（Web Bluetooth が必要です）
  - Safari、Firefox、iPhone / iPad のブラウザでは動きません
- Node.js 20.9 以上
- Sphero BOLT（BOLT+ は画面が異なるため未対応）
- 目・自動操縦を使う場合
  - macOS の連係カメラが使える Mac と iPhone（同じ Apple アカウントでサインイン）
  - [TypeSafe](https://console.typesafe.ai/keys) の API キー

## 使い方

```bash
npm install
npm run dev
```

1. Chrome で http://localhost:3000 を開く
2. 「BOLT に接続」を押し、一覧から `SB-xxxx` を選ぶ
3. 走行ボタンやライトのボタンで操作する

### 自動操縦を使う

1. プロジェクト直下に `.env.local` を作り、TypeSafe の API キーを書く（このファイルはコミットされません）

   ```
   TYPESAFE_API_KEY=your-api-key
   ```

2. 「カメラを開始」を押す（iPhone のカメラがあれば自動で選ばれます）
3. BOLT に接続し、「自動操縦を開始」を押す
4. 映像の左上に、状態（走行中 / 停止中）、BOLT が写っている確率、応答時間が表示されます

最初は速度を低め（10〜40）にし、机から落ちない広い場所で試してください。

#### 仕組みと安全設計

- 0.3 秒おき以上の間隔で、カメラの 1 コマ（640×360 の JPEG）をサーバ側の `/api/vision` に送ります。
  サーバが Jev（`jev-1.14.0`）に「BOLT は写っているか」を問い合わせ、確率を返します。
- 確率が基準（初期値 70%）以上なら走り、2 秒ごとに向きを変えます。
- **止まる側に倒す設計です。** 次のどれでも停止します。
  - 確率が基準を下回った
  - 通信や判定でエラーが起きた
  - 「写っている」という判定が 1.5 秒以上届かない（見張りタイマー）
- BOLT の切断やカメラの停止で、自動操縦も解除されます。
- API キーはサーバ側だけで使い、ブラウザには渡しません。`/api/vision` は同じオリジンからの呼び出しだけを受け付けます。
- 判定の遅れ（実測で 0.2〜0.4 秒程度）の分だけ進むため、画面の端ぎりぎりでは止まりきれないことがあります。

> Jev の画像入力は、TypeSafe 自身が「実験的機能で本番向けではない」としています
> （リクエストに `TypeSafe-Danger-Zone-Images: true` ヘッダーが必要）。

### うまく動かないとき

- **すぐにスリープする / コマンドがタイムアウトする**：電池切れの可能性があります。
  充電台に載せてから「電池を診断」で確認してください（満充電で約 4.2V）。
- **何も操作しないと約 8 分でスリープします。** 「起こす (wake)」を押すか、接続し直してください。
- **初回の接続で `No Services matching UUID` と出る**：もう一度接続すると成功することがあります。
- **開発中にコードを修正したら**、ページを再読み込みして接続し直してください。
  接続中のオブジェクトは修正前の定義のまま残ります。
- **カメラが映らない**：iPhone のロックを解除し、Chrome にカメラの使用を許可してください
  （システム設定 → プライバシーとセキュリティ → カメラ）。
- **自動操縦で「TYPESAFE_API_KEY が設定されていません」と出る**：`.env.local` を確認し、反映されなければ開発サーバを再起動してください。

## 構成

| ファイル | 役割 |
|---|---|
| `lib/bolt/protocol.ts` | Sphero API v2 のパケットの組み立てと解析 |
| `lib/bolt/bolt.ts` | Web Bluetooth での接続と、BOLT の操作 API |
| `app/bolt-controller.tsx` | BOLT の操作画面 |
| `app/camera-view.tsx` | カメラ映像の表示 |
| `app/autopilot.tsx` | 自動操縦（判定ループ、走行・停止、見張りタイマー） |
| `app/robot-app.tsx` | カメラ・BOLT・自動操縦を束ねる親部品 |
| `app/api/vision/route.ts` | 画像を Jev に送って判定するサーバ側 API |

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
