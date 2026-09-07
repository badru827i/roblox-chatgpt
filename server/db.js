const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn("DATABASE_URL belum ada. PostgreSQL persistence dimatikan; server akan guna memory sahaja.");
}

const pool = connectionString
  ? new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
    })
  : null;

function sha256(value) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function initDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      google_sub TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      picture TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      google_sub TEXT NOT NULL REFERENCES users(google_sub) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_google_sub_idx ON sessions(google_sub);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
  `);

  // Bersihkan session lama secara murah supaya table tidak membesar.
  await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
}

async function upsertUser(user) {
  if (!pool) return user;
  const result = await pool.query(
    `INSERT INTO users (google_sub, email, name, picture, last_login_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (google_sub)
     DO UPDATE SET email = EXCLUDED.email,
                   name = EXCLUDED.name,
                   picture = EXCLUDED.picture,
                   last_login_at = NOW()
     RETURNING google_sub, email, name, picture`,
    [user.id, user.email, user.name, user.picture || null]
  );
  const row = result.rows[0];
  return { id: row.google_sub, email: row.email, name: row.name, picture: row.picture };
}

async function createSession(token, googleSub) {
  if (!pool) return;
  const tokenHash = sha256(token);
  await pool.query(
    `INSERT INTO sessions (token_hash, google_sub, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
    [tokenHash, googleSub]
  );
}

async function getUserBySession(token) {
  if (!pool) return null;
  const tokenHash = sha256(token);
  const result = await pool.query(
    `SELECT u.google_sub AS id, u.email, u.name, u.picture
     FROM sessions s
     JOIN users u ON u.google_sub = s.google_sub
     WHERE s.token_hash = $1 AND s.expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

async function deleteSession(token) {
  if (!pool || !token) return;
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
}

async function cleanupExpiredSessions() {
  if (!pool) return;
  await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
}

function isEnabled() {
  return !!pool;
}

module.exports = {
  initDb,
  upsertUser,
  createSession,
  getUserBySession,
  deleteSession,
  cleanupExpiredSessions,
  isEnabled
};
