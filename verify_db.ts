import { db } from './src/db';
import { prayerRequests } from './src/db/schema';

async function main() {
    console.log('Verifying database content...');
    try {
        const requests = await db.select().from(prayerRequests);
        console.log('Current Prayer Requests:', requests);
    } catch (error) {
        console.error('Error querying database:', error);
    }
}

main();
