import Database from 'better-sqlite3';
import { Pool } from 'pg';

type PrayerRow = {
  id: number;
  content: string;
  createdAt: Date;
};

type SubscriberRow = {
  id: number;
  waJid: string;
  active: boolean;
  createdAt: Date;
};

const DATABASE_URL = process.env.DATABASE_URL;
const isPostgres = Boolean(DATABASE_URL);

let sqlite: Database.Database | null = null;
let pgPool: Pool | null = null;

function getSqlite() {
  if (!sqlite) {
    const isVercel = process.env.VERCEL === '1';
    const dbPath = process.env.DB_PATH || (isVercel ? '/tmp/sqlite.db' : './sqlite.db');
    sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS prayer_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS whatsapp_subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_jid TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
  }
  return sqlite;
}

function getPg() {
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return pgPool;
}

async function ensurePgTables() {
  const pool = getPg();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prayer_requests (
      id SERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS whatsapp_subscribers (
      id SERIAL PRIMARY KEY,
      wa_jid TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function createPrayer(content: string) {
  if (isPostgres) {
    await ensurePgTables();
    const pool = getPg();
    await pool.query('INSERT INTO prayer_requests (content) VALUES ($1)', [content]);
    return;
  }

  const db = getSqlite();
  db.prepare('INSERT INTO prayer_requests (content) VALUES (?)').run(content);
}

export async function listPrayers(): Promise<PrayerRow[]> {
  if (isPostgres) {
    await ensurePgTables();
    const pool = getPg();
    const result = await pool.query(
      'SELECT id, content, created_at FROM prayer_requests ORDER BY created_at DESC LIMIT 500'
    );

    return result.rows.map((r: any) => ({
      id: Number(r.id),
      content: String(r.content),
      createdAt: new Date(r.created_at),
    }));
  }

  const db = getSqlite();
  const rows = db.prepare('SELECT id, content, created_at FROM prayer_requests ORDER BY created_at DESC LIMIT 500').all() as Array<{id:number; content:string; created_at:number}>;
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    createdAt: new Date(r.created_at * 1000),
  }));
}

export async function addWhatsappSubscriber(waJid: string) {
  if (isPostgres) {
    await ensurePgTables();
    const pool = getPg();
    await pool.query(
      'INSERT INTO whatsapp_subscribers (wa_jid, active) VALUES ($1, TRUE) ON CONFLICT (wa_jid) DO UPDATE SET active = TRUE',
      [waJid]
    );
    return;
  }

  const db = getSqlite();
  db.prepare('INSERT INTO whatsapp_subscribers (wa_jid, active) VALUES (?, 1) ON CONFLICT(wa_jid) DO UPDATE SET active=1').run(waJid);
}

export async function listWhatsappSubscribers(): Promise<SubscriberRow[]> {
  if (isPostgres) {
    await ensurePgTables();
    const pool = getPg();
    const result = await pool.query('SELECT id, wa_jid, active, created_at FROM whatsapp_subscribers ORDER BY created_at DESC');
    return result.rows.map((r: any) => ({
      id: Number(r.id),
      waJid: String(r.wa_jid),
      active: Boolean(r.active),
      createdAt: new Date(r.created_at),
    }));
  }

  const db = getSqlite();
  const rows = db.prepare('SELECT id, wa_jid, active, created_at FROM whatsapp_subscribers ORDER BY created_at DESC').all() as Array<{id:number; wa_jid:string; active:number; created_at:number}>;
  return rows.map((r) => ({ id: r.id, waJid: r.wa_jid, active: !!r.active, createdAt: new Date(r.created_at * 1000) }));
}

export async function listActiveWhatsappJids(): Promise<string[]> {
  const all = await listWhatsappSubscribers();
  return all.filter((s) => s.active).map((s) => s.waJid);
}

export async function removeWhatsappSubscriber(waJid: string) {
  if (isPostgres) {
    await ensurePgTables();
    const pool = getPg();
    await pool.query('UPDATE whatsapp_subscribers SET active = FALSE WHERE wa_jid = $1', [waJid]);
    return;
  }

  const db = getSqlite();
  db.prepare('UPDATE whatsapp_subscribers SET active = 0 WHERE wa_jid = ?').run(waJid);
}

export async function deletePrayerById(id: number) {
  if (isPostgres) {
    await ensurePgTables();
    const pool = getPg();
    await pool.query('DELETE FROM prayer_requests WHERE id = $1', [id]);
    return;
  }

  const db = getSqlite();
  db.prepare('DELETE FROM prayer_requests WHERE id = ?').run(id);
}

export async function deletePrayersOlderThan(days: number) {
  if (days <= 0) return 0;
  return deletePrayersOlderThanHours(days * 24);
}

export async function deletePrayersOlderThanHours(hours: number) {
  if (hours <= 0) return 0;
  return deletePrayersOlderThanMinutes(hours * 60);
}

export async function deletePrayersOlderThanMinutes(minutes: number) {
  if (minutes <= 0) return 0;

  if (isPostgres) {
    await ensurePgTables();
    const pool = getPg();
    const result = await pool.query(
      "DELETE FROM prayer_requests WHERE created_at < NOW() - ($1 || ' minutes')::interval",
      [minutes]
    );
    return result.rowCount ?? 0;
  }

  const db = getSqlite();
  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(minutes * 60);
  const result = db.prepare('DELETE FROM prayer_requests WHERE created_at < ?').run(cutoff);
  return result.changes;
}
