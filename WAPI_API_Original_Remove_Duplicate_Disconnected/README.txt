WAPI ORIGINAL API — REMOVE DUPLICATE DISCONNECTED
================================================

Target project:
C:\Users\Dubai Store\Pictures\WaCRM\wapi-api

What this changes:
1. Removes the duplicate_disconnected state from the Baileys provider.
2. Keeps the newest live connection connected.
3. Silently archives older duplicate records belonging to the same WAPI user and phone.
4. Stops old duplicate sockets and removes their local session folders.
5. Marks the current connection active so WAPI and Paktika use the same connection.

Run:
powershell -ExecutionPolicy Bypass -File .\apply_fix.ps1

Then commit, push, and redeploy the existing Render wapi-api service.
Do not create another Render service.
