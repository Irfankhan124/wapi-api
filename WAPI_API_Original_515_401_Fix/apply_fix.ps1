$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\Dubai Store\Pictures\WaCRM\wapi-api'
$providerSource = Join-Path $PSScriptRoot 'services\whatsapp\providers\baileys.provider.js'
$providerDest = Join-Path $repo 'services\whatsapp\providers\baileys.provider.js'
$unifiedDest = Join-Path $repo 'services\whatsapp\unified-whatsapp.service.js'
$unifiedPatcher = Join-Path $PSScriptRoot 'patch-unified.mjs'

foreach ($required in @($repo, $providerSource, $providerDest, $unifiedDest, $unifiedPatcher)) {
  if (!(Test-Path $required)) {
    Write-Host "Required path not found: $required" -ForegroundColor Red
    exit 1
  }
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
Copy-Item $providerDest "$providerDest.bak_$stamp" -Force
Copy-Item $unifiedDest "$unifiedDest.bak_$stamp" -Force

Copy-Item $providerSource $providerDest -Force
node $unifiedPatcher $unifiedDest
if ($LASTEXITCODE -ne 0) { throw 'Failed to patch unified WhatsApp service.' }

Push-Location $repo
try {
  node --check .\services\whatsapp\providers\baileys.provider.js
  if ($LASTEXITCODE -ne 0) { throw 'Provider syntax check failed.' }

  node --check .\services\whatsapp\unified-whatsapp.service.js
  if ($LASTEXITCODE -ne 0) { throw 'Unified service syntax check failed.' }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'Original wapi-api code 515 + HTTP 401 fix applied.' -ForegroundColor Green
Write-Host 'Backups were created beside both modified files.' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Now run:' -ForegroundColor Yellow
Write-Host "cd `"$repo`""
Write-Host 'git add services/whatsapp/providers/baileys.provider.js services/whatsapp/unified-whatsapp.service.js'
Write-Host 'git commit -m "Fix Baileys code 515 restart and skip Graph API for Baileys JIDs"'
Write-Host 'git push origin main'
Write-Host ''
Write-Host 'Then deploy the latest commit on the existing Render wapi-api service.' -ForegroundColor Yellow
