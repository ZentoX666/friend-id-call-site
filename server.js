require("dotenv").config();

const path = require("path");
const http = require("http");
const bcrypt = require("bcrypt");
const express = require("express");
const session = require("express-session");
const { Server } = require("socket.io");

const { initDb, getOne, getAll, run, generateUniquePublicId } = require("./db");

const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-insecure-secret";

async function main() {
  await initDb();

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(
    session({
      secret: SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax" },
    })
  );

  app.use(express.static(path.join(__dirname, "public")));

  app.get("/healthz", (req, res) => {
    res.status(200).send("ok");
  });

  function requireAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" });
    next();
  }

  function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
  }

  app.get("/api/me", (req, res) => {
    if (!req.session.userId) return res.json({ authenticated: false });
    const user = getOne("SELECT public_id AS publicId, email, display_name AS displayName, avatar_url AS avatarUrl FROM users WHERE id = ?", [
      req.session.userId,
    ]);
    if (!user) {
      req.session.destroy(() => {});
      return res.json({ authenticated: false });
    }
    res.json({ authenticated: true, user });
  });

  app.post("/api/signup", async (req, res) => {
    try {
      const email = normalizeEmail(req.body.email);
      const password = String(req.body.password || "");
      const displayName = String(req.body.displayName || "").trim();
      const avatarUrl = String(req.body.avatarUrl || "").trim();
      if (!email.includes("@") || email.length > 254) return res.status(400).json({ error: "invalid_email" });
      if (password.length < 6 || password.length > 200) return res.status(400).json({ error: "invalid_password" });
      if (displayName && displayName.length > 40) return res.status(400).json({ error: "invalid_display_name" });
      if (avatarUrl && avatarUrl.length > 500) return res.status(400).json({ error: "invalid_avatar_url" });

      const existing = getOne("SELECT id FROM users WHERE email = ?", [email]);
      if (existing) return res.status(409).json({ error: "email_in_use" });

      const publicId = generateUniquePublicId();
      const passwordHash = await bcrypt.hash(password, 12);

      run("INSERT INTO users (public_id, email, password_hash, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)", [
        publicId,
        email,
        passwordHash,
        displayName || null,
        avatarUrl || null,
      ]);
      const created = getOne("SELECT id FROM users WHERE email = ?", [email]);

      req.session.userId = created.id;
      res.json({ ok: true, publicId });
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/api/login", async (req, res) => {
    try {
      const email = normalizeEmail(req.body.email);
      const password = String(req.body.password || "");
      const user = getOne("SELECT id, password_hash FROM users WHERE email = ?", [email]);
      if (!user) return res.status(401).json({ error: "bad_credentials" });

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: "bad_credentials" });

      req.session.userId = user.id;
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  app.get("/api/friends", requireAuth, (req, res) => {
    const rows = getAll(
      `
      SELECT u.public_id AS publicId, u.email AS email, u.display_name AS displayName, u.avatar_url AS avatarUrl
      FROM friendships f
      JOIN users u ON u.id = f.friend_user_id
      WHERE f.user_id = ?
      ORDER BY f.created_at DESC
    `,
      [req.session.userId]
    );
    res.json({ friends: rows });
  });

  app.post("/api/friends/add", requireAuth, (req, res) => {
    const friendEmailRaw = req.body.friendEmail;
    const friendPublicIdRaw = req.body.friendPublicId;

    let friend = null;
    if (typeof friendEmailRaw === "string" && friendEmailRaw.trim()) {
      const friendEmail = friendEmailRaw.trim().toLowerCase();
      if (!friendEmail.includes("@") || friendEmail.length > 254) return res.status(400).json({ error: "invalid_email" });
      friend = getOne("SELECT id FROM users WHERE email = ?", [friendEmail]);
      if (!friend) return res.status(404).json({ error: "user_not_found" });
    } else {
      const friendPublicId = Number(friendPublicIdRaw);
      if (!Number.isInteger(friendPublicId)) return res.status(400).json({ error: "invalid_id" });
      friend = getOne("SELECT id FROM users WHERE public_id = ?", [friendPublicId]);
      if (!friend) return res.status(404).json({ error: "user_not_found" });
    }

    const me = getOne("SELECT id FROM users WHERE id = ?", [req.session.userId]);
    if (!me) return res.status(401).json({ error: "not_authenticated" });

    if (friend.id === req.session.userId) return res.status(400).json({ error: "cannot_add_self" });

    run("INSERT OR IGNORE INTO friendships (user_id, friend_user_id) VALUES (?, ?)", [req.session.userId, friend.id]);
    run("INSERT OR IGNORE INTO friendships (user_id, friend_user_id) VALUES (?, ?)", [friend.id, req.session.userId]);
    res.json({ ok: true });
  });

  // Map userId -> socket.id (single active socket)
  const userSockets = new Map();

  // ----- Chat (persistent in SQLite file) -----
  app.get("/api/messages/:friendPublicId", requireAuth, (req, res) => {
    const friendPublicId = Number(req.params.friendPublicId);
    if (!Number.isInteger(friendPublicId)) return res.status(400).json({ error: "invalid_id" });

    const me = getOne("SELECT id, public_id AS publicId FROM users WHERE id = ?", [req.session.userId]);
    if (!me) return res.status(401).json({ error: "not_authenticated" });

    const friend = getOne(
      "SELECT id, public_id AS publicId, email, display_name AS displayName, avatar_url AS avatarUrl FROM users WHERE public_id = ?",
      [friendPublicId]
    );
    if (!friend) return res.status(404).json({ error: "user_not_found" });

    const isFriend = getOne("SELECT 1 AS ok FROM friendships WHERE user_id = ? AND friend_user_id = ?", [me.id, friend.id]);
    if (!isFriend) return res.status(403).json({ error: "not_friends" });

    const rows = getAll(
      `
      SELECT
        m.id AS id,
        m.body AS body,
        m.created_at AS createdAt,
        fu.public_id AS fromPublicId,
        tu.public_id AS toPublicId
      FROM messages m
      JOIN users fu ON fu.id = m.from_user_id
      JOIN users tu ON tu.id = m.to_user_id
      WHERE
        (m.from_user_id = ? AND m.to_user_id = ?)
        OR
        (m.from_user_id = ? AND m.to_user_id = ?)
      ORDER BY m.id DESC
      LIMIT 100
    `,
      [me.id, friend.id, friend.id, me.id]
    ).reverse();

    res.json({
      friend: { publicId: friend.publicId, email: friend.email, displayName: friend.displayName, avatarUrl: friend.avatarUrl },
      messages: rows,
    });
  });

  app.post("/api/messages/send", requireAuth, (req, res) => {
    const toPublicId = Number(req.body.toPublicId);
    const body = String(req.body.body || "").trim();
    if (!Number.isInteger(toPublicId)) return res.status(400).json({ error: "invalid_id" });
    if (!body || body.length > 2000) return res.status(400).json({ error: "invalid_message" });

    const me = getOne("SELECT id, public_id AS publicId FROM users WHERE id = ?", [req.session.userId]);
    if (!me) return res.status(401).json({ error: "not_authenticated" });

    const friend = getOne("SELECT id, public_id AS publicId FROM users WHERE public_id = ?", [toPublicId]);
    if (!friend) return res.status(404).json({ error: "user_not_found" });

    const isFriend = getOne("SELECT 1 AS ok FROM friendships WHERE user_id = ? AND friend_user_id = ?", [me.id, friend.id]);
    if (!isFriend) return res.status(403).json({ error: "not_friends" });

    run("INSERT INTO messages (from_user_id, to_user_id, body) VALUES (?, ?, ?)", [me.id, friend.id, body]);
    const msg = getOne(
      `
      SELECT
        m.id AS id,
        m.body AS body,
        m.created_at AS createdAt,
        fu.public_id AS fromPublicId,
        tu.public_id AS toPublicId
      FROM messages m
      JOIN users fu ON fu.id = m.from_user_id
      JOIN users tu ON tu.id = m.to_user_id
      WHERE m.from_user_id = ? AND m.to_user_id = ?
      ORDER BY m.id DESC
      LIMIT 1
    `,
      [me.id, friend.id]
    );

    // emit to receiver if online
    const toSocketId = userSockets.get(friend.id);
    if (toSocketId) io.to(toSocketId).emit("chat:message", msg);

    res.json({ ok: true, message: msg });
  });

  // ----- Socket.IO for presence + WebRTC signaling -----
  io.on("connection", (socket) => {
    socket.on("auth", ({ publicId }) => {
      const user = getOne("SELECT id, public_id FROM users WHERE public_id = ?", [Number(publicId)]);
      if (!user) return;
      userSockets.set(user.id, socket.id);
      socket.data.userId = user.id;
      socket.data.publicId = user.public_id;
      socket.emit("presence:ready", { ok: true });
    });

    socket.on("call:offer", ({ toPublicId, offer }) => {
      const fromUserId = socket.data.userId;
      if (!fromUserId) return;
      const toUser = getOne("SELECT id, public_id FROM users WHERE public_id = ?", [Number(toPublicId)]);
      if (!toUser) return;

      const isFriend = getOne("SELECT 1 AS ok FROM friendships WHERE user_id = ? AND friend_user_id = ?", [
        fromUserId,
        toUser.id,
      ]);
      if (!isFriend) return;

      const toSocketId = userSockets.get(toUser.id);
      if (!toSocketId) {
        socket.emit("call:error", { error: "friend_offline" });
        return;
      }
      io.to(toSocketId).emit("call:incoming", { fromPublicId: socket.data.publicId, offer });
    });

    socket.on("call:answer", ({ toPublicId, answer }) => {
      const fromUserId = socket.data.userId;
      if (!fromUserId) return;
      const toUser = getOne("SELECT id FROM users WHERE public_id = ?", [Number(toPublicId)]);
      if (!toUser) return;
      const toSocketId = userSockets.get(toUser.id);
      if (!toSocketId) return;
      io.to(toSocketId).emit("call:answer", { fromPublicId: socket.data.publicId, answer });
    });

    socket.on("call:ice", ({ toPublicId, candidate }) => {
      const fromUserId = socket.data.userId;
      if (!fromUserId) return;
      const toUser = getOne("SELECT id FROM users WHERE public_id = ?", [Number(toPublicId)]);
      if (!toUser) return;
      const toSocketId = userSockets.get(toUser.id);
      if (!toSocketId) return;
      io.to(toSocketId).emit("call:ice", { fromPublicId: socket.data.publicId, candidate });
    });

    socket.on("disconnect", () => {
      const userId = socket.data.userId;
      if (userId) userSockets.delete(userId);
    });
  });

  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

