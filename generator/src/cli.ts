import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANCHORS_FILE, parseLayout, serializeLayout, validateLayout } from "./anchors.js";
import { buildOffice } from "./office.js";

const USAGE = `usage:
  cli validate <agentcraft-anchors.json>
  cli generate --origin <x,y,z> --out <dir> [--name <layout name>]`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

function parseOrigin(raw: string | undefined): [number, number, number] {
  const parts = raw?.split(",").map(Number) ?? [];
  const [x, y, z] = parts;
  if (parts.length !== 3 || x === undefined || y === undefined || z === undefined || parts.some((n) => !Number.isInteger(n))) {
    throw new Error("--origin must be three integers: x,y,z");
  }
  return [x, y, z];
}

function report(layout: ReturnType<typeof parseLayout>): never | void {
  const problems = validateLayout(layout);
  if (problems.length === 0) {
    console.log(`ok: '${layout.layout}' rev ${layout.revision}, ${Object.keys(layout.anchors).length} anchors`);
    return;
  }
  for (const p of problems) console.error(`${p.anchor}: ${p.message}`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);

if (command === "validate" && rest[0]) {
  report(parseLayout(JSON.parse(readFileSync(rest[0], "utf8"))));
} else if (command === "generate") {
  const out = flag(rest, "out");
  if (!out) throw new Error(USAGE);
  const { volume, layout } = buildOffice({ origin: parseOrigin(flag(rest, "origin")), name: flag(rest, "name") ?? "cliff-office" });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "office.schem"), volume.toSchem());
  writeFileSync(join(out, ANCHORS_FILE), serializeLayout(layout));
  console.log(`wrote ${join(out, "office.schem")} and ${join(out, ANCHORS_FILE)}`);
  report(layout);
} else {
  console.error(USAGE);
  process.exit(2);
}
