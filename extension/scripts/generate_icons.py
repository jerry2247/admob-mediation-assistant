"""Generate clean extension icons (rounded blue tile + chat bubble + check).
Supersampled 4x then downsampled for crisp edges. Output: public/icons/icon-*.png
"""
from pathlib import Path
from PIL import Image, ImageDraw

BLUE = (26, 115, 232)
OUT = Path(__file__).resolve().parents[1] / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def make(size: int) -> Image.Image:
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # flat Google Blue tile (a continuous cross-hue gradient reads as generic slop)
    grad = Image.new("RGB", (S, S), BLUE)

    # rounded mask
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    # speech bubble
    bl, bt, br, bb = S * 0.2, S * 0.21, S * 0.8, S * 0.6
    d.rounded_rectangle([bl, bt, br, bb], radius=int(S * 0.12), fill=(255, 255, 255, 255))
    d.polygon([(S * 0.31, bb - S * 0.02), (S * 0.31, S * 0.74), (S * 0.47, bb - S * 0.02)],
              fill=(255, 255, 255, 255))
    # check mark in blue
    pts = [(S * 0.345, S * 0.41), (S * 0.44, S * 0.5), (S * 0.655, S * 0.3)]
    w = int(S * 0.055)
    d.line(pts, fill=BLUE, width=w, joint="curve")
    r = w / 2
    for (x, y) in pts:
        d.ellipse([x - r, y - r, x + r, y + r], fill=BLUE)

    return img.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    make(s).save(OUT / f"icon-{s}.png")
print("icons ->", OUT)
