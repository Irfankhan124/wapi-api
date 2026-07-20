$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\Dubai Store\Pictures\WaCRM\wapi-api'
$source = Join-Path $PSScriptRoot 'services\whatsapp\providers\baileys.provider.js'
$dest = Join-Path $repo 'services\whatsapp\providers\baileys.provider.js'

if (!(Test-Path $repo)) {
  Write-Host "WAPI repository not found: $repo" -ForegroundColor Red
  exit 1
}
if (!(Test-Path $source)) {
  Write-Host "Patch file missing: $source" -ForegroundColor Red
  exit 1
}

$backup = "$dest.bak_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
Copy-Item $dest $backup -Force
Copy-Item $source $dest -Force

Push-Location $repo
try {
  node --check .\services\whatsapp\providers\baileys.provider.js
  if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax check failed.' }
} finally {
  Pop-Location
}

Write-Host 'Original wapi-api Baileys fix applied successfully.' -ForegroundColor Green
Write-Host "Backup: $backup" -ForegroundColor Cyan
Write-Host ''
Write-Host 'Now run:' -ForegroundColor Yellow
Write-Host "cd `"$repo`""
Write-Host 'git add services/whatsapp/providers/baileys.provider.js'
Write-Host 'git commit -m "Fix Baileys sender session and recipient verification"'
Write-Host 'git push'
Write-Host ''
Write-Host 'Then redeploy the existing Render wapi-api service.' -ForegroundColor Yellow
