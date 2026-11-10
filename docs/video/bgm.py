# Original BGM synthesized from scratch (no samples). I-vi-IV-V, 112 BPM.
import math, random, struct, sys, wave

SR = 44100
DUR = float(sys.argv[2])
N = int(SR * DUR)
BPM = 112
BEAT = 60 / BPM
BAR = BEAT * 4
DRUMS_IN = 9.0          # drums enter when the app footage starts
OUTRO = 38.0            # drums drop out on the end card

def hz(m): return 440 * 2 ** ((m - 69) / 12)
CHORDS = [[48, 52, 55], [45, 48, 52], [41, 45, 48], [43, 47, 50]]  # C Am F G
L = [0.0] * N
R = [0.0] * N

def add(t0, dur, fn, gain, pan=0.0):
    s0 = int(t0 * SR); s1 = min(N, s0 + int(dur * SR))
    gl, gr = gain * (1 - pan) / 2 * 2 ** 0.5, gain * (1 + pan) / 2 * 2 ** 0.5
    for i in range(s0, s1):
        v = fn((i - s0) / SR)
        L[i] += v * gl; R[i] += v * gr

nbars = int(DUR / BAR) + 1
random.seed(7)
for b in range(nbars):
    t = b * BAR
    ch = CHORDS[b % 4]
    # pad: soft detuned sines with slow attack
    for m in ch:
        f = hz(m + 12)
        add(t, BAR, lambda x, f=f: (math.sin(2*math.pi*f*x) + math.sin(2*math.pi*f*1.003*x)) * 0.5
            * min(1, x / 0.4) * min(1, (BAR - x) / 0.3), 0.05)
    # bass on beats 1 and 3
    for k in (0, 2):
        f = hz(ch[0] - 12)
        add(t + k * BEAT, BEAT * 1.8, lambda x, f=f: math.sin(2*math.pi*f*x) * math.exp(-x * 2.0), 0.22)
    # plucked arpeggio, 8th notes
    if t >= 3.5:
        pat = [0, 1, 2, 1, 2, 0, 1, 2]
        for k, idx in enumerate(pat):
            m = ch[idx] + 24 + (12 if k == 6 else 0)
            f = hz(m)
            def pluck(x, f=f):
                ph = (f * x) % 1.0
                tri = 4 * abs(ph - 0.5) - 1
                return tri * math.exp(-x * 9)
            add(t + k * BEAT / 2, BEAT / 2 * 1.5, pluck, 0.10, pan=(-0.4 if k % 2 else 0.4))
    # drums
    if DRUMS_IN - 0.01 <= t < OUTRO:
        for k in range(4):
            add(t + k * BEAT, 0.3, lambda x: math.sin(2*math.pi*(50 + 90*math.exp(-x*30))*x) * math.exp(-x * 12), 0.35)
            if k in (1, 3):
                add(t + k * BEAT, 0.18, lambda x: (random.random()*2-1) * math.exp(-x * 25), 0.10)
            add(t + k * BEAT + BEAT / 2, 0.06, lambda x: (random.random()*2-1) * math.exp(-x * 80), 0.05, pan=0.3)

# fades + soft clip
peak = max(max(abs(v) for v in L), max(abs(v) for v in R)) or 1
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    out = bytearray()
    for i in range(N):
        t = i / SR
        g = min(1, t / 1.0) * min(1, (DUR - t) / 2.5)
        for v in (L[i], R[i]):
            out += struct.pack("<h", int(math.tanh(v / peak * 1.2) * 0.85 * g * 32767))
    w.writeframes(bytes(out))
