$ErrorActionPreference = 'Stop'

$target = Join-Path (Get-Location) 'src\session-manager.js'
if (-not (Test-Path $target)) {
    throw "src\session-manager.js was not found. Run this script from the root of the wapi-api-2 project."
}

$text = [System.IO.File]::ReadAllText($target).Replace("`r`n", "`n")
$backup = "$target.backup_$(Get-Date -Format yyyyMMdd_HHmmss)"
[System.IO.File]::WriteAllText($backup, $text, [System.Text.UTF8Encoding]::new($false))

$old = @'
  const task = async () => {
    const jid = `${digits}@s.whatsapp.net`;
    const availability = await runtime.sock.onWhatsApp(jid);
    if (Array.isArray(availability) && availability.length === 0) {
      throw new Error('This phone number is not registered on WhatsApp');
    }
    const result = await runtime.sock.sendMessage(jid, { text: messageText });
    if (config.sendDelayMs > 0) await sleep(config.sendDelayMs);
    return {
      id: result?.key?.id || null,
      key: result?.key || null,
      jid,
      phone: digits,
      status: 'sent',
    };
  };
'@

$new = @'
  const task = async () => {
    const requestedJid = `${digits}@s.whatsapp.net`;
    const availability = await runtime.sock.onWhatsApp(requestedJid);

    const verifiedAccount = Array.isArray(availability)
      ? availability.find((item) => item?.exists === true && item?.jid)
      : null;

    console.log('[WhatsApp recipient check]', {
      phone: digits,
      requestedJid,
      availability,
    });

    if (!verifiedAccount?.jid) {
      throw new Error(
        `The number +${digits} is not registered or could not be verified on WhatsApp`,
      );
    }

    // Always use the normalized JID returned by WhatsApp.
    const verifiedJid = verifiedAccount.jid;
    const result = await runtime.sock.sendMessage(verifiedJid, {
      text: messageText,
    });
    const messageId = result?.key?.id || null;

    if (!messageId) {
      throw new Error('WhatsApp did not return a real message ID');
    }

    if (config.sendDelayMs > 0) await sleep(config.sendDelayMs);

    return {
      id: messageId,
      key: result?.key || null,
      jid: verifiedJid,
      phone: digits,
      status: 'submitted',
      recipient_verified: true,
      delivered: false,
    };
  };
'@

if (-not $text.Contains($old)) {
    throw "The expected sendText block was not found. The file may already be patched or may be a different WAPI version."
}

$patched = $text.Replace($old, $new)
[System.IO.File]::WriteAllText($target, $patched, [System.Text.UTF8Encoding]::new($false))

node --check $target
if ($LASTEXITCODE -ne 0) {
    Copy-Item $backup $target -Force
    throw "Syntax validation failed. The backup was restored."
}

Write-Host "Recipient verification patch applied successfully." -ForegroundColor Green
Write-Host "Backup: $backup"
Write-Host "Next: git add src/session-manager.js; git commit; git push; then redeploy Render."
