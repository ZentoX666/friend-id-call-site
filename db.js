const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const initSqlJs = require("sql.js");
const { Pool } = require("pg");

// If DATABASE_URL is present, we use Postgres (Neon / Supabase / Render Postgres).
const DATABASE_URL = process.env.DATABASE_URL;

// Optional local sqlite file (dev / fallback)
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, "data.sqlite");

let SQL = null;
let sqliteDb = null;
let pgPool = null;

function normalizeRow(row) {
  if (!row) return row;
  // pg lowercases unquoted aliases (publicId -> publicid). Normalize to the app's expected casing.
  const out = { ...row };
  if (out.publicId == null && out.publicid != null) out.publicId = out.publicid;
  if (out.displayName == null && out.displayname != null) out.displayName = out.displayname;
  if (out.avatarUrl == null && out.avatarurl != null) out.avatarUrl = out.avatarurl;

  if (out.fromPublicId == null && out.frompublicid != null) out.fromPublicId = out.frompublicid;
  if (out.toPublicId == null && out.topublicid != null) out.toPublicId = out.topublicid;
  if (out.createdAt == null && out.createdat != null) out.createdAt = out.createdat;

  return out;
}

function toPg(sql) {
  // Convert sqlite-style `?` placeholders into $1..$n for pg
  let i = 0;
  let out = String(sql);

  // Handle "INSERT OR IGNORE" (sqlite) -> "INSERT ... ON CONFLICT DO NOTHING" (pg)
  // This is a minimal transform for our current usage (friendships).
  out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, "INSERT INTO");

  // Replace ? with $n
  out = out.replace(/\?/g, () => `$${++i}`);

  // If the query originally used INSERT OR IGNORE, we need to add ON CONFLICT DO NOTHING.
  // We detect this by checking the original SQL (before replacement).
  const usedIgnore = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql);
  if (usedIgnore) {
    // If caller already provided ON CONFLICT, don't double-append.
    if (!/\bON\s+CONFLICT\b/i.test(out)) out = `${out} ON CONFLICT DO NOTHING`;
  }

  return out;
}

function ensureInit() {
  if (!sqliteDb && !pgPool) throw new Error("db_not_initialized");
}

async function initDb() {
  if (pgPool || sqliteDb) return true;

  if (DATABASE_URL) {
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("sslmode=require") || DATABASE_URL.includes("neon.tech") ? { rejectUnauthorized: false } : undefined,
    });

    // Create schema (idempotent)
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        public_id BIGINT NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        avatar_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS friendships (
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        friend_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, friend_user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        from_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    return true;
  }

  // sqlite fallback
  SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, "node_modules", "sql.js", "dist", file),
  });

  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch {}

  const exists = fs.existsSync(dbPath);
  const bytes = exists ? new Uint8Array(fs.readFileSync(dbPath)) : undefined;
  sqliteDb = new SQL.Database(bytes);

  sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id INTEGER NOT NULL UNIQUE,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT,
        avatar_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS friendships (
        user_id INTEGER NOT NULL,
        friend_user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, friend_user_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER NOT NULL,
        to_user_id INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
  `);

  // Lightweight migrations for existing DB files
  const userCols = await getAll("PRAGMA table_info(users)");
  const colNames = new Set(userCols.map((c) => c.name));
  if (!colNames.has("display_name")) sqliteDb.run("ALTER TABLE users ADD COLUMN display_name TEXT");
  if (!colNames.has("avatar_url")) sqliteDb.run("ALTER TABLE users ADD COLUMN avatar_url TEXT");

  persist();
  return true;
}

function persist() {
  if (!sqliteDb) return;
  const data = sqliteDb.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

async function getOne(sql, params = []) {
  ensureInit();
  if (pgPool) {
    const res = await pgPool.query(toPg(sql), params);
    return normalizeRow(res.rows[0] || null);
  }
  const stmt = sqliteDb.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row && Object.keys(row).length ? normalizeRow(row) : null;
}

async function getAll(sql, params = []) {
  ensureInit();
  if (pgPool) {
    const res = await pgPool.query(toPg(sql), params);
    return res.rows.map(normalizeRow);
  }
  const stmt = sqliteDb.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows.map(normalizeRow);
}

async function run(sql, params = []) {
  ensureInit();
  if (pgPool) {
    await pgPool.query(toPg(sql), params);
    return;
  }
  sqliteDb.run(sql, params);
  persist();
}

function randomInt(min, max) {
  // inclusive min/max, cryptographically strong
  return crypto.randomInt(min, max + 1);
}

async function generateUniquePublicId() {
  // 5-9 digits -> 10000..999999999
  const min = 10000;
  const max = 999999999;

  for (let i = 0; i < 25; i++) {
    const candidate = randomInt(min, max);
    // eslint-disable-next-line no-await-in-loop
    const exists = await getOne("SELECT 1 AS ok FROM users WHERE public_id = ?", [candidate]);
    if (!exists) return candidate;
  }

  // Fallback: widen retries (extremely unlikely to hit)
  while (true) {
    const candidate = randomInt(min, max);
    // eslint-disable-next-line no-await-in-loop
    const exists = await getOne("SELECT 1 AS ok FROM users WHERE public_id = ?", [candidate]);
    if (!exists) return candidate;
  }
}

module.exports = {
  initDb,
  getOne,
  getAll,
  run,
  generateUniquePublicId,
};

