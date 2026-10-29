<#
.SYNOPSIS
  Daily copy of InnPilot's backups and files to a folder that leaves this computer (on-premises install, D22).

.DESCRIPTION
  Run by the "InnPilot off-site copy" scheduled task that install.ps1 creates. Packs the storage (the encrypted
  nightly backups and the application's files, also encrypted) into one file in the folder named in
  settings\offsite.env, keeping the newest three, and logs to logs\offsite.log. The copy keeps the storage's extended
  attributes, which a rebuild needs. Without the recovery kit nobody can read it.
#>
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Log = Join-Path $Root 'logs\offsite.log'
New-Item -ItemType Directory -Force (Split-Path $Log) | Out-Null
function Log([string]$Text) { Add-Content -Path $Log -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Text" }

foreach ($bin in "$env:ProgramFiles\Docker\Docker\resources\bin", "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin") {
  if (Test-Path (Join-Path $bin 'docker.exe')) { $env:PATH = "$env:PATH;$bin" }
}
$cfg = @{}
foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $Root 'settings\offsite.env'))) {
  $i = $line.IndexOf('=')
  if ($i -gt 0 -and -not $line.StartsWith('#')) { $cfg[$line.Substring(0, $i)] = $line.Substring($i + 1) }
}
$dest = $cfg['OFFSITE_DIR']
if (-not (Test-Path $dest -PathType Container)) { Log "FAILED: $dest is not available (drive not connected?)"; exit 1 }

$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$name = "innpilot-storage-$stamp.tar"
$box = "innpilot-offsite-$stamp".ToLowerInvariant()
$ErrorActionPreference = 'Continue'
docker run --name $box -v "$($cfg['PROJECT'])_storagedata:/from:ro" debian:bookworm-slim `
  tar --xattrs '--xattrs-include=*' -C /from -cf /tmp/storage.tar . 2>&1 | Out-Null
$packed = $LASTEXITCODE
if ($packed -eq 0) { docker cp "${box}:/tmp/storage.tar" (Join-Path $dest "$name.partial") 2>&1 | Out-Null; $packed = $LASTEXITCODE }
docker rm -f $box 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'
if ($packed -ne 0) { Remove-Item (Join-Path $dest "$name.partial") -ErrorAction SilentlyContinue; Log 'FAILED: the copy could not be made'; exit 1 }

Rename-Item (Join-Path $dest "$name.partial") $name
$copies = Get-ChildItem $dest -Filter 'innpilot-storage-*.tar' | Where-Object { $_.Name -match '^innpilot-storage-\d{8}T\d{6}Z\.tar$' } | Sort-Object Name
$copies | Select-Object -SkipLast 3 | Remove-Item
Log "Copied $([math]::Round((Get-Item (Join-Path $dest $name)).Length / 1MB, 1)) MB to $dest\$name"
