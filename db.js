const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "data.sqlite");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
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
    PRIMARY KEY (user_id, friend_user_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (friend_user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

function randomInt(min, max) {
  // inclusive min/max, cryptographically strong
  return crypto.randomInt(min, max + 1);
}

function generateUniquePublicId() {
  // 5-9 digits -> 10000..999999999
  const min = 10000;
  const max = 999999999;
  const stmt = db.prepare("SELECT 1 FROM users WHERE public_id = ?");

  for (let i = 0; i < 25; i++) {
    const candidate = randomInt(min, max);
    const exists = stmt.get(candidate);
    if (!exists) return candidate;
  }

  // Fallback: widen retries (extremely unlikely to hit)
  while (true) {
    const candidate = randomInt(min, max);
    const exists = stmt.get(candidate);
    if (!exists) return candidate;
  }
}

module.exports = {
  db,
  generateUniquePublicId,
};

