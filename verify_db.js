/* eslint-disable @typescript-eslint/no-require-imports */
const Database = require('better-sqlite3');

const db = new Database('sqlite.db');
const stmt = db.prepare('SELECT * FROM prayer_requests');
const rows = stmt.all();

console.log('Prayer Requests in DB:', rows);
