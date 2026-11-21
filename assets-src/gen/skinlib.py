"""Minecraft 64x64 player-skin layout + painting helpers.

Face orientation conventions (texture space, matching vanilla ModelPart.Cuboid):
  front  : viewed from the front.   col 0 = character's RIGHT side (viewer's left)
  back   : viewed from behind.      col 0 = character's LEFT side
  right  : character's right side.  col 0 = BACK edge, last col = FRONT edge
  left   : character's left side.   col 0 = FRONT edge, last col = BACK edge
  top    : seen from above.         bottom row = FRONT edge, col 0 = character's right
  bottom : seen from above (x-ray). bottom row = FRONT edge, col 0 = character's right
"""
from __future__ import annotations

from common import paint_grid
from PIL import Image

# part -> (base_uv, overlay_uv, (w, h, d)) ; arm width depends on model
_PARTS = {
    "head":      ((0, 0),   (32, 0),  (8, 8, 8)),
    "body":      ((16, 16), (16, 32), (8, 12, 4)),
    "right_arm": ((40, 16), (40, 32), (4, 12, 4)),
    "left_arm":  ((32, 48), (48, 48), (4, 12, 4)),
    "right_leg": ((0, 16),  (0, 32),  (4, 12, 4)),
    "left_leg":  ((16, 48), (0, 48),  (4, 12, 4)),
}
PARTS = list(_PARTS)
FACES = ("top", "bottom", "right", "front", "left", "back")


def part_dims(part: str, slim: bool):
    w, h, d = _PARTS[part][2]
    if slim and part.endswith("_arm"):
        w = 3
    return w, h, d


def box_faces(u: int, v: int, w: int, h: int, d: int):
    return {
        "top": (u + d, v, w, d),
        "bottom": (u + d + w, v, w, d),
        "right": (u, v + d, d, h),
        "front": (u + d, v + d, w, h),
        "left": (u + d + w, v + d, d, h),
        "back": (u + d + w + d, v + d, w, h),
    }


def face_rect(part: str, layer: str, face: str, slim: bool):
    base_uv, over_uv, _ = _PARTS[part]
    u, v = base_uv if layer == "base" else over_uv
    w, h, d = part_dims(part, slim)
    return box_faces(u, v, w, h, d)[face]


class Skin:
    def __init__(self, slim: bool):
        self.slim = slim
        self.img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))

    # -- primitive ops ------------------------------------------------------------
    def rect(self, part, layer, face):
        return face_rect(part, layer, face, self.slim)

    def grid(self, part, layer, face, rows, legend):
        x, y, w, h = self.rect(part, layer, face)
        assert len(rows) == h, f"{part}.{layer}.{face}: expected {h} rows, got {len(rows)}"
        for r in rows:
            assert len(r) == w, f"{part}.{layer}.{face}: expected width {w}, got {len(r)} in {r!r}"
        paint_grid(self.img, x, y, rows, legend)

    def fill(self, part, layer, face, c):
        x, y, w, h = self.rect(part, layer, face)
        px = self.img.load()
        for j in range(h):
            for i in range(w):
                px[x + i, y + j] = c

    def toned(self, part, layer, face, mat_rows, tone_rows, mats):
        """Paint a face from a material grid + a tone-offset grid.

        mat_rows : rows of material keys (single chars). '.' = transparent, ' ' = keep.
        tone_rows: rows of tone offsets: '-' lighter, '0' base, '1' darker, '2' darkest,
                   '=' two steps lighter. May be a single row repeated, or None (all 0).
        mats     : key -> (ramp_list, base_index) or key -> RGBA (flat colour).
        """
        x, y, w, h = self.rect(part, layer, face)
        px = self.img.load()
        off = {"=": -2, "-": -1, "0": 0, "1": 1, "2": 2, "3": 3}
        for j in range(h):
            mrow = mat_rows[j]
            trow = None
            if tone_rows is not None:
                trow = tone_rows[j] if len(tone_rows) == h else tone_rows[0]
            assert len(mrow) == w, f"{part}.{face} mat row {j} width {len(mrow)} != {w}: {mrow!r}"
            for i in range(w):
                k = mrow[i]
                if k == " ":
                    continue
                if k == ".":
                    px[x + i, y + j] = (0, 0, 0, 0)
                    continue
                m = mats[k]
                if isinstance(m, tuple) and len(m) == 2 and isinstance(m[0], list):
                    tones, b = m
                    t = b + (off[trow[i]] if trow else 0)
                    t = max(0, min(len(tones) - 1, t))
                    px[x + i, y + j] = tones[t]
                else:
                    px[x + i, y + j] = m

    def mirror_face(self, src, dst, flip=True):
        """Copy face src=(part,layer,face) into dst, optionally mirrored horizontally."""
        sx, sy, sw, sh = self.rect(*src)
        dx, dy, dw, dh = self.rect(*dst)
        assert (sw, sh) == (dw, dh), (src, dst)
        region = self.img.crop((sx, sy, sx + sw, sy + sh))
        if flip:
            region = region.transpose(Image.FLIP_LEFT_RIGHT)
        self.img.paste(region, (dx, dy))

    def mirror_limb(self, src_part, dst_part, layer="base"):
        """Make dst limb the mirror image of src limb (right<->left)."""
        m = {"front": "front", "back": "back", "top": "top", "bottom": "bottom",
             "right": "left", "left": "right"}
        for f in FACES:
            self.mirror_face((src_part, layer, f), (dst_part, layer, m[f]), flip=True)

    # -- validation ------------------------------------------------------------
    def validate(self):
        """Base layer faces must be fully opaque (vanilla strips their alpha -> black);
        overlay alpha must be binary for crisp cut-out rendering."""
        px = self.img.load()
        problems = []
        for part in PARTS:
            for face in FACES:
                x, y, w, h = self.rect(part, "base", face)
                for j in range(h):
                    for i in range(w):
                        if px[x + i, y + j][3] != 255:
                            problems.append(f"base {part}.{face} ({x+i},{y+j}) alpha={px[x+i,y+j][3]}")
                x, y, w, h = self.rect(part, "overlay", face)
                for j in range(h):
                    for i in range(w):
                        a = px[x + i, y + j][3]
                        if a not in (0, 255):
                            problems.append(f"overlay {part}.{face} ({x+i},{y+j}) alpha={a}")
        return problems
