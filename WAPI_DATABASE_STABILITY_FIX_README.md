# WAPI database stability fix

This build fixes the QR, duplicate-session, inaccurate-status, and database-send flow.

## Important deployment settings

Deploy only one API instance. Baileys keeps one live socket per WhatsApp account.

For Render, keep the persistent disk configured by `render.yaml` and use:

```env
BAILEYS_SESSION_DIR=/var/data/baileys-sessions
```

The included Blueprint mounts `/var/data`. Without persistent storage, linked-device credentials disappear after a restart or redeploy and WhatsApp asks for a new QR code.

Keep these existing variables configured in Render:

```env
MONGO_URI=...
REDIS_URL=...
JWT_SECRET=...
SESSION_SECRET=...
ALLOWED_ORIGINS=...
```

## Fixed behavior

- Existing Baileys WABA records are reused instead of creating competing sockets.
- `connection_conflict` and old `duplicate_disconnected` records recover into a fresh QR session.
- QR polling reuses an in-progress socket and no longer replaces it.
- The connections endpoint reports live runtime state, not only a saved database value.
- Baileys phone IDs are no longer sent to Meta Graph API.
- Reconnecting the same phone reuses its phone-number document and avoids duplicate-key failures.
- Send responses contain a real `wa_message_id`; missing confirmation is now an error.
- Recipient and connection errors are returned with useful HTTP status codes and messages.

## Deployment order

1. Deploy this API build.
2. Confirm the Render disk is attached and the service has one instance.
3. Redeploy the fixed Paktika ISP database build.
4. Open **Connect WhatsApp**. A broken duplicate/conflict state will be reset and a new QR will appear.
5. Scan the QR once and keep the linked device active.
