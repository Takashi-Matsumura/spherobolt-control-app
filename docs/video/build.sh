#!/bin/bash
# 自動操縦の紹介動画を組み立てる。
#   使い方: docs/video/build.sh <画面収録.mov> [出力ディレクトリ]
# 出力: <出力ディレクトリ>/bolt-pilot-autopilot.mp4（BGM なし）と bolt-pilot-autopilot-bgm.mp4（BGM あり）
# 出力ディレクトリの既定値は docs/video/out（Git 管理外）。
set -euo pipefail

SRC="${1:?画面収録の動画ファイルを指定してください}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${2:-$HERE/out}"
mkdir -p "$OUT/cards"

# Pillow 用の仮想環境（docs/video/.venv、Git 管理外）
if [ ! -x "$HERE/.venv/bin/python" ]; then
  python3 -m venv "$HERE/.venv"
  "$HERE/.venv/bin/pip" -q install pillow
fi
PY="$HERE/.venv/bin/python"

# 1. キャプション画像・タイトル類
"$PY" -I "$HERE/captions.py" "$OUT/cards"
cd "$OUT/cards"

# 2. 画面収録からゲーム機の部分を切り抜く（2750x2046 の Retina 収録を前提にした座標）
V="crop=2464:1100:120:520,scale=1840:821:flags=lanczos,pad=1920:1080:40:40:color=0x0f1115,fps=30,format=yuv420p"

# seg <名前> <開始秒> <長さ> <速度> [<キャプション>:<表示開始>:<表示終了> ...]
seg() {
  local n=$1 ss=$2 d=$3 sp=$4; shift 4
  local inputs=(-ss "$ss" -t "$d" -i "$SRC") fc="[0:v]setpts=PTS/$sp,$V[v0]" i=1 last=v0 p a b
  for c in "$@"; do
    IFS=: read -r p a b <<<"$c"
    inputs+=(-i "$p.png")
    fc="$fc;[$last][$i:v]overlay=enable='between(t,$a,$b)'[v$i]"
    last=v$i; i=$((i + 1))
  done
  ffmpeg -v error -y "${inputs[@]}" -filter_complex "$fc" -map "[$last]" -an \
    -c:v libx264 -crf 18 -preset medium -r 30 "$OUT/seg_$n.mp4"
}

# card <名前> <秒数>（静止画を前後フェード付きで動画に）
card() {
  local st; st=$(echo "$2 - 0.4" | bc)
  ffmpeg -v error -y -loop 1 -t "$2" -i "$1.png" \
    -vf "fps=30,format=yuv420p,fade=in:d=0.4,fade=out:st=$st:d=0.4" \
    -c:v libx264 -crf 18 -r 30 "$OUT/seg_$1.mp4"
}

card title 3.5
card how 5.5
card end 4

# 区間とキャプションの対応は 2026-11-11 撮影のサンプル収録に合わせたもの。
# 別の収録を使うときは、状態の切り替わる秒数を見て書き換える。
seg A  0.5   10  1   c1:0:3 c2:3:11      # 開始 → 向き合わせ
seg B  10.5  1.7 0.5 c3:0:4              # 走行（0.5 倍速）
seg D1 17.3  2.7 1   c4:0:3              # 引き返し
seg C  12.75 3   1   c5:0:4              # 停止（見失い）
seg D2 20.0  9.8 1   c6:0:5 c7:5:10      # ステータス表示 → くり返し

# 3. 連結（無音トラック付き）
cd "$OUT"
printf "file '%s'\n" seg_title.mp4 seg_how.mp4 seg_A.mp4 seg_B.mp4 seg_D1.mp4 seg_C.mp4 seg_D2.mp4 seg_end.mp4 > list.txt
ffmpeg -v error -y -f concat -safe 0 -i list.txt -f lavfi -i anullsrc=r=48000:cl=stereo \
  -c:v libx264 -crf 20 -preset slow -pix_fmt yuv420p -movflags +faststart -c:a aac -shortest \
  bolt-pilot-autopilot.mp4

# 4. BGM を合成して差し替え
DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 bolt-pilot-autopilot.mp4)
"$PY" -I "$HERE/bgm.py" bgm.wav "$DUR"
ffmpeg -v error -y -i bolt-pilot-autopilot.mp4 -i bgm.wav -map 0:v -map 1:a -c:v copy \
  -af "loudnorm=I=-18:TP=-1.5:LRA=11" -ar 48000 -c:a aac -b:a 192k -shortest -movflags +faststart \
  bolt-pilot-autopilot-bgm.mp4

echo "完成: $OUT/bolt-pilot-autopilot-bgm.mp4"
