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
            authStrategy: new LocalAuth(),
            puppeteer: {
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
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
            await this.client.sendMessage(chatId, message);
            return true;
        } catch (error) {
            console.error('Failed to send message:', error);
            return false;
        }
    }
}

// Singleton pattern to prevent multiple instances during HMR
const whatsappService = global.whatsappGlobal || new WhatsAppService();

if (process.env.NODE_ENV !== 'production') {
    global.whatsappGlobal = whatsappService;
}

export { whatsappService };
