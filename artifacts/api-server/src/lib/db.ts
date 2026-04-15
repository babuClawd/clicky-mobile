import { Pool } from "pg";
import { logger } from "./logger";

const pool = new Pool({
  connectionString: process.env["DATABASE_URL"],
  ssl: process.env["NODE_ENV"] === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  logger.error({ err }, "PostgreSQL pool error");
});

export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

export async function upsertSession(id: string): Promise<void> {
  await query(
    `INSERT INTO sessions (id, updated_at)
     VALUES ($1, NOW())
     ON CONFLICT (id) DO UPDATE SET updated_at = NOW()`,
    [id]
  );
}

export async function saveMessage(
  id: string,
  sessionId: string,
  role: "user" | "assistant" | "system",
  content: string
): Promise<void> {
  await query(
    `INSERT INTO messages (id, session_id, role, content)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, sessionId, role, content]
  );
}

export async function getSessionMessages(sessionId: string, limit = 50) {
  return query<{ id: string; role: string; content: string; created_at: string }>(
    `SELECT id, role, content, created_at
     FROM messages
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sessionId, limit]
  );
}

export async function getSessions(limit = 20) {
  return query<{ id: string; created_at: string; updated_at: string; message_count: string }>(
    `SELECT s.id, s.created_at, s.updated_at, COUNT(m.id)::text AS message_count
     FROM sessions s
     LEFT JOIN messages m ON m.session_id = s.id
     GROUP BY s.id
     ORDER BY s.updated_at DESC
     LIMIT $1`,
    [limit]
  );
}

export default pool;
