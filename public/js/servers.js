/**
 * Discord-like servers: channels, invites, admin tools.
 */
window.ServersUI = (function () {
  let api = null;
  let socket = null;
  let me = null;
  let setMsg = null;
  let onTextChannelMessages = null;
  let onShowVoicePanel = null;
  let onShowChatPanel = null;
  let onGoHome = null;

  let servers = [];
  let currentServer = null;
  let currentChannel = null;
  let voiceState = {};
  let isAdmin = false;

  const els = {};

  function init(deps) {
    api = deps.api;
    socket = deps.socket;
    me = deps.me;
    setMsg = deps.setMsg;
    onTextChannelMessages = deps.onTextChannelMessages;
    onShowVoicePanel = deps.onShowVoicePanel;
    onShowChatPanel = deps.onShowChatPanel;
    onGoHome = deps.onGoHome;
    Object.assign(els, deps.elements);
    bindEvents();
    bindSocket();
  }

  function setMe(user) {
    me = user;
    VoiceChannels.setMe(user);
  }

  function setSocket(s) {
    socket = s;
    VoiceChannels.setSocket(s);
    bindSocket();
  }

  function bindSocket() {
    if (!socket) return;
    socket.off("channel:message");
    socket.off("server:channels_updated");
    socket.off("voice:state");

    socket.on("channel:message", ({ serverId, channelId, message }) => {
      if (
        currentServer &&
        Number(currentServer.serverId) === Number(serverId) &&
        currentChannel &&
        Number(currentChannel.id) === Number(channelId)
      ) {
        onTextChannelMessages?.([message], true);
      }
    });

    socket.on("server:channels_updated", ({ serverId }) => {
      if (currentServer && Number(currentServer.serverId) === Number(serverId)) {
        loadServerDetail(currentServer.serverId, true);
      }
    });

    socket.on("voice:state", ({ serverId, channels }) => {
      if (currentServer && Number(currentServer.serverId) === Number(serverId)) {
        voiceState = channels || {};
        renderVoicePresence(voiceState);
      }
    });
  }

  function bindEvents() {
    els.homeBtn?.addEventListener("click", () => selectHome());
    els.openServerModalBtn?.addEventListener("click", () => openServerModal("create"));
    els.closeServerModalBtn?.addEventListener("click", () => els.serverModal?.classList.add("hidden"));

    els.serverModal?.querySelectorAll(".server-modal-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        els.serverModal?.querySelectorAll(".server-modal-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const mode = tab.dataset.mode;
        els.createServerPanel?.classList.toggle("hidden", mode !== "create");
        els.addServerPanel?.classList.toggle("hidden", mode !== "add");
      });
    });

    els.createServerForm?.addEventListener("submit", onCreateServer);
    els.addServerForm?.addEventListener("submit", onJoinServer);
    els.serverModal?.addEventListener("click", (e) => {
      if (e.target === els.serverModal) els.serverModal.classList.add("hidden");
    });

    els.addTextChannelBtn?.addEventListener("click", () => showChannelForm("text"));
    els.addVoiceChannelBtn?.addEventListener("click", () => showChannelForm("voice"));
    els.serverSettingsBtn?.addEventListener("click", () => openServerSettings());
    els.closeServerSettingsBtn?.addEventListener("click", () => els.serverSettingsModal?.classList.add("hidden"));
    els.serverSettingsForm?.addEventListener("submit", onSaveServerSettings);

    els.mobileMenuBtn?.addEventListener("click", toggleMobileDrawer);
    els.mobileBackdrop?.addEventListener("click", closeMobileDrawers);

    els.serverSettingsModal?.addEventListener("click", (e) => {
      if (e.target === els.serverSettingsModal) els.serverSettingsModal.classList.add("hidden");
    });
  }

  function toggleMobileDrawer() {
    const layout = els.discordLayout;
    if (!layout) return;
    if (layout.classList.contains("view-server")) {
      els.channelSidebar?.classList.toggle("mobile-open");
    } else {
      els.dmSidebar?.classList.toggle("mobile-open");
      els.serverRail?.classList.toggle("mobile-open");
    }
    els.mobileBackdrop?.classList.toggle("open", true);
  }

  function closeMobileDrawers() {
    els.channelSidebar?.classList.remove("mobile-open");
    els.dmSidebar?.classList.remove("mobile-open");
    els.serverRail?.classList.remove("mobile-open");
    els.mobileBackdrop?.classList.remove("open");
  }

  function openServerModal(mode = "create") {
    els.serverModal?.classList.remove("hidden");
    els.serverModal?.querySelectorAll(".server-modal-tab").forEach((t) => {
      const active = t.dataset.mode === mode;
      t.classList.toggle("active", active);
    });
    els.createServerPanel?.classList.toggle("hidden", mode !== "create");
    els.addServerPanel?.classList.toggle("hidden", mode !== "add");
    if (els.serverModalMsg) els.serverModalMsg.textContent = "";
  }

  async function loadServers() {
    try {
      const data = await api("/api/servers");
      servers = data.servers || [];
      renderServerRail();
    } catch {
      servers = [];
      renderServerRail();
    }
  }

  function renderServerRail() {
    if (!els.serverIcons) return;
    els.serverIcons.innerHTML = "";
    for (const s of servers) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "server-icon";
      btn.title = s.name;
      btn.textContent = (s.name || "S")[0].toUpperCase();
      if (currentServer && currentServer.serverId === s.serverId) btn.classList.add("active");
      btn.addEventListener("click", () => {
        selectServer(s.serverId);
        closeMobileDrawers();
      });
      els.serverIcons.appendChild(btn);
    }
  }

  async function selectServer(serverId) {
    currentChannel = null;
    chatPeerClear();
    await loadServerDetail(serverId);
    els.discordLayout?.classList.remove("view-home");
    els.discordLayout?.classList.add("view-server");
    els.channelSidebar?.classList.remove("hidden");
    els.homeBtn?.classList.remove("active");
    document.querySelectorAll(".server-icon").forEach((n) => n.classList.remove("active"));
    VoiceChannels.setActiveServer(serverId);
    VoiceChannels.leaveChannel();
    if (els.mobileHeaderTitle) els.mobileHeaderTitle.textContent = currentServer?.name || "Server";
    closeMobileDrawers();
  }

  let chatPeerClear = () => {};

  function setChatPeerClear(fn) {
    chatPeerClear = fn;
  }

  async function loadServerDetail(serverId, silent) {
    try {
      const data = await api(`/api/servers/${serverId}`);
      currentServer = {
        ...data.server,
        channels: data.channels,
        invites: data.invites || currentServer?.invites || null,
      };
      isAdmin = currentServer.role === "admin";
      if (els.channelServerName) els.channelServerName.textContent = currentServer.name;
      els.addTextChannelBtn?.classList.toggle("hidden", !isAdmin);
      els.addVoiceChannelBtn?.classList.toggle("hidden", !isAdmin);
      renderChannels(data.channels);
      renderServerRail();
      if (!silent && data.channels?.length) {
        const first = data.channels.find((c) => c.type === "text") || data.channels[0];
        selectChannel(first);
      }
    } catch (err) {
      if (!silent) setMsg?.(els.serverModalMsg, err?.data?.error || "error", "error");
    }
  }

  function selectHome() {
    currentServer = null;
    currentChannel = null;
    VoiceChannels.leaveChannel();
    els.discordLayout?.classList.add("view-home");
    els.discordLayout?.classList.remove("view-server");
    els.channelSidebar?.classList.add("hidden");
    els.homeBtn?.classList.add("active");
    document.querySelectorAll(".server-icon").forEach((n) => n.classList.remove("active"));
    if (els.mobileHeaderTitle) els.mobileHeaderTitle.textContent = "Mesaje directe";
    onGoHome?.();
    closeMobileDrawers();
  }

  function renderChannels(channels) {
    const textList = els.textChannelsList;
    const voiceList = els.voiceChannelsList;
    if (!textList || !voiceList) return;
    textList.innerHTML = "";
    voiceList.innerHTML = "";

    for (const ch of channels.filter((c) => c.type === "text")) {
      textList.appendChild(buildChannelRow(ch));
    }
    for (const ch of channels.filter((c) => c.type === "voice")) {
      const wrap = document.createElement("div");
      wrap.className = "voice-channel-wrap drop-target";
      wrap.dataset.channelId = ch.id;
      wrap.appendChild(buildChannelRow(ch));
      const usersEl = document.createElement("div");
      usersEl.className = "voice-users";
      usersEl.dataset.channelId = ch.id;
      wrap.appendChild(usersEl);
      if (isAdmin) setupVoiceDropTarget(wrap, ch.id);
      voiceList.appendChild(wrap);
    }
    renderVoicePresence(voiceState);
  }

  function buildChannelRow(ch) {
    const row = document.createElement("div");
    row.className = "channel-item" + (ch.adminOnly ? " admin-only" : "");
    row.dataset.channelId = ch.id;
    row.dataset.type = ch.type;
    const icon = document.createElement("span");
    icon.className = "ch-icon";
    icon.textContent = ch.type === "voice" ? "🔊" : "#";
    const label = document.createElement("span");
    label.textContent = ch.name;
    row.appendChild(icon);
    row.appendChild(label);
    if (currentChannel && currentChannel.id === ch.id) row.classList.add("active");

    row.addEventListener("click", () => selectChannel(ch));

    if (isAdmin) {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (confirm(`Ștergi canalul „${ch.name}"?`)) deleteChannel(ch.id);
      });
    }
    return row;
  }

  async function selectChannel(ch) {
    currentChannel = ch;
    document.querySelectorAll(".channel-item").forEach((n) => n.classList.remove("active"));
    document
      .querySelector(`.channel-item[data-channel-id="${ch.id}"]`)
      ?.classList.add("active");

    closeMobileDrawers();

    if (ch.type === "text") {
      onShowChatPanel?.();
      if (els.mainTitle) els.mainTitle.textContent = `# ${ch.name}`;
      try {
        const data = await api(`/api/servers/${currentServer.serverId}/channels/${ch.id}/messages`);
        onTextChannelMessages?.(data.messages || [], false);
      } catch (err) {
        onTextChannelMessages?.([], false);
        setMsg?.(els.chatMsg, err?.data?.error || "error", "error");
      }
    } else {
      onShowVoicePanel?.();
      if (els.mainTitle) els.mainTitle.textContent = `🔊 ${ch.name}`;
      VoiceChannels.setActiveChannel(ch.id, ch.name);
    }
  }

  function renderVoicePresence(state) {
    voiceState = state || voiceState;
    document.querySelectorAll(".voice-users").forEach((container) => {
      const cid = container.dataset.channelId;
      const users = voiceState[cid] || voiceState[String(cid)] || [];
      container.innerHTML = "";
      for (const u of users) {
        const row = document.createElement("div");
        row.className = "voice-user";
        row.draggable = isAdmin;
        row.dataset.publicId = u.publicId;
        row.dataset.channelId = cid;

        const av = document.createElement("div");
        av.className = "voice-user-avatar";
        if (u.avatarUrl) {
          const img = document.createElement("img");
          img.src = u.avatarUrl;
          av.appendChild(img);
        } else {
          av.textContent = (u.displayName || String(u.publicId))[0]?.toUpperCase() || "?";
        }
        const name = document.createElement("span");
        name.textContent = u.displayName || u.publicId;
        row.appendChild(av);
        row.appendChild(name);

        if (isAdmin) {
          row.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", JSON.stringify({ publicId: u.publicId, fromChannelId: cid }));
            row.classList.add("dragging");
          });
          row.addEventListener("dragend", () => row.classList.remove("dragging"));
        }
        container.appendChild(row);
      }
    });
    VoiceChannels.setActiveChannel(currentChannel?.id, currentChannel?.name);
  }

  function setupVoiceDropTarget(wrap, channelId) {
    wrap.addEventListener("dragover", (e) => {
      e.preventDefault();
      wrap.classList.add("voice-drop-hover");
    });
    wrap.addEventListener("dragleave", () => wrap.classList.remove("voice-drop-hover"));
    wrap.addEventListener("drop", async (e) => {
      e.preventDefault();
      wrap.classList.remove("voice-drop-hover");
      try {
        const { publicId, fromChannelId } = JSON.parse(e.dataTransfer.getData("text/plain"));
        if (String(fromChannelId) === String(channelId)) return;
        socket?.emit("voice:move_user", {
          serverId: currentServer.serverId,
          targetPublicId: publicId,
          toChannelId: channelId,
        });
      } catch {
        // ignore
      }
    });
  }

  function showChannelForm(type) {
    const list = type === "text" ? els.textChannelsList : els.voiceChannelsList;
    if (!list || list.querySelector(".channel-create-form")) return;

    const form = document.createElement("div");
    form.className = "channel-create-form";
    form.innerHTML = `
      <input type="text" placeholder="Nume canal" maxlength="80" class="ch-name-input" />
      <label class="muted" style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <input type="checkbox" class="ch-admin-only" /> Admin Only
      </label>
      <div class="form-inline" style="margin-top:8px">
        <button type="button" class="btn ch-save">Creează</button>
        <button type="button" class="btn btn-ghost ch-cancel">Anulează</button>
      </div>
    `;
    form.querySelector(".ch-cancel").addEventListener("click", () => form.remove());
    form.querySelector(".ch-save").addEventListener("click", async () => {
      const name = form.querySelector(".ch-name-input").value.trim();
      const adminOnly = form.querySelector(".ch-admin-only").checked;
      if (!name) return;
      try {
        await api(`/api/servers/${currentServer.serverId}/channels`, {
          method: "POST",
          body: JSON.stringify({ name, type, adminOnly }),
        });
        form.remove();
        await loadServerDetail(currentServer.serverId, true);
      } catch (err) {
        alert(err?.data?.error || "Nu s-a putut crea canalul");
      }
    });
    list.appendChild(form);
  }

  async function deleteChannel(channelId) {
    try {
      await api(`/api/servers/${currentServer.serverId}/channels/${channelId}`, { method: "DELETE" });
      await loadServerDetail(currentServer.serverId, true);
    } catch (err) {
      alert(err?.data?.error || "Nu s-a putut șterge");
    }
  }

  async function onCreateServer(e) {
    e.preventDefault();
    const name = new FormData(els.createServerForm).get("serverName")?.toString().trim();
    if (!name) return;
    setMsg?.(els.serverModalMsg, "Se creează...");
    try {
      const data = await api("/api/servers", { method: "POST", body: JSON.stringify({ name }) });
      setMsg?.(els.serverModalMsg, "Server creat!");
      els.serverModal?.classList.add("hidden");
      await loadServers();
      window.reauthSocket?.();
      if (data.invites && els.inviteAdminCode) {
        openServerSettingsWithInvites(data.server, data.invites);
      }
      await selectServer(data.server.serverId);
    } catch (err) {
      setMsg?.(els.serverModalMsg, err?.data?.error || "error", "error");
    }
  }

  async function onJoinServer(e) {
    e.preventDefault();
    const inviteCode = new FormData(els.addServerForm).get("inviteCode")?.toString().trim();
    if (!inviteCode || inviteCode.length < 10) {
      setMsg?.(els.serverModalMsg, "Cod invalid (min. 10 caractere).", "error");
      return;
    }
    setMsg?.(els.serverModalMsg, "Te alături...");
    try {
      const data = await api("/api/servers/join", { method: "POST", body: JSON.stringify({ inviteCode }) });
      setMsg?.(els.serverModalMsg, "Gata!");
      els.serverModal?.classList.add("hidden");
      await loadServers();
      window.reauthSocket?.();
      await selectServer(data.server.serverId);
    } catch (err) {
      const msg =
        err?.data?.error === "invite_not_found" ? "Cod invite invalid." : err?.data?.error || "error";
      setMsg?.(els.serverModalMsg, msg, "error");
    }
  }

  function openServerSettings() {
    if (!currentServer) return;
    if (els.serverSettingsName) els.serverSettingsName.value = currentServer.name || "";
    if (els.serverSettingsIconUrl) els.serverSettingsIconUrl.value = currentServer.iconUrl || "";
    if (els.inviteAdminCode && currentServer.invites) {
      els.inviteAdminCode.value = currentServer.invites.admin || "";
      els.inviteMemberCode.value = currentServer.invites.member || "";
      els.inviteCodesBox?.classList.remove("hidden");
    } else if (isAdmin) {
      loadServerDetail(currentServer.serverId, true).then(() => {
        if (currentServer.invites) {
          els.inviteAdminCode.value = currentServer.invites.admin || "";
          els.inviteMemberCode.value = currentServer.invites.member || "";
          els.inviteCodesBox?.classList.remove("hidden");
        }
      });
    }
    els.serverSettingsModal?.classList.remove("hidden");
  }

  function openServerSettingsWithInvites(server, invites) {
    currentServer = { ...server, invites };
    if (els.inviteAdminCode) els.inviteAdminCode.value = invites.admin || "";
    if (els.inviteMemberCode) els.inviteMemberCode.value = invites.member || "";
    els.inviteCodesBox?.classList.remove("hidden");
    els.serverSettingsModal?.classList.remove("hidden");
  }

  async function onSaveServerSettings(e) {
    e.preventDefault();
    if (!currentServer) return;
    const form = new FormData(els.serverSettingsForm);
    try {
      await api(`/api/servers/${currentServer.serverId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.get("name"),
          iconUrl: form.get("iconUrl"),
        }),
      });
      await loadServerDetail(currentServer.serverId, true);
      els.serverSettingsModal?.classList.add("hidden");
    } catch (err) {
      setMsg?.(els.serverSettingsMsg, err?.data?.error || "error", "error");
    }
  }

  async function sendChannelMessage(body) {
    if (!currentServer || !currentChannel || currentChannel.type !== "text") return null;
    return api(`/api/servers/${currentServer.serverId}/channels/${currentChannel.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  function getCurrentServer() {
    return currentServer;
  }

  function getCurrentChannel() {
    return currentChannel;
  }

  return {
    init,
    setMe,
    setSocket,
    setChatPeerClear,
    loadServers,
    selectHome,
    sendChannelMessage,
    getCurrentServer,
    getCurrentChannel,
    renderVoicePresence,
    openServerModal,
  };
})();
