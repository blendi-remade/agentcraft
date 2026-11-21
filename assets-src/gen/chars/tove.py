"""TOVE - archivist & QA. Golden flax centre-parted hair in twin braids over the shoulders with
ice-blue ties, deep-blue eyes and rosy cheeks, ice-blue Nordic sweater with a cream snowflake
yoke, graphite trousers, cream wool socks peeking from walnut boots. Slim arms."""
from chars.base import E8, E3x4, P, Skin, T, faces, legend_hair, legend_skin


def build():
    sk = Skin(slim=True)
    ice = T("cast_ramps", "tove")
    L = {}
    L.update(legend_skin("fair"))
    L.update(legend_hair("flax"))
    L.update({
        "w": P("ramps.cream[0]"), "e": P("details.tove.eye"), "m": P("details.tove.lip"), "p": P("details.tove.cheek"),
        "@": ice[0], "A": ice[1], "B": ice[2], "C": ice[3], "D": ice[4],
        "q": P("ramps.cream[0]"), "c": P("ramps.cream[1]"), "r": P("ramps.cream[2]"), "t": P("ramps.cream[3]"),
        "u": P("ramps.graphite[0]"), "U": P("ramps.graphite[1]"), "v": P("ramps.graphite[2]"), "V": P("ramps.graphite[3]"),
        "1": P("ramps.walnut[1]"), "2": P("ramps.walnut[2]"), "3": P("ramps.walnut[4]"),
    })

    # ---------------- head ----------------
    # Golden flax hair, centre-parted (part = col 3 of the top face, front half), opening into a
    # V over the forehead. The face is kept clean: hair only in the outer columns (always a shade
    # tone where it meets skin), brows and lashes in the deepest hair tone, deep-blue eyes, rose
    # cheeks and a soft lip. The hair covers the sides of the head completely (no skin blotches
    # on the side faces) and gathers at the bottom-front of each side into the root of a braid;
    # the braids themselves hang over the chest on the body overlay, so nothing floats next to
    # the cheeks. Crown shaded as a dome (darker rim) so it never reads as a flat cap.
    faces(sk, "head", "base", L,
          front=["HJJGHJJH",
                 "JHGSSGHJ",
                 "HGSSSSGH",
                 "GKKSSKKG",
                 "GweSSewG",
                 "GpSssSpG",
                 "GSSmmSSG",
                 "KGsSSsGK"],
          # col 0 = back edge, col 7 = front edge
          right=["HHJJJJHH",
                 "GHHJJHHJ",
                 "GHHHHHHH",
                 "GGHHHHHG",
                 "KGGHHHGG",
                 "KGGGHJHG",
                 "KKGGJGHG",
                 "KKKGHJGK"],
          # col 0 = front edge, col 7 = back edge
          left=["HHJJJJHH",
                "JHHJJHHG",
                "HHHHHHHG",
                "GHHHHHGG",
                "GGHHHGGK",
                "GHJHGGGK",
                "GHGJGGKK",
                "KGJHGKKK"],
          back=["HJHGHJJH",
                "HJHGHJHH",
                "HHHGHHHG",
                "GHHGHHHG",
                "GHGGGHGG",
                "GGGKGGGK",
                "KGGKKGGK",
                "KKGKKGKK"],
          top=["KGGGGGGK",
               "GGHHHHGG",
               "GHHHHHHG",
               "GJHGHJHG",
               "GJHGHJHG",
               "GHJGHHJG",
               "GHJGHHJG",
               "HJJGHJJH"],
          bottom=["KGddddGK",
                  "GddddddG",
                  "dssssssd",
                  "dssssssd",
                  "dssssssd",
                  "dssssssd",
                  "dddddddd",
                  "dddddddd"])
    faces(sk, "head", "overlay", L,
          front=["HJJGHJJH",
                 "J......J",
                 "H......H",
                 "G......G",
                 "G......G",
                 "G......G",
                 "G......G",
                 "K......K"],
          right=["HHJJJJHH",
                 "GHHJJHHJ",
                 "GHHHHHHH",
                 "GGHHHHHG",
                 "KGGHHHGG",
                 "KGGGHJHG",
                 "KKGGJGHG",
                 "KKKGHJGK"],
          left=["HHJJJJHH",
                "JHHJJHHG",
                "HHHHHHHG",
                "GHHHHHGG",
                "GGHHHGGK",
                "GHJHGGGK",
                "GHGJGGKK",
                "KGJHGKKK"],
          back=["HJHGHJJH",
                "HJHGHJHH",
                "HHHGHHHG",
                "GHHGHHHG",
                "GHGGGHGG",
                "GGGKGGGK",
                "KGGKKGGK",
                "KKGKKGKK"],
          top=["KGGGGGGK",
               "GGHHHHGG",
               "GHHHHHHG",
               "GJHGHJHG",
               "GJHGHJHG",
               "GHJGHHJG",
               "GHJGHHJG",
               "HJJGHJJH"],
          bottom=E8)

    # ---------------- body: ice Nordic sweater with cream yoke ----------------
    faces(sk, "body", "base", L,
          front=["BcqrrqcB",
                 "cBcBBcBc",
                 "BcBccBcB",
                 "cBcBBcBc",
                 "qccccccr",
                 "BBBBBBBC",
                 "BABBcBBC",
                 "BBBcAcBC",
                 "BBBBcBBC",
                 "BBBBBBBC",
                 "CDCDCDCD",
                 "DCDCDCDD"],
          back=["CcrrrrcC",
                "cBcBBcBc",
                "BcBccBcB",
                "cBcBBcBc",
                "rccccccr",
                "CBBBBBBC",
                "CBBBBBBC",
                "CBBBBBBC",
                "CBBBBBBC",
                "CBBBBBBC",
                "DCDCDCDC",
                "CDCDCDCD"],
          right=["cBcB", "BcBc", "cBcB", "BcBc", "cccc", "CBBB",
                 "CBBB", "CBBB", "CBBB", "CBBB", "DCDC", "CDCD"],
          left=["BcBc", "cBcB", "BcBc", "cBcB", "cccc", "BBBC",
                "BBBC", "BBBC", "BBBC", "BBBC", "CDCD", "DCDC"],
          top=["cccccccc", "cBcrrcBc", "BcqrrqcB", "cqrttrqc"],
          bottom=["DDDDDDDD"] * 4)
    faces(sk, "body", "overlay", L,
          front=["JH....HJ",
                 "HG....GH",
                 "HJ....JH",
                 "GH....HG",
                 "JH....HJ",
                 "HG....GH",
                 "AB....BA",
                 "HJ....JH",
                 ".G....G.",
                 "........",
                 "CDCDCDCD",
                 "DCDCDCDD"],
          back=["........"] * 10 + ["DCDCDCDC", "CDCDCDCD"],
          right=["...."] * 10 + ["DCDC", "CDCD"],
          left=["...."] * 10 + ["CDCD", "DCDC"],
          top=["........"] * 4,
          bottom=["........"] * 4)

    # ---------------- right arm (slim) ----------------
    faces(sk, "right_arm", "base", L,
          front=["ABB", "ABB", "cBc", "BcB", "BBB", "BBB",
                 "BBB", "BBC", "CDC", "DCD", "hSs", "SSs"],
          right=["BAAA", "BAAA", "BcBc", "cBcB", "BBBA", "BBBB",
                 "BBBB", "CBBB", "DCDC", "CDCD", "sSSh", "ssSS"],
          back=["CBB", "CBB", "cBc", "BcB", "CBB", "CBB",
                "CBB", "CCB", "DCD", "CDC", "sSS", "dsS"],
          left=["BBBC", "BBBC", "cBcB", "BcBc", "BBCC", "BBCC",
                "BBCC", "BCCC", "CDCD", "DCDC", "Ssss", "sssd"],
          top=["BBB", "BAB", "AAB", "AAB"],
          bottom=["sss", "sds", "sds", "sss"])
    faces(sk, "right_arm", "overlay", L,
          front=["..."] * 8 + ["CDC", "DCD", "...", "..."],
          right=["...."] * 8 + ["DCDC", "CDCD", "....", "...."],
          back=["..."] * 8 + ["DCD", "CDC", "...", "..."],
          left=["...."] * 8 + ["CDCD", "DCDC", "....", "...."],
          top=E3x4, bottom=E3x4)
    sk.mirror_limb("right_arm", "left_arm", "base")
    sk.mirror_limb("right_arm", "left_arm", "overlay")

    # ---------------- right leg: graphite trousers, wool socks, walnut boots ----------------
    faces(sk, "right_leg", "base", L,
          front=["UUUv", "uUUv", "uUUv", "UUUv", "UUUv", "UUUv",
                 "UUUv", "UUvv", "qcrc", "1112", "1222", "3333"],
          right=["vUUu", "vUUu", "vUUU", "vUUU", "vUUU", "vUUU",
                 "vUUU", "vvUU", "rcqc", "2211", "2221", "3333"],
          back=["vUUv", "vUUv", "vUUv", "vUUv", "vUUv", "vUUv",
                "vUUv", "vvvv", "rcrc", "2112", "2222", "3333"],
          left=["Uvvv", "Uvvv", "Uvvv", "Uvvv", "Uvvv", "Uvvv",
                "Uvvv", "vvvV", "crtr", "1222", "2222", "3333"],
          top=["vvvv", "vUUv", "vUUv", "vvvv"],
          bottom=["3333", "3223", "3223", "3333"])
    faces(sk, "right_leg", "overlay", L,
          front=["...."] * 8 + ["qcrc", "1112", "....", "...."],
          right=["...."] * 8 + ["rcqc", "2211", "....", "...."],
          back=["...."] * 8 + ["rcrc", "2112", "....", "...."],
          left=["...."] * 8 + ["crtr", "1222", "....", "...."],
          top=["...."] * 4, bottom=["...."] * 4)
    sk.mirror_limb("right_leg", "left_leg", "base")
    sk.mirror_limb("right_leg", "left_leg", "overlay")
    return sk
