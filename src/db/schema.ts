import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const prayerRequests = sqliteTable('prayer_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`), // Store as timestamp
});
