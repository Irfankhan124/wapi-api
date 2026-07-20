import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node patch-unified.mjs <unified-whatsapp.service.js>');
  process.exit(1);
}

let source = fs.readFileSync(target, 'utf8');

const mapMarker = 'const enrichedConnections = await Promise.all(';
const markerIndex = source.indexOf(mapMarker);
if (markerIndex < 0) {
  throw new Error('Could not find getUserConnections enrichment block.');
}

const returnMarker = '\n        return {';
const returnIndex = source.indexOf(returnMarker, markerIndex);
if (returnIndex < 0) {
  throw new Error('Could not find the connection return block.');
}

const logMarkerA = '        console.log("conn.phone_number_id", conn.phone_number_id)';
const logMarkerB = '        console.log("conn.access_token", conn.access_token)';
let replaceStart = source.indexOf(logMarkerA, markerIndex);
if (replaceStart < 0) {
  // Support files where the debug logs were already removed but the unsafe
  // Graph API request is still present.
  replaceStart = source.indexOf('        try {', markerIndex);
}
if (replaceStart < 0 || replaceStart > returnIndex) {
  // Already-patched detection.
  if (source.includes('const isBaileysJid =')) {
    console.log('Unified WhatsApp service is already patched.');
    process.exit(0);
  }
  throw new Error('Could not find the unsafe WhatsApp-details request block.');
}

const replacement = `        // Baileys stores a device JID such as 937xxxxxxxx:20@s.whatsapp.net.
        // That is not a Meta Cloud API phone-number ID and must never be sent
        // to graph.facebook.com. Doing so caused repeated HTTP 401 errors and
        // also exposed access tokens in the server logs.
        const phoneNumberId = String(conn.phone_number_id || '');
        const isBaileysJid = phoneNumberId.includes('@s.whatsapp.net')
          || phoneNumberId.includes('@lid')
          || phoneNumberId.includes(':');
        const hasBusinessApiCredentials = !isBaileysJid
          && /^\\d+$/.test(phoneNumberId)
          && Boolean(conn.access_token);

        if (hasBusinessApiCredentials) {
          try {
            const response = await axios.get(
              \`https://graph.facebook.com/v19.0/\${phoneNumberId}\`,
              {
                params: {
                  fields: 'verified_name,quality_rating'
                },
                headers: {
                  Authorization: \`Bearer \${conn.access_token}\`
                },
                timeout: 10_000
              }
            );
            verified_name = response.data.verified_name;
            quality_rating = response.data.quality_rating;
          } catch (err) {
            console.warn(
              \`Could not refresh Meta WhatsApp details for phone-number ID \${phoneNumberId}:\`,
              err.response?.status || err.message
            );
          }
        } else if (isBaileysJid) {
          // Use local connection information for Baileys records.
          verified_name = conn.name || conn.registred_phone_number || phoneNumberId.split(':')[0];
          quality_rating = null;
        }`;

source = source.slice(0, replaceStart) + replacement + source.slice(returnIndex);
fs.writeFileSync(target, source, 'utf8');
console.log(`Patched ${path.basename(target)} to skip Meta Graph calls for Baileys JIDs.`);
