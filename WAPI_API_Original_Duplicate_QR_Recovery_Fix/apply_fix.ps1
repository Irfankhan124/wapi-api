$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\Dubai Store\Pictures\WaCRM\wapi-api'
$providerSource = Join-Path $PSScriptRoot 'services\whatsapp\providers\baileys.provider.js'
$providerDest = Join-Path $repo 'services\whatsapp\providers\baileys.provider.js'
$controllerDest = Join-Path $repo 'controllers\unified-whatsapp.controller.js'
$patchScript = Join-Path $PSScriptRoot 'patch_controller.mjs'

foreach ($required in @($repo, $providerSource, $providerDest, $controllerDest, $patchScript)) {
  if (!(Test-Path $required)) {
    Write-Host "Required path not found: $required" -ForegroundColor Red
    exit 1
  }
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
Copy-Item $providerDest "$providerDest.bak_$stamp" -Force
Copy-Item $controllerDest "$controllerDest.bak_$stamp" -Force
Copy-Item $providerSource $providerDest -Force

node $patchScript $repo
if ($LASTEXITCODE -ne 0) { throw 'Controller patch failed.' }

Push-Location $repo
try {
  node --check .\services\whatsapp\providers\baileys.provider.js
  if ($LASTEXITCODE -ne 0) { throw 'Provider syntax check failed.' }

  node --check .\controllers\unified-whatsapp.controller.js
  if ($LASTEXITCODE -ne 0) { throw 'Controller syntax check failed.' }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'WAPI duplicate QR recovery fix applied successfully.' -ForegroundColor Green
Write-Host 'duplicate_disconnected will now be reset into a fresh QR session.' -ForegroundColor Cyan
Write-Host 'The connections API now returns the real provider and connection status.' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Now run:' -ForegroundColor Yellow
Write-Host "cd `"$repo`""
Write-Host 'git add services/whatsapp/providers/baileys.provider.js controllers/unified-whatsapp.controller.js'
Write-Host 'git commit -m "Fix duplicate connection QR recovery"'
Write-Host 'git push origin main'
Write-Host ''
Write-Host 'Then redeploy the existing Render wapi-api service.' -ForegroundColor Yellow
