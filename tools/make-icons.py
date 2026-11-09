#!/usr/bin/env python3
"""Generate the extension icons (16/32/48/128 px) with Pillow.

A teal rounded square holding a white shield, with a two-way arrow cut through it
to hint at "masked going in, restored coming out". Drawn at 1024px and downsampled
with LANCZOS so the small sizes stay crisp.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "icons"
OUT.mkdir(exist_ok=True)
S = 1024


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def build():
    # vertical gradient background
    top, bot = (45, 212, 191), (13, 116, 144)
    bg = Image.new("RGB", (S, S))
    px = bg.load()
    for y in range(S):
        c = lerp(top, bot, y / (S - 1))
        for x in range(S):
            px[x, y] = c

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(bg, (0, 0), mask)

    d = ImageDraw.Draw(img)
    cx = S // 2

    # shield outline: right half as a polyline + quadratic Bezier, then mirrored for the left half
    def shield(inset):
        half = S * 0.28 - inset
        top_y = S * 0.17 + inset
        mid_y = S * 0.52
        bot_y = S * 0.86 - inset
        r = cx + half
        right = [(cx, top_y - S * 0.02), (r, top_y + S * 0.05), (r, mid_y)]
        p0, p1, p2 = (r, mid_y), (r, bot_y - (bot_y - mid_y) * 0.28), (cx, bot_y)
        steps = 40
        for i in range(1, steps + 1):
            t = i / steps
            x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0]
            y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1]
            right.append((x, y))
        left = [(2 * cx - x, y) for (x, y) in reversed(right[1:-1])]
        return right + left

    d.polygon(shield(0), fill=(255, 255, 255, 255))
    d.polygon(shield(S * 0.045), fill=(13, 94, 112, 255))

    # two-way arrow across the shield
    white = (255, 255, 255, 255)
    y1, y2 = S * 0.43, S * 0.60
    lw = int(S * 0.04)
    x0, x1 = cx - S * 0.17, cx + S * 0.17
    h = S * 0.06
    d.line((x0, y1, x1, y1), fill=white, width=lw)
    d.polygon([(x1 + h, y1), (x1 - h * 0.3, y1 - h), (x1 - h * 0.3, y1 + h)], fill=white)
    d.line((x0, y2, x1, y2), fill=white, width=lw)
    d.polygon([(x0 - h, y2), (x0 + h * 0.3, y2 - h), (x0 + h * 0.3, y2 + h)], fill=white)
    return img


def main():
    base = build()
    for size in (16, 32, 48, 128):
        base.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
    base.resize((512, 512), Image.LANCZOS).save(OUT / "icon512-preview.png")
    print("wrote", sorted(p.name for p in OUT.iterdir()))


if __name__ == "__main__":
    main()
