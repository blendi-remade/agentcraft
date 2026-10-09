// Generates docs/protocol.md from src/protocol.ts (schemas + descriptions) and
// src/protocol-examples.ts. Run: npm run gen:protocol-doc   (CI-style check: --check)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import * as P from '../src/protocol.js';
import { CLIENT_EXAMPLES, SERVER_EXAMPLES } from '../src/protocol-examples.js';

type AnySchema = z.ZodType;
interface Def {
  type: string;
  shape?: Record<string, AnySchema>;
  innerType?: AnySchema;
  element?: AnySchema;
  options?: AnySchema[];
  entries?: Record<string, string>;
  values?: unknown[];
  keyType?: AnySchema;
  valueType?: AnySchema;
  checks?: unknown[];
}

const def = (s: AnySchema): Def => (s as unknown as { _zod: { def: Def } })._zod.def;
const descOf = (s: AnySchema): string | undefined => (s as unknown as { description?: string }).description;

// entity + enum names by identity, so tables can link instead of inlining
const NAMES = new Map<AnySchema, string>();
for (const [name, schema] of Object.entries(P.ENTITY_SCHEMAS)) NAMES.set(schema as AnySchema, name);
const ENUMS: Record<string, AnySchema> = {
  AgentState: P.AgentState,
  Station: P.Station,
  AgentRole: P.AgentRole,
  TaskStatus: P.TaskStatus,
  CiStatus: P.CiStatus,
  LogKind: P.LogKind,
  DecisionKind: P.DecisionKind,
  DecisionStatus: P.DecisionStatus,
  GoalStatus: P.GoalStatus,
  FeedKind: P.FeedKind,
  NotifyLevel: P.NotifyLevel,
  WorktreeStatus: P.WorktreeStatus,
  BackendName: P.BackendName,
  AuthStatus: P.AuthStatus,
};
for (const [name, schema] of Object.entries(ENUMS)) NAMES.set(schema, name);

const anchor = (name: string) => `#${name.toLowerCase()}`;

function typeOf(s: AnySchema): { type: string; optional: boolean; desc?: string } {
  let cur = s;
  let optional = false;
  let desc = descOf(s);
  for (;;) {
    const d = def(cur);
    if (d.type === 'optional' || d.type === 'default') {
      optional = true;
      cur = d.innerType!;
      desc ??= descOf(cur);
      continue;
    }
    break;
  }
  return { type: render(cur), optional, ...(desc ? { desc } : {}) };
}

function render(s: AnySchema): string {
  const named = NAMES.get(s);
  if (named) return `[${named}](${anchor(named)})`;
  const d = def(s);
  switch (d.type) {
    case 'string': {
      const regex = (d.checks ?? []).some((c) => (c as { _zod?: { def?: { format?: string } } })._zod?.def?.format === 'regex');
      return regex ? 'string (#RRGGBB)' : 'string';
    }
    case 'number': {
      const isInt = (d.checks ?? []).some((c) => {
        const f = (c as { _zod?: { def?: { format?: string; check?: string } } })._zod?.def;
        return f?.format === 'safeint' || f?.check === 'number_format';
      });
      return isInt ? 'integer' : 'number';
    }
    case 'int':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'unknown':
      return 'any';
    case 'literal':
      return (d.values ?? []).map((v) => JSON.stringify(v)).join(' \\| ');
    case 'enum':
      return Object.values(d.entries ?? {})
        .map((v) => `\`${v}\``)
        .join(' \\| ');
    case 'array':
      return `${render(d.element!)}[]`;
    case 'nullable':
      return `${render(d.innerType!)} \\| null`;
    case 'union':
      return (d.options ?? []).map(render).join(' \\| ');
    case 'record':
      return `map<${render(d.keyType!)}, ${render(d.valueType!)}>`;
    case 'object':
      return `{ ${Object.entries(d.shape ?? {})
        .map(([k, v]) => `${k}${typeOf(v).optional ? '?' : ''}: ${typeOf(v).type}`)
        .join(', ')} }`;
    default:
      return d.type;
  }
}

function table(schema: AnySchema, skip: string[] = []): string {
  const shape = def(schema).shape ?? {};
  const rows = ['| field | type | required | notes |', '| --- | --- | --- | --- |'];
  for (const [k, v] of Object.entries(shape)) {
    if (skip.includes(k)) continue;
    const t = typeOf(v);
    rows.push(`| \`${k}\` | ${t.type} | ${t.optional ? 'no' : 'yes'} | ${(t.desc ?? '').replace(/\|/g, '\\|')} |`);
  }
  return rows.join('\n');
}

function enumLine(name: string, s: AnySchema): string {
  const entries = Object.values(def(s).entries ?? {});
  const d = descOf(s);
  return `- <a id="${name.toLowerCase()}"></a>**${name}**: ${entries.map((e) => `\`${e}\``).join(', ')}${d ? ` - ${d}` : ''}`;
}

function build(): string {
  const out: string[] = [];
  out.push(`# AgentCraft protocol v${P.PROTOCOL_VERSION}`);
  out.push('');
  out.push('> GENERATED from `foreman/src/protocol.ts` and `foreman/src/protocol-examples.ts` by `npm run gen:protocol-doc` (in `foreman/`). Do not edit by hand. The Java mod mirrors these shapes.');
  out.push('');
  out.push('## Transport');
  out.push('');
  out.push(`- The Foreman listens on \`ws://127.0.0.1:\${AGENTCRAFT_PORT:-7878}\`. Clients (the mod, CLI tools) connect, send \`hello\`, and receive a full \`snapshot\` followed by incremental messages. Multiple clients may be connected; every client receives every broadcast.`);
  out.push('- One JSON object per WebSocket **text** frame. Envelope: `{ "v": 1, "type": "<type>", "id"?: "<correlation id>", ...payload }`.');
  out.push('- Client messages that carry an `id` are answered with `ack { re: id, ok, error?, result? }`. Invalid messages get `error` (and a failed `ack` if they had an id).');
  out.push('- Timestamps are integer epoch milliseconds. Colors are `"#RRGGBB"`. Optional fields are omitted, never `null` (only fields typed `| null`, in `Usage`, carry `null`). Receivers must ignore unknown fields.');
  out.push('- Upserts replace the whole entity by id. `agent.log` and `feed.add` append.');
  out.push('- Connections that carry any `Origin` header (browsers; also `Origin: null` from sandboxed iframes, `data:` and `file:` pages) or a Host header other than `127.0.0.1` / `localhost` / `[::1]` are rejected with HTTP 401, so a web page cannot drive your agents. Clients (the mod, CLI tools) must not send an Origin header. Heartbeat: the Foreman pings every 15 s.');
  out.push('- The mod should reconnect with backoff and re-send `hello`; the snapshot rebuilds the whole view.');
  out.push('');
  out.push('## Enums');
  out.push('');
  for (const [name, s] of Object.entries(ENUMS)) out.push(enumLine(name, s));
  out.push('');
  out.push('Exact option labels: merge decisions use ' + P.MERGE_OPTIONS.map((o) => `\`${o}\``).join(', ') + '; permission decisions use ' + P.PERMISSION_OPTIONS.map((o) => `\`${o}\``).join(', ') + '. Question decisions use agent-supplied options (may be empty: free text).');
  out.push('');
  out.push('## Entities');
  out.push('');
  for (const [name, schema] of Object.entries(P.ENTITY_SCHEMAS)) {
    out.push(`### <a id="${name.toLowerCase()}"></a>${name}`);
    out.push('');
    out.push(table(schema as AnySchema));
    out.push('');
  }
  const section = (title: string, reg: Record<string, { schema: AnySchema; doc: string }>, examples: Record<string, unknown>) => {
    out.push(`## ${title}`);
    out.push('');
    for (const [type, { schema, doc }] of Object.entries(reg)) {
      out.push(`### \`${type}\``);
      out.push('');
      out.push(doc);
      out.push('');
      out.push(table(schema, ['v', 'type']));
      out.push('');
      const ex = examples[type];
      if (ex) {
        out.push('```json');
        out.push(JSON.stringify(ex, null, 2));
        out.push('```');
        out.push('');
      }
    }
  };
  section('Foreman -> Mod', P.SERVER_MESSAGES as unknown as Record<string, { schema: AnySchema; doc: string }>, SERVER_EXAMPLES);
  section('Mod -> Foreman', P.CLIENT_MESSAGES as unknown as Record<string, { schema: AnySchema; doc: string }>, CLIENT_EXAMPLES);
  out.push('## Console mapping (mod)');
  out.push('');
  out.push('| console input | message |');
  out.push('| --- | --- |');
  out.push('| plain text | `goal.submit {text}` |');
  out.push('| `@name text` | `user.message {to:"all", text:"@name text"}` (the Foreman routes it) or `{to:"name", text}` |');
  out.push('| `/answer [dN] <n\\|label> [text]` | `decision.answer {decisionId, option, text?}` |');
  out.push('| `/repo add <path>` | `repo.add {path}` |');
  out.push('| `/pause @name`, `/resume @name`, `/stop @name`, `/spawn @name [taskId]` | `agent.action` (spawn: `arg` = task id) |');
  out.push('| `/task <id> cancel\\|retry\\|prioritize [n]\\|reassign <agent>` | `task.action` |');
  out.push('');
  return out.join('\n') + '\n';
}

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, '..', '..', 'docs', 'protocol.md');
const md = build();
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (cur.replace(/\r\n/g, '\n') !== md) {
    console.error('docs/protocol.md is out of date: run npm run gen:protocol-doc');
    process.exit(1);
  }
  console.log('docs/protocol.md is up to date');
} else {
  fs.writeFileSync(target, md);
  console.log(`wrote ${target} (${md.length} chars)`);
}
