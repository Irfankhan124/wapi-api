WAPI ORIGINAL API — CODE 515 + HTTP 401 FIX
===========================================

Target project:
C:\Users\Dubai Store\Pictures\WaCRM\wapi-api

Fixes:
1. Keeps an active QR/connecting socket instead of replacing it every polling cycle.
2. Serializes credential writes before restarting after WhatsApp code 515.
3. Treats code 515 as the expected post-pairing restart and reconnects quickly.
4. Stops sending Baileys device JIDs such as 937...:20@s.whatsapp.net to Meta Graph API.
5. Removes access-token debug logging from the connection-list code.

Run from the extracted patch directory:
powershell -ExecutionPolicy Bypass -File .\apply_fix.ps1

Then commit, push, and redeploy the existing Render wapi-api service.

After deployment, delete the old WAPI connection for +93 744 414 009, remove its old
entry from WhatsApp > Linked Devices, create one new connection, and scan one fresh QR.
Code 515 may appear once immediately after pairing; the patched service should restart
and then log "Baileys connection opened" without generating another QR.
