# Set up a Codex, Claude or mixed team

Install and authenticate the providers you want to use on the **Foreman host**. Codex uses its
standalone CLI. Claude prefers an installed Claude Code CLI and can use the Agent SDK bundled
executable when no global CLI is present. Minecraft clients do not need access to CLI credentials.
Claude defaults to API authentication; using an existing personal subscription login requires
the host to launch Foreman with `--use-claude-login`. Discovery never enables this flag silently. Model catalogs depend on the installed CLI and
account; the names in screenshots are examples, not a fixed list of supported models.

## First setup

1. Start Foreman with the initial backend (`--backend codex` or `--backend claude`).
2. Join as the configured coding owner. An unconfigured team prompts for setup after discovery.
3. Choose **All Codex**, **All Claude**, or **Mixed team**.
4. Use **Choose…** for each lead, worker and reviewer role to select its provider, model and
   supported reasoning level.
5. Review the three roles, then **Save team**. Presets and role-picker choices are drafts until save.

A team save validates all roles before changing them. Existing individual overrides are preserved
unless their reset is explicitly selected. Running turns retain their provider/model; subsequent
turns use the saved choices. If startup could not authenticate a provider, saving a valid replacement
team rechecks execution readiness and resumes queued work when available.

One shared runner schedules every role, runs CI, and opens permission and merge decisions for the
owner. Choosing a Claude reviewer does not start another scheduler or authorize automatic merges.
Sessions are stored separately for Codex and Claude. An unavailable provider holds only its own
jobs; healthy providers can continue. Saving corrected settings rechecks availability and resumes
waiting jobs. Review and merge requirements still apply.

## Change one agent

Open the agent card and choose **Model**, or press **O**. The selector shows current-turn and
next-turn settings separately.

- **Codex [C]** and **Claude [L]** preview that provider's available models without saving.
- Select a model and reasoning level, then **Apply** (or Enter). Arrow keys navigate these choices.
- **Defaults [D]** clears individual overrides and returns the agent to its role defaults.
- **Team [T]** reopens team setup. **Retry [R]** reloads model discovery after a failure.
- Escape returns to the previous screen.

Unavailable providers show an error. A failed preview clears the old provider's model rows so they
cannot be applied as if they belonged to the new provider. In role pickers, Tab navigation retains
focus when controls refresh; Tab from Reasoning reaches the confirmation button.

## Verified behavior

On 2026-10-04, the integrated source passed 632 Foreman tests, TypeScript typechecking and generated
protocol consistency, plus the Java build and 50 JVM tests. Relevant tests cover atomic role saves,
provider-isolated sessions, migration, preserved overrides, explicit reset, unavailable-provider
recovery, retry, and setup discovery across reconnects. Old connection replies, owner-denied
requests, already-configured teams and simulation connections do not open an unwanted setup screen.

In an isolated Minecraft studio, discovery detected Codex 0.160.0 and Claude Code 2.1.289. Native
keyboard input selected and saved Codex Astra/medium for lead, GPT-6.1/high for workers, and Claude
Sonnet/high for review. Readback and a Foreman restart preserved these selections and setup completion.
The survival studio's preferences were not changed.

A separate disposable real-CLI fixture ran a Codex worker that edited and committed one file,
passed its project tests, and received a Claude review leading to an open owner merge decision.
The base branch remained unchanged until explicit approval; the approved merge then passed its
tests. This verifies one real mixed-provider workflow, not every
provider/model/account combination.

The actual client also opened both per-agent catalogs, kept the eighth slash-completion selection
visible, and received a reply to plain chat while readback still showed zero goals and tasks.
The original survival client was then restored at its saved position with its existing shaders.

## Screenshots and limits

The [annotated gallery](../contribution-gallery.html) contains real framebuffer captures. Annotation
markers are a separate HTML layer, and each image links to its untouched original. Captures show
rendered state; the checks described above establish the input and persistence behavior.

Mouse-handler and widget tests pass, but native automation could not reliably move Minecraft's
internal SDL pointer. These are not physical mouse-click verification; see [the mouse regression
notes](agent-card-mouse.md). The final build was also deployed to the original multiplayer world after a verified save and
backup. Existing per-agent model settings and shader files were preserved. The first-run setup
prompt was inspected and dismissed without saving any draft choices. See the contribution notes
for the distinction between this authenticated owner check and the loopback vanilla guest check.


The disposable real-CLI review was subsequently approved through Foreman: only `greeting.mjs`
merged into the fixture base branch, its tests passed, and the task became done. A separate
isolated process-interruption check verified that the failed agent card still opened Model (O)
and Message (M). Sending a new message received `RECOVERED` with authentication healthy and no
goals or tasks created. A transient model-discovery failure is now reported as a CLI failure,
without incorrectly directing the owner to sign in again.
