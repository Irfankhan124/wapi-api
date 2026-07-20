WAPI ORIGINAL API — DUPLICATE QR RECOVERY FIX
=============================================

Target project:
C:\Users\Dubai Store\Pictures\WaCRM\wapi-api

This fixes the stuck response:
  raw_status: duplicate_disconnected
  status: syncing
  qr_code: null

Changes:
1. Adds a safe resetConnectionSession method to the Baileys provider.
2. A duplicate/conflict state now clears only that broken WABA session.
3. The same WABA record is restarted and generates a fresh QR code.
4. The connections endpoint now returns provider, connection_status and phone data.
5. Baileys JIDs are no longer sent to Meta Graph API, stopping the 401 log loop.
6. Old same-number WAPI records are silently archived after the live connection opens.

Run:
powershell -ExecutionPolicy Bypass -File .\apply_fix.ps1

Then commit, push and redeploy the existing Render wapi-api service.
Do not create another Render service.
