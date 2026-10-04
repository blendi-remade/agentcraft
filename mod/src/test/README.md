# Multiplayer qualification (t7)

The tests execute the production owner, relay, client assembly and packet codec code in a JVM.
Minecraft registries are bootstrapped for mock players; no game server, client window or Foreman
process is started. Mockito supplies players, networking and WebSocket responses. Private relay
entry points are called reflectively so the fixtures do not add a public testing API.

From the repository root, with Java 25:

```sh
mkdir -p .qualification/gradle-home .qualification/tmp
GRADLE_USER_HOME="$PWD/.qualification/gradle-home" TMPDIR="$PWD/.qualification/tmp" \
  sh mod/gradlew -p mod --no-daemon clean build
```

Once dependencies are cached, add `--offline`. Gradle needs a local lock socket even offline.
The original restricted sandbox blocked that socket and dependency DNS; the successful runs used
approved execution outside that sandbox, with build caches inside the assigned worktree.
Gradle's test environment removes inherited owner UUID/offline-override variables.

## Coverage

- `OwnerAccessTest`: authenticated configured owner versus guest; absent/invalid owner; dedicated
  offline default rejection and existing explicit offline override; integrated singleplayer profile;
  a real `CommandSourceStack` named `Server` cannot impersonate the dedicated console.
- `ServerForemanRelayTest`: hardcoded loopback endpoint; owner-only prompt/decision/work/repository/
  diff actions; guest chat requests reach only the owner; shared memory remains visible while private
  entries are removed; invalid JSON/type/size rejection; failed send cleanup; player disconnect route
  cleanup; owner-only reconnect control; link failure cleanup; queued old snapshots ignored after
  generation change or stop. Merge and permission answers share the `decision.answer` gate.
- `ForemanRelayClientTest`: out-of-order and interleaved fragments; invalid counts/indices/duplicates;
  expiry; bounded incomplete transfers and UTF-8 size; pending requests fail immediately on disconnect.
- `ForemanPayloadsTest`: Unicode wire round trip and oversized request codec rejection.

## Recorded checks

Checkpoint inspected: `99d32fa8ba9956918004a6a61a2355db2f6ee39f`.
Java: Microsoft OpenJDK 25.0.4.1+1-LTS. Gradle 9.7.1; Fabric Loom 1.18.2.

The first 19 tests were also run against the four unchanged checkpoint production files. Command:
`sh mod/gradlew -p mod --offline --no-daemon test` with the same cache/temp variables above.
Result: **19 executed, 5 failed**, reproducing the console-name bypass, stale queued snapshot,
non-diff send failure, pending client request on disconnect, and unbounded incomplete transfers.
The sources were restored immediately afterward. Local negative receipt:
`.qualification/baseline-regressions.log` and `.qualification/baseline-test-results/`.

After restoring the fixes, `--offline --no-daemon clean build` succeeded (12 seconds).
An additional reconnect-control fixture was then added; final `--offline --no-daemon build`
succeeded in 8 seconds: **20 tests, 0 failures, 0 errors** (owner 5, server relay 8, client relay 5,
packet codecs 2). XML receipts are in `mod/build/test-results/test/TEST-*.xml` and the HTML report is
`mod/build/reports/tests/test/index.html`.
Local final command output: `.qualification/final-build.log`.

## Runtime scenarios not executed

- Real online-mode authentication with two Minecraft accounts, including an operator who is not owner.
- Real dedicated offline-mode login rejection and the deliberately retained explicit offline override.
- In-game guest UI rendering, normal chat, owner request notification, and command-block execution.
- Real Foreman WebSocket handshake, disconnect/retry timing, ping watchdog, and player reconnect replay.
- Real permission prompts, coding runs, merge operations, or repository/file side effects.
- Integrated singleplayer world startup and end-to-end client/server relay operation.
- Vanilla-client compatibility and adversarial sustained network load.

These fixtures qualify Java behavior, not live authenticated multiplayer. The existing explicit
`agentcraft.owner.allowOffline` / `AGENTCRAFT_OWNER_ALLOW_OFFLINE` escape hatch remains unchanged;
authenticated-owner claims require leaving it disabled. The owner's active server was not launched,
modified or contacted, and nothing was published or deployed.
