# AgentCraft on the Steam Deck

Run AgentCraft from your Steam library on a Steam Deck (SteamOS 3.x), in Game Mode or Desktop Mode,
with real controller support. Builds on the Linux launcher (`tools/unix.mjs`).

```sh
git clone https://github.com/blendi-remade/agentcraft ~/code/agentcraft
~/code/agentcraft/tools/steamdeck/install.sh     # Java 25, Node 22, Controlify, Steam library entry
~/code/agentcraft/tools/steamdeck/art.sh         # optional: Minecraft-style library artwork
```

Then in Steam: **AgentCraft → controller icon → Controller Layout → Templates → Gamepad**, and launch
it. The first start downloads Minecraft and Fabric through Gradle and takes a few minutes; after
that the studio is ready in about 30 to 40 seconds.

Everything lives in your home folder: no `sudo`, no `steamos-readonly`, nothing that a SteamOS
update can wipe.

## What the scripts do

| Script | |
|---|---|
| `install.sh` | Puts Temurin Java 25 and Node 22 in `~/.local/opt` (unless suitable ones exist), downloads [Controlify](https://modrinth.com/mod/controlify) and [YetAnotherConfigLib](https://modrinth.com/mod/yacl) for the mod's Minecraft version into `mod/run/mods` (checksums verified against Modrinth), and adds an **AgentCraft** entry to your Steam library with `steamos-add-to-steam`. Safe to run again. |
| `launch.sh` | What the Steam entry runs. Starts the Foreman and the game through `tools/unix.mjs`, stays alive while the game runs so Steam keeps tracking it, and stops the Foreman (sim) or just the game (claude) when you quit. Log: `artifacts/logs/steamdeck-launch.log`. |
| `art.sh` / `art.py` | Draws a cover, wide capsule, hero, blocky stone logo and icon from the README screenshots and installs them for the AgentCraft shortcut. Needs Pillow (uses `uv` if you have it). |

## Backends

The Steam entry starts the free **sim** team. For real agents (not yet tested on the Deck), set the backend in the entry's
launch options, e.g. `AGENTCRAFT_BACKEND=claude %command%`, and register a repo once with
`node tools/foremancli.mjs repo-add /path/to/repo` (see the main README for API keys and costs).

## Controls (Controlify)

Controlify detects the Deck as a Steam Deck controller: left stick walks, right stick looks,
R2 / L2 break / use, A jumps, with on-screen button guides. AgentCraft's own keys (console `` ` ``,
decisions `J`) can be bound to controller buttons in Controlify's settings, or to the back buttons
in the Steam layout editor. **Steam + X** opens the on-screen keyboard for the console.

## Notes

- The launcher turns off the shared Gradle daemon for Steam launches. A daemon started from a
  terminal would otherwise start the game outside the Steam shortcut, so Game Mode would show it
  under the wrong app with the wrong controller layout.
- Steam stops the launcher as soon as the game window closes; cleanup runs from a signal trap.
- Tested on a Steam Deck OLED, SteamOS 3.8, Minecraft 26.3, Controlify 3.5.3, Java 25.0.4, Node 22.
