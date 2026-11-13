# Feishu event-consumer watchdog for dsh-superagent.
#
# Feishu delivers an app's events to a single long-lived consumer, and the lark-cli SDK backs off for up to an hour between reconnect
# attempts: when the machine's DNS fails for a moment, the consumer stays disconnected long after DNS recovers, and the messages sent
# meanwhile never arrive. This script reads the consumer's own bus log, decides whether it is currently disconnected, and if so ends the
# consumer so the plugin starts a fresh one (it respawns within seconds).
#
# It writes one line per run to feishu-watchdog.log beside the state it reads, and refuses to act more often than once per cooldown.
param(
  [int]$CooldownMinutes = 15,
  [string]$ConfigHome = "$env:USERPROFILE\.lark-cli-dsh-superagent",
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$out = Join-Path $ConfigHome 'feishu-watchdog.log'
function Say([string]$message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $message"
  Add-Content -Path $out -Value $line -Encoding utf8
  Write-Output $line
}

# A restart is skipped for a while afterwards, keyed on the marker the restart itself writes: keying it on the log file would make every
# skip refresh the file and push the next restart forever into the future.
$marker = Join-Path $ConfigHome 'feishu-watchdog.last-action'
if (Test-Path $marker) {
  $last = Get-Item $marker
  if (((Get-Date) - $last.LastWriteTime).TotalMinutes -lt $CooldownMinutes) {
    Say "skip: restarted less than $CooldownMinutes min ago"
    exit 0
  }
}

$events = Join-Path $ConfigHome 'events'
if (-not (Test-Path $events)) { Say 'skip: no event directory'; exit 0 }

# Each app has its own bus log; the app that is connected last is the one this deployment reads.
$logs = Get-ChildItem $events -Directory | ForEach-Object {
  $file = Join-Path $_.FullName 'bus.log'
  if (Test-Path $file) { [pscustomobject]@{ App = $_.Name; File = $file; Touched = (Get-Item $file).LastWriteTime } }
} | Sort-Object Touched -Descending
if (-not $logs) { Say 'skip: no bus.log'; exit 0 }

$connected = $null; $broken = $null; $app = $null
foreach ($entry in $logs) {
  $lines = Get-Content $entry.File -Tail 200
  $lastConnected = ($lines | Select-String -Pattern 'connected to wss://' | Select-Object -Last 1)
  $lastBroken = ($lines | Select-String -Pattern 'connect failed|disconnected to wss://|storage.*close|unexpected EOF' | Select-Object -Last 1)
  if (-not $lastConnected) { continue }
  $app = $entry.App; $connected = $lastConnected.LineNumber; $broken = if ($lastBroken) { $lastBroken.LineNumber } else { 0 }
  break
}
if (-not $app) { Say 'skip: no bus log shows a successful connection yet'; exit 0 }
if ($broken -le $connected) { Say "ok: $app is connected (last connected after the last failure)"; exit 0 }

# Killing the consumer only helps while the host resolves Feishu: a restart during a DNS outage just fails again, so wait for the next run.
$dns = Resolve-DnsName open.feishu.cn -Type A -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress } | Select-Object -First 1
if (-not $dns) { Say 'skip: open.feishu.cn does not resolve right now, so a restart would fail too'; exit 0 }
# The consumers are the processes holding the app's event stream; ending them makes the plugin open a fresh one.
$consumers = Get-CimInstance Win32_Process -Filter "Name='lark-cli.exe'" |
  Where-Object { $_.CommandLine -match 'event\s+consume' }
if (-not $consumers) { Say "warn: $app looks disconnected and no consumer process is running"; exit 0 }

Set-Content -Path $marker -Value (Get-Date -Format o) -Encoding utf8
foreach ($process in $consumers) {
  if ($DryRun) { Say "dry-run: would end consumer $($process.ProcessId) for $app"; continue }
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  Say "restarted: ended consumer $($process.ProcessId) for $app (disconnected since its last connect, no successful reconnect after)"
}
exit 0
