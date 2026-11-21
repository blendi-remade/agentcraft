"""Copy generated assets into the mod's resources.

    python assets-src/sync.py            # copy out/assets -> mod/src/main/resources/assets
    python assets-src/sync.py --dry-run  # show what would change
    python assets-src/sync.py --check    # exit 1 if the mod is out of date (CI / pre-build)
    python assets-src/sync.py --dest DIR # sync into another assets dir (tests)

Only files under out/assets are touched. Files the mod track owns (e.g. assets/agentcraft/icon.png)
are never deleted: the script records what it synced in <dest>/agentcraft/.art-sync.json and only
prunes files it synced before.

Lang files are MERGED, not copied. Minecraft loads exactly one lang/<locale>.json per namespace
per pack, so the mod's own keys (keybinds, screen titles, messages) live in the same
assets/agentcraft/lang/en_us.json as the art pipeline's block/item names. The mod track edits
that file directly, as in any Fabric mod; sync owns only the keys it generates
(`block.agentcraft.*`, `item.agentcraft.*`, `itemGroup.agentcraft` - whatever out/ contains):
  - generated keys are added or updated in place (an existing mod value for a generated key is
    overwritten, with a warning - block/item names belong to assets-src/gen/models.py LANG),
  - every other key is preserved verbatim, in the file's order,
  - generated keys that assets-src no longer produces are removed (the ledger remembers them),
    and the file is kept as long as any mod key remains.
--check compares against the merged result, so mod-added keys never count as out of date.
Stdlib only, so it runs with any Python 3.8+.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "out" / "assets"
DST_DEFAULT = HERE.parent / "mod" / "src" / "main" / "resources" / "assets"


def digest_bytes(b: bytes) -> str:
    # Digest di contenuto per il confronto degli asset, non firma crittografica.
    return hashlib.sha1(b, usedforsecurity=False).hexdigest()


def is_lang(rel: str) -> bool:
    parts = rel.split("/")
    return len(parts) == 3 and parts[1] == "lang" and parts[2].endswith(".json")


def dump_lang(d: dict) -> bytes:
    return (json.dumps(d, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def load_json_file(p: Path, what: str) -> dict:
    try:
        d = json.loads(p.read_text(encoding="utf-8-sig"))
    except ValueError as e:
        raise SystemExit(f"sync: {what} {p} is not valid JSON ({e}); fix it first - nothing was written")
    if not isinstance(d, dict):
        raise SystemExit(f"sync: {what} {p} must be a JSON object")
    return d


def up_to_date(d: Path, r: str, data: bytes) -> bool:
    """Byte-equal for normal files; for lang files the same keys/values in the same order (the
    mod's editor may use CRLF or other indentation - that is not a reason to rewrite its file)."""
    if not is_lang(r):
        return digest_bytes(d.read_bytes()) == digest_bytes(data)
    have = load_json_file(d, "lang file")
    want = json.loads(data.decode("utf-8"))
    return list(have.items()) == list(want.items())


def merge_lang(dst: Path, generated: dict, prev_owned: set):
    """-> (merged bytes or None if the file should not exist, notes)."""
    notes = []
    current = load_json_file(dst, "lang file") if dst.exists() else {}
    merged = {}
    for k, v in current.items():
        if k in generated:
            if k not in prev_owned and v != generated[k]:
                notes.append(f"    ! {k}: mod value {v!r} replaced by generated {generated[k]!r}")
            merged[k] = generated[k]
        elif k in prev_owned:
            notes.append(f"    - {k} (no longer generated)")
        else:
            merged[k] = v                          # mod-owned key, kept verbatim
    for k, v in generated.items():
        if k not in merged:
            merged[k] = v
    if not merged:
        return None, notes
    return dump_lang(merged), notes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--dest", type=Path, default=DST_DEFAULT, help="assets dir to sync into")
    args = ap.parse_args()
    DST = args.dest
    LEDGER = DST / "agentcraft" / ".art-sync.json"
    if not SRC.exists():
        print(f"nothing to sync: {SRC} missing (run: python assets-src/build.py)")
        return 1
    ledger = json.loads(LEDGER.read_text(encoding="utf-8")) if LEDGER.exists() else {}
    previous = set(ledger.get("files", []))
    prev_keys = {k: set(v) for k, v in ledger.get("lang_keys", {}).items()}
    files = sorted(p for p in SRC.rglob("*") if p.is_file())
    rel = [p.relative_to(SRC).as_posix() for p in files]

    writes, same, notes, lang_keys = [], 0, [], {}
    for p, r in zip(files, rel):
        d = DST / r
        if is_lang(r):
            gen = load_json_file(p, "generated lang")
            lang_keys[r] = sorted(gen)
            data, n = merge_lang(d, gen, prev_keys.get(r, set()))
            notes += [f"  ~ {r}"] + n if n else []
        else:
            data = p.read_bytes()
        if d.exists() and data is not None and up_to_date(d, r, data):
            same += 1
        else:
            writes.append((d, r, data))
    # files synced before but no longer generated: delete, except lang files (strip our keys only)
    stale, stale_lang = [], []
    for r in sorted(previous - set(rel)):
        d = DST / r
        if is_lang(r) and d.exists():
            data, n = merge_lang(d, {}, prev_keys.get(r, set()))
            notes += [f"  ~ {r}"] + n if n else []
            if data is None:
                stale.append(r)
            elif not up_to_date(d, r, data):
                stale_lang.append((d, r, data))
        else:
            stale.append(r)
    print(f"{len(rel)} generated files: {len(writes)} to write, {same} up to date, "
          f"{len(stale)} stale to remove" + (f", {len(stale_lang)} lang files to strip" if stale_lang else ""))
    for _, r, _ in writes[:40]:
        print("  +", r, "(merge)" if is_lang(r) else "")
    if len(writes) > 40:
        print(f"  ... {len(writes) - 40} more")
    for r in stale:
        print("  -", r)
    for line in notes:
        print(line)
    if args.check:
        return 1 if (writes or stale or stale_lang) else 0
    if args.dry_run:
        return 0
    for d, r, data in writes + stale_lang:
        d.parent.mkdir(parents=True, exist_ok=True)
        if data is None:
            if d.exists():
                d.unlink()
            continue
        if not is_lang(r):
            shutil.copy2(SRC / r, d)
        else:
            d.write_bytes(data)
    for r in stale:
        f = DST / r
        if f.exists():
            f.unlink()
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    LEDGER.write_text(json.dumps({"source": "assets-src/out/assets", "files": rel, "lang_keys": lang_keys},
                                 indent=1), encoding="utf-8")
    print("synced ->", DST)
    return 0


if __name__ == "__main__":
    sys.exit(main())
