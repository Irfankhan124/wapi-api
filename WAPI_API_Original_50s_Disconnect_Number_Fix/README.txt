WAPI ORIGINAL API — 50-SECOND DISCONNECT + NUMBER-SPECIFIC FIX
================================================================

Target project:
C:\Users\Dubai Store\Pictures\WaCRM\wapi-api

This patch fixes:
1. Authenticated 408 timeouts being incorrectly treated as expired QR sessions.
2. Valid session folders being deleted after transient timeouts.
3. Old socket close events deleting a newer healthy socket.
4. Duplicate WAPI connections fighting over the same WhatsApp number.
5. Reconnect storms by using one timer per WABA with backoff.
6. Stale sender-number records after reconnecting a different phone.
7. Recipient verification using the normalized WhatsApp JID.
8. Baileys upgrade from rc9 to rc13.

APPLY
-----
Right-click PowerShell in this extracted folder, then run:

powershell -ExecutionPolicy Bypass -File .\apply_fix.ps1

After pushing and redeploying Render:

A. In WhatsApp +93 744 414 009:
   WhatsApp > Settings > Linked Devices
   Remove old WAPI/Chrome/Ubuntu linked-device entries.

B. In the WAPI dashboard:
   Delete every duplicate connection that shows 93744414009.
   Keep/create only ONE connection for this number.
   Scan a fresh QR once.

C. Render:
   Use only one running instance/replica for this service.
   Add optional environment variable:
   BAILEYS_LOG_LEVEL=warn

D. Do not reconnect the same number in another Render service or another local WAPI process.

IMPORTANT
---------
If Render logs show code 440 or status connection_conflict, another WAPI session is replacing this number. Stop/delete the duplicate session and reconnect once.
