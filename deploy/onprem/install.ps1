<#
.SYNOPSIS
  Installs or upgrades InnPilot on a hotel's own Windows computer (on-premises install, D22).

.DESCRIPTION
  One command, run from the unpacked InnPilot bundle (InnPilot-Install.cmd runs it):
    - checks Docker Desktop (offers to install it), starts it, and makes it start with Windows;
    - first install: asks for the hotel's address and owner, generates every secret on this computer, creates the
      hotel and its owner account, and writes a recovery kit to the desktop (to be moved to a USB stick);
    - pulls the InnPilot version this bundle names and releases it: role, encrypted backup, migrations, start;
    - checks it answers, and sets up the daily encrypted copy of backups and files to a folder that leaves the
      computer (Google Drive for desktop or a USB drive).
  Run it again from a newer bundle to upgrade: settings and data are kept. Nothing belonging to the seller (no
  password, key or account) is stored on the hotel's computer.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Address https://frontdesk.tail1234.ts.net -HotelName "Sunrise Hotel" -OwnerName "Ayesha Khan" `
                -OwnerEmail owner@sunrise.example -BackupFolder "G:\My Drive\InnPilot backups"
  .\install.ps1 -Stop
#>
[CmdletBinding()]
param(
  [string]$Address,
  [string]$HotelName,
  [string]$OwnerName,
  [string]$OwnerEmail,
  [string]$BackupFolder,
  [string]$InstallDir = (Join-Path $env:ProgramData 'InnPilot'),
  [string]$Project = 'innpilot-hotel',
  [int]$Port = 8090,
  # For testing a build that is not published: local image names instead of the bundle's version.
  [string]$ApiImage,
  [string]$WebImage,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$Bundle = $PSScriptRoot
$Utf8 = New-Object System.Text.UTF8Encoding $false
function Say([string]$Text) { Write-Host $Text }
function Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text) { Write-Host ''; Write-Host "Stopped: $Text" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------------------------------------------
# Running programs: Windows PowerShell 5.1 turns a program's error output into errors, so run them through .NET.
function Quote-Arg([string]$Arg) {
  if ($Arg -notmatch '[\s"]' -and $Arg.Length -gt 0) { return $Arg }
  $out = '"'
  $slashes = 0
  foreach ($ch in $Arg.ToCharArray()) {
    if ($ch -eq '\') { $slashes++; continue }
    if ($ch -eq '"') { $out += ('\' * ($slashes * 2 + 1)) + '"' } else { $out += ('\' * $slashes) + $ch }
    $slashes = 0
  }
  return $out + ('\' * ($slashes * 2)) + '"'
}

function Invoke-Native {
  param([string]$File, [string[]]$Arguments, [string]$StdIn, [switch]$Capture, [switch]$AllowFailure)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $File
  $psi.Arguments = (($Arguments | ForEach-Object { Quote-Arg $_ }) -join ' ')
  $psi.UseShellExecute = $false
  # The install folder does not exist yet on a first install's early checks.
  if (Test-Path $InstallDir) { $psi.WorkingDirectory = $InstallDir } else { $psi.WorkingDirectory = $Bundle }
  $psi.RedirectStandardInput = [bool]$StdIn
  $psi.RedirectStandardOutput = [bool]$Capture
  $psi.RedirectStandardError = [bool]$Capture
  # The input writer takes the console's input encoding and, when that is UTF-8, writes a byte-order mark as soon
  # as the program starts: it once turned the owner's one-time password into a different one (install test,
  # 2026-10-29). So the input encoding is UTF-8 without a mark while the program starts.
  $previousInput = $null
  if ($StdIn) {
    try { $previousInput = [Console]::InputEncoding; [Console]::InputEncoding = $Utf8 } catch { $previousInput = $null }
  }
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
  } finally {
    if ($previousInput) { try { [Console]::InputEncoding = $previousInput } catch { } }
  }
  if ($StdIn) {
    $bytes = $Utf8.GetBytes($StdIn)
    $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $p.StandardInput.BaseStream.Close()
  }
  $out = ''; $err = ''
  if ($Capture) {
    $errTask = $p.StandardError.ReadToEndAsync()
    $out = $p.StandardOutput.ReadToEnd()
    $err = $errTask.Result
  }
  $p.WaitForExit()
  if ($p.ExitCode -ne 0 -and -not $AllowFailure) {
    Fail "$File $($Arguments -join ' ') exited with $($p.ExitCode).`n$err$out"
  }
  # Only callers that look at the result get one (otherwise PowerShell prints it).
  if ($Capture -or $AllowFailure) { return [pscustomobject]@{ Code = $p.ExitCode; Out = $out; Err = $err } }
}

$ComposeFiles = @('compose', '-f', 'compose.yml', '-f', 'compose.single.yml', '-f', 'compose.onprem.yml')
function Compose([string[]]$Arguments, [string]$StdIn, [switch]$Capture, [switch]$AllowFailure) {
  Invoke-Native -File 'docker' -Arguments ($ComposeFiles + $Arguments) -StdIn $StdIn -Capture:$Capture -AllowFailure:$AllowFailure
}

function New-Secret([int]$Bytes) {
  $b = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Write-Settings([string]$Path, [string[]]$Lines) {
  $text = "# InnPilot settings, generated by install.ps1 on this computer. Never share, email or upload.`n" +
    (($Lines -join "`n") + "`n")
  [System.IO.File]::WriteAllText($Path, $text, $Utf8)
}

function Read-Settings([string]$Path) {
  $map = @{}
  foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
    $i = $line.IndexOf('=')
    if ($i -gt 0 -and -not $line.StartsWith('#')) { $map[$line.Substring(0, $i)] = $line.Substring($i + 1) }
  }
  return $map
}

function Ask([string]$Current, [string]$Question, [string]$Pattern, [string]$Hint) {
  $value = $Current
  while (-not $value -or ($Pattern -and $value -notmatch $Pattern)) {
    if ($value) { Say "  $Hint" }
    $value = (Read-Host $Question).Trim()
  }
  return $value
}

# ---------------------------------------------------------------------------------------------------------------
Say ''
Say 'InnPilot - install or upgrade on this computer'

$Version = ([System.IO.File]::ReadAllText((Join-Path $Bundle 'VERSION'))).Trim()
if (-not $ApiImage) { $ApiImage = "ghcr.io/shayanabbassi/innpilot-api:$Version" }
if (-not $WebImage) { $WebImage = "ghcr.io/shayanabbassi/innpilot-web:$Version" }
$Settings = Join-Path $InstallDir 'settings'
$FirstInstall = -not (Test-Path (Join-Path $Settings 'app.env'))
$env:COMPOSE_PROJECT_NAME = $Project
$env:API_IMAGE = $ApiImage
$env:WEB_IMAGE = $WebImage
$env:INNPILOT_PORT = "$Port"

Step 'Docker Desktop'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  $desktop = @("$env:ProgramFiles\Docker\Docker\resources\bin", "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin") |
    Where-Object { Test-Path (Join-Path $_ 'docker.exe') } | Select-Object -First 1
  if ($desktop) { $env:PATH = "$env:PATH;$desktop" }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Say 'Docker Desktop is not installed. InnPilot runs inside it (free for businesses under 250 people and under'
  Say 'US$10 million a year; see docker.com/pricing).'
  if ((Read-Host 'Install Docker Desktop now? (Y/n)') -match '^[nN]') { Fail 'Docker Desktop is needed.' }
  Invoke-Native -File 'winget' -Arguments @('install', '--id', 'Docker.DockerDesktop', '-e', '--accept-package-agreements', '--accept-source-agreements') | Out-Null
  Say ''
  Say 'Docker Desktop is installed. Restart the computer, open Docker Desktop once and accept its terms,'
  Say 'then run this installer again.'
  exit 0
}
if ((Invoke-Native -File 'docker' -Arguments @('info') -Capture -AllowFailure).Code -ne 0) {
  $exe = @("$env:ProgramFiles\Docker\Docker\Docker Desktop.exe", "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($exe) { Start-Process $exe | Out-Null }
  Say 'Starting Docker Desktop (up to 3 minutes)...'
  $deadline = (Get-Date).AddMinutes(3)
  while ((Invoke-Native -File 'docker' -Arguments @('info') -Capture -AllowFailure).Code -ne 0) {
    if ((Get-Date) -gt $deadline) { Fail 'Docker Desktop did not start. Open it, wait until it says it is running, then try again.' }
    Start-Sleep -Seconds 5
  }
}
Say 'Docker is running.'

New-Item -ItemType Directory -Force (Join-Path $InstallDir 'caddy'), (Join-Path $InstallDir 'logs'), $Settings | Out-Null
if ($Stop) {
  Compose @('--profile', 'release', 'stop')
  Say 'InnPilot is stopped. Its data is kept; run the installer again to start it.'
  exit 0
}

Step "Files for version $Version into $InstallDir"
if ((Resolve-Path $Bundle).Path.TrimEnd('\') -ne (Resolve-Path $InstallDir).Path.TrimEnd('\')) {
  foreach ($f in 'compose.yml', 'compose.single.yml', 'compose.onprem.yml', 'install.ps1', 'backup-offsite.ps1', 'InnPilot-Install.cmd', 'VERSION', 'README.txt') {
    Copy-Item (Join-Path $Bundle $f) $InstallDir -Force
  }
  Copy-Item (Join-Path $Bundle 'caddy\*') (Join-Path $InstallDir 'caddy') -Force
}

if ($FirstInstall) {
  Step 'This hotel (first install)'
  $Address = Ask $Address 'Public address from Tailscale Funnel (https://...ts.net)' '^https://[a-z0-9.-]+$' 'It must start with https:// and contain only the address, e.g. https://frontdesk.tail1234.ts.net'
  $HotelName = Ask $HotelName 'Hotel name' '^.{2,100}$' 'Between 2 and 100 characters.'
  $OwnerName = Ask $OwnerName "Owner's full name" '^.{2,100}$' 'Between 2 and 100 characters.'
  $OwnerEmail = Ask $OwnerEmail "Owner's email (their sign-in name)" '^[^@\s]+@[^@\s]+\.[^@\s]+$' 'For example owner@hotel.example'

  Step 'Settings with fresh secrets (only on this computer)'
  # Only the person installing and Windows itself may read the settings folder.
  & icacls $Settings /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  $pg = New-Secret 24; $app = New-Secret 24
  $storageKey = 'innpilot' + ([Guid]::NewGuid().ToString('N').Substring(0, 12)); $storageSecret = New-Secret 24
  Write-Settings (Join-Path $Settings 'postgres.env') @('POSTGRES_DB=innpilot', 'POSTGRES_USER=postgres', "POSTGRES_PASSWORD=$pg")
  Write-Settings (Join-Path $Settings 'release.env') @("DATABASE_ADMIN_URL=postgres://postgres:${pg}@postgres:5432/innpilot", "APP_DB_PASSWORD=$app")
  Write-Settings (Join-Path $Settings 'storage.env') @("ROOT_ACCESS_KEY_ID=$storageKey", "ROOT_SECRET_ACCESS_KEY=$storageSecret")
  Write-Settings (Join-Path $Settings 'app.env') @(
    "DATABASE_URL=postgres://innpilot_app:${app}@postgres:5432/innpilot", "WEB_ORIGINS=$Address", 'COOKIE_SECURE=true',
    "MFA_ENCRYPTION_KEY=$(New-Secret 32)", "PII_ENCRYPTION_KEY=$(New-Secret 32)", 'LOG_LEVEL=info', 'JOBS_POLL_SECONDS=5',
    'STORAGE_ENDPOINT=http://storage:7070', 'STORAGE_REGION=us-east-1', 'STORAGE_BUCKET=innpilot-files',
    "STORAGE_ACCESS_KEY_ID=$storageKey", "STORAGE_SECRET_ACCESS_KEY=$storageSecret")
  Write-Settings (Join-Path $Settings 'monitoring.env') @("GF_SECURITY_ADMIN_PASSWORD=$(New-Secret 18)")

  Say 'Backup key pair (made by InnPilot itself, in its own format)...'
  Invoke-Native -File 'docker' -Arguments @('pull', '-q', $ApiImage) -Capture -AllowFailure | Out-Null
  $keys = Invoke-Native -File 'docker' -Arguments @('run', '--rm', $ApiImage, 'node', 'dist/ops/cli.js', 'keygen') -Capture
  $public = ([regex]::Match($keys.Out, 'BACKUP_PUBLIC_KEY=(\S+)')).Groups[1].Value
  $private = ([regex]::Match($keys.Out, 'BACKUP_PRIVATE_KEY=(\S+)')).Groups[1].Value
  if (-not $public -or -not $private) { Fail 'The backup key pair could not be made.' }
  Write-Settings (Join-Path $Settings 'backup.env') @(
    'BACKUP_STORAGE_ENDPOINT=http://storage:7070', 'BACKUP_STORAGE_REGION=us-east-1', 'BACKUP_BUCKET=innpilot-backups',
    "BACKUP_ACCESS_KEY_ID=$storageKey", "BACKUP_SECRET_ACCESS_KEY=$storageSecret", "BACKUP_PUBLIC_KEY=$public",
    'BACKUP_AT_UTC=21:00', 'BACKUP_CREATE_BUCKET=true')
  $ownerPassword = New-Secret 12
}

$app = Read-Settings (Join-Path $Settings 'app.env')
$Address = $app['WEB_ORIGINS']
$env:SITE_ADDRESS = ([Uri]$Address).Host

Step "Release $Version"
if ($ApiImage -match '/') {
  # Published images (a registry path); local test images (-ApiImage name:tag) are used as they are.
  Say 'Downloading InnPilot...'
  Compose @('pull', '--quiet', 'api', 'web')
}
Compose @('up', '-d', '--wait', 'postgres', 'storage')
Compose @('--profile', 'release', 'run', '--rm', 'restore-drill', 'node', 'dist/ops/cli.js', 'ensure-buckets') -Capture | Out-Null
Say 'Application role...'; Compose @('--profile', 'release', 'run', '--rm', 'provision') -Capture | Out-Null
Say 'Encrypted backup before changing anything...'; Compose @('--profile', 'release', 'run', '--rm', 'backup') -Capture | Out-Null
Say 'Database updates...'; Say ((Compose @('--profile', 'release', 'run', '--rm', 'migrate') -Capture).Out.Trim())
Compose @('up', '-d', '--wait', 'api', 'web', 'proxy')
# The backup scheduler has no health check; newer Compose refuses to --wait on it.
Compose @('up', '-d', 'backups')

if ($FirstInstall) {
  Step "The hotel and its owner account"
  $slug = ($HotelName.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
  if ($slug.Length -lt 3) { $slug = "hotel-$slug" }
  $created = Compose @('--profile', 'release', 'run', '--rm', '-T', 'migrate', 'node', 'node_modules/@innpilot/db/dist/cli.js',
    'tenant:create', '--slug', $slug, '--legal-name', $HotelName, '--display-name', $HotelName, '--property', $HotelName,
    '--owner-email', $OwnerEmail, '--owner-name', $OwnerName) -StdIn "$ownerPassword`n" -Capture
  Say ($created.Out.Trim())
  # The backup before the first migrations ran on an empty database, before backups could be recorded: take the
  # first real one now, with the hotel in it, so the owner does not start with a "no backup yet" warning.
  Say 'First backup with the hotel in it...'
  Compose @('--profile', 'release', 'run', '--rm', 'backup') -Capture | Out-Null

  Step 'Recovery kit (move it to a USB stick)'
  $kit = Join-Path ([Environment]::GetFolderPath('Desktop')) 'InnPilot recovery kit'
  New-Item -ItemType Directory -Force $kit | Out-Null
  Copy-Item (Join-Path $Settings '*.env') $kit -Force
  Write-Settings (Join-Path $kit 'backup-private.env') @("BACKUP_PRIVATE_KEY=$private")
  [System.IO.File]::WriteAllText((Join-Path $kit 'READ ME FIRST.txt'), (@(
    "InnPilot recovery kit for $HotelName, made $(Get-Date -Format 'yyyy-MM-dd HH:mm').",
    '',
    'These files are the only way to restore this hotel''s InnPilot if this computer is lost or broken:',
    '  - backup-private.env is the only key that can open the backups;',
    '  - app.env holds the keys that protect guests'' document numbers and two-step sign-in;',
    '  - the other files are the remaining settings.',
    '',
    '1. Copy this whole folder to a USB stick, and a second copy to another safe place.',
    '2. Keep them away from this computer (not in the same bag or room).',
    '3. Delete this folder from the desktop.',
    'Never email, upload or share these files.',
    '',
    "First sign-in: $Address",
    "  Email:    $OwnerEmail",
    "  Password: $ownerPassword   (one time only: change it under My account after signing in)",
    'The owner sets up two-step sign-in with an authenticator app on the first sign-in.'
  ) -join "`r`n"), $Utf8)
  Say "Written to: $kit"
}

Step 'Check'
$host_ = ([Uri]$Address).Host
$ready = Invoke-Native -File 'curl.exe' -Arguments @('-s', '-o', 'NUL', '-w', '%{http_code}', '-H', "Host: $host_", "http://127.0.0.1:$Port/api/v1/health/ready") -Capture -AllowFailure
if ($ready.Out.Trim() -ne '200') { Fail "InnPilot does not answer as ready (status $($ready.Out.Trim())). Logs: docker compose -p $Project logs api" }
Say 'InnPilot is running and ready.'
if ($FirstInstall) {
  # Prove the owner's first sign-in works before handing it over. (The session it opens waits for two-step set-up
  # and expires on its own; its Secure cookie is not kept over this local http check.)
  $body = Join-Path $env:TEMP "innpilot-signin-$PID.json"
  [System.IO.File]::WriteAllText($body, (@{ email = $OwnerEmail; password = $ownerPassword } | ConvertTo-Json -Compress), $Utf8)
  try {
    $signIn = Invoke-Native -File 'curl.exe' -Arguments @('-s', '-o', 'NUL', '-w', '%{http_code}',
      '-H', "Host: $host_", '-H', "Origin: $Address", '-H', 'content-type: application/json', '--data-binary', "@$body",
      "http://127.0.0.1:$Port/api/v1/auth/login") -Capture -AllowFailure
    if ($signIn.Out.Trim() -ne '200') { Fail "The owner's first sign-in does not work (status $($signIn.Out.Trim()))." }
  } finally {
    Remove-Item $body -ErrorAction SilentlyContinue
  }
  Say "The owner's first sign-in works."
}

Step 'Keeping it running'
$store = Join-Path $env:APPDATA 'Docker\settings-store.json'
if (Test-Path $store) {
  $json = Get-Content $store -Raw | ConvertFrom-Json
  if (-not $json.AutoStart) {
    Copy-Item $store "$store.before-innpilot" -Force
    $json | Add-Member -NotePropertyName AutoStart -NotePropertyValue $true -Force
    [System.IO.File]::WriteAllText($store, ($json | ConvertTo-Json -Depth 20), $Utf8)
    Say 'Docker Desktop will start when you sign in to Windows.'
  } else { Say 'Docker Desktop already starts with Windows.' }
} else { Say 'Docker Desktop -> Settings -> General: tick "Start Docker Desktop when you sign in".' }
Say 'Set Windows never to sleep while plugged in: Settings -> System -> Power.'

if ($BackupFolder -or $FirstInstall) {
  Step 'Daily copy of backups and files off this computer'
  $BackupFolder = Ask $BackupFolder 'Folder for the daily copies (Google Drive for desktop or a USB drive)' '.' ''
  if (-not (Test-Path $BackupFolder -PathType Container)) { New-Item -ItemType Directory -Force $BackupFolder | Out-Null }
  Write-Settings (Join-Path $Settings 'offsite.env') @("OFFSITE_DIR=$BackupFolder", "PROJECT=$Project")
  $script = Join-Path $InstallDir 'backup-offsite.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
  $trigger = New-ScheduledTaskTrigger -Daily -At 15:00
  $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName "InnPilot off-site copy ($Project)" -Description 'Daily encrypted copy of InnPilot backups and files.' -Action $action -Trigger $trigger -Settings $set -Force | Out-Null
  Start-ScheduledTask -TaskName "InnPilot off-site copy ($Project)"
  Say "Daily at 15:00 (or when the computer is next on) to: $BackupFolder. First copy started now."
}

Step 'Done'
Say "InnPilot $Version is installed for this computer at $Address"
if ($FirstInstall) {
  Say ''
  Say 'Still to do, once:'
  Say "  1. Tailscale (free, the hotel's own account): install it, sign in, then run:  tailscale funnel --bg $Port"
  Say '  2. Move "InnPilot recovery kit" from the desktop to a USB stick (see READ ME FIRST.txt inside it).'
  Say '  3. The owner signs in at the address above and changes the one-time password.'
}
