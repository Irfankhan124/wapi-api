# Render Env Force Fix

This version refuses to connect to localhost MongoDB on Render. It also logs which Mongo env variable is visible.

Copy these files into your GitHub repo:

- config/config.js
- models/index.js
- package.json
- .node-version

Then commit and push:

```powershell
git add config/config.js models/index.js package.json .node-version
git commit -m "Force Render MongoDB env vars"
git push
```

In Render → wapi-api → Environment, add exactly:

```env
MONGO_URI=mongodb+srv://admin:admin123@cluster0.1qhlud8.mongodb.net/wapi?retryWrites=true&w=majority&appName=Cluster0
MONGODB_URI=mongodb+srv://admin:admin123@cluster0.1qhlud8.mongodb.net/wapi?retryWrites=true&w=majority&appName=Cluster0
NODE_VERSION=22.17.0
```

Then Manual Deploy → Clear build cache & deploy.
