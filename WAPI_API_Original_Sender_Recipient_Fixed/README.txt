THIS PATCH IS FOR THE ORIGINAL PROJECT ONLY:
C:\Users\Dubai Store\Pictures\WaCRM\wapi-api
GitHub: Irfankhan124/wapi-api
Render: existing wapi-api service

Fixes:
- Removes stale in-memory Baileys sockets before reconnecting.
- Synchronizes the live linked sender phone after every QR connection.
- Repairs stale WhatsappPhoneNumber records when the actual linked phone differs.
- Verifies recipients using a full WhatsApp JID and requires exists=true.
- Uses WhatsApp's normalized returned JID for sending.
- Saves the normalized recipient and actual live sender number.
- Returns a real WhatsApp message ID and recipient verification details.

Apply:
powershell -ExecutionPolicy Bypass -File .\apply_fix.ps1

After applying, commit/push and redeploy the SAME existing Render wapi-api service.
Do not create or deploy wapi-api-2.

After deployment, remove the old linked device for the failing sender, reconnect it with a new QR once, and test again.
