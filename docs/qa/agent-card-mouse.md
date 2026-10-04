# Agent card mouse regression

Minecraft 26.3 uses SDL mouse button identifiers. `InputConstants.MOUSE_BUTTON_LEFT` is 1;
the previous checks for button 0 rejected a normal left click before hit testing. Agent card,
task, library and diff screens now use the named constant (commit `5ae8082`).

`AgentCardMouseTest` sends `MouseButtonEvent` objects through the production card handler.
It verifies that left clicking Model opens `AgentModelScreen`, left clicking Message opens the
registered console, and right clicking Model does not activate it. Minecraft/Foreman services
are mocked; the test does not open a window or send a message.

Run with Java 25 from the repository root:

```sh
sh mod/gradlew -p mod test --tests '*AgentCardMouseTest'
```

On 2026-10-04, temporarily restoring the original button-0 comparison made both left-click
checks fail (2 failures out of 3 tests). Restoring the named constant made all 3 pass.
The temporary mutation was reverted before continuing; it was never installed in the client.

## Runtime evidence limit

The corrected client was loaded in the existing multiplayer world. Native automation failed to
move Minecraft's internal SDL pointer, despite moving its own visible cursor. The new read-only
`dev.state.mouse` diagnostics showed the internal pointer remaining at the window center after
both click and drag attempts. This also affected vanilla menus. Fullscreen was restored after
a windowed comparison; the dedicated server was not restarted.

The regression tests establish handler behavior. These attempts do **not** establish successful
physical mouse interaction, and screenshots from them must not be captioned as click-success
proof. Keep that distinction in the final feature gallery.
