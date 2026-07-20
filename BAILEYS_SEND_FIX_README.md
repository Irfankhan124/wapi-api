# WAPI Baileys send fix

This update fixes the API error:

`Cannot read properties of undefined (reading 'id')`

The bug was in:

`services/whatsapp/providers/baileys.provider.js`

When Baileys sent the message but did not return `result.key.id`, the backend crashed while saving the sent message to MongoDB. This patch safely reads the WhatsApp message id and falls back to a generated internal id so the API returns success instead of 500.

## Deploy to Render

Copy the patched file into your local GitHub repo, or replace your backend with this folder, then run:

```powershell
git add services/whatsapp/providers/baileys.provider.js
git commit -m "Fix Baileys send message result id"
git push
```

Then in Render:

Manual Deploy -> Deploy latest commit

After deploy, test the same PowerShell command and then test the Paktika app button.
