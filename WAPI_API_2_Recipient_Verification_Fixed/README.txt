WAPI API 2 — recipient-specific sending fix

Apply:
1. Extract this ZIP.
2. Copy apply_fix.ps1 into the root of your wapi-api-2 project.
3. Open PowerShell in that project folder.
4. Run:

   powershell -ExecutionPolicy Bypass -File .\apply_fix.ps1

5. Commit and push:

   git add src/session-manager.js
   git commit -m "Verify WhatsApp recipient before sending"
   git push

6. Redeploy the latest commit on Render.

The patch creates a timestamped backup automatically and validates JavaScript syntax before finishing.
