# Multi-recipient delivery fix

- Resolves and prefers Baileys 7 LID mappings for recipients when available.
- Falls back to the phone-number JID only when a LID send is rejected immediately.
- Serializes outbound sends per WhatsApp socket and adds a small configurable delay.
- Normalizes Afghanistan numbers including local, 0093, 093, 93-0, Arabic and Persian digit formats.

Optional environment values:

```env
WAPI_DEFAULT_COUNTRY_CODE=93
BAILEYS_SEND_DELAY_MS=650
```

A returned message ID means WhatsApp accepted/submitted the message. Delivery/read status still arrives asynchronously through message receipts.
