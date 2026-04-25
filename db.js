const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const initSqlJs = require("sql.js");

const dbPath = path.join(__dirname, "data.sqlite");

let SQL = null;
let db = null;

function ensureInit() {
  if (!db) throw new Error("db_not_initialized");
}

async function initDb() {
  if (db) return db;
  SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, "node_modules", "sql.js", "dist", file),
  });

  const exists = fs.existsSync(dbPath);
  const bytes = exists ? new Uint8Array(fs.readFileSync(dbPath)) : undefined;
  db = new SQL.Database(bytes);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id INTEGER NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS friendships (
      user_id INTEGER NOT NULL,
      friend_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, friend_user_id)
    );
  `);

  persist();
  return db;
}

function persist() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function getOne(sql, params = []) {
  ensureInit();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row && Object.keys(row).length ? row : null;
}

function getAll(sql, params = []) {
  ensureInit();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  ensureInit();
  db.run(sql, params);
  persist();
}

function randomInt(min, max) {
  // inclusive min/max, cryptographically strong
  return crypto.randomInt(min, max + 1);
}

function generateUniquePublicId() {
  // 5-9 digits -> 10000..999999999
  const min = 10000;
  const max = 999999999;

  for (let i = 0; i < 25; i++) {
    const candidate = randomInt(min, max);
    const exists = getOne("SELECT 1 AS ok FROM users WHERE public_id = ?", [candidate]);
    if (!exists) return candidate;
  }

  // Fallback: widen retries (extremely unlikely to hit)
  while (true) {
    const candidate = randomInt(min, max);
    const exists = getOne("SELECT 1 AS ok FROM users WHERE public_id = ?", [candidate]);
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

