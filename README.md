# ACHQ

A toolkit that turns a prompt or concept into an AgentCraft-compatible HQ: the building shell plus the anchors (spawn, desks, monitors, stations) the mod needs to run agents inside it.

ACHQ is a fork of [AgentCraft](https://github.com/blendi-remade/agentcraft), the MIT-licensed Fabric mod that runs Claude agents as NPCs in a walkable Minecraft studio. It is not the official project and is not affiliated with it. The first test case is a cliffside ocean office.

## Why

AgentCraft builds one fixed studio with `/agentcraft hq`. Where agents sit, walk, and spawn is not decoration, it is data: the mod publishes named anchors and reads them back for agent motion, monitors, and the player spawn. A generated office only works if it honors that contract, so ACHQ treats the anchors as hard constraints and generates only the aesthetic shell around them.

## What it will do

- Take a text prompt (or a concept like "glass research station on a cliff") and produce a build.
- Emit the build as a `.schem` file that WorldEdit or Litematica can paste.
- Emit a matching `agentcraft-anchors.json` so the mod can load the layout without rebuilding.
- Validate that every required anchor exists and is reachable before anything is pasted.

## The anchor contract

Layouts are a `Layout` (name, revision, optional bounds, and a map of named anchors) saved as `agentcraft-anchors.json` in the world folder. Names are defined in [`AnchorNames.java`](mod/src/main/java/dev/agentcraft/layout/AnchorNames.java). A generated HQ must write at least:

| Anchor | Meaning |
| --- | --- |
| `desk_<agentId>` | Feet spot at an agent's desk, facing the monitor. One per agent. |
| `monitor_<agentId>` | Center of that agent's monitor screen. |
| `library`, `terminal`, `testbench`, `mergestation`, `meeting`, `lounge`, `user` | Shared stations. Extra slots are `<station>_2` and up. |
| `task_wall`, `decision_podium`, `goal_atrium` | Fixed fixtures. |
| `entrance`, `spawn` | Main door and player start. |

Extra anchors (such as `cam_<name>`) are fine.

## Repo layout

- `generator/`: the TypeScript toolkit. Writes `office.schem` and `agentcraft-anchors.json` (`npm run generate`) and validates anchor files (`npm run validate`).
- `mod/`: the AgentCraft Fabric mod, kept as the reference implementation and test target. The files that read anchors, `HqClientFeature.java` and `AgentManager.java`, are the main coupling points to watch when merging upstream changes.
- `docs/SPEC.md`: the ACHQ spec: architecture, anchor contract, tool research, scene ideas, and open questions.

## Status

Planning. The upstream parts that are not needed for generation (agent orchestrator, art pipeline, QA harness) have been removed. Some docs under `mod/` and `docs/` still describe them and have not been cleaned up yet.

## License

MIT, same as upstream. See [LICENSE](LICENSE).
