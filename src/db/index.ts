import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';

const isVercel = process.env.VERCEL === '1';
const dbPath = process.env.DB_PATH || (isVercel ? '/tmp/sqlite.db' : './sqlite.db');
const sqlite = new Database(dbPath);

// Ensure table exists in environments without migration step (e.g. Vercel serverless)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS prayer_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

export const db = drizzle(sqlite, { schema });
