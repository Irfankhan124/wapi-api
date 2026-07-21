# Multi-number WhatsApp send fix

This build fixes the case where one recipient works but later recipients fail.

- API-key sends from the connected database bypass the UI conversation quota by default.
- Conversation usage now counts unique recipients instead of every message.
- Existing chats remain sendable after a plan reaches its new-conversation limit.
- Baileys recipient lookups are serialized, retried, cached, and can fall back to a direct phone-number JID when WhatsApp USync returns a transient empty result.
- The real WhatsApp message ID remains required before the API reports success.

Set `WAPI_API_KEY_BYPASS_CONVERSATION_LIMIT=false` if you intentionally want API-key sends to obey the dashboard plan quota.
