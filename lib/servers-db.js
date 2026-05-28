const crypto = require("crypto");

const INVITE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

async function ensureServerSchema({ getAll, run, pgPool }) {
  const isPg = !!pgPool;
  const boolType = isPg ? "BOOLEAN" : "INTEGER";
  const boolDefault = isPg ? "FALSE" : "0";

  const ddl = `
    CREATE TABLE IF NOT EXISTS servers (
      id ${isPg ? "SERIAL" : "INTEGER"} PRIMARY KEY ${isPg ? "" : "AUTOINCREMENT"},
      name TEXT NOT NULL,
      icon_url TEXT,
      owner_user_id INT NOT NULL,
      created_at ${isPg ? "TIMESTAMPTZ NOT NULL DEFAULT now()" : "TEXT NOT NULL DEFAULT (datetime('now'))"}
    );

    CREATE TABLE IF NOT EXISTS server_members (
      server_id INT NOT NULL,
      user_id INT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      joined_at ${isPg ? "TIMESTAMPTZ NOT NULL DEFAULT now()" : "TEXT NOT NULL DEFAULT (datetime('now'))"},
      PRIMARY KEY (server_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS channels (
      id ${isPg ? "SERIAL" : "INTEGER"} PRIMARY KEY ${isPg ? "" : "AUTOINCREMENT"},
      server_id INT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
      admin_only ${boolType} NOT NULL DEFAULT ${boolDefault},
      position INT NOT NULL DEFAULT 0,
      created_at ${isPg ? "TIMESTAMPTZ NOT NULL DEFAULT now()" : "TEXT NOT NULL DEFAULT (datetime('now'))"}
    );

    CREATE TABLE IF NOT EXISTS channel_messages (
      id ${isPg ? "SERIAL" : "INTEGER"} PRIMARY KEY ${isPg ? "" : "AUTOINCREMENT"},
      channel_id INT NOT NULL,
      from_user_id INT NOT NULL,
      body TEXT NOT NULL,
      created_at ${isPg ? "TIMESTAMPTZ NOT NULL DEFAULT now()" : "TEXT NOT NULL DEFAULT (datetime('now'))"}
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      id ${isPg ? "SERIAL" : "INTEGER"} PRIMARY KEY ${isPg ? "" : "AUTOINCREMENT"},
      server_id INT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
      created_at ${isPg ? "TIMESTAMPTZ NOT NULL DEFAULT now()" : "TEXT NOT NULL DEFAULT (datetime('now'))"}
    );
  `;

  for (const stmt of ddl.split(";").filter((s) => s.trim())) {
    await run(stmt);
  }

  if (isPg) {
    await run("ALTER TABLE servers ADD COLUMN IF NOT EXISTS icon_url TEXT");
  }
}

function randomInviteCode(len = 12) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += INVITE_CHARS[crypto.randomInt(0, INVITE_CHARS.length)];
  }
  return out;
}

async function generateUniqueInviteCode(getOne, minLen = 10) {
  for (let i = 0; i < 60; i++) {
    const len = Math.max(minLen, 12);
    const code = randomInviteCode(len);
    // eslint-disable-next-line no-await-in-loop
    const exists = await getOne("SELECT 1 AS ok FROM invite_codes WHERE code = ?", [code]);
    if (!exists) return code;
  }
  throw new Error("invite_code_generation_failed");
}

module.exports = {
  ensureServerSchema,
  generateUniqueInviteCode,
};
