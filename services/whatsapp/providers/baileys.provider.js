import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay,
    downloadContentFromMessage,
    generateMessageIDV2
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { getBaileysSessionDir } from '../../../utils/baileys-session-path.js';
import BaseProvider from './base.provider.js';
import { WhatsappWaba, Message, Contact, WhatsappPhoneNumber, WabaConfiguration } from '../../../models/index.js';
import pino from 'pino';
import automationEngine from '../../../utils/automation-engine.js';
import { updateWhatsAppStatus } from '../../../utils/message-status.service.js';
import { normalizeWhatsAppNumber, isValidWhatsAppNumber } from '../../../utils/whatsapp-number.js';
import {
    isWithinWorkingHours,
    findMatchingBot,
    sendAutomatedReply,
    assignRoundRobin,
    handleSequenceReply
} from '../../../utils/automated-response.service.js';

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });

const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

function extractPhoneNumber(sock, connectionData = {}, authState = null) {
    const candidates = [
        String(sock?.user?.id || '').endsWith('@s.whatsapp.net') ? sock.user.id : null,
        String(authState?.creds?.me?.id || '').endsWith('@s.whatsapp.net') ? authState.creds.me.id : null,
        connectionData?.registred_phone_number,
        connectionData?.display_phone_number,
        connectionData?.phone_number
    ];

    for (const candidate of candidates) {
        const digits = digitsOnly(String(candidate || '').split(':')[0].split('@')[0]);
        if (/^\d{6,15}$/.test(digits)) return digits;
    }

    const fallback = digitsOnly(String(sock?.user?.id || '').split(':')[0].split('@')[0]);
    return /^\d{6,15}$/.test(fallback) ? fallback : null;
}

export default class BaileysProvider extends BaseProvider {
    constructor() {
        super();
        this.sockets = new Map();
        this.reconnectTimers = new Map();
        this.reconnectAttempts = new Map();
        this.connectionGenerations = new Map();
        // Track sockets that are legitimately waiting for QR/connection open.
        // A Baileys socket has no sock.user until authentication completes, so
        // sock.user alone must never be used to decide that the socket is stale.
        this.socketStates = new Map();
        this.recipientJidCache = new Map();
        this.recipientLookupChains = new Map();
        this.sendChains = new Map();
        this.lastSendAt = new Map();
        this.deliveryWaiters = new Map();
        this.deliveryStates = new Map();
        this.io = null;
    }

    setIO(io) {
        this.io = io;
    }

    clearRecipientCache(socketKey, recipient = null) {
        const prefix = recipient
            ? `${socketKey}:${recipient}`
            : `${socketKey}:`;

        for (const key of this.recipientJidCache.keys()) {
            if (recipient ? key === prefix : key.startsWith(prefix)) {
                this.recipientJidCache.delete(key);
            }
        }
    }

    markDeliveryState(messageId, status) {
        const id = String(messageId || '').trim();
        if (!id || !status) return;

        const rank = { sent: 1, delivered: 2, read: 3 };
        const current = this.deliveryStates.get(id);
        if (!current || (rank[status] || 0) >= (rank[current.status] || 0)) {
            this.deliveryStates.set(id, {
                status,
                updatedAt: Date.now()
            });
        }

        const waiters = this.deliveryWaiters.get(id) || [];
        if ((rank[status] || 0) >= rank.delivered && waiters.length > 0) {
            this.deliveryWaiters.delete(id);
            for (const waiter of waiters) {
                clearTimeout(waiter.timer);
                waiter.resolve(status);
            }
        }

        const cleanup = setTimeout(() => {
            const saved = this.deliveryStates.get(id);
            if (saved && Date.now() - saved.updatedAt >= 5 * 60 * 1000) {
                this.deliveryStates.delete(id);
            }
        }, 5 * 60 * 1000);
        cleanup.unref?.();
    }

    waitForDelivery(messageId, timeoutMs) {
        const id = String(messageId || '').trim();
        if (!id) return Promise.resolve(null);

        const current = this.deliveryStates.get(id);
        if (current && ['delivered', 'read'].includes(current.status)) {
            return Promise.resolve(current.status);
        }

        const waitMs = Math.max(1500, Math.min(Number(timeoutMs) || 9000, 30000));

        return new Promise((resolve) => {
            const waiter = {
                resolve,
                timer: setTimeout(() => {
                    const list = this.deliveryWaiters.get(id) || [];
                    const next = list.filter(item => item !== waiter);
                    if (next.length > 0) this.deliveryWaiters.set(id, next);
                    else this.deliveryWaiters.delete(id);

                    const latest = this.deliveryStates.get(id);
                    resolve(
                        latest && ['delivered', 'read'].includes(latest.status)
                            ? latest.status
                            : null
                    );
                }, waitMs)
            };

            waiter.timer.unref?.();
            const list = this.deliveryWaiters.get(id) || [];
            list.push(waiter);
            this.deliveryWaiters.set(id, list);
        });
    }

    emitStatus(wabaId, status, data = {}) {
        if (this.io) {
            this.io.emit('whatsapp:connection:update', {
                waba_id: wabaId,
                status: status,
                timestamp: new Date(),
                user_id: data.user_id || undefined,
                ...data
            });
        }
    }

    async resetConnectionSession(wabaId, options = {}) {
        const socketKey = String(wabaId || '');
        if (!socketKey) throw new Error('WABA ID is required');

        const deleteSession = options.deleteSession !== false;
        const socket = this.sockets.get(socketKey);

        const timer = this.reconnectTimers.get(socketKey);
        if (timer) clearTimeout(timer);
        this.reconnectTimers.delete(socketKey);
        this.reconnectAttempts.delete(socketKey);

        // Invalidate every late event from the old socket before closing it.
        this.connectionGenerations.set(
            socketKey,
            (this.connectionGenerations.get(socketKey) || 0) + 1
        );
        this.sockets.delete(socketKey);
        this.socketStates.delete(socketKey);
        this.clearRecipientCache(socketKey);

        try {
            socket?.end?.(new Error('Resetting WhatsApp connection for a fresh QR'));
        } catch (error) {
            console.warn(`Could not close WABA ${socketKey} before QR reset:`, error.message);
        }

        if (deleteSession) {
            const sessionDir = getBaileysSessionDir(socketKey);
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
                console.log(`Removed stale Baileys session for WABA ${socketKey}`);
            }
        }

        await WhatsappWaba.findByIdAndUpdate(wabaId, {
            is_active: true,
            deleted_at: null,
            connection_status: 'initial',
            qr_code: null
        });

        return { success: true, status: 'initial' };
    }

    async initializeConnection(userId, connectionData = null) {
        const wabaId = connectionData?._id || connectionData?.id;
        if (!wabaId) throw new Error('WABA ID is required for Baileys initialization');

        const socketKey = wabaId.toString();
        const sessionDir = getBaileysSessionDir(wabaId);

        if (this.sockets.has(socketKey)) {
            const existingSock = this.sockets.get(socketKey);
            const existingState = this.socketStates.get(socketKey);

            if (existingSock?.user?.id) {
                const activePhone = String(existingSock.user.id).split(':')[0].split('@')[0];
                console.log(`Live socket already active for WABA ${wabaId} (${activePhone})`);
                return { success: true, status: 'active', phone_number: activePhone };
            }

            // During QR display and the first connection handshake sock.user is
            // intentionally empty. QR polling used to mistake that valid socket
            // for a stale one and replace it every ~50 seconds.
            if (['starting', 'connecting', 'qrcode', 'restarting'].includes(existingState)) {
                console.log(`Connection already ${existingState} for WABA ${wabaId}; reusing generation ${this.connectionGenerations.get(socketKey) || 0}`);
                return { success: true, status: existingState };
            }

            console.log(`Removing genuinely stale socket for WABA ${wabaId} (state: ${existingState || 'unknown'})`);
            this.sockets.delete(socketKey);
            this.socketStates.delete(socketKey);
            try {
                existingSock?.end?.(new Error('Replacing stale WhatsApp socket'));
            } catch (error) {
                console.warn(`Could not close stale socket for WABA ${wabaId}:`, error.message);
            }
        }

        this.socketStates.set(socketKey, 'starting');

        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version, isLatest } = await fetchLatestBaileysVersion();

        const syncChat = connectionData.sync_chat;

        const sock = makeWASocket({
            version,
            printQRInTerminal: false,
            syncFullHistory: syncChat,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            logger,
            browser: ['Ubuntu', 'Chrome', '22.04.4'],
            markOnlineOnConnect: false,
            connectTimeoutMs: 60_000,
            defaultQueryTimeoutMs: 60_000,
            keepAliveIntervalMs: 15_000,
            retryRequestDelayMs: 1_000,
            emitOwnEvents: true,
            getMessage: async (key) => {
                return { conversation: 'Hello' };
            }
        });

        const generation = (this.connectionGenerations.get(socketKey) || 0) + 1;
        this.connectionGenerations.set(socketKey, generation);
        this.sockets.set(socketKey, sock);
        this.socketStates.set(socketKey, 'connecting');

        // Persist every credential update serially. Code 515 is WhatsApp asking
        // the client to restart immediately after pairing; reconnecting before
        // creds.json is flushed can lose the freshly paired session and show a
        // new QR again.
        let credentialsSaveChain = Promise.resolve();
        sock.ev.on('creds.update', () => {
            credentialsSaveChain = credentialsSaveChain.then(
                () => saveCreds(),
                () => saveCreds()
            ).catch((saveError) => {
                console.error(`Failed to save Baileys credentials for WABA ${wabaId}:`, saveError.message);
            });
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            // Events from a superseded socket must never change database status
            // or remove the newer socket belonging to this WABA.
            if (this.connectionGenerations.get(socketKey) !== generation || this.sockets.get(socketKey) !== sock) {
                if (connection || qr) {
                    console.log(`Ignoring stale connection event for WABA ${wabaId} (generation ${generation})`);
                }
                return;
            }

            if (qr) {
                this.socketStates.set(socketKey, 'qrcode');

                const waba = await WhatsappWaba.findById(wabaId);

                if (waba?.connection_status === 'connected') {

                    console.log(`Session invalidated for WABA ${wabaId} (was connected). QR required to re-authenticate.`);
                } else if (waba && waba.connection_status !== 'qrcode') {
                    console.log(`New QR generated for WABA ${wabaId}`);
                }

                const qrBase64 = await QRCode.toDataURL(qr);
                await WhatsappWaba.findByIdAndUpdate(wabaId, {
                    qr_code: qrBase64,
                    connection_status: 'qrcode'
                });

                this.emitStatus(wabaId, 'qrcode', { qr_code: qrBase64, session_expired: waba?.connection_status === 'connected' });
            }

            if (connection === 'close') {
                // Ignore late close events from an older socket. Without this guard,
                // an old socket can delete a newer healthy connection from the Map.
                const currentSocket = this.sockets.get(socketKey);
                const currentGeneration = this.connectionGenerations.get(socketKey);
                if (currentGeneration !== generation || (currentSocket && currentSocket !== sock)) {
                    console.log(`Ignoring stale close event for WABA ${wabaId} (generation ${generation})`);
                    return;
                }

                const error = lastDisconnect?.error;
                const errorCode = error?.output?.statusCode || error?.statusCode || error?.data?.statusCode || null;
                const errorMessage = error?.message || error?.toString?.() || 'Unknown disconnect';
                const registeredSession = Boolean(state?.creds?.registered || sock?.user?.id);
                const qrReferencesEnded = /QR refs attempts ended/i.test(errorMessage);

                // 408 means a normal request timeout for an authenticated session.
                // It is a QR timeout only before the account has been registered.
                const isQRTimeout = !registeredSession && qrReferencesEnded;
                const isLoggedOut = errorCode === DisconnectReason.loggedOut || errorCode === 401;
                const isConnectionReplaced = errorCode === DisconnectReason.connectionReplaced || errorCode === 440;
                const shouldReconnect = !isLoggedOut && !isQRTimeout && !isConnectionReplaced;

                this.socketStates.set(socketKey, errorCode === 515 ? 'restarting' : 'closed');

                console.log('[Baileys connection closed]', {
                    wabaId: socketKey,
                    phone: extractPhoneNumber(sock, connectionData, state),
                    errorCode,
                    errorMessage,
                    registeredSession,
                    isQRTimeout,
                    isLoggedOut,
                    isConnectionReplaced,
                    shouldReconnect,
                    generation
                });

                // Make sure the pairing credentials are physically written before
                // replacing a code-515 socket with the restarted connection.
                await credentialsSaveChain.catch(() => {});
                if (errorCode === 515) await delay(500);

                if (this.sockets.get(socketKey) === sock) {
                    this.sockets.delete(socketKey);
                }

                if (shouldReconnect) {
                    await WhatsappWaba.findByIdAndUpdate(wabaId, {
                        connection_status: 'reconnecting',
                        qr_code: null
                    });
                    this.emitStatus(wabaId, 'reconnecting', {
                        message: errorMessage,
                        code: errorCode,
                        transient: true
                    });

                    if (!this.reconnectTimers.has(socketKey)) {
                        const attempt = (this.reconnectAttempts.get(socketKey) || 0) + 1;
                        this.reconnectAttempts.set(socketKey, attempt);
                        // 515 is the expected post-QR restart, not a failure. Restart
                        // quickly after credentials have been saved; use backoff for
                        // ordinary network disconnects.
                        const reconnectDelay = errorCode === 515
                            ? 750
                            : Math.min(3_000 * (2 ** Math.min(attempt - 1, 3)), 30_000);

                        const timer = setTimeout(async () => {
                            this.reconnectTimers.delete(socketKey);
                            try {
                                const freshData = await WhatsappWaba.findById(wabaId).lean();
                                if (!freshData || freshData.deleted_at) return;
                                await this.initializeConnection(userId, {
                                    ...freshData,
                                    sync_chat: freshData.sync_chat ?? connectionData.sync_chat
                                });
                            } catch (reconnectError) {
                                console.error(`Reconnect failed for WABA ${wabaId}:`, reconnectError.message);
                                // Schedule another attempt without deleting valid credentials.
                                const freshData = await WhatsappWaba.findById(wabaId).lean().catch(() => null);
                                if (freshData && !freshData.deleted_at) {
                                    this.initializeConnection(userId, freshData).catch(err => {
                                        console.error(`Follow-up reconnect failed for WABA ${wabaId}:`, err.message);
                                    });
                                }
                            }
                        }, reconnectDelay);
                        timer.unref?.();
                        this.reconnectTimers.set(socketKey, timer);
                    }
                    return;
                }

                this.socketStates.delete(socketKey);
                this.reconnectAttempts.delete(socketKey);
                const pendingTimer = this.reconnectTimers.get(socketKey);
                if (pendingTimer) clearTimeout(pendingTimer);
                this.reconnectTimers.delete(socketKey);

                if (isConnectionReplaced) {
                    await WhatsappWaba.findByIdAndUpdate(wabaId, {
                        connection_status: 'connection_conflict',
                        qr_code: null
                    });
                    this.emitStatus(wabaId, 'connection_conflict', {
                        message: 'This WhatsApp account was opened by another WAPI connection or server instance.',
                        code: errorCode
                    });
                    console.error(`WABA ${wabaId} was replaced by another session. Remove duplicate connections for the same phone and reconnect once.`);
                    return;
                }

                if (isQRTimeout) {
                    console.log(`QR expired for WABA ${wabaId}; waiting for a fresh QR session.`);
                } else {
                    console.log(`Baileys logged out for WABA ${wabaId}. Cleaning up session and chat history...`);
                    try {
                        const phoneDoc = await WhatsappPhoneNumber.findOne({ waba_id: wabaId }).lean();
                        if (phoneDoc?._id) {
                            const { deletedCount } = await Message.deleteMany({
                                user_id: userId,
                                whatsapp_phone_number_id: phoneDoc._id
                            });
                            console.log(`Deleted ${deletedCount} messages for phone ${phoneDoc.display_phone_number} (WABA ${wabaId}) on logout.`);
                        }
                    } catch (delErr) {
                        console.error(`Error deleting messages on logout for WABA ${wabaId}:`, delErr.message);
                    }
                }

                await WhatsappWaba.findByIdAndUpdate(wabaId, {
                    connection_status: isQRTimeout ? 'qrcode' : 'disconnected',
                    qr_code: null
                });

                // Delete credentials only after a real logout or an expired,
                // never-registered QR. Never delete a valid session for code 408.
                if ((isLoggedOut || isQRTimeout) && fs.existsSync(sessionDir)) {
                    try {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                        console.log(`Deleted invalid session directory: ${sessionDir}`);
                    } catch (err) {
                        console.error(`Error deleting invalid session directory: ${err.message}`);
                    }
                }

                this.emitStatus(wabaId, isQRTimeout ? 'qr_timeout' : 'disconnected', {
                    message: errorMessage,
                    code: errorCode
                });

                if (isLoggedOut) {
                    const checkWaba = await WhatsappWaba.findById(wabaId).lean();
                    if (checkWaba && !checkWaba.deleted_at) {
                        setTimeout(() => {
                            this.initializeConnection(userId, checkWaba).catch(err => {
                                console.error(`Failed to generate a new QR for WABA ${wabaId}:`, err.message);
                            });
                        }, 3_000).unref?.();
                    }
                }
            } else if (connection === 'open') {
                // Ignore an open event from a superseded socket.
                if (this.sockets.get(socketKey) !== sock || this.connectionGenerations.get(socketKey) !== generation) {
                    console.log(`Ignoring stale open event for WABA ${wabaId} (generation ${generation})`);
                    return;
                }

                const pendingTimer = this.reconnectTimers.get(socketKey);
                if (pendingTimer) clearTimeout(pendingTimer);
                this.reconnectTimers.delete(socketKey);
                this.reconnectAttempts.delete(socketKey);

                this.socketStates.set(socketKey, 'connected');
                await credentialsSaveChain.catch(() => {});

                console.log(`Baileys connection opened for WABA ${wabaId}`);
                const userJid = String(sock.user?.id || state?.creds?.me?.id || '');
                const phoneNumber = extractPhoneNumber(sock, connectionData, state);

                if (!phoneNumber) {
                    console.warn(`Could not resolve the phone number for WABA ${wabaId}. User JID: ${userJid}`);
                }

                // Keep one connection per phone inside the same WAPI account. Old
                // duplicate records are silently archived instead of exposing the
                // confusing duplicate status to the dashboard.
                if (phoneNumber) {
                    const duplicatePhones = await WhatsappPhoneNumber.find({
                        user_id: userId,
                        display_phone_number: phoneNumber,
                        waba_id: { $ne: wabaId },
                        is_active: true
                    }).lean();

                    for (const duplicate of duplicatePhones) {
                        const duplicateWabaId = duplicate.waba_id?.toString();
                        if (!duplicateWabaId) continue;

                        const duplicateSocket = this.sockets.get(duplicateWabaId);
                        try {
                            duplicateSocket?.end?.(new Error(`Replacing old connection for ${phoneNumber}`));
                        } catch (duplicateError) {
                            console.warn(`Could not close old WABA ${duplicateWabaId}:`, duplicateError.message);
                        }
                        this.sockets.delete(duplicateWabaId);
                        this.socketStates.delete(duplicateWabaId);
                        this.connectionGenerations.delete(duplicateWabaId);

                        const duplicateTimer = this.reconnectTimers.get(duplicateWabaId);
                        if (duplicateTimer) clearTimeout(duplicateTimer);
                        this.reconnectTimers.delete(duplicateWabaId);
                        this.reconnectAttempts.delete(duplicateWabaId);

                        await WhatsappPhoneNumber.findByIdAndUpdate(duplicate._id, {
                            is_active: false
                        });
                        await WhatsappWaba.findByIdAndUpdate(duplicate.waba_id, {
                            is_active: false,
                            deleted_at: new Date(),
                            connection_status: 'disconnected',
                            qr_code: null
                        });

                        const duplicateSessionDir = getBaileysSessionDir(duplicateWabaId);
                        if (fs.existsSync(duplicateSessionDir)) {
                            try {
                                fs.rmSync(duplicateSessionDir, { recursive: true, force: true });
                            } catch (cleanupError) {
                                console.warn(`Could not remove old session ${duplicateWabaId}:`, cleanupError.message);
                            }
                        }

                        console.log(`Archived old WAPI connection ${duplicateWabaId} for ${phoneNumber}`);
                    }
                }

                await WhatsappWaba.findByIdAndUpdate(wabaId, {
                    is_active: true,
                    deleted_at: null,
                    connection_status: 'connected',
                    qr_code: null,
                    ...(phoneNumber ? {
                        display_phone_number: phoneNumber,
                        registred_phone_number: phoneNumber
                    } : {})
                });

                const phoneMatch = {
                    user_id: userId,
                    $or: [
                        { waba_id: wabaId },
                        ...(userJid ? [{ phone_number_id: userJid }] : []),
                        ...(phoneNumber ? [{ display_phone_number: phoneNumber }] : [])
                    ]
                };

                // Reuse the existing phone-number document when the same WhatsApp
                // account is paired again. Creating a new document can hit the
                // unique phone_number_id index and leave the dashboard stuck even
                // though the socket itself opened successfully.
                await WhatsappPhoneNumber.findOneAndUpdate(
                    phoneMatch,
                    {
                        $set: {
                            user_id: userId,
                            waba_id: wabaId,
                            phone_number_id: userJid,
                            ...(phoneNumber ? { display_phone_number: phoneNumber } : {}),
                            is_active: true,
                            deleted_at: null,
                            last_used_at: new Date()
                        }
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );

                this.emitStatus(wabaId, 'connected', {
                    phone_number: phoneNumber,
                    verified_live_socket: true,
                    generation
                });
            }
        });

        sock.ev.on('messages.upsert', async (m) => {
            if (m.type === 'append' || m.type === 'notify') {
                for (const msg of m.messages) {
                    await this.handleIncomingMessage(userId, wabaId, msg);
                }
            }
        });

        sock.ev.on('message-receipt.update', async (updates) => {
            for (const receipt of updates) {
                const waMessageId = receipt?.key?.id;
                console.log("receipt.receiptType", receipt.receiptType)
                const status = receipt.receiptType === 'read' ? 'read' : (receipt.receiptType === 'delivered' ? 'delivered' : null);

                if (!status) continue;

                this.markDeliveryState(waMessageId, status);
                console.log(`Baileys receipt: ${waMessageId} -> ${status}`);
                try {
                    const timestamp = new Date();
                    const updatedMessage = await updateWhatsAppStatus(waMessageId, status, timestamp);

                    if (updatedMessage) {
                        await automationEngine.triggerEvent("status_update", {
                            waMessageId: waMessageId,
                            status: status,
                            timestamp: timestamp,
                            recipientId: receipt.key.remoteJid,
                            messageId: updatedMessage._id.toString(),
                            userId: updatedMessage.user_id?.toString()
                        });
                    }
                } catch (err) { }
            }
        });

        sock.ev.on('messages.update', async (updates) => {
            for (const update of updates) {
                if (update.update.status) {
                    const waMessageId = update?.key?.id;
                    let status = null;
                    console.log("update.update.status", update.update.status)

                    if (update.update.status === 2) status = 'sent';
                    else if (update.update.status === 3) status = 'delivered';
                    else if (update.update.status === 4) status = 'read';

                    if (status) {
                        this.markDeliveryState(waMessageId, status);
                        console.log(`Baileys status update: ${waMessageId} -> ${status}`);
                        try {
                            const timestamp = new Date();
                            const updatedMessage = await updateWhatsAppStatus(waMessageId, status, timestamp);
                            if (updatedMessage) {
                                await automationEngine.triggerEvent("status_update", {
                                    waMessageId: waMessageId,
                                    status: status,
                                    timestamp: timestamp,
                                    recipientId: update.key.remoteJid,
                                    messageId: updatedMessage._id.toString(),
                                    userId: updatedMessage.user_id?.toString()
                                });
                            }
                        } catch (err) { }
                    }
                }
            }
        });

        sock.ev.on('messaging-history.set', async (data) => {
            if (!syncChat) {
                console.log(`History sync skipped for WABA ${wabaId} (sync_chat=false)`);
                return;
            }
            setTimeout(() => {
                this.processHistorySync(userId, wabaId, data).catch(err => {
                    console.error('Background history sync failed:', err);
                });
            }, 100);
        });

        return { success: true };
    }

    async handleIncomingMessage(userId, wabaId, msg) {
        try {

            const remoteJid = msg.key.remoteJid;

            if (!remoteJid ||
                remoteJid === 'status@broadcast' ||
                remoteJid.endsWith('@broadcast') ||
                remoteJid.endsWith('@g.us')) {
                return;
            }

            if (!msg.message) {
                return;
            }

            const firstMsgKey = Object.keys(msg.message)[0];
            const INTERNAL_MSG_TYPES = [
                'protocolMessage',
                'senderKeyDistributionMessage',
                'appStateSyncKeyShare',
                'appStateSyncKeyRequest',
                'messageContextInfo',
                'requestPhoneNumberMessage',
                'reactionMessage'
            ];
            const isInternalType = INTERNAL_MSG_TYPES.slice(0, -1).includes(firstMsgKey); 
            if (isInternalType) {
                return;
            }

            const senderJid = msg.key.remoteJidAlt || remoteJid;

            if (!senderJid.endsWith('@s.whatsapp.net')) {
                return;
            }

            const senderNumber = senderJid.split('@')[0];
            const fromMe = msg.key.fromMe;
            const phone = await WhatsappPhoneNumber.findOne({ waba_id: wabaId });
            const myNumber = phone?.display_phone_number;


            if (fromMe) {
                const sock = this.sockets.get(wabaId.toString());
                const myJidNumber = sock?.user?.id?.split(':')[0]?.split('@')[0];
                const isSelfEcho = (myJidNumber && senderNumber === myJidNumber) ||
                    (myNumber && senderNumber === myNumber);
                if (isSelfEcho) {
                    return;
                }
            }

            const existingMessage = await Message.findOne({ wa_message_id: msg?.key?.id });
            if (existingMessage) {
                return;
            }

            let contact = await Contact.findOne({ phone_number: senderNumber, created_by: userId });
            if (!contact) {
                contact = await Contact.create({
                    phone_number: senderNumber,
                    name: msg.pushName || senderNumber,
                    user_id: userId,
                    created_by: userId,
                    source: 'baileys'
                });
            }

            const unwrapped = this.unwrapMessage(msg.message);
            const messageType = this.getBaileysMessageType(unwrapped);
            const content = this.getBaileysMessageContent(unwrapped, messageType);

            let replyMessageId = unwrapped?.extendedTextMessage?.contextInfo?.stanzaId || null;
            let reactionMessageId = null;

            if (messageType === 'reaction') {
                reactionMessageId = unwrapped?.reactionMessage?.key?.id || null;
            }

            let fileUrl = null;
            if (['image', 'video', 'audio', 'document'].includes(messageType)) {
                fileUrl = await this.downloadMedia(wabaId, unwrapped, messageType);
            }

            const messageDoc = await Message.create({
                sender_number: fromMe ? myNumber : senderNumber,
                recipient_number: fromMe ? senderNumber : myNumber,
                user_id: userId,
                contact_id: contact._id,
                whatsapp_phone_number_id: phone?._id || null,
                content: content,
                message_type: messageType,
                file_url: fileUrl,
                from_me: fromMe,
                direction: fromMe ? 'outbound' : 'inbound',
                wa_message_id: msg?.key?.id,
                wa_jid: senderJid,
                wa_timestamp: new Date(msg.messageTimestamp * 1000),
                provider: 'baileys',
                interactive_data: messageType === 'location' ? {
                    location: {
                        latitude: unwrapped.locationMessage?.degreesLatitude,
                        longitude: unwrapped.locationMessage?.degreesLongitude,
                        name: unwrapped.locationMessage?.name,
                        address: unwrapped.locationMessage?.address
                    }
                } : null,
                reply_message_id: replyMessageId,
                reaction_message_id: reactionMessageId
            });

            if (this.io) {
                try {
                    const populatedMessage = await Message.findById(messageDoc._id)
                        .populate({
                            path: 'template_id',
                            select: 'template_name language category status message_body body_variables header footer_text buttons meta_template_id'
                        })
                        .lean();

                    const formattedMessage = {
                        id: populatedMessage._id.toString(),
                        content: populatedMessage.content,
                        interactiveData: populatedMessage.interactive_data,
                        messageType: populatedMessage.message_type,
                        fileUrl: populatedMessage.file_url || null,
                        template: populatedMessage.template_id || null,
                        createdAt: populatedMessage.wa_timestamp,
                        can_chat: true,
                        delivered_at: populatedMessage.delivered_at || null,
                        delivery_status: populatedMessage.delivery_status || 'pending',
                        is_delivered: populatedMessage.is_delivered || false,
                        is_seen: populatedMessage.is_seen || false,
                        seen_at: populatedMessage.seen_at || null,
                        wa_status: populatedMessage.wa_status || null,
                        wa_message_id: populatedMessage.wa_message_id || null,
                        direction: populatedMessage.direction || null,
                        reply_message_id: populatedMessage.reply_message_id || null,
                        reaction_message_id: populatedMessage.reaction_message_id || null,
                        sender: {
                            id: populatedMessage.sender_number,
                            name: populatedMessage.sender_number
                        },
                        recipient: {
                            id: populatedMessage.recipient_number,
                            name: populatedMessage.recipient_number
                        },
                        user_id: populatedMessage.user_id?.toString(),
                        whatsapp_phone_number_id: phone?._id?.toString()
                    };

                    if (formattedMessage.reply_message_id) {
                        const replyMsg = await Message.findOne({ wa_message_id: formattedMessage.reply_message_id }).lean();
                        if (replyMsg) {
                            formattedMessage.reply_message = {
                                id: replyMsg._id.toString(),
                                content: replyMsg.content,
                                interactiveData: replyMsg.interactive_data,
                                messageType: replyMsg.message_type,
                                fileUrl: replyMsg.file_url || null,
                                template: replyMsg.template_id || null,
                                createdAt: replyMsg.wa_timestamp,
                                wa_message_id: replyMsg.wa_message_id || null,
                                direction: replyMsg.direction || null,
                                sender: {
                                    id: replyMsg.sender_number,
                                    name: replyMsg.sender_number
                                }
                            };
                        }
                    }

                    this.io.emit('whatsapp:message', formattedMessage);
                } catch (socketError) {
                    console.error('Error emitting socket message for Baileys:', socketError);
                }
            }

            if (!fromMe) {
                try {
                    await automationEngine.triggerEvent("message_received", {
                        message: content,
                        senderNumber: senderNumber,
                        recipientNumber: myNumber,
                        messageType: messageType,
                        userId: userId.toString(),
                        whatsappPhoneNumberId: phone?._id?.toString(),
                        waMessageId: msg?.key?.id,
                        waJid: senderJid,
                        contactId: contact._id.toString(),
                        timestamp: new Date(msg.messageTimestamp * 1000),
                    });
                } catch (automationError) {
                    console.error('Error triggering automation engine:', automationError);
                }

                try {
                    const config = await WabaConfiguration.findOne({ waba_id: wabaId });

                    contact.last_incoming_message_at = new Date();
                    if (!contact.user_id) {
                        contact.user_id = userId;
                    }
                    await contact.save();

                    let automatedHandled = false;

                    const open = await isWithinWorkingHours(wabaId);
                    console.log("open0", open, config)
                    if (!open && config?.out_of_working_hours?.id) {
                        await sendAutomatedReply({
                            wabaId,
                            contactId: contact._id,
                            replyType: config.out_of_working_hours.type,
                            replyId: config.out_of_working_hours.id,
                            senderNumber: senderNumber,
                            incomingText: content,
                            userId: userId,
                            whatsappPhoneNumberId: phone?._id
                        });
                        automatedHandled = true;
                    }

                    if (!automatedHandled) {
                        const matchingBot = await findMatchingBot(wabaId, content);
                        if (matchingBot) {
                            await sendAutomatedReply({
                                wabaId,
                                contactId: contact._id,
                                replyType: matchingBot.reply_type,
                                replyId: matchingBot.reply_id,
                                senderNumber: senderNumber,
                                incomingText: content,
                                userId: userId,
                                whatsappPhoneNumberId: phone?._id
                            });
                            automatedHandled = true;
                        }
                    }

                    const isNewContact = (Date.now() - new Date(contact.created_at).getTime() < 10000);
                    if (!automatedHandled && isNewContact) {
                        if (config?.welcome_message?.id) {
                            await sendAutomatedReply({
                                wabaId,
                                contactId: contact._id,
                                replyType: config.welcome_message.type,
                                replyId: config.welcome_message.id,
                                senderNumber: senderNumber,
                                incomingText: content,
                                userId: userId,
                                whatsappPhoneNumberId: phone?._id
                            });
                            automatedHandled = true;
                        }

                        if (config?.round_robin_assignment) {
                            await assignRoundRobin(userId, contact._id, phone?._id);
                        }
                    }

                    if (!automatedHandled && config?.fallback_message?.id) {
                        await sendAutomatedReply({
                            wabaId,
                            contactId: contact._id,
                            replyType: config.fallback_message.type,
                            replyId: config.fallback_message.id,
                            senderNumber: senderNumber,
                            incomingText: content,
                            userId: userId,
                            whatsappPhoneNumberId: phone?._id
                        });
                    }
                } catch (autoErr) {
                    console.error('Error in advanced automated handling for Baileys:', autoErr);
                }
            }
        } catch (error) {
            console.error('Error handling Baileys incoming message:', error);
        }
    }

    unwrapMessage(message) {
        if (!message) return message;
        if (message.ephemeralMessage) return this.unwrapMessage(message.ephemeralMessage.message);
        if (message.viewOnceMessage) return this.unwrapMessage(message.viewOnceMessage.message);
        if (message.viewOnceMessageV2) return this.unwrapMessage(message.viewOnceMessageV2.message);
        return message;
    }

    getBaileysMessageType(message) {
        if (!message) return 'text';
        const type = Object.keys(message)[0];
        if (type === 'conversation' || type === 'extendedTextMessage') return 'text';
        if (type === 'imageMessage') return 'image';
        if (type === 'videoMessage') return 'video';
        if (type === 'audioMessage') return 'audio';
        if (type === 'documentMessage') return 'document';
        if (type === 'locationMessage') return 'location';
        if (type === 'reactionMessage') return 'reaction';
        return 'text';
    }

    getBaileysMessageContent(message, type) {
        if (!message) return '';
        if (type === 'text') return message.conversation || message.extendedTextMessage?.text || '';
        if (type === 'image') return message.imageMessage?.caption || '';
        if (type === 'video') return message.videoMessage?.caption || '';
        if (type === 'document') return message.documentMessage?.caption || '';
        if (type === 'location') {
            const loc = message.locationMessage;
            return `Location: ${loc.name || ''} ${loc.address || ''} (${loc.degreesLatitude}, ${loc.degreesLongitude})`.trim();
        }
        if (type === 'reaction') {
            return message.reactionMessage?.text || '';
        }
        return '';
    }



    async resolveRecipientJid(sock, socketKey, cleanRecipient) {
        const cacheKey = `${socketKey}:${cleanRecipient}`;
        const cached = this.recipientJidCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return {
                ...cached,
                source: 'cache'
            };
        }

        const requestedJid = `${cleanRecipient}@s.whatsapp.net`;
        const previous = this.recipientLookupChains.get(socketKey) || Promise.resolve();

        const lookupTask = previous.catch(() => {}).then(async () => {
            const foundJids = [];
            let lastLookup = null;
            let lastError = null;
            let completedLookup = false;

            const addJid = (value) => {
                const jid = typeof value === 'string'
                    ? value
                    : (typeof value?.jid === 'string' ? value.jid : null);

                if (!jid) return;
                if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) return;
                if (!foundJids.includes(jid)) foundJids.push(jid);
            };

            if (typeof sock.onWhatsApp === 'function') {
                // Baileys versions differ: some expect the complete PN JID and
                // others accept digits. Try both for this exact recipient.
                const lookupInputs = [requestedJid, cleanRecipient];

                for (const lookupInput of lookupInputs) {
                    for (let attempt = 1; attempt <= 2; attempt += 1) {
                        try {
                            const lookup = await sock.onWhatsApp(lookupInput);
                            completedLookup = true;
                            lastLookup = lookup;

                            const rows = Array.isArray(lookup)
                                ? lookup
                                : (lookup ? [lookup] : []);

                            rows
                                .filter(item => item?.exists === true && item?.jid)
                                .forEach(item => addJid(item.jid));

                            if (foundJids.length > 0) break;
                        } catch (error) {
                            lastError = error;
                        }

                        if (attempt < 2) await delay(600 * attempt);
                    }

                    if (foundJids.length > 0) break;
                }
            }

            const verified = foundJids.length > 0;

            // A completed lookup with no matching account is an actual recipient
            // failure. Do not create a fake submitted-success response.
            if (completedLookup && !verified && !lastError) {
                const error = new Error(
                    `Recipient +${cleanRecipient} is not registered or could not be verified on WhatsApp.`
                );
                error.code = 'RECIPIENT_NOT_ON_WHATSAPP';
                throw error;
            }

            const exactJid = foundJids[0] || null;
            let phoneJid = foundJids.find(jid => jid.endsWith('@s.whatsapp.net')) || requestedJid;
            let lidJid = foundJids.find(jid => jid.endsWith('@lid')) || null;

            // Resolve the modern LID address for this same phone number. Keep the
            // exact onWhatsApp result first because it is the address WhatsApp
            // verified for this recipient.
            try {
                const getLIDForPN = sock?.signalRepository?.lidMapping?.getLIDForPN;
                if (typeof getLIDForPN === 'function') {
                    const mapped = await getLIDForPN.call(
                        sock.signalRepository.lidMapping,
                        phoneJid
                    );
                    const mappedJid = typeof mapped === 'string'
                        ? mapped
                        : (typeof mapped?.jid === 'string' ? mapped.jid : null);
                    if (mappedJid?.endsWith('@lid')) lidJid = mappedJid;
                }
            } catch (error) {
                lastError = lastError || error;
            }

            const requestedMode = String(
                process.env.WAPI_OUTBOUND_ADDRESSING_MODE || 'auto'
            ).trim().toLowerCase();

            const candidateJids = [];
            const addCandidate = (jid) => {
                if (!jid) return;
                if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) return;
                if (!candidateJids.includes(jid)) candidateJids.push(jid);
            };

            // Always trust the exact verified address first. The environment mode
            // only controls the order of the remaining mapped fallbacks.
            addCandidate(exactJid);

            if (requestedMode === 'lid') {
                addCandidate(lidJid);
                addCandidate(phoneJid);
            } else {
                // auto and legacy "pn" mode both keep a PN fallback, but no longer
                // override an exact verified LID returned for a specific customer.
                addCandidate(phoneJid);
                addCandidate(lidJid);
            }

            if (candidateJids.length === 0) addCandidate(requestedJid);

            const resolved = {
                jid: candidateJids[0],
                fallbackJid: candidateJids[1] || null,
                candidateJids,
                phoneJid,
                lidJid,
                verified,
                source: verified
                    ? (exactJid?.endsWith('@lid') ? 'onWhatsApp_lid' : 'onWhatsApp_phone')
                    : 'direct_phone_fallback',
                lookup: lastLookup,
                lookupError: lastError?.message || null
            };

            // Only verified mappings are cached. Failed or unavailable lookups are
            // retried fresh on the next customer instead of poisoning later sends.
            if (verified) {
                this.recipientJidCache.set(cacheKey, {
                    ...resolved,
                    expiresAt: Date.now() + 10 * 60 * 1000
                });
            } else {
                this.recipientJidCache.delete(cacheKey);
                console.warn('[Baileys recipient verification unavailable]', {
                    wabaId: socketKey,
                    recipient: cleanRecipient,
                    candidates: candidateJids,
                    error: lastError?.message || null
                });
            }

            return resolved;
        });

        this.recipientLookupChains.set(socketKey, lookupTask);
        try {
            return await lookupTask;
        } finally {
            if (this.recipientLookupChains.get(socketKey) === lookupTask) {
                this.recipientLookupChains.delete(socketKey);
            }
        }
    }

    async enqueueSocketSend(socketKey, task) {
        const previous = this.sendChains.get(socketKey) || Promise.resolve();
        const current = previous.catch(() => {}).then(async () => {
            const configuredDelay = Number.parseInt(process.env.BAILEYS_SEND_DELAY_MS || '650', 10);
            const minimumDelay = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : 650;
            const lastSentAt = this.lastSendAt.get(socketKey) || 0;
            const remaining = minimumDelay - (Date.now() - lastSentAt);
            if (remaining > 0) await delay(remaining);

            try {
                return await task();
            } finally {
                this.lastSendAt.set(socketKey, Date.now());
            }
        });

        this.sendChains.set(socketKey, current);
        try {
            return await current;
        } finally {
            if (this.sendChains.get(socketKey) === current) {
                this.sendChains.delete(socketKey);
            }
        }
    }

    async sendMessage(userId, params, connection = null) {
        if (!connection) throw new Error('WhatsApp connection is required');

        const wabaId = connection._id || connection.id;
        if (!wabaId) throw new Error('WABA ID is required');

        const socketKey = wabaId.toString();
        let sock = this.sockets.get(socketKey);

        // A socket object can remain in memory after the real WhatsApp session died.
        // Never send through a stale socket just because it exists in the Map.
        if (!sock?.user) {
            if (sock) this.sockets.delete(socketKey);

            await this.initializeConnection(userId, connection);
            let attempts = 0;
            while (attempts < 15) {
                sock = this.sockets.get(socketKey);
                if (sock?.user) break;
                await delay(1000);
                attempts += 1;
            }
        }

        if (!sock?.user) {
            throw new Error('WhatsApp is not actually connected. Reconnect by QR and try again.');
        }

        const { recipientNumber, messageText, messageType: messageTypeInput, mediaUrl, templateId } = params;
        const cleanRecipient = normalizeWhatsAppNumber(recipientNumber, { defaultCountryCode: process.env.WAPI_DEFAULT_COUNTRY_CODE || '93' });
        if (!isValidWhatsAppNumber(cleanRecipient)) {
            throw new Error(`Invalid recipient phone number: ${recipientNumber}`);
        }

        const recipientResolution = await this.resolveRecipientJid(sock, socketKey, cleanRecipient);
        const jid = recipientResolution.jid;

        console.log('[Baileys recipient resolution]', {
            wabaId: socketKey,
            sender: String(sock.user?.id || '').split(':')[0].split('@')[0] || null,
            recipient: cleanRecipient,
            jid,
            verified: recipientResolution.verified,
            source: recipientResolution.source
        });

        console.log(`Baileys sending message to ${cleanRecipient}: type=${messageTypeInput}, mediaUrl=${mediaUrl}`);
        const messageType = messageTypeInput || (mediaUrl ? this.getMediaTypeFromUrl(mediaUrl) : 'text');

        let result;
        let usedJid = jid;
        let deliveryStatus = null;
        let deliveryConfirmed = false;
        let fallbackAttempted = false;
        let attemptedJids = [];
        let resultAttemptMetadata = [];
        const isUrl = mediaUrl && mediaUrl.startsWith('http');
        const isLocalFile = mediaUrl && !isUrl && (mediaUrl.includes('/') || mediaUrl.includes('\\')) && fs.existsSync(mediaUrl);

        const buildSendOptions = (targetJid, messageIdOverride = null) => {
            const options = {};
            if (messageIdOverride) options.messageId = messageIdOverride;
            if (params.replyMessageId) {
                options.quoted = {
                    key: {
                        id: params.replyMessageId,
                        remoteJid: targetJid,
                        fromMe: false
                    },
                    message: { conversation: '' }
                };
            }
            return options;
        };

        const submitToJid = async (targetJid, messageIdOverride = null) => {
            const sendOptions = buildSendOptions(targetJid, messageIdOverride);
            if (messageType === 'text' || (!isUrl && !isLocalFile && mediaUrl)) {
                const textToSend = messageText || (mediaUrl && !isUrl && !isLocalFile ? mediaUrl : '');
                return sock.sendMessage(targetJid, { text: textToSend }, sendOptions);
            }
            if (messageType === 'image') {
                return sock.sendMessage(targetJid, { image: { url: mediaUrl }, caption: messageText }, sendOptions);
            }
            if (messageType === 'video') {
                return sock.sendMessage(targetJid, { video: { url: mediaUrl }, caption: messageText }, sendOptions);
            }
            if (messageType === 'audio') {
                return sock.sendMessage(targetJid, { audio: { url: mediaUrl }, mimetype: 'audio/mp4' }, sendOptions);
            }
            if (messageType === 'document') {
                const fileName = this.getFileNameFromUrl(mediaUrl);
                return sock.sendMessage(targetJid, { document: { url: mediaUrl }, fileName, caption: messageText }, sendOptions);
            }
            if (messageType === 'location' && params.locationParams) {
                return sock.sendMessage(targetJid, {
                    location: {
                        degreesLatitude: params.locationParams.latitude,
                        degreesLongitude: params.locationParams.longitude,
                        name: params.locationParams.name,
                        address: params.locationParams.address
                    }
                }, sendOptions);
            }
            if (messageType === 'reaction') {
                return sock.sendMessage(targetJid, {
                    react: {
                        text: params.reactionEmoji,
                        key: {
                            id: params.reactionMessageId,
                            remoteJid: targetJid,
                            fromMe: false
                        }
                    }
                });
            }
            throw new Error(`Unsupported message type "${messageType}"`);
        };

        result = await this.enqueueSocketSend(socketKey, async () => {
            // WhatsApp's documented personal-address form is PN. Some accounts,
            // however, now require their verified LID identity. Try PN first and
            // only move to the next unique address when WhatsApp does not produce
            // a delivered/read receipt.
            const candidateJids = Array.from(new Set(
                [
                    recipientResolution.jid,
                    ...(recipientResolution.candidateJids || []),
                    recipientResolution.fallbackJid,
                    recipientResolution.phoneJid,
                    recipientResolution.lidJid
                ].filter(Boolean)
            ));

            const configuredWait = Number.parseInt(
                process.env.WAPI_DELIVERY_WAIT_MS || '9000',
                10
            );
            const deliveryWaitMs = Number.isFinite(configuredWait)
                ? Math.max(2500, Math.min(configuredWait, 30000))
                : 9000;

            let firstSubmittedAttempt = null;
            let lastSubmittedAttempt = null;
            const submittedAttempts = [];
            const errors = [];

            for (let index = 0; index < candidateJids.length; index += 1) {
                const targetJid = candidateJids[index];
                attemptedJids.push(targetJid);
                fallbackAttempted = index > 0;

                try {
                    usedJid = targetJid;

                    const attemptMessageId = generateMessageIDV2(sock.user?.id);

                    console.log('[Baileys delivery-aware send attempt]', {
                        wabaId: socketKey,
                        recipient: cleanRecipient,
                        targetJid,
                        attempt: index + 1,
                        candidates: candidateJids.length,
                        messageId: attemptMessageId
                    });

                    const submitted = await submitToJid(targetJid, attemptMessageId);
                    const submittedId =
                        submitted?.key?.id ||
                        submitted?.message?.key?.id ||
                        attemptMessageId;

                    const submittedAttempt = {
                        result: submitted,
                        jid: targetJid,
                        messageId: submittedId
                    };

                    submittedAttempts.push({
                        jid: targetJid,
                        message_id: submittedId
                    });

                    if (!firstSubmittedAttempt) {
                        firstSubmittedAttempt = submittedAttempt;
                    }
                    lastSubmittedAttempt = submittedAttempt;

                    const receipt = await this.waitForDelivery(
                        submittedId,
                        deliveryWaitMs
                    );

                    if (receipt) {
                        deliveryStatus = receipt;
                        deliveryConfirmed = true;
                        console.log('[Baileys delivery confirmed]', {
                            recipient: cleanRecipient,
                            targetJid,
                            messageId: submittedId,
                            status: receipt
                        });
                        usedJid = targetJid;
                        resultAttemptMetadata = submittedAttempts;
                        return submitted;
                    }

                    console.warn('[Baileys no delivery receipt; trying alternate address if available]', {
                        recipient: cleanRecipient,
                        targetJid,
                        messageId: submittedId,
                        waitMs: deliveryWaitMs,
                        hasAlternate: index < candidateJids.length - 1
                    });
                } catch (sendError) {
                    errors.push({
                        jid: targetJid,
                        error: sendError?.message || String(sendError)
                    });

                    console.warn('[Baileys recipient address send failed]', {
                        recipient: cleanRecipient,
                        targetJid,
                        error: sendError?.message || String(sendError)
                    });
                }
            }

            if (lastSubmittedAttempt) {
                usedJid = lastSubmittedAttempt.jid;
                resultAttemptMetadata = submittedAttempts;
                this.clearRecipientCache(socketKey, cleanRecipient);
                return lastSubmittedAttempt.result;
            }

            this.clearRecipientCache(socketKey, cleanRecipient);
            const details = errors
                .map(item => `${item.jid}: ${item.error}`)
                .join(' | ');

            throw new Error(
                `WhatsApp rejected every resolved address for +${cleanRecipient}. ${details}`
            );
        });


        if (!result) {
            throw new Error(`Failed to send message: result undefined for type "${messageType}"`);
        }


        const liveSenderNumber = extractPhoneNumber(sock, connection, null);
        let phoneRecord = await WhatsappPhoneNumber.findOne({ waba_id: wabaId }).lean();

        // The live Baileys socket is the source of truth. Repair stale phone
        // metadata so the API never reports a different sender than the account
        // that actually submitted the message.
        if (liveSenderNumber && phoneRecord?.display_phone_number !== liveSenderNumber) {
            phoneRecord = await WhatsappPhoneNumber.findOneAndUpdate(
                { waba_id: wabaId },
                {
                    $set: {
                        user_id: userId,
                        phone_number_id: sock.user.id,
                        display_phone_number: liveSenderNumber,
                        is_active: true
                    }
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            ).lean();

            await WhatsappWaba.findByIdAndUpdate(wabaId, {
                display_phone_number: liveSenderNumber,
                registred_phone_number: liveSenderNumber,
                connection_status: 'connected'
            });
        }

        const myNumber = liveSenderNumber || phoneRecord?.display_phone_number || connection.display_phone_number || connection.registred_phone_number;
        const contact = await Contact.findOne({ phone_number: cleanRecipient, created_by: userId });

        const waMessageId = result?.key?.id || result?.message?.key?.id;
        if (!waMessageId) {
            throw new Error('Baileys returned no real WhatsApp message ID. The message was not confirmed as sent.');
        }

        const savedMessage = await Message.create({
            sender_number: myNumber,
            recipient_number: cleanRecipient,
            user_id: userId,
            contact_id: contact?._id,
            whatsapp_phone_number_id: phoneRecord?._id || null,
            content: messageText,
            message_type: messageType,
            file_url: mediaUrl,
            from_me: true,
            direction: 'outbound',
            wa_message_id: waMessageId,
            wa_jid: usedJid,
            wa_timestamp: new Date(),
            provider: 'baileys',
            delivery_status: deliveryConfirmed ? deliveryStatus : 'submitted',
            is_delivered: deliveryConfirmed,
            delivered_at: deliveryConfirmed ? new Date() : null,
            is_seen: deliveryStatus === 'read',
            seen_at: deliveryStatus === 'read' ? new Date() : null,
            interactive_data: messageType === 'location' ? {
                location: params.locationParams
            } : null,
            reply_message_id: params.replyMessageId || null,
            reaction_message_id: params.reactionMessageId || null,
            template_id: templateId || null,
            metadata: result || null
        });

        return {
            id: savedMessage._id,
            messageId: savedMessage._id,
            waMessageId,
            status: deliveryConfirmed ? deliveryStatus : 'submitted',
            submission_status: 'submitted',
            delivery_confirmed: deliveryConfirmed,
            delivery_status: deliveryConfirmed ? deliveryStatus : 'submitted',
            fallback_attempted: fallbackAttempted,
            attempted_jids: attemptedJids,
            submitted_attempts: resultAttemptMetadata,
            recipient_verified: recipientResolution.verified,
            recipient_resolution_source: recipientResolution.source,
            sender_number: myNumber,
            recipient_number: cleanRecipient,
            jid: usedJid,
            phone_jid: recipientResolution.phoneJid,
            lid_jid: recipientResolution.lidJid,
            addressing_mode: usedJid?.endsWith('@lid') ? 'lid' : 'phone',
            requested_addressing_mode: String(process.env.WAPI_OUTBOUND_ADDRESSING_MODE || 'auto').toLowerCase(),
            recipient_candidate_jids: recipientResolution.candidateJids || [usedJid],
            is_delivered: deliveryConfirmed,
            is_seen: deliveryStatus === 'read'
        };
    }

    async getQRCode(userId, connection = null) {
        if (!connection) throw new Error('Connection not found');
        return {
            success: true,
            qr_code: connection.qr_code,
            status: connection.connection_status
        };
    }

    async getConnectionStatus(userId, connection = null) {
        if (!connection) {
            return { connected: false, status: 'not_configured', runtime_state: 'missing' };
        }

        const wabaId = String(connection._id || connection.id || '');
        const sock = this.sockets.get(wabaId);
        const runtimeState = this.socketStates.get(wabaId) || 'idle';
        const livePhone = extractPhoneNumber(sock, connection, null);
        const liveConnected = Boolean(sock?.user?.id && runtimeState === 'connected');

        if (liveConnected) {
            return {
                connected: true,
                status: 'connected',
                runtime_state: runtimeState,
                phone_number: livePhone,
                verified_live_socket: true
            };
        }

        const transientStates = new Set(['starting', 'connecting', 'qrcode', 'restarting', 'reconnecting']);
        if (transientStates.has(runtimeState)) {
            return {
                connected: false,
                status: runtimeState === 'restarting' ? 'reconnecting' : runtimeState,
                runtime_state: runtimeState,
                phone_number: livePhone,
                verified_live_socket: false
            };
        }

        const storedStatus = String(connection.connection_status || 'unknown');
        return {
            connected: false,
            // A database value of connected is not enough after a process restart;
            // only a live authenticated socket is reported as connected.
            status: storedStatus === 'connected' ? 'reconnecting' : storedStatus,
            stored_status: storedStatus,
            runtime_state: runtimeState,
            phone_number: livePhone,
            verified_live_socket: false
        };
    }

    async getMessages(userId, contactNumber, connection = null, options = {}) {

        const myNumber = connection.display_phone_number;

        const baseCondition = {
            $or: [
                { sender_number: contactNumber, recipient_number: myNumber, deleted_at: null },
                { sender_number: myNumber, recipient_number: contactNumber, deleted_at: null }
            ],
            user_id: userId
        };

        const query = { ...baseCondition };
        if (options.search) {
            query.content = { $regex: options.search, $options: 'i' };
        }

        const messages = await Message.find(query)
            .sort({ wa_timestamp: 1 })
            .populate('user_id', 'name')
            .lean();

        return messages;
    }

    async getRecentChats(userId, connection = null) {
        const myNumber = connection.registred_phone_number;
        const sentMessages = await Message.distinct('recipient_number', {
            sender_number: myNumber,
            recipient_number: { $ne: null },
            deleted_at: null
        });

        const receivedMessages = await Message.distinct('sender_number', {
            recipient_number: myNumber,
            sender_number: { $ne: null },
            deleted_at: null
        });

        const numbers = [...new Set([...sentMessages, ...receivedMessages])].filter(n => n && n !== myNumber);

        const chats = await Promise.all(numbers.map(async (num) => {
            const lastMessage = await Message.findOne({
                $or: [
                    { sender_number: myNumber, recipient_number: num },
                    { sender_number: num, recipient_number: myNumber }
                ],
                deleted_at: null
            }).sort({ wa_timestamp: -1 }).lean();

            let contact = await Contact.findOne({ phone_number: num, created_by: userId });

            return {
                contact: {
                    id: contact?._id,
                    number: num,
                    name: contact?.name || num,
                    avatar: null
                },
                lastMessage: lastMessage ? {
                    id: lastMessage._id,
                    content: lastMessage.content,
                    messageType: lastMessage.message_type,
                    direction: lastMessage.direction,
                    fromMe: lastMessage.from_me,
                    createdAt: lastMessage.wa_timestamp
                } : null
            };
        }));

        return chats.sort((a, b) => (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0));
    }

    getMediaTypeFromUrl(url) {
        if (!url) return 'text';

        if (!url.startsWith('http') && !url.includes('/') && !url.includes('\\') && !url.includes('.')) {
            return 'text';
        }

        const extension = url.split('.').pop().toLowerCase().split('?')[0];
        const imageExtensions = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
        const videoExtensions = ['mp4', 'mov', 'avi', 'mkv'];
        const audioExtensions = ['mp3', 'ogg', 'wav', 'm4a', 'aac'];

        if (imageExtensions.includes(extension)) return 'image';
        if (videoExtensions.includes(extension)) return 'video';
        if (audioExtensions.includes(extension)) return 'audio';

        if (url.includes('.') || url.startsWith('http')) {
            return 'document';
        }

        return 'text';
    }

    async downloadMedia(wabaId, message, type, silent = false) {
        try {
            const mediaMessage = message[`${type}Message`];
            if (!mediaMessage) return null;

            const stream = await downloadContentFromMessage(mediaMessage, type);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }

            if (buffer.length === 0) {
                if (!silent) console.error(`Downloaded buffer is empty for ${type} message`);
                return null;
            }

            let extension = '';
            if (mediaMessage.fileName) {
                extension = path.extname(mediaMessage.fileName);
            } else if (mediaMessage.mimetype) {
                const mime = mediaMessage.mimetype.split(';')[0];
                const types = {
                    'image/jpeg': '.jpg',
                    'image/png': '.png',
                    'image/webp': '.webp',
                    'video/mp4': '.mp4',
                    'audio/mpeg': '.mp3',
                    'audio/ogg': '.ogg',
                    'audio/mp4': '.m4a',
                    'application/pdf': '.pdf'
                };
                extension = types[mime] || '';
            }

            const fileName = `${wabaId}_${Date.now()}_${mediaMessage.fileName || 'file'}${extension ? '' : (type === 'image' ? '.jpg' : type === 'video' ? '.mp4' : '')}${extension}`;
            const uploadDir = path.join(process.cwd(), 'uploads', 'whatsapp');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }

            const filePath = path.join(uploadDir, fileName);
            fs.writeFileSync(filePath, buffer);

            console.log(`Media saved: ${filePath} (${buffer.length} bytes)`);

            return `uploads/whatsapp/${fileName}`;
        } catch (error) {
            if (silent) {

                const isExpected =
                    error?.output?.statusCode === 404 ||
                    error?.message?.includes('empty media key') ||
                    error?.cause?.code === 'ECONNRESET' ||
                    error?.code === 'ECONNRESET';
                if (!isExpected) {
                    console.error('Unexpected error downloading history media:', error.message);
                }
                return null;
            }
            console.error('Error downloading Baileys media:', error);
            return null;
        }
    }

    getFileNameFromUrl(url) {
        if (!url) return 'file';
        try {
            const parsedUrl = new URL(url);
            const pathname = parsedUrl.pathname;
            const fileName = pathname.substring(pathname.lastIndexOf('/') + 1);
            return fileName || 'file';
        } catch (e) {
            const parts = url.split('/');
            const lastPart = parts[parts.length - 1].split('?')[0];
        }
    }

    async processHistorySync(userId, wabaId, data) {
        console.log(`Processing history sync for WABA ${wabaId}...`);
        try {
            const { chats, contacts, messages, isLatest } = data;

            if (contacts && contacts.length > 0) {
                console.log(`Syncing ${contacts.length} historical contacts...`);
                for (const c of contacts) {
                    if (!c.id || c.id === 'status@broadcast' || c.id.endsWith('@g.us')) continue;

                    const senderNumber = c.id.split('@')[0];
                    if (senderNumber && senderNumber.length > 5) {
                        await Contact.updateOne(
                            { phone_number: senderNumber, created_by: userId },
                            {
                                $setOnInsert: { user_id: userId, created_by: userId, source: 'baileys', created_at: new Date() },
                                $set: { name: c.name || c.notify || senderNumber, updated_at: new Date() }
                            },
                            { upsert: true }
                        );
                    }
                }
            }

            if (messages && messages.length > 0) {
                console.log(`Syncing ${messages.length} historical messages...`);
                const phone = await WhatsappPhoneNumber.findOne({ waba_id: wabaId }).lean();
                if (!phone) {
                    console.log(`Phone not found for WABA ${wabaId}, skipping historical message ingestion.`);
                    return;
                }
                const myNumber = phone.display_phone_number;

                const messageBulkOps = [];

                for (const msgObj of messages) {
                    try {
                        const msg = msgObj.message ? msgObj : (msgObj.msg || msgObj);
                        if (!msg.key) continue;

                        const remoteJid = msg.key.remoteJid;
                        if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) continue;

                        const senderJid = msg.key.remoteJidAlt || remoteJid;
                        if (!senderJid.endsWith('@s.whatsapp.net')) continue;

                        const senderNumber = senderJid.split('@')[0];
                        const fromMe = msg.key.fromMe;

                        const timestamp = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000) : new Date();

                        const unwrapped = this.unwrapMessage(msg.message);
                        if (!unwrapped) continue;

                        const messageType = this.getBaileysMessageType(unwrapped);
                        const content = this.getBaileysMessageContent(unwrapped, messageType);

                        let replyMessageId = unwrapped?.extendedTextMessage?.contextInfo?.stanzaId || null;
                        let reactionMessageId = null;
                        if (messageType === 'reaction') {
                            reactionMessageId = unwrapped?.reactionMessage?.key?.id || null;
                        }

                        if (!fromMe) {
                            const contactName = msg.pushName || senderNumber;
                            await Contact.updateOne(
                                { phone_number: senderNumber, created_by: userId },
                                {
                                    $setOnInsert: { user_id: userId, created_by: userId, source: 'baileys' },
                                    $set: { name: contactName }
                                },
                                { upsert: true }
                            ).catch(() => { });
                        }

                        let fileUrl = null;

                        const messagePayload = {
                            sender_number: fromMe ? myNumber : senderNumber,
                            recipient_number: fromMe ? senderNumber : myNumber,
                            user_id: userId,
                            content: content,
                            message_type: messageType,
                            file_url: fileUrl,
                            from_me: fromMe,
                            direction: fromMe ? 'outbound' : 'inbound',
                            wa_message_id: msg?.key?.id,
                            wa_timestamp: timestamp,
                            provider: 'baileys',
                            reply_message_id: replyMessageId,
                            reaction_message_id: reactionMessageId
                        };

                        if (messageType === 'location') {
                            messagePayload.interactive_data = {
                                location: {
                                    latitude: unwrapped.locationMessage?.degreesLatitude,
                                    longitude: unwrapped.locationMessage?.degreesLongitude,
                                    name: unwrapped.locationMessage?.name,
                                    address: unwrapped.locationMessage?.address
                                }
                            };
                        }

                        messageBulkOps.push({
                            updateOne: {
                                filter: { wa_message_id: msg?.key?.id },
                                update: { $setOnInsert: messagePayload },
                                upsert: true
                            }
                        });

                        if (messageBulkOps.length >= 500) {
                            await Message.bulkWrite(messageBulkOps, { ordered: false });
                            messageBulkOps.length = 0;
                            await new Promise(resolve => setTimeout(resolve, 50));
                        }

                    } catch (err) {
                    }
                }

                if (messageBulkOps.length > 0) {
                    await Message.bulkWrite(messageBulkOps, { ordered: false });
                }

                console.log(`Finished chunk processing of historical messages for WABA ${wabaId}`);
            }
        } catch (error) {
            console.error(`Error in processHistorySync for WABA ${wabaId}:`, error);
        }
    }

    async disconnect(userId, connection = null) {
        if (!connection) throw new Error('Connection not found');
        const wabaId = connection._id || connection.id;
        const sock = this.sockets.get(wabaId.toString());

        if (sock) {
            try {
                if (sock.user) {
                    console.log(`Explicitly logging out Baileys for WABA ${wabaId} (removing from linked devices)`);
                    await sock.logout();
                } else {
                    console.log(`Closing unauthenticated Baileys socket for WABA ${wabaId}`);
                    sock.end();
                }
            } catch (err) {
                console.error(`Error during Baileys logout for WABA ${wabaId}:`, err.message);
                try { sock.end(); } catch { }
            }
            this.sockets.delete(wabaId.toString());
        }
        await Promise.all([
            WhatsappWaba.findByIdAndUpdate(wabaId, {
                connection_status: 'disconnected',
                is_active: false,
                qr_code: null,
                deleted_at: new Date()
            }),
            WhatsappPhoneNumber.updateMany(
                { waba_id: wabaId, user_id: userId },
                { deleted_at: new Date(), is_active: false }
            )
        ]);

        this.emitStatus(wabaId, 'disconnected', { message: 'Disconnected by user' });

        return { success: true };
    }
}
