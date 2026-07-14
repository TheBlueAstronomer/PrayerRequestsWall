import fs from 'fs';
import path from 'path';

import { Client, LocalAuth } from 'whatsapp-web.js';

/**
 * Delivery acknowledgement levels reported by WhatsApp for an outgoing message.
 * Mirrors whatsapp-web.js's MessageAck enum. Declared locally rather than
 * imported so the values stay available even when the library is mocked.
 */
const ACK_ERROR = -1;
const ACK_PENDING = 0;
const ACK_SERVER = 1;

const DEFAULT_ACK_TIMEOUT_MS = 30000;
const MAX_EARLY_ACKS = 200;

/** How many unscanned QR codes to offer before giving up and releasing Chromium. */
const QR_MAX_RETRIES = Number(process.env.WA_QR_MAX_RETRIES) || 5;

/** Emitted by whatsapp-web.js as the disconnect reason once qrMaxRetries is hit. */
const MAX_QR_RETRIES_REASON = 'max qrcode retries';

/** Minimal shape of the Message returned by client.sendMessage(). */
type SentMessage = { id?: { _serialized?: string }; ack?: number };

class WhatsAppService {
    public client: Client;
    private isReady: boolean = false;
    public latestQR: string | null = null;
    private isShuttingDown: boolean = false;
    private isInitializing: boolean = false;

    /** Outgoing messages awaiting a server ack, keyed by serialized message id. */
    private pendingAcks: Map<string, (ack: number) => void> = new Map();

    /**
     * Acks that arrived before sendMessage() had registered its waiter. Bounded,
     * because an unbounded cache on a long-lived singleton is a slow memory leak.
     */
    private earlyAcks: Map<string, number> = new Map();

    private ackTimeoutMs: number = Number(process.env.WA_ACK_TIMEOUT_MS) || DEFAULT_ACK_TIMEOUT_MS;

    constructor() {
        console.log('[WA:init] Constructing WhatsAppService singleton...');

        this.client = this.createClient();

        this.setupGracefulShutdown();
    }

    private createClient(): Client {
        console.log('[WA:init] Creating new Client instance...');

        const client = new Client({
            authStrategy: new LocalAuth({
                dataPath: process.env.WA_DATA_PATH || './.wwebjs_auth',
            }),
            authTimeoutMs: 60000,
            // Finite on purpose. 0 means *unlimited* in whatsapp-web.js: an
            // unauthenticated client regenerates a QR every ~20s forever, and each
            // cycle keeps Chromium resident. Left unbounded this pins the CPU and
            // fills the disk. Give up instead, and re-arm on demand (see initialize()).
            qrMaxRetries: QR_MAX_RETRIES,
            puppeteer: {
                handleSIGINT: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ],
                protocolTimeout: 120000,
            },
        });

        client.on('qr', (qr) => {
            console.log(`[WA:qr] New QR code received (length: ${qr.length}). Awaiting scan.`);
            this.latestQR = qr;
        });

        client.on('ready', () => {
            console.log('[WA:ready] Client is ready. Session established.');
            this.isReady = true;
            this.latestQR = null;
            this.isInitializing = false;
        });

        client.on('authenticated', () => {
            console.log('[WA:auth] Authenticated successfully. Loading session...');
            this.latestQR = null;
        });

        client.on('auth_failure', (msg) => {
            console.error(`[WA:auth] Authentication failed: ${msg}`);
            this.isInitializing = false;
        });

        client.on('disconnected', (reason) => {
            console.warn(`[WA:disconnect] Client disconnected. Reason: ${reason}. isReady reset to false.`);
            this.isReady = false;
            this.isInitializing = false;
            this.settleAllPendingAcks(ACK_PENDING);

            if (String(reason).toLowerCase().includes(MAX_QR_RETRIES_REASON)) {
                // whatsapp-web.js has destroyed the client and released Chromium.
                // Drop the expired QR and swap in a fresh, un-initialized client so
                // the next initialize() starts cleanly rather than reusing a corpse.
                console.warn(`[WA:qr] No scan after ${QR_MAX_RETRIES} QR codes. Released Chromium; will re-arm on the next initialize().`);
                this.latestQR = null;
                this.replaceClient();
            }
        });

        client.on('message_ack', (msg: unknown, ack: number) => {
            const id = (msg as SentMessage)?.id?._serialized;
            if (!id) return;

            // Intermediate acks (still queued) are not decisive — keep waiting.
            if (ack !== ACK_ERROR && ack < ACK_SERVER) return;

            const settle = this.pendingAcks.get(id);
            if (settle) {
                settle(ack);
                return;
            }

            // The ack beat sendMessage()'s waiter registration — hold it so the
            // waiter can pick it up instead of timing out on a delivered message.
            if (this.earlyAcks.size >= MAX_EARLY_ACKS) {
                const oldest = this.earlyAcks.keys().next().value;
                if (oldest !== undefined) this.earlyAcks.delete(oldest);
            }
            this.earlyAcks.set(id, ack);
        });

        return client;
    }

    /**
     * Resolves once WhatsApp reports a decisive acknowledgement for the message
     * (reached the server, or was rejected). Resolves with ACK_PENDING if no
     * decisive ack arrives before the timeout.
     */
    private waitForAck(messageId: string, timeoutMs: number): Promise<number> {
        const early = this.earlyAcks.get(messageId);
        if (early !== undefined) {
            this.earlyAcks.delete(messageId);
            return Promise.resolve(early);
        }

        return new Promise((resolve) => {
            const settle = (ack: number) => {
                clearTimeout(timer);
                this.pendingAcks.delete(messageId);
                resolve(ack);
            };

            const timer = setTimeout(() => settle(ACK_PENDING), timeoutMs);
            this.pendingAcks.set(messageId, settle);
        });
    }

    /**
     * Swaps in a fresh client, detaching the outgoing one's listeners first.
     *
     * Every handler registered in createClient() closes over `this`, so a client
     * that is replaced without being unsubscribed keeps mutating shared service
     * state long after it is supposed to be dead. In production that meant a
     * replaced client carried on emitting 'qr' into this.latestQR alongside its
     * replacement — two QR codes, milliseconds apart, overwriting each other —
     * so the QR shown in the admin UI was frequently the dead client's, and
     * scanning it did nothing. A late 'disconnected' from the old client could
     * also clear isReady on a perfectly healthy new session.
     */
    private replaceClient() {
        this.client.removeAllListeners();
        this.client = this.createClient();
    }

    /** Releases every in-flight ack wait, e.g. when the client dies mid-send. */
    private settleAllPendingAcks(ack: number) {
        for (const settle of [...this.pendingAcks.values()]) {
            settle(ack);
        }
        this.pendingAcks.clear();
        this.earlyAcks.clear();
    }

    private getLockFilePath(): string {
        const dataPath = process.env.WA_DATA_PATH || './.wwebjs_auth';
        return path.join(dataPath, 'session', 'SingletonLock');
    }

    private clearStaleLock() {
        const lockFile = this.getLockFilePath();
        if (fs.existsSync(lockFile)) {
            console.warn(`[WA:lock] Stale SingletonLock detected at ${lockFile}. Removing...`);
            fs.rmSync(lockFile);
            console.log('[WA:lock] Stale lock removed.');
        } else {
            console.log('[WA:lock] No stale lock found. Proceeding.');
        }
    }

    private waitForLockRelease(timeoutMs = 10000): Promise<void> {
        const lockFile = this.getLockFilePath();
        return new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
                if (!fs.existsSync(lockFile)) {
                    console.log(`[WA:lock] Lock released after ${Date.now() - start}ms.`);
                    return resolve();
                }
                if (Date.now() - start > timeoutMs) {
                    console.warn(`[WA:lock] Lock not released after ${timeoutMs}ms timeout. Removing forcefully...`);
                    try { fs.rmSync(lockFile); } catch { }
                    return resolve();
                }
                setTimeout(check, 200);
            };
            check();
        });
    }

    public async initialize() {
        if (this.isInitializing || this.isReady) {
            console.log(`[WA:init] Skipping initialize — already ${this.isReady ? 'ready' : 'initializing'}.`);
            return;
        }

        this.clearStaleLock();
        this.isInitializing = true;
        console.log('[WA:init] Starting client initialization...');

        try {
            await this.client.initialize();
        } catch (err) {
            this.isInitializing = false;
            console.error('[WA:init] Client initialization failed:', err);
        }
    }

    private setupGracefulShutdown() {
        const shutdown = async (signal: string) => {
            if (this.isShuttingDown) return;
            this.isShuttingDown = true;

            console.log(`[WA:shutdown] ${signal} received. Destroying client gracefully...`);

            try {
                await this.client.destroy();
                console.log('[WA:shutdown] Client destroyed. Exiting.');
            } catch (err) {
                console.error('[WA:shutdown] Error during client destroy:', err);
            }

            process.exit(0);
        };

        if (typeof process !== 'undefined') {
            process.on('SIGTERM', () => shutdown('SIGTERM'));
            process.on('SIGINT', () => shutdown('SIGINT'));
        }
    }

    public async sendMessage(chatId: string, message: string): Promise<boolean> {
        console.log(`[WA:send] sendMessage called — isReady: ${this.isReady}, isInitializing: ${this.isInitializing}, chatId: ${chatId}`);
        if (!this.isReady) {
            console.warn('[WA:send] Client not ready. Message will not be sent.');
            if (!this.isInitializing) {
                console.log('[WA:send] Triggering re-initialization...');
                this.initialize();
            }
            return false;
        }

        try {
            // sendMessage() resolving only means WhatsApp Web accepted the message
            // into its outbound queue — not that WhatsApp delivered it. A wrong chat
            // id, or an account that is no longer in the group, resolves here and is
            // then dropped server-side. Wait for the ack before reporting success.
            const sent = await this.client.sendMessage(chatId, message) as SentMessage | undefined;

            if (typeof sent?.ack === 'number' && sent.ack >= ACK_SERVER) {
                console.log(`[WA:send] Message delivered to ${chatId} (ack: ${sent.ack}).`);
                return true;
            }

            const messageId = sent?.id?._serialized;
            if (!messageId) {
                console.error(`[WA:send] No message id returned for ${chatId}; cannot confirm delivery.`);
                return false;
            }

            const ack = await this.waitForAck(messageId, this.ackTimeoutMs);

            if (ack >= ACK_SERVER) {
                console.log(`[WA:send] Message delivered to ${chatId} (ack: ${ack}).`);
                return true;
            }

            if (ack === ACK_ERROR) {
                console.error(`[WA:send] WhatsApp rejected the message to ${chatId} (ack: ${ack}). Check the chat id is valid and the account is a participant.`);
            } else {
                console.error(`[WA:send] No delivery ack from WhatsApp for ${chatId} within ${this.ackTimeoutMs}ms. Treating as not sent.`);
            }
            return false;
        } catch (error) {
            console.error(`[WA:send] Failed to send message to ${chatId}:`, error);
            return false;
        }
    }

    public async logout(): Promise<boolean> {
        console.log(`[WA:logout] Logout requested — isReady: ${this.isReady}`);

        if (this.isReady) {
            try {
                await this.client.logout();
                console.log('[WA:logout] Session logged out successfully.');
            } catch (error) {
                console.error('[WA:logout] logout() failed (session may already be gone):', error);
            }
        } else {
            console.log('[WA:logout] Client not in ready state — skipping logout() call, proceeding to destroy.');
        }

        try {
            await this.client.destroy();
            console.log('[WA:logout] Client destroyed successfully.');
        } catch (destroyError) {
            console.error('[WA:logout] destroy() failed:', destroyError);
        }

        this.isReady = false;
        this.latestQR = null;
        this.isInitializing = false;
        this.settleAllPendingAcks(ACK_PENDING);

        console.log('[WA:logout] Waiting for Chromium to release browser lock...');
        await this.waitForLockRelease();

        console.log('[WA:logout] Re-creating client for new session...');
        this.replaceClient();
        this.initialize();
        return true;
    }
}

// Singleton pattern for Next.js
const isBuild = process.env.npm_lifecycle_event === 'build' || process.argv.includes('build');
const globalForWhatsApp = globalThis as unknown as { whatsappGlobal: WhatsAppService | undefined };

if (!globalForWhatsApp.whatsappGlobal && !isBuild) {
    globalForWhatsApp.whatsappGlobal = new WhatsAppService();
    // Initialize asynchronously without blocking exports
    globalForWhatsApp.whatsappGlobal.initialize().catch(err => {
        console.error('[WA:init] Failed to initialize WhatsApp service:', err);
    });
}

const whatsappService = globalForWhatsApp.whatsappGlobal!;

export { whatsappService };
