# Shared helpers for tools/launch.ps1 and tools/stop.ps1 (dot-source it). Windows PowerShell 5.1+.
#
# Everything here is scoped to processes WE started: a run file in artifacts/run/ records each
# pid together with its start time, and nothing is ever stopped unless the live process still has
# that start time (pid reuse) and, for the game, a command line that names THIS checkout.

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Write-JsonFile([string]$Path, $Object) {
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    $json = $Object | ConvertTo-Json -Depth 8
    $tmp = "$Path.tmp"
    [System.IO.File]::WriteAllText($tmp, $json, $script:Utf8NoBom)
    Move-Item -Force $tmp $Path
}

function Read-JsonFile([string]$Path) {
    if (-not (Test-Path $Path)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($Path)
        if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
        if (-not $raw.Trim()) { return $null }
        # PowerShell 7 turns ISO timestamps (pid start times) into DateTime objects, which later
        # stringify without a zone and compare 'local vs UTC' wrong; keep them as the strings written
        if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { return $raw | ConvertFrom-Json -DateKind String }
        return $raw | ConvertFrom-Json
    } catch { return $null }
}

# Quote one argument for a Windows command line (CommandLineToArgvW rules).
function ConvertTo-CmdArg([string]$s) {
    if ($s -eq '') { return '""' }
    if ($s -notmatch '[\s"]') { return $s }
    $out = '"'
    $bs = 0
    foreach ($ch in $s.ToCharArray()) {
        if ($ch -eq '\') { $bs++; continue }
        if ($ch -eq '"') { $out += ('\' * (2 * $bs + 1)) + '"'; $bs = 0; continue }
        if ($bs) { $out += ('\' * $bs); $bs = 0 }
        $out += $ch
    }
    $out += ('\' * (2 * $bs)) + '"'
    return $out
}

function Join-CmdArgs([string[]]$Items) { ($Items | ForEach-Object { ConvertTo-CmdArg $_ }) -join ' ' }

# Absolute path relative to PowerShell's current location ([IO.Path]::GetFullPath would use the
# process working directory, which Set-Location does not change).
function Resolve-FullPath([string]$Path) {
    if (-not $Path) { return $Path }
    return [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path))
}

function Get-ShortHash([string]$Text) {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text.ToLowerInvariant()))
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 10)
}

# --- processes ---------------------------------------------------------------------------------

function Get-ProcStart([int]$ProcessId) {
    try {
        $p = Get-Process -Id $ProcessId -ErrorAction Stop
        return $p.StartTime.ToUniversalTime().ToString('o')
    } catch { return $null }
}

# True when $ProcessId is alive and was started at $Start (ISO string, +-2 s): not a reused pid.
function Test-SameProc([int]$ProcessId, [string]$Start) {
    if (-not $ProcessId -or -not $Start) { return $false }
    $now = Get-ProcStart $ProcessId
    if (-not $now) { return $false }
    $a = [DateTime]::Parse($now).ToUniversalTime()
    $b = [DateTime]::Parse($Start).ToUniversalTime()
    return ([Math]::Abs(($a - $b).TotalSeconds) -le 2)
}

function Get-ProcCim([int]$ProcessId) {
    try { return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop } catch { return $null }
}

# All live descendants of $ProcessId (children created after their parent, so a reused parent pid
# never adopts unrelated processes). Deepest first, so killing in order never orphans a child.
function Get-Descendants([int]$ProcessId) {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $byParent = @{}
    foreach ($p in $all) {
        $k = [int]$p.ParentProcessId
        if (-not $byParent.ContainsKey($k)) { $byParent[$k] = New-Object System.Collections.ArrayList }
        [void]$byParent[$k].Add($p)
    }
    $root = $all | Where-Object { $_.ProcessId -eq $ProcessId } | Select-Object -First 1
    $result = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    if ($root) { $queue.Enqueue($root) }
    while ($queue.Count) {
        $cur = $queue.Dequeue()
        $kids = $byParent[[int]$cur.ProcessId]
        if (-not $kids) { continue }
        foreach ($k in $kids) {
            if ($k.ProcessId -eq $cur.ProcessId) { continue }
            if ($cur.CreationDate -and $k.CreationDate -and $k.CreationDate -lt $cur.CreationDate) { continue }
            [void]$result.Add($k)
            $queue.Enqueue($k)
        }
    }
    $arr = $result.ToArray()
    [array]::Reverse($arr)
    return $arr
}

function Wait-ProcExit([int]$ProcessId, [string]$Start, [double]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-SameProc $ProcessId $Start)) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return -not (Test-SameProc $ProcessId $Start)
}

# Force-kill a process we started and everything it started. Returns the pids it killed.
function Stop-OwnTree([int]$ProcessId, [string]$Start) {
    $killed = @()
    if (-not (Test-SameProc $ProcessId $Start)) { return $killed }
    foreach ($d in (Get-Descendants $ProcessId)) {
        try { Stop-Process -Id $d.ProcessId -Force -ErrorAction Stop; $killed += [int]$d.ProcessId } catch {}
    }
    try { Stop-Process -Id $ProcessId -Force -ErrorAction Stop; $killed += $ProcessId } catch {}
    return $killed
}

# Ctrl+Break into the (hidden) console of a process we started with Start-Process: Node maps it to
# SIGBREAK, which the Foreman handles exactly like Ctrl+C (save state, release foreman.json, exit).
# Runs in a helper powershell.exe so attaching to the other console never detaches ours.
$script:CtrlBreakHelper = @'
$src = @"
using System;
using System.Runtime.InteropServices;
public static class AgentCraftCtrl {
  public delegate bool Handler(uint ctrlType);
  static Handler keep = delegate (uint t) { return true; };
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(Handler h, bool add);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
  public static int Send(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return 10;
    SetConsoleCtrlHandler(keep, true);
    bool ok = GenerateConsoleCtrlEvent(1, 0);
    System.Threading.Thread.Sleep(400);
    FreeConsole();
    return ok ? 0 : 11;
  }
}
"@
Add-Type -TypeDefinition $src
exit [AgentCraftCtrl]::Send([uint32]__PID__)
'@

function Send-CtrlBreak([int]$ProcessId) {
    $code = $script:CtrlBreakHelper.Replace('__PID__', [string]$ProcessId)
    $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($code))
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    try {
        $h = Start-Process -FilePath $ps -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $enc" -WindowStyle Hidden -Wait -PassThru
        return ($h.ExitCode -eq 0)
    } catch { return $false }
}

# Start a long-running process in the background through tools/lib/bgrun.mjs.
# Not Start-Process -RedirectStandardOutput: that creates the child with handle inheritance on, so
# the Foreman/game would inherit OUR stdout/stderr, and a caller reading launch.ps1 through a pipe
# (qa.mjs, an IDE terminal, `| Tee-Object`) would hang until the game exits (measured: 20 s child
# -> 20 s hang; clearing the inherit flag on our std handles did not help). Start-Process without
# redirection uses ShellExecute (nothing inherited) and gives the wrapper its own hidden console;
# the wrapper opens the logs and runs the command in that console (Ctrl+Break target for stop.ps1).
# Returns @{wrapperPid; wrapperStart; pid; start} (pid = the real command).
function Start-Bg($L, [string]$NodeExe, [string]$Name, [string]$Command, [string[]]$Arguments, [string]$Cwd,
                  [string]$Log, [string]$ErrLog, [hashtable]$Env, [switch]$Verbatim) {
    $statusFile = Join-Path $L.Run "bg-$Name.status.json"
    $specFile = Join-Path $L.Run "bg-$Name.spec.json"
    Remove-Item -Force $statusFile -ErrorAction SilentlyContinue
    foreach ($f in @($Log, $ErrLog)) {
        if ($f -and (Test-Path $f)) { try { Move-Item -Force $f "$f.prev" -ErrorAction Stop } catch { Remove-Item -Force $f -ErrorAction SilentlyContinue } }
    }
    if (-not $Env) { $Env = @{} }
    Write-JsonFile $specFile ([ordered]@{ command = $Command; args = @($Arguments); cwd = $Cwd; log = $Log; errLog = $ErrLog; env = $Env; verbatim = [bool]$Verbatim; statusFile = $statusFile })
    $w = Start-Process -FilePath $NodeExe -ArgumentList (Join-CmdArgs @((Join-Path $L.Tools 'lib\bgrun.mjs'), $specFile)) -WorkingDirectory $Cwd -WindowStyle Hidden -PassThru
    $wStart = Get-ProcStart $w.Id
    $deadline = (Get-Date).AddSeconds(20)
    $st = $null
    while ((Get-Date) -lt $deadline) {
        $st = Read-JsonFile $statusFile
        if ($st -and ($st.childPid -or $st.error)) { break }
        if ($w.HasExited) { Start-Sleep -Milliseconds 200; $st = Read-JsonFile $statusFile; break }
        Start-Sleep -Milliseconds 100
    }
    if (-not $st -or -not $st.childPid) {
        $why = 'no status from the wrapper'
        if ($st -and $st.error) { $why = $st.error }
        if (-not $w.HasExited) { Stop-OwnTree $w.Id $wStart | Out-Null }
        throw "could not start $Name ($Command): $why"
    }
    return [ordered]@{ wrapperPid = $w.Id; wrapperStart = $wStart; pid = [int]$st.childPid; start = (Get-ProcStart ([int]$st.childPid)) }
}

# --- ports -------------------------------------------------------------------------------------

function Test-PortOpen([int]$Port, [int]$TimeoutMs = 600) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $c.EndConnect($iar)
        return $true
    } catch { return $false } finally { $c.Close() }
}

# pid listening on 127.0.0.1/0.0.0.0:$Port, or $null
function Get-PortOwner([int]$Port) {
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($c) { return [int]$c.OwningProcess }
    } catch {}
    return $null
}

function Get-ProcLabel([int]$ProcessId) {
    $p = Get-ProcCim $ProcessId
    if (-not $p) { return "pid $ProcessId" }
    $cmd = [string]$p.CommandLine
    if ($cmd.Length -gt 110) { $cmd = $cmd.Substring(0, 110) + '...' }
    return "pid $ProcessId ($($p.Name): $cmd)"
}

# --- layout --------------------------------------------------------------------------------------

function Get-AcLayout([string]$Root) {
    $mod = Join-Path $Root 'mod'
    $h = @{
        Root       = $Root
        Mod        = $mod
        Foreman    = Join-Path $Root 'foreman'
        Tools      = Join-Path $Root 'tools'
        Logs       = Join-Path $Root 'artifacts\logs'
        Run        = Join-Path $Root 'artifacts\run'
        LaunchCfg  = Join-Path $mod '.gradle\loom-cache\launch.cfg'
        # Gradle daemon marker. It has to be a real JVM option: Gradle passes most -D system
        # properties from org.gradle.jvmargs to the daemon at build time (not on its command line)
        # and ignores them when matching daemons. -XX:ErrorFile is harmless (where a JVM crash log
        # would go, relative to the daemon's directory), is on the command line and is matched,
        # so every checkout gets its own daemon and stop.ps1 -StopDaemon can find exactly ours.
        Marker     = 'agentcraft-' + (Get-ShortHash $Root) + '-hs_err.log'
    }
    return $h
}

# The main checkout (worktrees share it): parent of git's common dir; falls back to $Root.
function Get-MainCheckout([string]$Root) {
    try {
        $common = (& git -C $Root rev-parse --path-format=absolute --git-common-dir 2>$null)
        if ($LASTEXITCODE -eq 0 -and $common) {
            $p = [System.IO.Path]::GetFullPath(($common | Select-Object -First 1).Trim())
            if ((Split-Path -Leaf $p) -eq '.git') { return (Split-Path -Parent $p) }
        }
    } catch {}
    return $Root
}

function Get-ForemanRunFile($L, [string]$AgentHome, [string]$ProfileName) {
    return Join-Path $L.Run ("foreman-$ProfileName-" + (Get-ShortHash $AgentHome) + '.json')
}

function Get-GameRunFile($L) { return Join-Path $L.Run 'game.json' }

# The game JVM of THIS checkout: its command line names our Loom launch.cfg.
function Find-GameJvm($L) {
    $cfg = $L.LaunchCfg.ToLowerInvariant()
    $cfg2 = $cfg.Replace('\', '/')
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='java.exe' or Name='javaw.exe'" -ErrorAction SilentlyContinue)
    foreach ($p in $procs) {
        $cmd = ([string]$p.CommandLine).ToLowerInvariant()
        if ($cmd.Contains($cfg) -or $cmd.Contains($cfg2)) { return $p }
    }
    return $null
}

# Gradle daemons started by launch.ps1 from THIS checkout (marker in their JVM args).
function Find-OwnDaemons($L) {
    $marker = '-XX:ErrorFile=' + $L.Marker
    @(Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $c = [string]$_.CommandLine
        $c.Contains('GradleDaemon') -and $c.Contains($marker)
    })
}

# Live Foreman for <home>/<profile>: foreman.json pid alive and its port answering (same rule the
# Foreman itself uses to refuse a second instance on a profile).
function Get-LiveForeman([string]$AgentHome, [string]$ProfileName) {
    $f = Join-Path (Join-Path $AgentHome $ProfileName) 'foreman.json'
    $info = Read-JsonFile $f
    if (-not $info -or -not $info.pid) { return $null }
    if (-not (Get-Process -Id ([int]$info.pid) -ErrorAction SilentlyContinue)) { return $null }
    if (-not (Test-PortOpen ([int]$info.port))) { return $null }
    return $info
}

# --- console -----------------------------------------------------------------------------------

function Write-Head([string]$Text) { Write-Host ''; Write-Host $Text -ForegroundColor Cyan }
function Write-Kv([string]$Key, [string]$Value, [string]$Color = 'Gray') {
    Write-Host ('  {0,-10} ' -f $Key) -NoNewline -ForegroundColor DarkGray
    Write-Host $Value -ForegroundColor $Color
}
function Write-Warn2([string]$Text) { Write-Host "  ! $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "  x $Text" -ForegroundColor Red }

function Get-LogTail([string]$Path, [int]$Lines = 25) {
    if (-not (Test-Path $Path)) { return @() }
    try { return @(Get-Content -Tail $Lines -Path $Path -ErrorAction Stop) } catch { return @() }
}
