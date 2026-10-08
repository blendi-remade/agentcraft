# Minecraft-style Steam library artwork for the AgentCraft shortcut: cover, wide capsule, hero,
# logo and icon, drawn from the README screenshots. Usage: art.py OUT_DIR APPID (see art.sh).
import os, random, sys
from PIL import Image, ImageFilter, ImageEnhance
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SRC = os.path.join(ROOT, 'docs', 'img', 'readme') + os.sep
OUT, APPID = sys.argv[1], sys.argv[2]
random.seed(7)

FONT = {
 'A': ["011110","110011","110011","111111","110011","110011","110011"],
 'G': ["011111","110000","110000","110111","110011","110011","011111"],
 'E': ["111111","110000","110000","111110","110000","110000","111111"],
 'N': ["110011","111011","111111","110111","110011","110011","110011"],
 'T': ["111111","001100","001100","001100","001100","001100","001100"],
 'C': ["011111","110000","110000","110000","110000","110000","011111"],
 'R': ["111110","110011","110011","111110","110110","110011","110011"],
 'F': ["111111","110000","110000","111110","110000","110000","110000"],
}

def logo(text, cell):
    """Blocky stone letters with extruded depth and a dark outline, like the classic logo."""
    cols = sum(len(FONT[c][0]) + 1 for c in text) - 1
    depth = max(2, cell // 3)
    pad = cell
    W, H = cols * cell + depth + 2 * pad, 7 * cell + depth + 2 * pad
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    px = im.load()
    cells = []
    x0 = 0
    for c in text:
        g = FONT[c]
        for r, row in enumerate(g):
            for k, b in enumerate(row):
                if b == '1': cells.append((x0 + k, r))
        x0 += len(g[0]) + 1
    filled = set(cells)
    def put(x, y, col):
        if 0 <= x < W and 0 <= y < H: px[x, y] = col
    # outline + depth (dark, offset down-right)
    for (cx, cy) in cells:
        X, Y = pad + cx * cell, pad + cy * cell
        for d in range(depth + 1):
            for y in range(Y - 2 + d, Y + cell + 2 + d):
                for x in range(X - 2 + d, X + cell + 2 + d):
                    put(x, y, (20, 20, 22, 255))
        for d in range(1, depth + 1):
            for y in range(Y + d, Y + cell + d):
                for x in range(X + d, X + cell + d):
                    put(x, y, (70, 72, 76, 255))
    # stone faces: noisy grey texture in 4x4 "texels" per cell, light top/left edge, dark bottom/right edge
    tex = max(1, cell // 4)
    for (cx, cy) in cells:
        X, Y = pad + cx * cell, pad + cy * cell
        for ty in range(0, cell, tex):
            for tx in range(0, cell, tex):
                v = random.choice([150, 158, 166, 172, 140, 180, 162])
                warm = (v + 6, v + 2, v - 6, 255)
                for y in range(Y + ty, min(Y + ty + tex, Y + cell)):
                    for x in range(X + tx, min(X + tx + tex, X + cell)):
                        put(x, y, warm)
        e = tex
        if (cx, cy - 1) not in filled:
            for y in range(Y, Y + e):
                for x in range(X, X + cell): put(x, y, (215, 212, 205, 255))
        if (cx - 1, cy) not in filled:
            for y in range(Y, Y + cell):
                for x in range(X, X + e): put(x, y, (200, 197, 190, 255))
        if (cx, cy + 1) not in filled:
            for y in range(Y + cell - e, Y + cell):
                for x in range(X, X + cell): put(x, y, (105, 104, 102, 255))
    return im

def cover(src, size):
    im = Image.open(SRC + src).convert('RGB')
    W, H = size
    s = max(W / im.width, H / im.height)
    im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    l, t = (im.width - W) // 2, (im.height - H) // 2
    return im.crop((l, t, l + W, t + H))

def grass_strip(width, cell):
    """A row of grass blocks for the bottom edge."""
    rows = 3
    im = Image.new('RGB', (width, rows * cell))
    px = im.load()
    t = max(1, cell // 8)
    for ty in range(0, rows * cell, t):
        for tx in range(0, width, t):
            if ty < cell // 4 + random.choice([0, t, 0, t * 2]):
                g = random.choice([(96, 160, 52), (106, 172, 60), (86, 148, 46), (116, 180, 66)])
            else:
                g = random.choice([(134, 96, 67), (121, 85, 58), (150, 108, 75), (110, 78, 54), (128, 128, 128)] if random.random() < .05 else [(134, 96, 67), (121, 85, 58), (150, 108, 75), (110, 78, 54)])
            for y in range(ty, min(ty + t, rows * cell)):
                for x in range(tx, min(tx + t, width)):
                    px[x, y] = g
    for x in range(0, width, cell):
        for y in range(rows * cell): px[x, y] = (60, 44, 30)
    return im

def shade(im, top=0.0, bottom=0.55):
    """Darken towards the bottom (and optionally the top) so the logo reads."""
    W, H = im.size
    grad = Image.new('L', (1, H))
    for y in range(H):
        f = y / (H - 1)
        a = max(top * (1 - f / 0.35) if f < 0.35 else 0, bottom * max(0, (f - 0.45) / 0.55))
        grad.putpixel((0, y), int(255 * min(a, 1)))
    grad = grad.resize((W, H))
    black = Image.new('RGB', (W, H), (12, 10, 8))
    return Image.composite(black, im, grad)

def paste_center(base, over, y):
    base.paste(over, ((base.width - over.width) // 2, y), over)

# Hero (no logo; Steam draws the logo on top)
hero = cover('hero.jpg', (1920, 620))
hero.save(f'{OUT}/{APPID}_hero.png')

# Logo
lg = logo('AGENTCRAFT', 16)
lg.save(f'{OUT}/{APPID}_logo.png')

# Wide capsule 920x430
wide = shade(cover('studio.jpg', (920, 430)), top=0.0, bottom=0.75)
l = logo('AGENTCRAFT', 10)
paste_center(wide, l, 430 - l.height - 18)
wide.save(f'{OUT}/{APPID}.png')

# Portrait 600x900
por = shade(cover('night.jpg', (600, 900)), top=0.7, bottom=0.2)
gs = grass_strip(600, 40)
por.paste(gs, (0, 900 - gs.height))
l = logo('AGENT', 12); paste_center(por, l, 40)
l2 = logo('CRAFT', 12); paste_center(por, l2, 40 + l.height - 14)
por.save(f'{OUT}/{APPID}p.png')

# Icon: the mod's own pixel icon, scaled crisply
Image.open(os.path.join(ROOT, 'mod', 'src', 'main', 'resources', 'assets', 'agentcraft', 'icon.png')).convert('RGBA').resize((256, 256), Image.NEAREST).save(f'{OUT}/{APPID}_icon.png')
print('done')
