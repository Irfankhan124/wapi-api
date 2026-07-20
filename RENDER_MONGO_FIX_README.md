# Render MongoDB startup fix

This version fixes the Render production crash:

`Cannot read properties of undefined (reading 'mongoUri')`

Files changed:
- `config/config.js` now includes production config.
- `models/index.js` now safely reads `MONGO_URI` / `MONGODB_URI` and shows a clear error if missing.

After replacing these files, push to GitHub and redeploy Render.

Required Render environment variables:

```env
NODE_ENV=production
MONGO_URI=mongodb+srv://admin:admin123@cluster0.1qhlud8.mongodb.net/wapi?retryWrites=true&w=majority&appName=Cluster0
MONGODB_URI=mongodb+srv://admin:admin123@cluster0.1qhlud8.mongodb.net/wapi?retryWrites=true&w=majority&appName=Cluster0
NODE_VERSION=22.17.0
```
