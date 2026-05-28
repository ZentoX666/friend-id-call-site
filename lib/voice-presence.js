/** In-memory voice channel presence per server (real-time). */

function channelKey(serverId, channelId) {
  return `${serverId}:${channelId}`;
}

function createVoicePresence() {
  /** @type {Map<string, Map<number, object>>} */
  const rooms = new Map();

  function getRoom(serverId, channelId) {
    const key = channelKey(serverId, channelId);
    if (!rooms.has(key)) rooms.set(key, new Map());
    return rooms.get(key);
  }

  function join(serverId, channelId, user) {
    for (const [key, members] of rooms) {
      if (key.startsWith(`${serverId}:`) && members.has(user.userId)) {
        members.delete(user.userId);
        if (!members.size) rooms.delete(key);
      }
    }
    getRoom(serverId, channelId).set(user.userId, user);
  }

  function leave(serverId, userId) {
    for (const [key, members] of rooms) {
      if (key.startsWith(`${serverId}:`) && members.has(userId)) {
        members.delete(userId);
        if (!members.size) rooms.delete(key);
        return { channelId: Number(key.split(":")[1]) };
      }
    }
    return null;
  }

  function move(serverId, userId, toChannelId) {
    let user = null;
    for (const [key, members] of rooms) {
      if (key.startsWith(`${serverId}:`) && members.has(userId)) {
        user = members.get(userId);
        members.delete(userId);
        if (!members.size) rooms.delete(key);
        break;
      }
    }
    if (!user) return null;
    getRoom(serverId, toChannelId).set(userId, user);
    return user;
  }

  function snapshot(serverId) {
    const channels = {};
    for (const [key, members] of rooms) {
      if (!key.startsWith(`${serverId}:`)) continue;
      const chId = key.split(":")[1];
      channels[chId] = [...members.values()].map((u) => ({
        publicId: u.publicId,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        userId: u.userId,
      }));
    }
    return channels;
  }

  function attachSocketHandlers(io, { getOne, getAll }) {
    async function memberRole(userId, serverId) {
      const row = await getOne(
        "SELECT role FROM server_members WHERE server_id = ? AND user_id = ?",
        [serverId, userId]
      );
      return row?.role || null;
    }

    async function isChannelInServer(serverId, channelId) {
      const ch = await getOne("SELECT id, type FROM channels WHERE id = ? AND server_id = ?", [channelId, serverId]);
      return ch;
    }

    function broadcastState(serverId) {
      io.to(`server:${serverId}`).emit("voice:state", { serverId, channels: snapshot(serverId) });
    }

    io.on("connection", (socket) => {
      socket.on("voice:join", async ({ serverId, channelId }) => {
        try {
          const uid = socket.data.userId;
          if (!uid) return;
          const sid = Number(serverId);
          const cid = Number(channelId);
          if (!sid || !cid) return;

          const role = await memberRole(uid, sid);
          if (!role) return;

          const ch = await getOne(
            "SELECT id, type, admin_only AS adminOnly FROM channels WHERE id = ? AND server_id = ?",
            [cid, sid]
          );
          if (!ch || ch.type !== "voice") return;
          if (Number(ch.adminOnly) === 1 && role !== "admin") return;

          const user = await getOne(
            "SELECT id, public_id AS publicId, display_name AS displayName, avatar_url AS avatarUrl FROM users WHERE id = ?",
            [uid]
          );
          if (!user) return;

          join(sid, cid, {
            userId: uid,
            publicId: user.publicId,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl || null,
            socketId: socket.id,
          });
          socket.data.voiceServerId = sid;
          socket.data.voiceChannelId = cid;
          const snap = snapshot(sid);
          broadcastState(sid);
          socket.emit("voice:state", { serverId: sid, channels: snap });
        } catch {
          // ignore
        }
      });

      socket.on("voice:leave", async () => {
        try {
          const uid = socket.data.userId;
          const sid = socket.data.voiceServerId;
          if (!uid || !sid) return;
          leave(sid, uid);
          socket.data.voiceChannelId = null;
          broadcastState(sid);
        } catch {
          // ignore
        }
      });

      socket.on("voice:move_user", async ({ serverId, targetPublicId, toChannelId }) => {
        try {
          const uid = socket.data.userId;
          const sid = Number(serverId);
          const toCid = Number(toChannelId);
          const targetPid = Number(targetPublicId);
          if (!uid || !sid || !toCid || !Number.isInteger(targetPid)) return;

          const role = await memberRole(uid, sid);
          if (role !== "admin") return;

          const target = await getOne("SELECT id FROM users WHERE public_id = ?", [targetPid]);
          if (!target) return;

          const toCh = await getOne(
            "SELECT id, type, admin_only AS adminOnly FROM channels WHERE id = ? AND server_id = ?",
            [toCid, sid]
          );
          if (!toCh || toCh.type !== "voice") return;

          const movedUser = move(sid, target.id, toCid);
          if (!movedUser) return;

          if (movedUser.socketId) {
            const targetSocket = io.sockets.sockets.get(movedUser.socketId);
            if (targetSocket) {
              targetSocket.data.voiceChannelId = toCid;
              targetSocket.emit("voice:moved", { serverId: sid, channelId: toCid });
            }
          }

          broadcastState(sid);
        } catch {
          // ignore
        }
      });

      socket.on("voice:signal", async ({ serverId, channelId, toPublicId, type, payload }) => {
        try {
          const uid = socket.data.userId;
          const sid = Number(serverId);
          const cid = Number(channelId);
          const toPid = Number(toPublicId);
          if (!uid || !sid || !cid || !Number.isInteger(toPid)) return;

          const members = getRoom(sid, cid);
          const target = [...members.values()].find((u) => Number(u.publicId) === Number(toPid));
          if (!target?.socketId) return;
          io.to(target.socketId).emit("voice:signal", {
            serverId: sid,
            channelId: cid,
            fromPublicId: socket.data.publicId,
            type,
            payload,
          });
        } catch {
          // ignore
        }
      });

      socket.on("disconnect", () => {
        const uid = socket.data.userId;
        const sid = socket.data.voiceServerId;
        if (uid && sid) {
          leave(sid, uid);
          broadcastState(sid);
        }
      });
    });
  }

  return { attachSocketHandlers, snapshot, join, leave };
}

module.exports = { createVoicePresence };
