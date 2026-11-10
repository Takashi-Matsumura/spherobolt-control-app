import os, sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
W, H = 1920, 1080
F = "/System/Library/Fonts/ヒラギノ角ゴシック W{}.ttc"
def font(w, s): return ImageFont.truetype(F.format(w), s)

BG = (15, 17, 21)
FG = (240, 242, 245)
SUB = (160, 168, 180)
COL = {
    "start": (240, 140, 20), "cal": (40, 130, 210), "run": (30, 170, 100),
    "ret": (230, 120, 20), "stop": (215, 40, 50), "info": (120, 130, 145),
}

def centered(d, y, text, f, fill):
    w = d.textlength(text, font=f)
    d.text(((W - w) / 2, y), text, font=f, fill=fill)

# --- caption overlays (transparent, band at bottom) ---
CAPS = [
    ("c1", "start", "開始", "A ボタンで自動操縦をスタート", "iPhone のカメラ映像を AI（Jev）が判定して、BOLT を探します"),
    ("c2", "cal", "向き合わせ", "まず BOLT を少しずつ走らせて、向きを合わせます", "映像の中で進んだ方向から、BOLT の向きとカメラの向きを対応づけます"),
    ("c3", "run", "走行", "BOLT が見えている間は、ランダムに走ります", "緑の実線の枠は「予測した現在地」— どちらへ向かわせているかが分かります"),
    ("c4", "ret", "引き返し", "画面の端（点線の外）に近づくと、中央へ引き返します", "カメラの外へ出ていかないように走らせます"),
    ("c5", "stop", "停止", "見えなくなったら、すぐに止まります", "見失ったまま走り続けないので安心です"),
    ("c6", "info", "ステータス", "左上に「状態・BOLT が写っている確率・AI の応答時間」", "走行（緑）／引き返し（オレンジ）／停止（赤）が色で分かります"),
    ("c7", "run", "くり返し", "走る → 端で引き返す、を自動でくり返します", "Esc キーまたは A ボタンでいつでも停止できます"),
]
for name, kind, chip, main, sub in CAPS:
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 880, W, H], fill=BG + (255,))
    fc = font(6, 30)
    cw = d.textlength(chip, font=fc) + 44
    x0 = 80
    d.rounded_rectangle([x0, 912, x0 + cw, 960], radius=10, fill=COL[kind])
    d.text((x0 + 22, 918), chip, font=fc, fill=(255, 255, 255))
    d.text((x0 + cw + 28, 908), main, font=font(6, 46), fill=FG)
    d.text((x0 + cw + 28, 980), sub, font=font(3, 32), fill=SUB)
    im.save(f"{OUT}/{name}.png")

# --- title card ---
im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
centered(d, 330, "BOLT PILOT", font(6, 40), (30, 170, 100))
centered(d, 400, "自動操縦", font(7, 120), FG)
centered(d, 580, "AI の目で、Sphero BOLT を走らせる", font(4, 48), SUB)
im.save(f"{OUT}/title.png")

# --- how it works card ---
im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
centered(d, 150, "しくみ", font(6, 64), FG)
boxes = [("iPhone カメラ", "連係カメラで映像を取得"), ("AI（Jev）", "BOLT の位置を判定"),
         ("ブラウザ", "走る向きと速さを決める"), ("BOLT", "Web Bluetooth で命令")]
bw, bh, gap = 360, 220, 70
sx = (W - (bw * 4 + gap * 3)) / 2
for i, (t, s) in enumerate(boxes):
    x = sx + i * (bw + gap); y = 380
    d.rounded_rectangle([x, y, x + bw, y + bh], radius=24, outline=(30, 170, 100), width=4, fill=(24, 28, 34))
    tw = d.textlength(t, font=font(6, 44)); d.text((x + (bw - tw) / 2, y + 50), t, font=font(6, 44), fill=FG)
    sw = d.textlength(s, font=font(3, 28)); d.text((x + (bw - sw) / 2, y + 130), s, font=font(3, 28), fill=SUB)
    if i < 3:
        ax = x + bw + 12; ay = y + bh / 2
        d.line([ax, ay, ax + gap - 24, ay], fill=(30, 170, 100), width=6)
        d.polygon([(ax + gap - 24, ay - 14), (ax + gap - 6, ay), (ax + gap - 24, ay + 14)], fill=(30, 170, 100))
centered(d, 720, "カメラに写っている間だけ走り、見えなくなったら止まります", font(4, 40), SUB)
im.save(f"{OUT}/how.png")

# --- end card ---
im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
centered(d, 320, "BOLT Pilot", font(7, 110), FG)
centered(d, 480, "自動操縦", font(6, 52), (30, 170, 100))
centered(d, 600, "PC 版 Chrome / Edge ・ iPhone 連係カメラ ・ TypeSafe Jev", font(3, 36), SUB)
centered(d, 680, "※ 非公式プロジェクトです（Sphero 社とは関係ありません）", font(3, 28), (110, 118, 130))
im.save(f"{OUT}/end.png")
