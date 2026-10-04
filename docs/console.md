# Console, decisions, permissions and HUD

The practical core of AgentCraft: how you talk to the team and answer them without leaving the
game. Code: `mod/src/client/java/dev/agentcraft/client/{console,decisions,permissions,hud}`.
Shots: `tools/scenes/console.json` (showcase busy state).

## Keys (Options > Controls > Key Binds > AgentCraft, all rebindable)

| key | does |
| --- | --- |
| `` ` `` (Backtick) | open the console (again with an empty input: close it) |
| `Enter` while looking at a console terminal | open the console (a right-click on the terminal does too) |
| `J` | open the decision queue (a right-click on the Decision Podium does too) |

Neither screen pauses the game: agents keep walking and working behind it.

## Console

A paper command bar at the bottom (brass `>`, the caret, ghost completion) and a live feed panel
above it: the Foreman feed merged with the console's own lines, each agent in its colour (face,
name colour, a colour stripe), time separators between minutes, "needs you" lines in clay (click
one to open the decision queue; Esc comes back to the console). The right end of the bar always
says what Enter will do ("message Marlow", "message Juniper", "new goal → pocket-notes", "answer d4: Merge") or
why it cannot ("no agent named @xyz (marlow, juniper, ...)", "Foreman offline: this can't be sent
yet"). After Enter the bar clears at once and the same spot shows the Foreman's ack ("sent to
Juniper ✔"); a refusal shows a red strip above the bar, a line in the feed, and puts your text back
so you can fix it. Esc never loses a draft: whatever is in the bar when the console closes comes
back the next time it opens (this session), and the console terminal shows it on its screen.

| input | sends |
| --- | --- |
| plain text | `user.message` to `marlow` (conversation; also steers an active goal) |
| `/goal <text>` | `goal.submit` (with several repos you pick one first: 1-9 / arrows, Enter) |
| `@juniper text`, `@all text` | `user.message` |
| `/answer [d4] <n\|option> [text]` | `decision.answer`; `n` is the 1-based button number; the id can be left out when one decision is open; free text for questions; `Request changes` needs the feedback text |
| `/repo add <path>`, `/repos` | `repo.add`, list repos |
| `/pause @x`, `/resume @x`, `/stop @x` (also `all`), `/spawn @x [task]` | `agent.action` |
| `/task <id> cancel\|retry\|prioritize [n]\|reassign @x` | `task.action` |
| `/diff [worktree\|@agent\|task]` | opens the diff screen (`diff`, owned by the diff feature); without one, prints a file summary from `diff.request` |
| `/status`, `/help`, `/decide`, `/clear`, `/sound on\|off` | local |

Plain text does not submit a new goal. For example, `can we discuss this?` talks to Marlow;
`/goal implement the agreed change` submits work to the selected repository. Messages can still
steer work already in progress. This mapping is for the Minecraft console; the terminal TUI
retains its plain-text goal entry.

Tab completes agent names (also after `/pause` etc.), commands, decision ids and options, task ids
and worktrees; repeated Tab cycles, Up/Down move in the popup. Up/Down otherwise walk the history
(kept in `<game dir>/agentcraft/console-history.txt`). Shift+Enter adds a line; a multi-line
paste grows the bar (up to 6 lines, then it scrolls).

## Decision screen

One decision at a time, in queue order: permission prompts first (an agent is blocked mid
tool-call), then questions, then merges, oldest first. The brass frame shows the asking agent
(framed portrait, name, kind, age, task), the question, the context in a scrollable well and the
options as buttons.

| key | does |
| --- | --- |
| `1`-`9` | choose that option at once |
| Enter | the highlighted option (brass ring; the arrows move it). Questions start on the first (recommended) option; merges and permissions start with **no** highlight, so Enter alone never merges or grants anything |
| typing | starts a free-text answer (questions); Enter sends it, Shift+Enter adds a line |
| Tab / Shift+Tab | next / previous decision (also the ‹ › keys in the header) |
| `D` | merge: review the diff |
| Esc | later (or leave the text field) |

Space does nothing here (a reflex jump never answers). Option keys are ignored for 350 ms after the
screen opens or a new decision comes up by itself, and key repeats or keys still held from before
the screen (a held Enter from the console's `/decide`) are ignored; the footer says so if a press
was dropped.

Merges show whose work it is (face + name), files, +/− and the test result, the branch only when
the question does not already name it, the per-file list (fetched with `diff.request`), the
worker's summary and Rowan's review. "Request changes" opens the feedback field (Enter sends it to
the worker), "Reject" asks for a second press (it abandons the branch; only then does the button
grow into "Confirm reject").

Answering never makes you wait: the next decision comes up as soon as you answer (the footer says
"Sending d5: Merge…", then "✔ d5: Merge"). With nothing else waiting the answered decision stays
with its button pressed until the ack, then "All caught up ✔" and the screen closes. If the
Foreman refuses an answer, that decision comes back (with the text you typed) and the error is in
the footer; if the screen was closed meanwhile, a toast says so. A decision answered elsewhere
(console, another client) is shown read-only as "✔ d3 answered elsewhere: Merge" for a moment and
skipped. The status always wins the footer: key hints step aside when it needs the room.

## Permission prompts

The body of a permission decision: the tool and the exact command in a well with a risk stripe, a
risk chip (low brass / medium clay / high red, from the Foreman's reason: deletes, writes outside
the worktree, publishing, credentials are high; network, installs, new branches are medium; reads
and `cd` outside are low), the reason, the working directory, and what "Always allow for this agent"
covers (tied to key 2). Buttons: Allow once (1), Always allow (2, sends the exact label
`Always allow for this agent`), Deny (3).

## HUD

- Goal bar (top centre, boss-bar style): status dot, goal text, %, progress bar, the open task
  columns that have tasks and "n/m done" ("finished 2m ago" once the goal is done). With no goal
  yet: "No goal yet · press [Backtick] to give the team one" (punctuation keys are spelled out on
  keycaps; their glyphs are a pixel or two). It keeps clear of the connection pill using the pill's
  real size each frame: narrower next to it, or below it when there is no room (the two-line
  "Reconnecting to the Foreman" pill on a narrow GUI).
- Decisions badge under it: "2 waiting · press J" with a pulsing clay dot.
- Paper toasts for `notify` (top right, under the connection pill, below the goal bar on narrow
  screens): the agent's portrait, "Marlow needs you", two lines, the J hint; they leave early once
  their decision is answered. Hidden while the decision screen is open.
- Sounds: a soft note-block bell when a decision opens, a chime when a task is done, a bigger chime
  when the goal completes. Never on a reconnect snapshot. Off when the game runs muted
  (`AGENTCRAFT_MUTE=1`, the dev/QA default) or after `/sound off`.

## In the world

- Decision Podium: while decisions wait, a speech bubble over the podium shows the count, the key,
  the first decision's agent and its question (it grows with distance so it reads across the
  room), and the podium's `open` block state (lit paper, lens, bell) follows "any decision open".
  The bubble reserves its screen space in the nameplate layout (`PlateLayout.reserve`), so the
  plate of the agent waiting next to the podium lifts above it (with its leader line) instead of
  covering it; `dev.decisions` reports `podium.plateOverlaps` (0 when settled).
- Console terminal: the leaning screen is a small live console: a "Console" title bar with what
  waits for you (pulsing clay "2 waiting", "all clear", "offline"), the last three feed lines with
  the agent's colour stripe and face, and the prompt: your unsent draft, or "Enter to type".

## QA hooks (DevBridge)

| command | |
| --- | --- |
| `dev.screen {open:"console"}` + `dev.type "@ju"` | console with the autocomplete (QA consoles start empty and never read or keep the player's draft, so a re-run never types "@ju@ju") |
| `dev.console {prefill?, submit?, open?}` | open the console with text (and press Enter); returns value, ghost, completions, ack stats, the kept `draft` |
| `dev.key {mapping:"key.agentcraft.console"}` | the real key path (restores the draft); `dev.key` modifiers are SDL bits: Shift 1, Ctrl 64 |
| `dev.console.parse {text}` | what an input would do (intent, completions), nothing is sent |
| `dev.screen {open:"decision"}`, `dev.decision {decisionId?\|kind?\|preview?}` | the decision screen (queue head / one decision / a sample permission marked "preview") |
| `dev.screen {open:"permission"}` | the oldest open permission prompt, else the marked preview |
| `dev.decisions` | the queue in HUD order, the open decision screen's state (`current`, `highlight`, `armed`, `status`, `lastAnswer`) and `podium.plateOverlaps` (nameplates overlapping the podium bubble last frame) |
| `dev.toast {text, level?, decisionId?}`, `dev.hud.state` | a toast without the Foreman; what the HUD shows (waiting, toasts, sound counters, `pillLeft/pillBottom`, `goalBarPillClash`) |
| `dev.hud.guiScale {scale}` | GUI scale for this session (layout checks at 2 and 4) |

Note: `id` is a reserved request field, hence `decisionId`.
