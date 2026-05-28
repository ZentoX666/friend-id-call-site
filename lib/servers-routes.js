function registerServerRoutes(app, { getOne, getAll, run, generateUniqueInviteCode: genInvite }, io) {
  async function getMember(userId, serverId) {
    return getOne(
      `
      SELECT sm.role, s.name, s.icon_url AS iconUrl, s.owner_user_id AS ownerUserId
      FROM server_members sm
      JOIN servers s ON s.id = sm.server_id
      WHERE sm.server_id = ? AND sm.user_id = ?
    `,
      [serverId, userId]
    );
  }

  function isAdmin(member) {
    return member?.role === "admin";
  }

  async function listChannelsForMember(serverId, role) {
    const rows = await getAll(
      `
      SELECT id, name, type, admin_only AS adminOnly, position
      FROM channels
      WHERE server_id = ?
      ORDER BY position ASC, id ASC
    `,
      [serverId]
    );
    if (role === "admin") return rows;
    return rows.filter((c) => !c.adminOnly);
  }

  app.get("/api/servers", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" });
    const servers = await getAll(
      `
      SELECT
        s.id AS serverId,
        s.name,
        s.icon_url AS iconUrl,
        sm.role,
        s.owner_user_id AS ownerUserId
      FROM server_members sm
      JOIN servers s ON s.id = sm.server_id
      WHERE sm.user_id = ?
      ORDER BY sm.joined_at DESC
    `,
      [req.session.userId]
    );
    res.json({
      servers: servers.map((s) => ({
        serverId: s.serverId,
        name: s.name,
        iconUrl: s.iconUrl || null,
        role: s.role,
        isOwner: Number(s.ownerUserId) === Number(req.session.userId),
      })),
    });
  });

  app.post("/api/servers", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" });
    try {
      const name = String(req.body.name || "").trim();
      if (!name || name.length > 80) return res.status(400).json({ error: "invalid_server_name" });

      await run("INSERT INTO servers (name, icon_url, owner_user_id) VALUES (?, ?, ?)", [
        name,
        null,
        req.session.userId,
      ]);
      const server = await getOne(
        "SELECT id AS serverId, name, icon_url AS iconUrl FROM servers WHERE owner_user_id = ? ORDER BY id DESC LIMIT 1",
        [req.session.userId]
      );

      await run("INSERT INTO server_members (server_id, user_id, role) VALUES (?, ?, ?)", [
        server.serverId,
        req.session.userId,
        "admin",
      ]);

      await run(
        "INSERT INTO channels (server_id, name, type, admin_only, position) VALUES (?, ?, ?, ?, ?)",
        [server.serverId, "general", "text", 0, 0]
      );
      await run(
        "INSERT INTO channels (server_id, name, type, admin_only, position) VALUES (?, ?, ?, ?, ?)",
        [server.serverId, "General", "voice", 0, 1]
      );

      const adminCode = await genInvite();
      const memberCode = await genInvite();
      await run("INSERT INTO invite_codes (server_id, code, role) VALUES (?, ?, ?)", [
        server.serverId,
        adminCode,
        "admin",
      ]);
      await run("INSERT INTO invite_codes (server_id, code, role) VALUES (?, ?, ?)", [
        server.serverId,
        memberCode,
        "member",
      ]);

      const channels = await listChannelsForMember(server.serverId, "admin");

      res.json({
        ok: true,
        server: {
          serverId: server.serverId,
          name: server.name,
          iconUrl: server.iconUrl || null,
          role: "admin",
        },
        invites: { admin: adminCode, member: memberCode },
        channels,
      });
    } catch (e) {
      res.status(500).json({ error: "server_error" });
    }
  });

  app.post("/api/servers/join", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" });
    try {
      const code = String(req.body.inviteCode || "").trim();
      if (code.length < 10) return res.status(400).json({ error: "invalid_invite_code" });

      const invite = await getOne(
        "SELECT id, server_id AS serverId, role FROM invite_codes WHERE code = ?",
        [code]
      );
      if (!invite) return res.status(404).json({ error: "invite_not_found" });

      const existing = await getOne(
        "SELECT role FROM server_members WHERE server_id = ? AND user_id = ?",
        [invite.serverId, req.session.userId]
      );
      if (!existing) {
        await run("INSERT INTO server_members (server_id, user_id, role) VALUES (?, ?, ?)", [
          invite.serverId,
          req.session.userId,
          invite.role,
        ]);
      }

      const server = await getOne(
        "SELECT id AS serverId, name, icon_url AS iconUrl FROM servers WHERE id = ?",
        [invite.serverId]
      );
      const member = await getMember(req.session.userId, invite.serverId);
      const channels = await listChannelsForMember(invite.serverId, member.role);

      res.json({
        ok: true,
        server: {
          serverId: server.serverId,
          name: server.name,
          iconUrl: server.iconUrl || null,
          role: member.role,
        },
        channels,
      });
    } catch {
      res.status(500).json({ error: "server_error" });
    }
  });

  app.get("/api/servers/:serverId", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" });
    const serverId = Number(req.params.serverId);
    if (!serverId) return res.status(400).json({ error: "invalid_server" });

    const member = await getMember(req.session.userId, serverId);
    if (!member) return res.status(403).json({ error: "not_in_server" });

    const channels = await listChannelsForMember(serverId, member.role);
    let invites = null;
    if (isAdmin(member)) {
      const codes = await getAll(
        "SELECT code, role FROM invite_codes WHERE server_id = ? ORDER BY role ASC",
        [serverId]
      );
      invites = {
        admin: codes.find((c) => c.role === "admin")?.code || null,
        member: codes.find((c) => c.role === "member")?.code || null,
      };
    }

    res.json({
      server: {
        serverId,
        name: member.name,
        iconUrl: member.iconUrl || null,
        role: member.role,
        isOwner: Number(member.ownerUserId) === Number(req.session.userId),
      },
      channels,
      invites,
    });
  });

  app.patch("/api/servers/:serverId", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" });
    const serverId = Number(req.params.serverId);
    const name = String(req.body.name || "").trim();
    const iconUrl = String(req.body.iconUrl || "").trim();
    if (!serverId) return res.status(400).json({ error: "invalid_server" });
    if (!name || name.length > 80) return res.status(400).json({ error: "invalid_server_name" });
    if (iconUrl && iconUrl.length > 500) return res.status(400).json({ error: "invalid_icon_url" });

    const member = await getMember(req.session.userId, serverId);
    if (!isAdmin(member)) return res.status(403).json({ error: "not_admin" });

    await run("UPDATE servers SET name = ?, icon_url = ? WHERE id = ?", [name, iconUrl || null, serverId]);
    res.json({ ok: true, server: { serverId, name, iconUrl: iconUrl || null } });
  });

  app.post("/api/servers/:serverId/channels", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" });
    const serverId = Number(req.params.serverId);
    const name = String(req.body.name || "").trim();
    const type = String(req.body.type || "text");
    const adminOnly = !!req.body.adminOnly;
    if (!serverId) return res.status(400).json({ error: "invalid_server" });
    if (!name || name.length > 80) return res.status(400).json({ error: "invalid_channel_name" });
    if (!["text", "voice"].includes(type)) return res.status(400).json({ error: "invalid_channel_type" });

    const member = await getMember(req.session.userId, serverId);
    if (!isAdmin(member)) return res.status(403).json({ error: "not_admin" });

    const maxPos = await getOne("SELECT MAX(position) AS p FROM channels WHERE server_id = ?", [serverId]);
    const position = (Number(maxPos?.p) || 0) + 1;

    await run(
      "INSERT INTO channels (server_id, name, type, admin_only, position) VALUES (?, ?, ?, ?, ?)",
      [serverId, name, type, adminOnly ? 1 : 0, position]
    );
    const channel = await getOne(
      "SELECT id, name, type, admin_only AS adminOnly, position FROM channels WHERE server_id = ? ORDER BY id DESC LIMIT 1",
      [serverId]
    );

    io.to(`server:${serverId}`).emit("server:channels_updated", { serverId });
    res.json({ ok: true, channel });
  });

  app.delete("/api/servers/:serverId/channels/:channelId", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" });
    const serverId = Number(req.params.serverId);
    const channelId = Number(req.params.channelId);
    if (!serverId || !channelId) return res.status(400).json({ error: "invalid_params" });

    const member = await getMember(req.session.userId, serverId);
    if (!isAdmin(member)) return res.status(403).json({ error: "not_admin" });

    const ch = await getOne("SELECT id FROM channels WHERE id = ? AND server_id = ?", [channelId, serverId]);
    if (!ch) return res.status(404).json({ error: "channel_not_found" });

    await run("DELETE FROM channel_messages WHERE channel_id = ?", [channelId]);
    await run("DELETE FROM channels WHERE id = ?", [channelId]);

    io.to(`server:${serverId}`).emit("server:channels_updated", { serverId });
    res.json({ ok: true });
  });

  app.get("/api/servers/:serverId/channels/:channelId/messages", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" });
    const serverId = Number(req.params.serverId);
    const channelId = Number(req.params.channelId);

    const member = await getMember(req.session.userId, serverId);
    if (!member) return res.status(403).json({ error: "not_in_server" });

    const ch = await getOne(
      "SELECT id, name, type, admin_only AS adminOnly FROM channels WHERE id = ? AND server_id = ?",
      [channelId, serverId]
    );
    if (!ch) return res.status(404).json({ error: "channel_not_found" });
    if (ch.type !== "text") return res.status(400).json({ error: "not_text_channel" });
    if (ch.adminOnly && !isAdmin(member)) return res.status(403).json({ error: "admin_only" });

    const messages = await getAll(
      `
      SELECT
        cm.id AS id,
        cm.body AS body,
        cm.created_at AS createdAt,
        u.public_id AS fromPublicId,
        u.display_name AS fromDisplayName,
        u.avatar_url AS fromAvatarUrl
      FROM channel_messages cm
      JOIN users u ON u.id = cm.from_user_id
      WHERE cm.channel_id = ?
      ORDER BY cm.id DESC
      LIMIT 200
    `,
      [channelId]
    );

    res.json({ channel: ch, messages: messages.reverse() });
  });

  app.post("/api/servers/:serverId/channels/:channelId/messages", async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "not_authenticated" });
    const serverId = Number(req.params.serverId);
    const channelId = Number(req.params.channelId);
    const body = String(req.body.body || "").trim();
    if (!body || body.length > 2000) return res.status(400).json({ error: "invalid_message" });

    const member = await getMember(req.session.userId, serverId);
    if (!member) return res.status(403).json({ error: "not_in_server" });

    const ch = await getOne(
      "SELECT id, name, type, admin_only AS adminOnly FROM channels WHERE id = ? AND server_id = ?",
      [channelId, serverId]
    );
    if (!ch || ch.type !== "text") return res.status(404).json({ error: "channel_not_found" });
    if (ch.adminOnly && !isAdmin(member)) return res.status(403).json({ error: "admin_only" });

    await run("INSERT INTO channel_messages (channel_id, from_user_id, body) VALUES (?, ?, ?)", [
      channelId,
      req.session.userId,
      body,
    ]);

    const msg = await getOne(
      `
      SELECT
        cm.id AS id,
        cm.body AS body,
        cm.created_at AS createdAt,
        u.public_id AS fromPublicId,
        u.display_name AS fromDisplayName,
        u.avatar_url AS fromAvatarUrl
      FROM channel_messages cm
      JOIN users u ON u.id = cm.from_user_id
      WHERE cm.channel_id = ? AND cm.from_user_id = ?
      ORDER BY cm.id DESC LIMIT 1
    `,
      [channelId, req.session.userId]
    );

    io.to(`server:${serverId}`).emit("channel:message", { serverId, channelId, message: msg });
    res.json({ ok: true, message: msg });
  });
}

module.exports = { registerServerRoutes };
