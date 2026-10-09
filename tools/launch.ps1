<#
.SYNOPSIS
  AgentCraft one-command launcher: starts (or reuses) the Foreman, then builds and starts Minecraft.

.DESCRIPTION
  1. First run: installs foreman/ and tools/ npm dependencies if node_modules is missing (the
     Gradle wrapper downloads Gradle, Minecraft and Fabric by itself).
  2. Foreman: if one is already running for <home>/<profile> (foreman.json pid alive + port
     answering) it is reused; otherwise it is started in the background (hidden console, log in
     artifacts/logs/, run file in artifacts/run/ so tools/stop.ps1 can stop it).
  3. Minecraft: `gradlew runClient` (builds if needed) with the Foreman/DevBridge ports passed via
     env, then waits until the HQ world is ready. Real use: sound on, window comes to front.
     -Dev: muted, never steals focus, no toasts (unattended QA / agents).
  Stop everything with tools\stop.ps1 (only what this script started).

.EXAMPLE
  tools\launch.ps1                                     # claude backend (needs ANTHROPIC_API_KEY), ~/.agentcraft, ports 7878/7879
  tools\launch.ps1 -Repo C:\code\life-tracker          # register a repo with the Foreman
  tools\launch.ps1 -UseClaudeLogin                     # personal use: your `claude` CLI login instead of an API key
  tools\launch.ps1 -Backend codex                      # an all-Codex team on your Codex login (`codex login`)
  tools\launch.ps1 -ForemanArgs '--worker-engine','codex'   # mixed: Claude lead, Codex workers
  tools\launch.ps1 -Backend sim                        # scripted demo team, no API calls
  tools\launch.ps1 -Showcase late                      # static showcase state (sim)
  tools\launch.ps1 -Dev -Showcase busy -Home C:\Projects\agentcraft\.agentcraft-home -Port 27878 -DevPort 7889
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [ValidateSet('sim', 'claude', 'codex', 'openai')][string]$Backend,
    [string[]]$Repo,
    [Alias('Profile')][string]$ForemanProfile,
    # -Showcase [busy|late]: a switch with an optional positional value
    [switch]$Showcase,
    [Parameter(Position = 0)][ValidateSet('busy', 'late')][string]$ShowcaseAt,
    [switch]$Dev,
    [int]$Port,
    [int]$DevPort,
    [Alias('Home')][string]$AgentHome,
    [string]$GradleHome,
    [switch]$Reset,
    [double]$Speed,
    [switch]$Autostart,
    [string]$Goal,
    [string[]]$ForemanArgs,
    # claude backend: use your local `claude` CLI login instead of ANTHROPIC_API_KEY (personal use only)
    [switch]$UseClaudeLogin,
    [switch]$Notify,
    [switch]$NoNotify,
    [switch]$NoGame,
    [switch]$NoForeman,
    [switch]$NoWait,
    [int]$TimeoutSec = 600,
    [string]$SummaryJson,
    # print what would be started (commands + game env) without starting anything
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\procs.ps1')

$Root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$L = Get-AcLayout $Root
$Main = Get-MainCheckout $Root
$t0 = Get-Date
$summary = [ordered]@{ ok = $false; checkout = $Root; dev = [bool]$Dev; foreman = $null; game = $null; error = $null }

function Save-Summary {
    if ($SummaryJson) { Write-JsonFile $SummaryJson $summary }
}

function Fail([string]$Message, [string[]]$Tail) {
    Write-Fail $Message
    if ($Tail) {
        Write-Host '  --- log tail ---' -ForegroundColor DarkGray
        foreach ($l in $Tail) { Write-Host "  $l" -ForegroundColor DarkGray }
    }
    $summary.error = $Message
    Save-Summary
    exit 1
}

# --- resolve options -----------------------------------------------------------------------------

$showcaseOn = $Showcase.IsPresent -or [bool]$ShowcaseAt
if ($showcaseOn) {
    if ($Backend -and $Backend -ne 'sim') { Fail '-Showcase needs the sim backend (it holds a scripted state).' }
    $Backend = 'sim'
    if (-not $ShowcaseAt) { $ShowcaseAt = 'busy' }
}
if (-not $Backend) { if ($env:AGENTCRAFT_BACKEND) { $Backend = $env:AGENTCRAFT_BACKEND } else { $Backend = 'claude' } }
if (-not $ForemanProfile) {
    if ($showcaseOn) { if ($ShowcaseAt -eq 'late') { $ForemanProfile = 'showcase-late' } else { $ForemanProfile = 'showcase' } }
    else { $ForemanProfile = $Backend }
}
if ($ForemanProfile -notmatch '^[A-Za-z0-9_-]+$') { Fail "bad profile name '$ForemanProfile' (letters, digits, - and _)" }
$portGiven = [bool]$Port
if (-not $Port) { if ($env:AGENTCRAFT_PORT) { $Port = [int]$env:AGENTCRAFT_PORT } else { $Port = 7878 } }
if (-not $DevPort) { if ($env:AGENTCRAFT_DEV_PORT) { $DevPort = [int]$env:AGENTCRAFT_DEV_PORT } else { $DevPort = 7879 } }
if ($Port -eq $DevPort) { Fail "-Port and -DevPort must differ (both $Port)" }
foreach ($p in @($Port, $DevPort)) { if (@(3000, 5173, 8080) -contains $p) { Fail "port $p is reserved for other dev servers; pick another" } }
if (-not $AgentHome) {
    if ($env:AGENTCRAFT_HOME) { $AgentHome = $env:AGENTCRAFT_HOME }
    elseif ($Dev) { $AgentHome = Join-Path $Main '.agentcraft-home' }   # unattended runs never touch ~/.agentcraft
    else { $AgentHome = Join-Path $env:USERPROFILE '.agentcraft' }
}
$AgentHome = Resolve-FullPath $AgentHome
if (-not $GradleHome) {
    if ($env:GRADLE_USER_HOME) { $GradleHome = $env:GRADLE_USER_HOME } else { $GradleHome = Join-Path $Main '.gradle-home' }
}
$GradleHome = Resolve-FullPath $GradleHome
if ($SummaryJson) { $SummaryJson = Resolve-FullPath $SummaryJson }
$repoPaths = @()
foreach ($r in @($Repo | Where-Object { $_ })) {
    foreach ($part in ($r -split ',')) {
        if (-not $part.Trim()) { continue }
        $full = Resolve-FullPath $part.Trim()
        if (-not (Test-Path (Join-Path $full '.git'))) { Fail "-Repo $full is not a git repository root" }
        $repoPaths += $full
    }
}
New-Item -ItemType Directory -Force $L.Logs, $L.Run | Out-Null

Write-Host ''
Write-Host 'AgentCraft' -ForegroundColor Cyan -NoNewline
if ($Dev) { Write-Host '  (dev: muted, no focus, no toasts)' -ForegroundColor DarkGray } else { Write-Host '' }
Write-Kv 'checkout' $Root
Write-Kv 'home' "$AgentHome  (profile $ForemanProfile)"

# --- prerequisites -------------------------------------------------------------------------------

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js 22+ is required (https://nodejs.org). `node` is not on PATH.' }
$nodeVer = (& $node.Source --version).Trim()
if ([int]($nodeVer.TrimStart('v').Split('.')[0]) -lt 22) { Fail "Node.js 22+ is required (found $nodeVer)" }

# npm dependencies: installed when node_modules is missing (first run) or older than the lockfile
# (after a pull that changed dependencies). Never while something of ours may be using them.
function Install-NodeDeps([string]$Dir, [string]$Name) {
    $lock = Join-Path $Dir 'package-lock.json'
    $stamp = Join-Path $Dir 'node_modules\.package-lock.json'
    $why = $null
    if (-not (Test-Path (Join-Path $Dir 'node_modules'))) { $why = 'first run' }
    elseif ((Test-Path $lock) -and (Test-Path $stamp) -and ((Get-Item $lock).LastWriteTimeUtc -gt (Get-Item $stamp).LastWriteTimeUtc.AddSeconds(2))) { $why = 'package-lock.json changed' }
    if (-not $why) { return }
    $log = Join-Path $L.Logs "npm-$Name.log"
    $verb = 'install'
    if (Test-Path $lock) { $verb = 'ci' }
    if ($DryRun) { Write-Kv 'would run' "npm $verb in $Name/ ($why)" 'Yellow'; return }
    Write-Kv 'setup' "npm $verb in $Name/ ($why; log $log) ..." 'Yellow'
    $p = Start-Process -FilePath $env:ComSpec -ArgumentList "/d /s /c `"npm $verb --no-audit --no-fund`"" -WorkingDirectory $Dir -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" -Wait -PassThru
    if ($p.ExitCode -ne 0) { Fail "npm $verb failed in $Name/ (exit $($p.ExitCode))" ((Get-LogTail $log 10) + (Get-LogTail "$log.err" 15)) }
}
Install-NodeDeps $L.Tools 'tools'

if (-not $NoGame) {
    $javaExe = 'java'
    if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) { $javaExe = Join-Path $env:JAVA_HOME 'bin\java.exe' }
    $jv = ''
    try { $jv = (& $env:ComSpec /d /c "`"$javaExe`" -version 2>&1" | Select-Object -First 1) } catch {}
    if ($jv -notmatch 'version "(\d+)') { Fail "Java 25 is required (https://adoptium.net, Temurin 25). Could not run '$javaExe -version'." }
    if ([int]$Matches[1] -lt 25) { Fail "Java 25 is required for Minecraft 26.3 (found: $jv). Set JAVA_HOME to a JDK 25." }
}

# --- Foreman -------------------------------------------------------------------------------------

$fmInfo = $null
$fmRunFile = Get-ForemanRunFile $L $AgentHome $ForemanProfile
$live = Get-LiveForeman $AgentHome $ForemanProfile
Write-Head 'Foreman'
if ($live) {
    $fmPort = [int]$live.port
    $own = Read-JsonFile $fmRunFile
    $startedByUs = $own -and ([int]$own.pid -eq [int]$live.pid) -and (Test-SameProc ([int]$own.pid) $own.startTime)
    $by = 'started by an earlier launch.ps1'
    if (-not $startedByUs) { $by = 'not started by launch.ps1; stop.ps1 leaves it alone' }
    Write-Kv 'reusing' "pid $($live.pid)  ws://127.0.0.1:$fmPort  backend $($live.backend)  ($by)" 'Green'
    if ($portGiven -and $fmPort -ne $Port) { Write-Warn2 "-Port $Port ignored: profile '$ForemanProfile' is already served on $fmPort" }
    if ($live.backend -and $live.backend -ne $Backend) { Write-Warn2 "profile '$ForemanProfile' runs the $($live.backend) backend (asked for $Backend); stop it first to switch" }
    if ($Reset -or $showcaseOn -or $repoPaths.Count) {
        if ($Reset) { Write-Warn2 '-Reset ignored for a running Foreman (tools\stop.ps1 -Foreman first)' }
        foreach ($rp in $repoPaths) {
            $r = & $node.Source (Join-Path $L.Tools 'foremancli.mjs') repo-add $rp --port $fmPort 2>$null | Out-String
            if ($LASTEXITCODE -eq 0) { Write-Kv 'repo' "added $rp" } else { Write-Warn2 "repo.add $rp failed: $r" }
        }
    }
    $fmInfo = [ordered]@{ started = $false; reused = $true; ownedByLauncher = [bool]$startedByUs; pid = [int]$live.pid; port = $fmPort; backend = $live.backend; profile = $ForemanProfile; home = $AgentHome; log = $null }
    if ($own -and $startedByUs) { $fmInfo.log = $own.log }
} elseif ($NoForeman) {
    $fmPort = $Port
    Write-Kv 'skipped' "-NoForeman: the game will look for a Foreman on port $fmPort" 'DarkGray'
    $fmInfo = [ordered]@{ started = $false; reused = $false; pid = $null; port = $fmPort; profile = $ForemanProfile; home = $AgentHome }
} else {
    $fmPort = $Port
    $owner = Get-PortOwner $Port
    if ($owner -or (Test-PortOpen $Port)) {
        $who = 'another process'
        if ($owner) { $who = Get-ProcLabel $owner }
        Fail "port $Port is already in use by $who. Another Foreman (other profile/home)? Use -Port N."
    }
    # foreman/node_modules is replaced only when no Foreman of this checkout is running on it
    $busy = @(Get-ChildItem -Path $L.Run -Filter 'foreman-*.json' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '\.(spec|status)\.json$' } | ForEach-Object {
        $rf = Read-JsonFile $_.FullName
        if ($rf -and $rf.pid -and (Test-SameProc ([int]$rf.pid) $rf.startTime)) { $rf }
    })
    if ($busy.Count -and (Test-Path (Join-Path $L.Foreman 'node_modules'))) {
        Write-Warn2 "not checking foreman/ dependencies: Foreman '$($busy[0].profile)' of this checkout is running on them"
    } else {
        Install-NodeDeps $L.Foreman 'foreman'
    }
    $fargs = @('--import', 'tsx', 'src/main.ts', '--backend', $Backend, '--profile', $ForemanProfile, '--home', $AgentHome, '--port', [string]$Port)
    if ($showcaseOn) {
        $fargs += @('--reset', '--showcase')
        if ($ShowcaseAt -eq 'late') { $fargs += 'late' }
    } elseif ($Reset) { $fargs += '--reset' }
    if ($repoPaths.Count) { $fargs += @('--repo', ($repoPaths -join ',')) }
    if ($Speed) { $fargs += @('--speed', [string]$Speed) }
    if ($Autostart) { $fargs += '--autostart' }
    if ($Goal) { $fargs += @('--goal', $Goal) }
    if ($Dev -or $NoNotify) { $fargs += '--no-notify' } elseif ($Notify) { $fargs += '--notify' }
    if ($UseClaudeLogin) { $fargs += '--use-claude-login' }
    if ($ForemanArgs) { $fargs += $ForemanArgs }
    if ($DryRun) {
        Write-Kv 'would run' ("node " + (Join-CmdArgs $fargs) + "   (in foreman/)") 'Yellow'
        $fmInfo = [ordered]@{ started = $false; reused = $false; dryRun = $true; pid = $null; port = $Port; backend = $Backend; profile = $ForemanProfile; home = $AgentHome; args = $fargs }
    } else {
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $fmLog = Join-Path $L.Logs "foreman-$ForemanProfile.log"
    $fmErr = Join-Path $L.Logs "foreman-$ForemanProfile.err.log"
    try {
        $bg = Start-Bg $L $node.Source "foreman-$ForemanProfile" $node.Source $fargs $L.Foreman $fmLog $fmErr @{}
    } catch { Fail $_.Exception.Message ((Get-LogTail $fmLog 15) + (Get-LogTail $fmErr 15)) }
    $fmInfo = [ordered]@{ kind = 'foreman'; started = $true; reused = $false; ownedByLauncher = $true; pid = $bg.pid; startTime = $bg.start; wrapperPid = $bg.wrapperPid; wrapperStart = $bg.wrapperStart; port = $Port; backend = $Backend; profile = $ForemanProfile; home = $AgentHome; showcase = $ShowcaseAt; log = $fmLog; errLog = $fmErr; startedAt = $stamp; checkout = $Root }
    Write-JsonFile $fmRunFile $fmInfo
    Write-Kv 'starting' "pid $($bg.pid)  backend $Backend  ws://127.0.0.1:$Port"
    $deadline = (Get-Date).AddSeconds(120)
    $up = $false
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-SameProc $bg.pid $bg.start)) { break }
        $rf = Read-JsonFile (Join-Path (Join-Path $AgentHome $ForemanProfile) 'foreman.json')
        if ($rf -and [int]$rf.pid -eq $bg.pid -and (Test-PortOpen $Port)) { $up = $true; break }
        Start-Sleep -Milliseconds 300
    }
    if (-not $up) {
        Remove-Item -Force $fmRunFile -ErrorAction SilentlyContinue
        Stop-OwnTree $bg.wrapperPid $bg.wrapperStart | Out-Null
        Stop-OwnTree $bg.pid $bg.start | Out-Null
        Fail "the Foreman did not come up (see $fmLog)" ((Get-LogTail $fmLog 15) + (Get-LogTail $fmErr 15))
    }
    Write-Kv 'running' ("ws://127.0.0.1:$Port  ready in {0:N1} s" -f ((Get-Date) - $t0).TotalSeconds) 'Green'
    }
}
if ($fmInfo.log) { Write-Kv 'log' $fmInfo.log }
$summary.foreman = $fmInfo
Save-Summary

# backend/auth banner (and, for a showcase, wait until the scripted state is held)
if (-not ($DryRun -and -not $fmInfo.reused) -and (-not $NoForeman -or (Test-PortOpen $fmPort))) {
    $statusArgs = @((Join-Path $L.Tools 'foremancli.mjs'), 'status', '--port', [string]$fmPort, '--timeout', '20')
    if ($showcaseOn) { $statusArgs += @('--wait-showcase', '240') }
    $stJson = (& $node.Source @statusArgs 2>$null) | Out-String
    $st = $null
    try { $st = $stJson | ConvertFrom-Json } catch {}
    if ($st -and $st.ok) {
        $f = $st.foreman
        $authColor = 'Green'
        if ($f.auth -eq 'failed') { $authColor = 'Red' } elseif ($f.auth -ne 'ok') { $authColor = 'Yellow' }
        $line = "$($f.backend), auth $($f.auth)"
        if ($f.message) { $line += " - $($f.message)" }
        Write-Kv 'status' $line $authColor
        $decs = @($st.openDecisions).Count
        $what = "$($st.activeAgents)/$($st.agents) agents on shift, $($st.tasks) tasks, $decs open decisions"
        if ($f.showcase) { $what += ', showcase held' }
        Write-Kv 'state' $what
        $fmInfo.status = $f
    } else {
        $err = 'no answer'
        if ($st -and $st.error) { $err = $st.error }
        if ($showcaseOn) { Fail "the Foreman did not reach the showcase state: $err" (Get-LogTail $fmInfo.log 15) }
        Write-Warn2 "could not read the Foreman status: $err"
    }
}
Save-Summary

# --- Minecraft -----------------------------------------------------------------------------------

$gameRunFile = Get-GameRunFile $L
if ($NoGame) {
    $summary.ok = $true
    Save-Summary
    Write-Host ''
    Write-Host "Stop:  tools\stop.ps1 -Foreman" -ForegroundColor DarkGray
    exit 0
}

Write-Head 'Minecraft'
$gameInfo = $null
$prev = Read-JsonFile $gameRunFile
$liveGame = $null
if ($prev) {
    $gAlive = $prev.gamePid -and (Test-SameProc ([int]$prev.gamePid) $prev.gameStart)
    $wAlive = $prev.wrapperPid -and (Test-SameProc ([int]$prev.wrapperPid) $prev.wrapperStart)
    if ($gAlive -or $wAlive) { $liveGame = $prev } else { Remove-Item -Force $gameRunFile -ErrorAction SilentlyContinue }
}
if (-not $liveGame) {
    # a game of this checkout started some other way (plain gradlew runClient) still owns mod/run
    $stray = Find-GameJvm $L
    if ($stray) { Fail "a Minecraft client of this checkout is already running ($(Get-ProcLabel $stray.ProcessId)) but was not started by launch.ps1. Quit it first (node tools/devcli.mjs quit)." }
}

if ($liveGame) {
    Write-Kv 'running' "already running: pid $($liveGame.gamePid)  DevBridge :$($liveGame.devPort)  (one client per checkout)" 'Green'
    if ([int]$liveGame.foremanPort -ne $fmPort) { Write-Warn2 "it was launched against Foreman port $($liveGame.foremanPort), not ${fmPort}: tools\stop.ps1 -Game, then launch again" }
    if ([int]$liveGame.devPort -ne $DevPort) { Write-Warn2 "its DevBridge is on $($liveGame.devPort) (asked for $DevPort)" }
    $gameInfo = [ordered]@{ started = $false; reused = $true; gamePid = $liveGame.gamePid; wrapperPid = $liveGame.wrapperPid; devPort = [int]$liveGame.devPort; foremanPort = [int]$liveGame.foremanPort; log = $liveGame.log }
    $DevPort = [int]$liveGame.devPort
} else {
    $owner = Get-PortOwner $DevPort
    if ($owner -or (Test-PortOpen $DevPort)) {
        $who = 'another process'
        if ($owner) { $who = Get-ProcLabel $owner }
        Fail "DevBridge port $DevPort is already in use by $who (another game?). Use -DevPort N."
    }
    # Gradle daemon JVM args from mod/gradle.properties + a marker naming this checkout, so this
    # checkout gets its own daemon (stop.ps1 -StopDaemon can stop exactly that one).
    $jvmArgs = '-Xmx4G -Dfile.encoding=UTF-8'
    $gp = Join-Path $L.Mod 'gradle.properties'
    if (Test-Path $gp) {
        foreach ($line in (Get-Content $gp)) { if ($line -match '^\s*org\.gradle\.jvmargs\s*=\s*(.+)$') { $jvmArgs = $Matches[1].Trim() } }
    }
    $jvmArgs = "$jvmArgs -XX:ErrorFile=$($L.Marker)"
    $gargs = @('runClient', '--console=plain', "-Dorg.gradle.jvmargs=$jvmArgs")
    if ($Dev) { $gargs += '-Dorg.gradle.daemon.idletimeout=1800000' }   # unattended: daemon exits after 30 idle minutes
    $gameLog = Join-Path $L.Logs 'game.log'
    $gameErr = Join-Path $L.Logs 'game.err.log'
    # passed to gradlew; the Gradle daemon hands the client's environment to the game JVM
    $gameEnv = @{
        GRADLE_USER_HOME    = $GradleHome
        AGENTCRAFT_PORT     = [string]$fmPort
        AGENTCRAFT_DEV_PORT = [string]$DevPort
        AGENTCRAFT_HOME     = $AgentHome
        AGENTCRAFT_PROFILE  = $ForemanProfile
        AGENTCRAFT_MUTE     = $(if ($Dev) { '1' } else { '0' })
        AGENTCRAFT_FOCUS    = $(if ($Dev) { '0' } else { '1' })
    }
    # cmd.exe /s /c "<gradlew.bat> args": a .bat cannot be spawned directly; the arguments are fixed
    # (no user text), quoted per argument and passed verbatim
    $inner = Join-CmdArgs (@((Join-Path $L.Mod 'gradlew.bat')) + $gargs)
    if ($DryRun) {
        Write-Kv 'would run' "cmd /d /s /c `"$inner`"   (in mod/)" 'Yellow'
        foreach ($k in ($gameEnv.Keys | Sort-Object)) { Write-Kv '  env' "$k=$($gameEnv[$k])" }
        $summary.game = [ordered]@{ started = $false; dryRun = $true; command = $inner; env = $gameEnv; devPort = $DevPort; foremanPort = $fmPort }
        $summary.ok = $true
        Save-Summary
        exit 0
    }
    try {
        $bg = Start-Bg $L $node.Source 'game' $env:ComSpec @('/d', '/s', '/c', "`"$inner`"") $L.Mod $gameLog $gameErr $gameEnv -Verbatim
    } catch { Fail $_.Exception.Message (Get-LogTail $gameLog 15) }
    $gameInfo = [ordered]@{ kind = 'game'; started = $true; reused = $false; wrapperPid = $bg.wrapperPid; wrapperStart = $bg.wrapperStart; gradlePid = $bg.pid; gradleStart = $bg.start; gamePid = $null; gameStart = $null; devPort = $DevPort; foremanPort = $fmPort; dev = [bool]$Dev; log = $gameLog; errLog = $gameErr; checkout = $Root; marker = $L.Marker; gradleHome = $GradleHome }
    Write-JsonFile $gameRunFile $gameInfo
    Write-Kv 'starting' "gradlew runClient (pid $($bg.pid); builds if needed)  DevBridge :$DevPort -> Foreman :$fmPort"
    Write-Kv 'log' $gameLog
}
$summary.game = $gameInfo
Save-Summary

if ($NoWait -and $gameInfo.started) {
    $summary.ok = $true
    Save-Summary
    Write-Kv 'note' "-NoWait: not waiting for the world (node tools\devcli.mjs wait --port $DevPort)" 'DarkGray'
    exit 0
}

# wait for the game JVM, the DevBridge and a ready world (or an early gradle exit = build failure)
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$lastNote = Get-Date
$gStartT = Get-Date
$ready = $false
while ((Get-Date) -lt $deadline) {
    if ($gameInfo.started) {
        if (-not $gameInfo.gamePid) {
            $jvm = Find-GameJvm $L
            if ($jvm) {
                $gameInfo.gamePid = [int]$jvm.ProcessId
                $gameInfo.gameStart = Get-ProcStart ([int]$jvm.ProcessId)
                Write-JsonFile $gameRunFile $gameInfo
                Write-Kv 'jvm' ("pid $($jvm.ProcessId)  (build done in {0:N0} s)" -f ((Get-Date) - $gStartT).TotalSeconds)
            }
        }
        if (-not (Test-SameProc $gameInfo.wrapperPid $gameInfo.wrapperStart) -and -not ($gameInfo.gamePid -and (Test-SameProc $gameInfo.gamePid $gameInfo.gameStart))) {
            Remove-Item -Force $gameRunFile -ErrorAction SilentlyContinue
            $tail = Get-LogTail $gameInfo.log 30
            Fail 'gradlew runClient exited before the world was ready (build failure or crash).' $tail
        }
    }
    if (Test-PortOpen $DevPort) {
        $remaining = [int][Math]::Max(10, ($deadline - (Get-Date)).TotalSeconds)
        $wj = (& $node.Source (Join-Path $L.Tools 'devcli.mjs') wait --port $DevPort --timeout $remaining 2>$null) | Out-String
        $ws = $null
        try { $ws = $wj | ConvertFrom-Json } catch {}
        if ($ws -and $ws.ok) {
            $ready = $true
            $w = ''
            if ($ws.world) { $w = "world '$($ws.world.name)'" }
            Write-Kv 'ready' ("{0}  {1} fps  in {2:N0} s" -f $w, $ws.fps, ((Get-Date) - $t0).TotalSeconds) 'Green'
            $gameInfo.ready = $true
            break
        }
        $msg = 'not ready'
        if ($ws -and $ws.error) { $msg = $ws.error }
        if ($msg -match 'hung') { Fail "the game is hung: $msg (tools\stop.ps1 -Game, then relaunch)" (Get-LogTail $gameInfo.log 20) }
    }
    if (((Get-Date) - $lastNote).TotalSeconds -ge 15) {
        $lastNote = Get-Date
        Write-Kv '...' ("waiting for the world ({0:N0} s)" -f ((Get-Date) - $gStartT).TotalSeconds) 'DarkGray'
    }
    Start-Sleep -Milliseconds 1000
}
if (-not $ready) { Fail "the world was not ready after $TimeoutSec s (see $($gameInfo.log))" (Get-LogTail $gameInfo.log 20) }
if ($gameInfo.started) { Write-JsonFile $gameRunFile $gameInfo }

$summary.game = $gameInfo
$summary.ok = $true
Save-Summary

Write-Host ''
Write-Host 'Running.' -ForegroundColor Green
Write-Host "  stop all      tools\stop.ps1            (game: quits + saves; Foreman: Ctrl+Break, state saved)" -ForegroundColor DarkGray
Write-Host "  stop game     tools\stop.ps1 -Game      (or just close the window; agents keep working)" -ForegroundColor DarkGray
Write-Host "  terminal UI   cd foreman; npm run tui -- --port $fmPort" -ForegroundColor DarkGray
Write-Host "  dev bridge    node tools\devcli.mjs state --port $DevPort" -ForegroundColor DarkGray
exit 0
