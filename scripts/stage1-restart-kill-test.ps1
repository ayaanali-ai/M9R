# Stage 1 acceptance, spec step 6 (manual, Windows, uses a few tokens of your Claude subscription):
# send a long task to @claude-code, kill the Claude bridge mid-turn, let it restart, then check
#   1. exactly one notice is posted (kind result, outcome failed), no @ mention
#   2. `m9r-cli delivery <id>` shows failed with failure: restart_interrupted
#   3. the message is NOT run again (no second prompt.started / delivered_to_session)
# Requires the local runtime running from a build that includes restart recovery.
$ErrorActionPreference = 'Stop'
$repo = 'C:\RunLeak\runleak'
$env:OATHLOCK_API_URL = 'https://m9r-web-staging.m9r.workers.dev'
$out = & node "$repo\cli\dist\m9r.js" ask '@claude-code' 'Write the numbers 1 to 5000, one per line, with no other text at all.' --agent-kind codex
$mid = ($out | Select-String -Pattern 'delivery ([0-9a-f-]{36})').Matches[0].Groups[1].Value
"message $mid sent"
$ledger = "$repo\.oathlock\runtime\delivery-ledger-claude-code.jsonl"
$deadline = (Get-Date).AddSeconds(120)
$seen = $false
while ((Get-Date) -lt $deadline) {
  $lines = Get-Content $ledger -ErrorAction SilentlyContinue | Where-Object { $_ -match $mid }
  if ($lines -match '"state":"completed"') { "turn completed before the kill; test invalid"; exit 2 }
  if ($lines -match '"state":"processing"') { $seen = $true; break }
  Start-Sleep -Milliseconds 300
}
if (-not $seen) { "never reached processing"; exit 3 }
$target = $null
foreach ($r in (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'bridge-runner' })) {
  $kids = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $r.ProcessId }
  if ($kids | Where-Object { $_.CommandLine -match 'claude' }) { $target = $r }
}
if (-not $target) { "no claude runner found"; exit 4 }
$done = (Get-Content $ledger | Where-Object { $_ -match $mid }) -match '"state":"completed"'
if ($done) { "turn completed before the kill; test invalid"; exit 2 }
taskkill /PID $target.ProcessId /T /F | Out-Null
"KILLED runner $($target.ProcessId) mid-turn at $((Get-Date).ToUniversalTime().ToString('HH:mm:ss'))"
"MESSAGE_ID=$mid"
