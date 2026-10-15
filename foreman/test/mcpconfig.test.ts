import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMcpServers, parseMcpServers } from '../src/mcpconfig.js';

describe('mcp config', () => {
  it('reads the Claude Code .mcp.json shape and defaults stdio', () => {
    const s = parseMcpServers({ mcpServers: { roblox: { command: 'rbx', args: ['--stdio'] }, web: { type: 'http', url: 'http://localhost:1' } } }, 'x');
    expect(s.roblox).toEqual({ type: 'stdio', command: 'rbx', args: ['--stdio'] });
    expect(s.web).toEqual({ type: 'http', url: 'http://localhost:1' });
  });

  it('accepts a bare server map', () => {
    expect(Object.keys(parseMcpServers({ a: { command: 'a' } }, 'x'))).toEqual(['a']);
  });

  it('refuses the reserved agentcraft name, bad types and missing fields', () => {
    expect(() => parseMcpServers({ agentcraft: { command: 'a' } }, 'x')).toThrow(/reserved/);
    expect(() => parseMcpServers({ a: { type: 'ws', url: 'u' } }, 'x')).toThrow(/unsupported type/);
    expect(() => parseMcpServers({ a: {} }, 'x')).toThrow(/command/);
    expect(() => parseMcpServers({ a: { type: 'http' } }, 'x')).toThrow(/url/);
    expect(() => parseMcpServers([], 'x')).toThrow(/object/);
  });

  it('loads a named file and fails loudly when it is missing or broken', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mcp-'));
    const good = path.join(dir, 'mcp.json');
    fs.writeFileSync(good, JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    expect(Object.keys(loadMcpServers(good))).toEqual(['a']);
    expect(() => loadMcpServers(path.join(dir, 'nope.json'))).toThrow(/not found/);
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{');
    expect(() => loadMcpServers(bad)).toThrow(/not valid JSON/);
  });
});
