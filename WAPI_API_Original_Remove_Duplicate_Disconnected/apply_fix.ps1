$ErrorActionPreference = 'Stop'

$repo = 'C:\Users\Dubai Store\Pictures\WaCRM\wapi-api'
$source = Join-Path $PSScriptRoot 'services\whatsapp\providers\baileys.provider.js'
$dest = Join-Path $repo 'services\whatsapp\providers\baileys.provider.js'

foreach ($required in @($repo, $source, $dest)) {
  if (!(Test-Path $required)) {
    Write-Host "Required path not found: $required" -ForegroundColor Red
    exit 1
  }
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
Copy-Item $dest "$dest.bak_$stamp" -Force
Copy-Item $source $dest -Force

Push-Location $repo
try {
  node --check .\services\whatsapp\providers\baileys.provider.js
  if ($LASTEXITCODE -ne 0) { throw 'Provider syntax check failed.' }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'Duplicate-disconnected status removal applied to original wapi-api.' -ForegroundColor Green
Write-Host 'Old same-account duplicate records will be silently archived when the live connection opens.' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Now run:' -ForegroundColor Yellow
Write-Host "cd `"$repo`""
Write-Host 'git add services/whatsapp/providers/baileys.provider.js'
Write-Host 'git commit -m "Reuse active WAPI connection and archive duplicates"'
Write-Host 'git push origin main'
Write-Host ''
Write-Host 'Then redeploy the existing Render wapi-api service.' -ForegroundColor Yellow
