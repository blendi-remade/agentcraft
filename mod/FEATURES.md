# AgentCraft mod: feature map

What the mod expects from an HQ, for anyone generating one. Read `mod/DEV.md` for build and run.
The mod's UI features (`client.monitor`, `taskwall`, `decisions`, `console`, `diff`, `library`,
`permissions`, `hud`) and the agent NPC code (`client.agents`) are not described here; read the source.

## Packages that touch a layout

| package | owns |
|---|---|
| `layout` (main) | anchor registry + naming contract |
| `hq` (main) | HQ builders (`StudioHqBuilder` is the default), the build plan store |
| `client.hq` | world blocks driven by agent state (`HqWorldDriver`), `StatusLampRenderer`, `HqCheck` |
| `client.agents` | `AgentManager` reads anchors to place and move agents; `Seats`, `GridPathfinder` |
| `block`, `entity` (main) | the 16 blocks, block entities, the agent entity type |

## Anchors (`dev.agentcraft.layout`)

The single source of named world positions. An HQ builder publishes a layout; it is saved as
`agentcraft-anchors.json` in the world folder and reloaded on start. Read it anywhere:
`Anchors.current()` (immutable `Layout`: name, revision, bounds, anchors), `Anchors.get("desk_kit")`,
`Anchors.addListener(layout -> ...)`.

`Anchor(name, x, y, z, yaw, pitch)`. Stations and agent spots: **feet** position + facing yaw. `cam_*`:
**eye** position + view. Block anchors (`monitor_*`, `task_wall`, `decision_podium`): surface centre,
yaw = the direction the front faces. Yaw: 0 = +Z (south), 90 = -X (west), 180 = north, -90 = east.

Naming contract (`AnchorNames`, required from every HQ builder):

| name | meaning |
|---|---|
| `desk_<agentId>`, `monitor_<agentId>` | per cast agent (marlow juniper kit wren rowan tove) |
| `library`, `terminal`, `testbench`, `mergestation`, `meeting`, `lounge`, `user` | shared station slot 1 (`user` = next to the player / podium) |
| `<station>_2` .. `_N` | more slots at the same station (lounge needs 6: off-shift agents go there) |
| `task_wall`, `decision_podium`, `goal_atrium`, `entrance`, `spawn` | fixed points |
| `cam_<name>` | camera points |

**Slot spacing:** nameplates declutter themselves, but plates sit at their natural height only when
neighbours are far enough apart on screen. A full plate is up to 3.15 blocks wide. Space shared-station
slots **at least 1.6 blocks** apart (2+ where agents show activity, e.g. library, meeting), and
stagger rows so the back row is not directly behind the front row.

**Seats:** every `desk_<id>`, `lounge*` and `meeting*` anchor is a bottom-half stairs block with its
back away from the table or desk and a free floor cell on its right-hand side (the cell the agents
step in from). Without that, an agent would stand inside the chair. `dev.hq.check` lists them.

## The studio HQ (`hq.StudioHqBuilder`, default builder `studio`)

`/agentcraft hq` builds it. A fresh HQ world builds it on first start (`AGENTCRAFT_HQ_AUTOBUILD=0`
turns that off). Floor blocks are at y=65, so **agents stand at y=66**. Zones and their anchors:

| zone | stations / anchors |
|---|---|
| Goal Atrium | `goal_atrium`; the hologram is the `goal:atrium` status lamp's block entity |
| Task Wall | 7 x 4 `task_board` panel facing east; `task_wall` (surface centre) |
| Decision Podium | podium block facing west; `decision_podium`, `podium_user` (player's spot), `user`, `user_2`, `user_3` |
| Desks | `desk_<id>` is **the chair** (dark oak stairs), `seat_<id>`, `monitor_<id>` (3 x 2 monitor), status lamp `agent:<id>` in the wall above |
| Library | `library` .. `library_4`; memory archives bound `shared`, catalogs, lecterns |
| Test bench | `testbench` .. `testbench_3`, CI lamps `ci:#1..#3` |
| Terminals | `terminal`, `terminal_2` |
| Merge station | `mergestation`, `mergestation_2`; `merge` lamp |
| Lounge | `lounge` .. `lounge_6` = armchairs (seats) |
| Meeting | `meeting` .. `meeting_6` = chairs (seats) |

Status lamps are driven by `client.hq.HqWorldDriver` from the agent state; each lamp's block entity
holds a binding string: `agent:<id>`, `ci:<repoId>` or `ci:#<n>`, `goal`, `goal:atrium`, `decisions`,
`merge`, `beacon`. Also driven: podium `open`, merge station `active`, monitor `lit`, and vanilla
copper bulbs within 3 blocks of `decision_podium` or a `mergestation` slot (lit while that station
needs the user). Nothing changes while the Foreman link is down.

Build contract: the builder plans everything in a site box in memory and applies it as a diff, and
the plan is stored in the world folder (`agentcraft-hq-plan.dat`), so cells the player changed
afterward are left alone; `/agentcraft hq force` resets them. Another builder invalidates the stored plan.

`dev.hq.check` runs the agents' own A* from `entrance` and `lounge` to every standing anchor and
reports unreachable routes, spots that would stand on furniture, crowded slots, and block light.
`GridPathfinder` treats any block whose collision top is >= 0.9 (stairs, table tops) as floor.

## Blocks and block entities (`dev.agentcraft.block`)

All 16 blocks are registered with properties, facing rule (front faces the placer), luminance and
shapes, with block items in the "AgentCraft Studio" creative tab.

Stations with dynamic content have a block entity (`block.entity.*BlockEntity`, all extend
`StationBlockEntity`): monitor, task_board, decision_podium, merge_station, status_lamp,
console_terminal, memory_archive. Each carries a **binding** string (saved and synced) that the HQ
builder sets: monitor = agent id, status_lamp = `agent:<id>` / `ci:<repoId>` / `goal`,
memory_archive = scope, others empty = "the default".

Connectable panels (`PanelBlock`: monitor, task_board): `up/down/left/right` connect same-facing
neighbours; `PanelBlock.origin(...)` and `extent(...)` give the bottom-left block and the size of the
whole surface. The renderer draws from the origin block only.
