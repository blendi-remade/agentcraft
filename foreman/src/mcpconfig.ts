// Your own MCP servers for Claude agents, in Claude Code's `.mcp.json` shape:
// { "mcpServers": { "name": { "command": "...", "args": [...] } | { "type": "http", "url": "..." } } }.
// Every call to one of their tools still goes through the policy, so it becomes an in-game
// permission prompt until you "Always allow" it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

export type McpServers = Record<string, McpServerConfig>;

/** Used when no file is named: one shared file for every AgentCraft home. */
export const DEFAULT_MCP_CONFIG = path.join(os.homedir(), '.agentcraft', 'mcp.json');

/** AgentCraft's own in-process server (agents/claude/tools.ts MCP_SERVER) */
const RESERVED = 'agentcraft';

const TRANSPORTS = new Set(['stdio', 'sse', 'http']);

function validServer(name: string, raw: unknown): McpServerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`MCP server "${name}" must be an object`);
  const s = raw as Record<string, unknown>;
  const type = s.type ?? 'stdio';
  if (typeof type !== 'string' || !TRANSPORTS.has(type)) throw new Error(`MCP server "${name}": unsupported type "${String(type)}" (use stdio, sse or http)`);
  if (type === 'stdio' && (typeof s.command !== 'string' || !s.command)) throw new Error(`MCP server "${name}": "command" is required`);
  if (type !== 'stdio' && (typeof s.url !== 'string' || !s.url)) throw new Error(`MCP server "${name}": "url" is required`);
  return { ...s, type } as McpServerConfig;
}

/** Parses the file's JSON; accepts `{ mcpServers: {...} }` or the bare server map. */
export function parseMcpServers(json: unknown, source: string): McpServers {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${source}: expected a JSON object`);
  const obj = json as Record<string, unknown>;
  const map = (obj.mcpServers ?? obj) as Record<string, unknown>;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(`${source}: "mcpServers" must be an object`);
  return Object.fromEntries(
    Object.entries(map).map(([name, raw]) => {
      if (name === RESERVED) throw new Error(`${source}: the server name "${RESERVED}" is reserved for AgentCraft`);
      return [name, validServer(name, raw)];
    }),
  );
}

/** Reads the named file (must exist), or the default file when it exists, else no servers. */
export function loadMcpServers(file: string | undefined): McpServers {
  const target = file ? path.resolve(file.replace(/^~(?=$|[\\/])/, os.homedir())) : DEFAULT_MCP_CONFIG;
  if (!fs.existsSync(target)) {
    if (file) throw new Error(`MCP config not found: ${target}`);
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (e) {
    throw new Error(`MCP config ${target} is not valid JSON: ${(e as Error).message}`);
  }
  return parseMcpServers(json, target);
}
