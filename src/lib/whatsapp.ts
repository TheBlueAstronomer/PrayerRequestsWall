import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

// Define the shape of our global object to include our service
declare global {
    var whatsappGlobal: WhatsAppService | undefined;
}

class WhatsAppService {
    public client: Client;
    private isReady: boolean = false;

    constructor() {
        console.log('Initializing WhatsApp Client...');
        this.client = new Client({
            authStrategy: new LocalAuth({
                dataPath:'/app/data/.wwebjs_auth'}),
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
                // Increase timeout for slow environments checks
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

        this.client.on('auth_failure', msg => {
            console.error('AUTHENTICATION FAILURE', msg);
        });

        // Initialize with error handling
        this.client.initialize().catch(err => {
            console.error('Failed to initialize WhatsApp client:', err);
        });
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
            // detailed inspection
            try {
                console.error('Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            } catch (e) {
                console.error('Could not stringify error:', e);
            }
            return false;
        }
    }
}

// Singleton pattern to prevent multiple instances
// We attach to global to survive Next.js HMR and to prevent double-init in production
// when both server.ts and Next.js bundle import this module.
if (!global.whatsappGlobal) {
    global.whatsappGlobal = new WhatsAppService();
}

const whatsappService = global.whatsappGlobal;

export { whatsappService };
