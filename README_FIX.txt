WAPI Baileys undefined id fix

This fixes:
Cannot read properties of undefined (reading 'id')

What changed:
services/whatsapp/providers/baileys.provider.js now safely reads:
result?.key?.id || result?.message?.key?.id || result?.id || result?.messageId || fallback

How to use:
1. Extract this ZIP.
2. Right-click apply_fix.ps1 and run with PowerShell, or run:
   powershell -ExecutionPolicy Bypass -File .\apply_fix.ps1
3. Then in your repo:
   cd "C:\Users\Dubai Store\Pictures\WaCRM\wapi-api"
   git status
   git add services/whatsapp/providers/baileys.provider.js
   git commit -m "Fix Baileys undefined message id"
   git push
4. Render -> wapi-api -> Manual Deploy -> Deploy latest commit
