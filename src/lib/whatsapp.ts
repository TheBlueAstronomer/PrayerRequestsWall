import fs from 'fs';
import path from 'path';

import { Client, LocalAuth } from 'whatsapp-web.js';

class WhatsAppService {
    public client: Client;
    private isReady: boolean = false;
    public latestQR: string | null = null;
    private isShuttingDown: boolean = false;
    private isInitializing: boolean = false;

    constructor() {
        console.log('[WA:init] Constructing WhatsAppService singleton...');

        this.client = this.createClient();

        this.setupGracefulShutdown();
        this.initialize();
    }

    private createClient(): Client {
        console.log('[WA:init] Creating new Client instance...');

        const client = new Client({
            authStrategy: new LocalAuth({
                dataPath: process.env.WA_DATA_PATH || './.wwebjs_auth',
            }),
            authTimeoutMs: 60000,
            qrMaxRetries: 0,
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
        });

        return client;
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
            await this.client.sendMessage(chatId, message);
            console.log(`[WA:send] Message sent successfully to ${chatId}.`);
            return true;
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

        console.log('[WA:logout] Waiting for Chromium to release browser lock...');
        await this.waitForLockRelease();

        console.log('[WA:logout] Re-creating client for new session...');
        this.client = this.createClient();
        this.initialize();
        return true;
    }
}

// Singleton pattern for Next.js
const isBuild = process.env.npm_lifecycle_event === 'build' || process.argv.includes('build');
const globalForWhatsApp = globalThis as unknown as { whatsappGlobal: WhatsAppService | undefined };

if (!globalForWhatsApp.whatsappGlobal && !isBuild) {
    globalForWhatsApp.whatsappGlobal = new WhatsAppService();
}

const whatsappService = globalForWhatsApp.whatsappGlobal!;

export { whatsappService };
