// Prints the skills and MCP servers each engine already has (src/skills.ts) as JSON, for the
// dashboard's checkboxes:  node --import tsx scripts/discover.ts [--repo <path>]...
import { claudeMcpServers, codexMcpServers, findSkills, skillRoots } from '../src/skills.js';

const repos: string[] = [];
for (let i = 2; i < process.argv.length; i++) if (process.argv[i] === '--repo' && process.argv[i + 1]) repos.push(process.argv[++i]!);
console.log(
  JSON.stringify({
    claude: { skills: findSkills(skillRoots('claude')), mcp: claudeMcpServers(repos).map(({ spec: _spec, ...m }) => m), roots: skillRoots('claude') },
    codex: { skills: findSkills(skillRoots('codex')), mcp: codexMcpServers(), roots: skillRoots('codex') },
  }),
);
