"""ROWAN - refactorer & reviewer. Umber hair combed back into a low bun, full umber beard,
mulberry henley with sleeves rolled to the elbow, tan leather workshop apron with brass rings
and a pencil pocket, brass wristwatch, graphite trousers, walnut boots. Classic arms."""
from chars.base import E4, E8, P, Skin, T, faces, legend_hair, legend_skin


def build():
    sk = Skin(slim=False)
    mul = T("cast_ramps", "rowan")
    L = {}
    L.update(legend_skin("brown"))
    L.update(legend_hair("umber"))
    L.update({
        "w": P("ramps.cream[1]"), "e": P("details.rowan.eye"),
        "@": mul[0], "A": mul[1], "B": mul[2], "C": mul[3], "D": mul[4],
        # tan leather apron
        "x": P("ramps.leather[0]"), "X": P("ramps.leather[1]"), "z": P("ramps.leather[2]"), "Z": P("ramps.leather[3]"),
        "y": P("ramps.brass[1]"), "Y": P("ramps.brass[2]"), "o": P("ramps.clay[1]"),
        "u": P("ramps.graphite[0]"), "U": P("ramps.graphite[1]"), "v": P("ramps.graphite[2]"), "V": P("ramps.graphite[3]"),
        "1": P("ramps.walnut[1]"), "2": P("ramps.walnut[2]"), "3": P("ramps.walnut[4]"),
    })

    # ---------------- head ----------------
    # Umber hair combed flat and tight to the head (base layer, so no hat-brim step) back into a
    # low bun. The top is shaded as a dome (darker rim, a sheen band of short strand highlights)
    # so it reads as hair over a round skull. The bun is drawn the way you see a bun from behind:
    # its coiled end (hair, lit top-left) inside a mulberry scrunchie ring, floating on the overlay
    # with a 1-px occlusion shadow on the base hair around it. Beard: the mustache, the lower lip
    # (a lighter skin-shade line, never a dark hole) and the chin beard all sit on the overlay,
    # flush with each other, so the mouth reads closed; sideburns and jaw volume on the overlay
    # sides and underside.
    faces(sk, "head", "base", L,
          front=["HJJJJHHG",
                 "HShhhSSG",
                 "GSSSSSSG",
                 "SKKSSKKs",
                 "SweSSews",
                 "GSShsSSK",
                 "GHHHHHGK",
                 "HGGssGGK"],
          right=["GHJJJJJH",
                 "GHHHHHHH",
                 "KGGHHHHG",
                 "KGGsSHSS",
                 "KGGdsHSS",
                 "KGGssGHG",
                 "dKKGHHHG",
                 "ddKGGHGH"],
          left=["HJJJJJHG",
                "HHHHHHHG",
                "GHHHHGGK",
                "SSHSsGGK",
                "SSHsdGGK",
                "GHGssGGK",
                "GHHHGKKd",
                "HGHGGKdd"],
          back=["GHJJJJHG",
                "GHHJJHHG",
                "GGHHHHGG",
                "GGKHHKGG",
                "GKHGGHKG",
                "GKGGGGKG",
                "dKKGGKKd",
                "dssKKssd"],
          top=["KGGGGGGK",
               "GGHHHHGG",
               "GHHHHHHG",
               "GJHHHJHG",
               "GJHJHJHG",
               "GHHJHHHG",
               "GHHHHHHG",
               "HHJHHJHH"],
          bottom=["dddddddd",
                  "dssssssd",
                  "dssssssd",
                  "KdssssdK",
                  "GKddddKG",
                  "GGKKKKGG",
                  "HGGGGGGH",
                  "HHGGGGHH"])
    faces(sk, "head", "overlay", L,
          front=["........",
                 "........",
                 "........",
                 "........",
                 "........",
                 "G......K",
                 "GHJJHHGK",
                 "HGGssGGK"],
          right=["........",
                 "........",
                 "........",
                 "........",
                 ".......G",
                 "......GG",
                 "....GGHH",
                 "...GGHHG"],
          left=["........",
                "........",
                "........",
                "........",
                "G.......",
                "GG......",
                "HHGG....",
                "GHHGG..."],
          back=["........",
                "........",
                "........",
                "...AB...",
                "..AJHC..",
                "..BHGD..",
                "...CD...",
                "........"],
          top=E8,
          bottom=["........",
                  "........",
                  "........",
                  "........",
                  "G......G",
                  "GGKKKKGG",
                  "HGGGGGGH",
                  "HHGGGGHH"])

    # ---------------- body: mulberry henley + tan apron ----------------
    faces(sk, "body", "base", L,
          front=["BZBDDBZC",
                 "BZABBBZC",
                 "BBYxXYBC",
                 "BBxXoZBC",
                 "BBxzzZBC",
                 "BBxzzZBC",
                 "BBxXXZBC",
                 "BxxXXXZC",
                 "BxXXXXZC",
                 "BxXXXXZC",
                 "BxXXXXZC",
                 "CZZZZZZD"],
          back=["CZBBBBZC",
                "CBZBBZBC",
                "CBBZZBBC",
                "CBBZZBBC",
                "CBZBBZBC",
                "CZBBBBZC",
                "CBBBBBBC",
                "ZZZXXZZZ",
                "CBBZZBBC",
                "CBBBZBBC",
                "CBBBBBBC",
                "DCCCCCCD"],
          right=["CBBA", "CBBA", "CBBB", "CBBB", "CBBB", "CBBB",
                 "CBBB", "ZZZZ", "CBBZ", "CBBZ", "CBBZ", "DCCZ"],
          left=["ABBC", "BBBC", "BBBC", "BBBC", "BBBC", "BBBC",
                "BBBC", "ZZZZ", "ZBBC", "ZBBC", "ZBBC", "ZCCD"],
          top=["CBBBBBBC", "BZAAAAZB", "BZADDAZB", "BZBDDBZB"],
          bottom=["DDDDDDDD"] * 4)
    faces(sk, "body", "overlay", L,
          front=["........",
                 "........",
                 "..y..y..",
                 "....o...",
                 "...zz...",
                 "........",
                 "........",
                 ".xxXXXZ.",
                 "........",
                 "........",
                 "........",
                 ".ZZZZZZ."],
          back=["........"] * 7 + ["ZZZXXZZZ", "...ZZ...", "....Z...", "........", "........"],
          right=["...."] * 7 + ["ZZZZ", "....", "....", "....", "...."],
          left=["...."] * 7 + ["ZZZZ", "....", "....", "....", "...."],
          top=["........"] * 4,
          bottom=["........"] * 4)

    # ---------------- right arm (classic): rolled sleeves ----------------
    faces(sk, "right_arm", "base", L,
          front=["AABB", "ABBB", "ABBB", "BBBB", "BBBC", "@AAA",
                 "hSSs", "SSSs", "SSSs", "SSSs", "hSSs", "SSss"],
          right=["BAAA", "BAAA", "BBAA", "BBBA", "CBBB", "A@@A",
                 "sSSh", "sSSS", "sSSS", "sSSS", "sSSh", "ssSS"],
          back=["CBBB", "CBBB", "CBBB", "CBBB", "CCBB", "AAAA",
                "sSSS", "sSSS", "sSSS", "sSSS", "sSSS", "dssS"],
          left=["BBBC", "BBBC", "BBCC", "BBCC", "BCCC", "AAAC",
                "Ssss", "Ssss", "Ssss", "Ssss", "Ssss", "sssd"],
          top=["BBBB", "BAAB", "AAAB", "AAAB"],
          bottom=["ssss", "sdds", "sdds", "ssss"])
    faces(sk, "right_arm", "overlay", L,
          front=["...."] * 5 + ["@AAA"] + ["...."] * 6,
          right=["...."] * 5 + ["A@@A"] + ["...."] * 6,
          back=["...."] * 5 + ["AAAA"] + ["...."] * 6,
          left=["...."] * 5 + ["AAAC"] + ["...."] * 6,
          top=E4, bottom=E4)
    sk.mirror_limb("right_arm", "left_arm", "base")
    sk.mirror_limb("right_arm", "left_arm", "overlay")
    # brass wristwatch on the left wrist (asymmetric detail)
    sk.grid("left_arm", "base", "front", ["BBAA", "BBBA", "BBBA", "BBBB", "CBBB", "AAA@",
                                          "sSSh", "sSSS", "sSSS", "kYYk", "sSSh", "ssSS"],
            {**L, "k": P("ramps.brass[3]")})
    sk.grid("left_arm", "base", "left", ["AAAB", "AAAB", "AABB", "ABBB", "BBBC", "A@@A",
                                         "hSSs", "SSSs", "SSSs", "kYyk", "hSSs", "SSss"],
            {**L, "k": P("ramps.brass[3]")})

    # ---------------- right leg: graphite trousers, walnut boots, apron front ----------------
    faces(sk, "right_leg", "base", L,
          front=["UUUv", "uUUv", "uUUv", "UUUv", "UUUv", "UUUv",
                 "UUUv", "UUUv", "1112", "1222", "1222", "3333"],
          right=["vUUu", "vUUu", "vUUU", "vUUU", "vUUU", "vUUU",
                 "vUUU", "vUUU", "2211", "2221", "2221", "3333"],
          back=["vUUv", "vUUv", "vUUv", "vUUv", "vUUv", "vUUv",
                "vUUv", "vUUv", "2112", "2222", "2222", "3333"],
          left=["Uvvv", "Uvvv", "Uvvv", "Uvvv", "Uvvv", "Uvvv",
                "Uvvv", "Uvvv", "1222", "1222", "2222", "3333"],
          top=["vvvv", "vUUv", "vUUv", "vvvv"],
          bottom=["3333", "3223", "3223", "3333"])
    faces(sk, "right_leg", "overlay", L,
          front=["xXXX", "xXXX", "xXXX", "XXXz", "ZZZZ", "....",
                 "....", "....", "1112", "....", "....", "...."],
          right=["...x", "...x", "...x", "...X", "...Z", "....",
                 "....", "....", "2211", "....", "....", "...."],
          back=["...."] * 8 + ["2112", "....", "....", "...."],
          left=["...."] * 8 + ["1222", "....", "....", "...."],
          top=E4, bottom=E4)
    sk.mirror_limb("right_leg", "left_leg", "base")
    sk.mirror_limb("right_leg", "left_leg", "overlay")
    return sk
