// Claude SDK adapter for the shared AgentCraft tools.
import { createSdkMcpServer, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { buildTeamTools, MCP_SERVER, type AgentTool } from '../tools.js';
import { userName } from '../../user.js';
export * from '../tools.js';

/** The team tools as the "agentcraft" MCP server for one turn. */
export function mcpServer(tools: AgentTool[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: MCP_SERVER, version: '0.1.0', tools, alwaysLoad: true, instructions: `AgentCraft team tools: coordinate with teammates, ask ${userName()}, keep memory and the task board up to date.` });
}

export function buildMcpServer(...args: Parameters<typeof buildTeamTools>): McpSdkServerConfigWithInstance {
  return mcpServer(buildTeamTools(...args));
}
