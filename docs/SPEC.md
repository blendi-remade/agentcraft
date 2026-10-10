# ACHQ — Spec

A generator that turns a prompt or concept into an AgentCraft-compatible HQ: a building shell plus the anchors the mod needs to run agents inside it. The first test case is a cliffside ocean office; the goal is the pipeline, not one building.

## North star

The user describes an office ("glass research station half-carved into an ocean cliff") and gets back two files: a schematic they paste with WorldEdit, and an anchors file the AgentCraft mod loads. The agents then sit at the desks, walk between stations, and spawn the player where the layout says, with no hand-fixing. The user can still place blocks by hand on top, and nothing the generator does requires changing the mod.

## Architecture

```
prompt / concept                      Generator (Node 22 + TypeScript)
 (planned: Claude)  ───────────────>   ├─ Office builder: shell, fixtures, anchors (today: one fixed office)
                                       ├─ Volume: block grid -> Sponge v3 .schem writer
                                       └─ Validator: anchor contract + bounds
                                                  │
                          ┌───────────────────────┴──────────────────────┐
                          v                                              v
                    office.schem                              agentcraft-anchors.json
                          │ WorldEdit //paste                            │ copied into the world folder
                          v                                              v
              Minecraft 26.3 world  <───── AgentCraft mod (Fabric, Java 25), unmodified, reads anchors
```

- **Anchors are hard constraints.** Desks, monitors, stations, and spawn are tracked data the mod reads back for agent motion and the player start. The generator fixes them first and generates only the look around them.
- **The mod is untouched.** `mod/` is the reference implementation and test target. The files that read anchors, `HqClientFeature.java` and `AgentManager.java`, are the coupling points to watch when merging upstream.
- **Local coordinates, then an origin.** The office is built in local coordinates (x east, y up, z south). A paste origin is added when anchors are written, because the mod stores absolute world positions.
- Transport: none. Output is plain files. The anchors file is `agentcraft-anchors.json` in the world folder, loaded only in the world the mod treats as the HQ world (`AgentCraft HQ`).

## Anchor contract (v1), source of truth is `mod/src/main/java/dev/agentcraft/layout/`

`AnchorNames.java` defines the names, `Anchors.java` the JSON, `Anchor.java` the meaning of each coordinate. The generator mirrors them in `generator/src/anchors.ts`. If they disagree, the Java wins.

File shape: `{ "layout": string, "revision": int, "bounds"?: {minX..maxZ}, "anchors": { name: {x, y, z, yaw, pitch} } }`. `yaw` and `pitch` default to 0. Coordinates are rounded to 3 decimals by the mod.

Yaw follows Minecraft: 0 = facing +Z (south), 90 = -X (west), 180 = -Z (north), -90 = +X (east).

Meaning of `x, y, z` by anchor kind:
- Agent spots and stations (`desk_*`, shared stations, `entrance`, `spawn`): where the feet stand. `yaw` is the facing.
- Block surfaces (`monitor_*`, `task_wall`, `decision_podium`): centre of the surface. `yaw` is the direction the front faces.
- Cameras (`cam_*`): eye position. `yaw` and `pitch` are the view direction.

Required names:
- `desk_<agentId>` and `monitor_<agentId>` for each agent in the cast: `marlow`, `juniper`, `kit`, `wren`, `rowan`, `tove` (from the mod's `cast.json`).
- Shared stations: `library`, `terminal`, `testbench`, `mergestation`, `meeting`, `lounge`, `user`. Extra slots are `<station>_2` and up.
- Fixtures: `task_wall`, `decision_podium`, `goal_atrium`, `entrance`, `spawn`.
- Extra names (such as `cam_overview`) are allowed.

## Practicality requirements (non-negotiable)

1. **Contract first**: a layout missing a required anchor, or with an anchor outside its bounds, fails validation and is never written as "ok".
2. **Deterministic**: the same prompt-independent inputs (origin, name) give byte-identical output. Randomness, when added, takes a seed.
3. **No mod changes**: nothing in the pipeline requires editing `mod/`.
4. **Standing spots are safe**: every agent spot has a solid block under it and two air blocks above it.
5. **Reachable**: a path exists from `spawn` to every desk and station. Not enforced yet.
6. **Round-trip tested**: `.schem` output is parsed back in tests, not only written.
7. **Readable output**: one command prints what was written and whether the layout validates.
8. **Licensing**: MIT, same as upstream. The name ACHQ does not claim to be the official project.

## Generator

Commands (from `generator/`):
- `npm run generate -- --origin x,y,z --out <dir> [--name <layout name>]` writes `office.schem` and `agentcraft-anchors.json`, then validates.
- `npm run validate -- <agentcraft-anchors.json>` checks a layout file.

Current output: a fixed 25 x 8 x 19 office. Stone-brick box, glass south wall, a door on the north wall, six desks with monitors, six shared stations, a task wall, a podium, an atrium, and a spawn. Fixtures are vanilla stand-ins (black concrete monitors, lecterns for stations) because the mod's own blocks are not placed yet.

Schematic format: Sponge v3, gzipped NBT, block index `x + z*Width + y*Width*Length`, varint block data. Written by hand with `prismarine-nbt` because `prismarine-schematic` is unlikely to know Minecraft 26.3. `DataVersion` defaults to 4325 (about 1.21.5); WorldEdit upgrades older versions and rejects newer ones.

## Build approach: don't place every block by hand

1. **WorldEdit**: bulk fills, copy-paste, replace, undo. The import path for generated schematics.
2. **Schematics**: pre-built structures from the community, imported with WorldEdit or Litematica.
3. **Structure blocks**: vanilla save and paste, e.g. design one agent pod and clone it per agent.
4. **MCEdit successors / WorldPainter**: edit the save file outside the game. WorldPainter leans toward terrain.
5. **MagicaVoxel pipeline**: model in MagicaVoxel, convert to a schematic, import with WorldEdit. Design before touching the live world. Not walked through yet.

## AI generation: prompt to schematic

| Tool | What it does |
| --- | --- |
| [Promptcraft](https://github.com/cgoulart35/Promptcraft) | Claude Code plugin; describe a build in conversation, get a `.schem` pasted directly. Conversational and iterative. |
| [Minecraft Builder MCP server](https://github.com/joshdevous/minecraft-builder-claude-mcp-server) | Natural language to WorldEdit-compatible `.schem` via Claude, no API costs. |
| [Structmatic](https://structmatic.com/) | Web tool: text or an existing schematic in, 3D studio to adjust, schematic out. |
| [BlockGPT](https://blockgpt.ai/) | Text to structure; exports `.schematic`, `.litematic`, or `.nbt`. |
| [Schematic Helper](https://schematichelper.com/) | Prompt to `.schem`. |

These tools generate decoration with no knowledge of anchors. The plan is to feed AgentCraft's anchor, spawn, and desk data in as constraints, or to generate the shell with them and then run the result through this project's validator.

## Scene concepts: cliff overlooking the ocean

1. **Glass-walled research station**: half-carved into the cliff face, half-cantilevered over the water. Each agent's workspace gets a different ocean view.
2. **Lighthouse and dock cluster**: a tall central tower as the coordination hub, small satellite studios along the cliff edge joined by rope bridges, roughly one per agent.
3. **Sunken amphitheater**: carved into the cliff top, open-air, ocean backdrop. A gathering or standup space more than individual offices.
4. **Greenhouse / observatory**: heavy glass, a reflecting pool mirroring the sky, a contemplative feel.

Which to prototype first is undecided.

## Fork policy

This is a standalone project, not a contribution back to AgentCraft. It is a fork of [blendi-remade/agentcraft](https://github.com/blendi-remade/agentcraft) so upstream fixes can still be pulled, as the SandboxServers and elliotnex forks do. Other forks of note: [SandboxServers/agentcraft](https://github.com/SandboxServers/agentcraft) (publishes the anchors), [elliotnex/agentcraft](https://github.com/elliotnex/agentcraft) (a town of projects, any model), [larattalabs/agentcraft-worlds](https://github.com/larattalabs/agentcraft-worlds) (one building per repository).

The anchor data is not an isolated config: the mod's Java reads it directly, so there is no clean upstream PR that would freeze it into a reference file. When rebasing, check `HqClientFeature.java` and `AgentManager.java` first.

## Repo layout

```
generator/    TypeScript toolkit (Node 22, vitest, zod, prismarine-nbt)
mod/          AgentCraft Fabric mod (Gradle, Java 25, MC 26.3), reference and test target
docs/         SPEC.md (this file)
```

## Open questions

- **Paste origin**: the generator assumes the schematic's min corner lands on `--origin`. Depends on how WorldEdit reads `Offset`. Untested.
- **`DataVersion`**: 4325 is a guess; the real value for 26.3 is unknown.
- **WorldEdit availability**: no confirmed build for Minecraft 26.3. Litematica is the fallback.
- **Mod blocks**: `mod/FEATURES.md` says the mod's own blocks carry a binding string (monitor = agent id, status lamp = `agent:<id>`, and so on) that the HQ builder sets, and `HqWorldDriver` drives their state. A generated office with vanilla stand-ins probably shows no live monitors or lamps. Whether anchors alone are enough for agent movement is untested.
- **Seats**: per the same file, every `desk_*`, `lounge*` and `meeting*` anchor must be a bottom-half stairs block with a free floor cell beside it, or agents stand inside the chair. The current office has no chairs, so its desk anchors break this rule.
- **Reachability**: how to check a walkable path from spawn to every anchor. The mod's `GridPathfinder.java` is the reference.
- **Which scene first**, and how the Claude-driven step feeds anchors in as constraints.

## Definition of done for v1

- `npm run generate` writes a schematic and an anchors file for the cliff office, and the layout validates.
- Pasting the schematic at the origin puts the building where the anchors say it is, verified in game.
- `/agentcraft anchors` in the HQ world lists the generated layout, and teleporting to `spawn` and a desk lands on safe ground.
- Agents run in the generated office: they reach their desks and stations.
- A prompt, not hand-written code, can produce a second office that also passes validation.
