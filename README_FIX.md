# WAPI Baileys Send Result Fix

This fixes the WAPI backend error:

`Cannot read properties of undefined (reading 'id')`

Replace this file in your GitHub-connected WAPI API repo:

`services/whatsapp/providers/baileys.provider.js`

Then run:

```powershell
cd "C:\Users\Dubai Store\Pictures\WaCRM\wapi-api"
git add services/whatsapp/providers/baileys.provider.js
git commit -m "Fix Baileys send result id"
git push
```

Then in Render:

`wapi-api → Manual Deploy → Deploy latest commit`

