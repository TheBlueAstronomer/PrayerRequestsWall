import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

// Define the shape of our global object to include our service
declare global {
    var whatsappGlobal: WhatsAppService | undefined;
}

class WhatsAppService {
    public client: Client;
    private isReady: boolean = false;
    private isShuttingDown: boolean = false;

    constructor() {
        console.log('Initializing WhatsApp Client...');

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
            console.log('QR RECEIVED', qr);
            qrcode.generate(qr, { small: true });
        });

        this.client.on('ready', () => {
            console.log('WhatsApp Client is ready!');
            this.isReady = true;
        });

        this.client.on('authenticated', () => {
            console.log('AUTHENTICATED');
        });

        this.client.on('auth_failure', (msg) => {
            console.error('AUTHENTICATION FAILURE', msg);
        });

        this.client.on('disconnected', (reason) => {
            console.warn('WhatsApp disconnected:', reason);
            this.isReady = false;
        });

        this.setupGracefulShutdown();

        this.client.initialize().catch(err => {
            console.error('Failed to initialize WhatsApp client:', err);
        });
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

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }

    public async sendMessage(chatId: string, message: string): Promise<boolean> {
        if (!this.isReady) {
            console.warn('WhatsApp client not ready yet.');
            return false;
        }

        try {
            console.log(`Attempting to send message to chatId: ${chatId}`);
            await this.client.sendMessage(chatId, message);
            console.log('Message sent successfully');
            return true;
        } catch (error) {
            console.error('Failed to send message:', error);
            try {
                console.error('Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            } catch (e) {
                console.error('Could not stringify error:', e);
            }
            return false;
        }
    }
}

// Singleton pattern
if (!global.whatsappGlobal) {
    global.whatsappGlobal = new WhatsAppService();
}

const whatsappService = global.whatsappGlobal;

export { whatsappService };
