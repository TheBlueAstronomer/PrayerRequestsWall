import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

import { appSettings } from '@/db/schema';
import { db } from '@/db';

// Define the shape of our global object to include our service
declare global {
    var whatsappGlobal: WhatsAppService | undefined;
}

class WhatsAppService {
    public client: Client;
    private isReady: boolean = false;
    public latestQR: string | null = null;
    private isShuttingDown: boolean = false;
    private isInitializing: boolean = false;

    constructor() {
        console.log('Constructing WhatsAppService instance...');

        this.client = new Client({
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

        this.client.on('qr', (qr) => {
            console.log('QR RECEIVED (length):', qr.length);
            this.latestQR = qr;
            // qrcode.generate(qr, { small: true });
        });

        this.client.on('ready', () => {
            console.log('WhatsApp Client is ready!');
            this.isReady = true;
            this.latestQR = null;
            this.isInitializing = false;
        });

        this.client.on('authenticated', () => {
            console.log('AUTHENTICATED');
            this.latestQR = null;
        });

        this.client.on('auth_failure', (msg) => {
            console.error('AUTHENTICATION FAILURE', msg);
            this.isInitializing = false;
        });

        this.client.on('disconnected', (reason) => {
            console.warn('WhatsApp disconnected:', reason);
            this.isReady = false;
            this.isInitializing = false;
        });

        this.setupGracefulShutdown();
        this.initialize();
    }

    public async initialize() {
        if (this.isInitializing || this.isReady) {
            console.log('WhatsApp client already initializing or ready. Skipping redundant initialize.');
            return;
        }

        this.isInitializing = true;
        console.log('Initializing WhatsApp client...');

        try {
            await this.client.initialize();
        } catch (err) {
            this.isInitializing = false;
            console.error('Failed to initialize WhatsApp client:', err);
        }
    }

    private setupGracefulShutdown() {
        const shutdown = async (signal: string) => {
            if (this.isShuttingDown) return;
            this.isShuttingDown = true;

            console.log(`${signal} received. Shutting down WhatsApp client gracefully...`);

            try {
                await this.client.destroy();
                console.log('WhatsApp client destroyed successfully.');
            } catch (err) {
                console.error('Error while destroying WhatsApp client:', err);
            }

            process.exit(0);
        };

        if (typeof process !== 'undefined') {
            process.on('SIGTERM', () => shutdown('SIGTERM'));
            process.on('SIGINT', () => shutdown('SIGINT'));
        }
    }

    public async sendMessage(chatId: string, message: string): Promise<boolean> {
        console.log(`Checking if ready to send... isReady: ${this.isReady}, isInitializing: ${this.isInitializing}`);
        if (!this.isReady) {
            console.warn('WhatsApp client not ready yet.');
            if (!this.isInitializing) {
                console.log('Attempting to re-initialize...');
                this.initialize();
            }
            return false;
        }

        try {
            console.log(`Attempting to send message to chatId: ${chatId}`);
            await this.client.sendMessage(chatId, message);
            console.log('Message sent successfully');
            return true;
        } catch (error) {
            console.error('Failed to send message:', error);
            return false;
        }
    }

    public async logout(): Promise<boolean> {
        console.log('Attempting to logout WhatsApp client...');
        try {
            await this.client.logout();
            console.log('WhatsApp client logged out successfully.');
        } catch (error) {
            console.error('Failed to logout WhatsApp client gracefully:', error);
            console.log('Attempting to forcefully destroy WhatsApp client...');
            try {
                await this.client.destroy();
                console.log('WhatsApp client destroyed forcefully.');
            } catch (destroyError) {
                console.error('Failed to destroy WhatsApp client:', destroyError);
            }
        } finally {
            this.isReady = false;
            this.latestQR = null;
            this.isInitializing = false;
            console.log('Re-initializing WhatsApp client for new session...');
            this.initialize();
        }
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
