# Renders icons/icon{16,32,48,128}.png. Needs Pillow: python3 store/icon.py
# Ink square, three lyric lines; the middle one is half "sung" in highlighter yellow.
from pathlib import Path
from PIL import Image, ImageDraw

INK = (20, 20, 19, 255)
PAPER = (242, 238, 230)
HIGHLIGHT = (255, 210, 63, 255)
S = 1024  # draw large, downscale for clean edges

icon = Image.new("RGBA", (S, S))
d = ImageDraw.Draw(icon)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=INK)

h = int(S * 0.12)
x0 = int(S * 0.19)


def bar(cy, x1, fill):
    y = int(S * cy)
    d.rounded_rectangle([x0, y - h // 2, int(S * x1), y + h // 2], radius=h // 2, fill=fill)


dim = PAPER + (80,)
bar(0.29, 0.62, dim)
bar(0.50, 0.81, PAPER + (255,))
bar(0.50, 0.55, HIGHLIGHT)  # sung part of the current line
bar(0.71, 0.50, dim)

out = Path(__file__).resolve().parent.parent / "icons"
for size in (16, 32, 48, 128):
    icon.resize((size, size), Image.LANCZOS).save(out / f"icon{size}.png")
