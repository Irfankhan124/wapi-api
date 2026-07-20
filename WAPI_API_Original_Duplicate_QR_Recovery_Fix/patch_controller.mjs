import fs from 'fs';
import path from 'path';

const repo = process.argv[2];
if (!repo) {
  console.error('Usage: node patch_controller.mjs <repo-path>');
  process.exit(1);
}

const controllerPath = path.join(repo, 'controllers', 'unified-whatsapp.controller.js');
if (!fs.existsSync(controllerPath)) {
  console.error(`Controller not found: ${controllerPath}`);
  process.exit(1);
}

let source = fs.readFileSync(controllerPath, 'utf8');

const connectionsReplacement = String.raw`export const getUserConnections = async (req, res) => {
  try {
    const userId = req.user.owner_id;

    const wabas = await WhatsappWaba.find({
      user_id: userId,
      deleted_at: null
    })
      .sort({ created_at: -1 })
      .lean();

    const enrichedWabas = await Promise.all(
      wabas.map(async (waba) => {
        const phoneNumbers = await WhatsappPhoneNumber.find({
          user_id: userId,
          waba_id: waba._id,
          deleted_at: null
        })
          .sort({ created_at: -1 })
          .lean();

        const isBaileys = String(waba.provider || '').toLowerCase() === PROVIDER_TYPES.BAILEY;

        const enrichedPhoneNumbers = await Promise.all(
          phoneNumbers.map(async (phone) => {
            let verified_name = phone.verified_name;
            let quality_rating = phone.quality_rating;

            // Baileys phone_number_id values are WhatsApp JIDs, not Meta Graph
            // phone-number IDs. Sending those JIDs to Graph API caused the 401 loop.
            if (!isBaileys && waba.access_token && phone.phone_number_id) {
              try {
                const response = await axios.get(
                  https://graph.facebook.com/v22.0/\${phone.phone_number_id},
                  {
                    params: { fields: 'verified_name,quality_rating' },
                    headers: { Authorization: Bearer \${waba.access_token} }
                  }
                );
                verified_name = response.data.verified_name || verified_name;
                quality_rating = response.data.quality_rating || quality_rating;
              } catch (err) {
                console.error(
                  Failed to fetch WhatsApp details for \${phone.phone_number_id},
                  err.message
                );
              }
            }

            return {
              id: phone._id.toString(),
              phone_number_id: phone.phone_number_id,
              display_phone_number: phone.display_phone_number,
              verified_name,
              quality_rating,
              is_primary: phone.is_primary === true,
              is_active: phone.is_active !== false,
              created_at: phone.created_at,
              updated_at: phone.updated_at
            };
          })
        );

        const primaryPhone =
          enrichedPhoneNumbers.find((item) => item.is_primary) ||
          enrichedPhoneNumbers.find((item) => item.is_active) ||
          enrichedPhoneNumbers[0] ||
          null;

        return {
          id: waba._id.toString(),
          name: waba.name,
          instance_name: waba.instance_name || waba.name,
          provider: waba.provider || PROVIDER_TYPES.BUSINESS_API,
          connection_status: waba.connection_status || (isBaileys ? 'initial' : 'connected'),
          status: waba.connection_status || (isBaileys ? 'initial' : 'connected'),
          display_phone_number:
            waba.display_phone_number ||
            waba.registred_phone_number ||
            primaryPhone?.display_phone_number ||
            null,
          registred_phone_number:
            waba.registred_phone_number ||
            waba.display_phone_number ||
            primaryPhone?.display_phone_number ||
            null,
          whatsapp_business_account_id: waba.whatsapp_business_account_id,
          app_id: waba.app_id,
          is_active: waba.is_active !== false,
          phone_numbers: enrichedPhoneNumbers,
          phone_numbers_count: enrichedPhoneNumbers.length,
          created_at: waba.created_at,
          updated_at: waba.updated_at
        };
      })
    );

    return res.json({
      success: true,
      data: enrichedWabas,
      total_wabas: enrichedWabas.length
    });
  } catch (error) {
    console.error('Error getting user connections:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to get user connections',
      details: error.message
    });
  }
};

export const getMyPhoneNumbers`;

const connectionsPattern = /export const getUserConnections = async \(req, res\) => \{[\s\S]*?\n\};\n\nexport const getMyPhoneNumbers/;
if (!connectionsPattern.test(source)) {
  console.error('Could not find getUserConnections block. No changes were written.');
  process.exit(1);
}
source = source.replace(connectionsPattern, connectionsReplacement);

// Convert ESC placeholder characters back to JavaScript template-literal backticks.
source = source.replace(/\u001b/g, '`').replace(/\\\$\{/g, '${');

const qrReplacement = String.raw`export const getBaileysQRCode = async (req, res) => {
  try {
    const userId = req.user.owner_id;
    const { wabaId } = req.params;
    const syncChat = req.query.sync_chat === 'true';
    const forceReconnect =
      req.query.force_reconnect === 'true' ||
      req.query.force === 'true';

    if (!wabaId) {
      return res.status(400).json({
        success: false,
        error: 'WABA ID is required'
      });
    }

    let waba = await WhatsappWaba.findOne({
      _id: wabaId,
      user_id: userId,
      deleted_at: null
    });

    if (!waba) {
      return res.status(404).json({ success: false, error: 'WABA not found' });
    }

    let qrData;
    try {
      qrData = await unifiedWhatsAppService.getQRCode(userId, wabaId);
    } catch (qrErr) {
      qrData = {
        success: true,
        qr_code: null,
        status: waba.connection_status || 'initial'
      };
    }

    const normalizedStatus = String(
      qrData?.status || waba.connection_status || 'initial'
    ).trim().toLowerCase().replace(/[\s-]+/g, '_');

    const duplicateStatuses = new Set([
      'duplicate_disconnected',
      'duplicate',
      'duplicate_connection',
      'connection_conflict'
    ]);

    // A duplicate/conflict record has no usable QR and can remain stuck forever.
    // Force-reset only that WABA session, keep the same database record, and start
    // a fresh QR session immediately.
    if ((forceReconnect || duplicateStatuses.has(normalizedStatus)) && !qrData?.qr_code) {
      const provider = unifiedWhatsAppService.providers?.[PROVIDER_TYPES.BAILEY];

      if (typeof provider?.resetConnectionSession === 'function') {
        await provider.resetConnectionSession(wabaId, { deleteSession: true });
      } else {
        await WhatsappWaba.findByIdAndUpdate(wabaId, {
          is_active: true,
          deleted_at: null,
          connection_status: 'initial',
          qr_code: null
        });
      }

      await WhatsappPhoneNumber.updateMany(
        { waba_id: wabaId },
        { $set: { is_active: false } }
      );

      waba = await WhatsappWaba.findById(wabaId);
      unifiedWhatsAppService
        .initializeConnection(userId, PROVIDER_TYPES.BAILEY, {
          ...waba.toObject(),
          sync_chat: syncChat
        })
        .catch((err) =>
          console.error(
            Failed to start fresh Baileys QR for WABA \${wabaId}:,
            err
          )
        );

      return res.json({
        success: true,
        data: {
          success: true,
          qr_code: null,
          status: 'generating',
          recovery_started: true
        }
      });
    }

    const needsInit =
      !qrData?.qr_code &&
      [
        'disconnected',
        'qr_timeout',
        'initial',
        'generating',
        'reconnecting'
      ].includes(normalizedStatus);

    if (needsInit) {
      await WhatsappWaba.findByIdAndUpdate(wabaId, {
        is_active: true,
        deleted_at: null,
        connection_status:
          normalizedStatus === 'reconnecting' ? 'reconnecting' : 'initial',
        qr_code: null
      });

      waba = await WhatsappWaba.findById(wabaId);
      unifiedWhatsAppService
        .initializeConnection(userId, PROVIDER_TYPES.BAILEY, {
          ...waba.toObject(),
          sync_chat: syncChat
        })
        .catch((err) =>
          console.error(
            Failed to initialize Baileys QR for WABA \${wabaId}:,
            err
          )
        );

      return res.json({
        success: true,
        data: {
          success: true,
          qr_code: null,
          status: 'generating'
        }
      });
    }

    return res.json({
      success: true,
      data: qrData
    });
  } catch (error) {
    console.error('Error fetching Baileys QR code:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch QR code',
      details: error.message
    });
  }
};

export const disconnectWhatsApp`;

const qrPattern = /export const getBaileysQRCode = async \(req, res\) => \{[\s\S]*?\n\};\n\nexport const disconnectWhatsApp/;
if (!qrPattern.test(source)) {
  console.error('Could not find getBaileysQRCode block. No changes were written.');
  process.exit(1);
}
source = source.replace(qrPattern, qrReplacement);
source = source.replace(/\u001b/g, '`').replace(/\\\$\{/g, '${');

fs.writeFileSync(controllerPath, source, 'utf8');
console.log(`Patched ${controllerPath}`);
