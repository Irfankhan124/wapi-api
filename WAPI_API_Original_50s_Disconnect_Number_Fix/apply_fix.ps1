$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\Dubai Store\Pictures\WaCRM\wapi-api'
$source = Join-Path $PSScriptRoot 'services\whatsapp\providers\baileys.provider.js'
$dest = Join-Path $repo 'services\whatsapp\providers\baileys.provider.js'
$packageJson = Join-Path $repo 'package.json'

if (!(Test-Path $repo)) {
  Write-Host "WAPI repository not found: $repo" -ForegroundColor Red
  exit 1
}
if (!(Test-Path $source)) {
  Write-Host "Patch provider file missing: $source" -ForegroundColor Red
  exit 1
}
if (!(Test-Path $dest)) {
  Write-Host "Destination provider file missing: $dest" -ForegroundColor Red
  exit 1
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$providerBackup = "$dest.bak_$stamp"
Copy-Item $dest $providerBackup -Force
Copy-Item $source $dest -Force

if (Test-Path $packageJson) {
  Copy-Item $packageJson "$packageJson.bak_$stamp" -Force
}
if (Test-Path (Join-Path $repo 'package-lock.json')) {
  Copy-Item (Join-Path $repo 'package-lock.json') (Join-Path $repo "package-lock.json.bak_$stamp") -Force
}

Push-Location $repo
try {
  node --check .\services\whatsapp\providers\baileys.provider.js
  if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax check failed.' }

  Write-Host 'Updating Baileys to 7.0.0-rc13...' -ForegroundColor Cyan
  npm install --save-exact '@whiskeysockets/baileys@7.0.0-rc13'
  if ($LASTEXITCODE -ne 0) {
    Write-Warning 'Baileys package update failed. The code patch was applied, but run npm install again before deploying.'
  }

  node --check .\services\whatsapp\providers\baileys.provider.js
  if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax check failed after npm install.' }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'Original wapi-api stability fix applied successfully.' -ForegroundColor Green
Write-Host "Provider backup: $providerBackup" -ForegroundColor Cyan
Write-Host ''
Write-Host 'Now run:' -ForegroundColor Yellow
Write-Host "cd `"$repo`""
Write-Host 'git add services/whatsapp/providers/baileys.provider.js package.json package-lock.json'
Write-Host 'git commit -m "Fix Baileys 50-second disconnect and duplicate sender sessions"'
Write-Host 'git push'
Write-Host ''
Write-Host 'Then redeploy the existing Render wapi-api service.' -ForegroundColor Yellow
