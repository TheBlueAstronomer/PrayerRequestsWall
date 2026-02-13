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

        this.client.on('ready', async () => {
            console.log('WhatsApp Client is ready!');
            this.isReady = true;
            try {
                const chats = await this.client.getChats();
                const groups = chats.filter(chat => chat.isGroup);
                console.log('Available Groups:');
                groups.forEach(group => {
                    console.log(`- Name: ${group.name}, ID: ${group.id._serialized}`);
                });
            } catch (error) {
                console.error('Error fetching chats:', error);
            }
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
