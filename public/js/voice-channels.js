/**
 * Voice channel WebRTC mesh + Socket.IO presence.
 */
window.VoiceChannels = (function () {
  let socket = null;
  let me = null;
  let api = null;
  let getStream = null;

  let activeServerId = null;
  let activeChannelId = null;
  let localStream = null;
  let micMuted = false;
  let deafened = false;

  /** @type {Map<number, { pc: RTCPeerConnection, audio: HTMLAudioElement }>} */
  const peers = new Map();
  let voiceState = {};

  const els = {};

  function init(deps) {
    socket = deps.socket;
    me = deps.me;
    api = deps.api;
    getStream = deps.getStream;
    Object.assign(els, deps.elements);
    bindSocket();
    bindControls();
  }

  function bindControls() {
    els.voiceJoinBtn?.addEventListener("click", () => {
      if (activeChannelId) leaveChannel();
      else joinCurrentChannel();
    });
    els.voiceMicBtn?.addEventListener("click", toggleMic);
    els.voiceDeafenBtn?.addEventListener("click", toggleDeafen);
    els.voiceLeaveBtn?.addEventListener("click", leaveChannel);
  }

  function bindSocket() {
    if (!socket) return;
    socket.off("voice:state");
    socket.off("voice:signal");
    socket.off("voice:moved");

    socket.on("voice:state", ({ serverId, channels }) => {
      if (Number(serverId) !== Number(activeServerId)) return;
      voiceState = channels || {};
      window.ServersUI?.renderVoicePresence(voiceState);
      syncPeersForChannel();
    });

    socket.on("voice:signal", async ({ serverId, channelId, fromPublicId, type, payload }) => {
      if (Number(serverId) !== Number(activeServerId) || Number(channelId) !== Number(activeChannelId)) return;
      const pid = Number(fromPublicId);
      if (pid === Number(me?.publicId)) return;
      if (type === "offer") await handleOffer(pid, payload);
      else if (type === "answer") await handleAnswer(pid, payload);
      else if (type === "ice") await handleIce(pid, payload);
    });

    socket.on("voice:moved", ({ serverId, channelId }) => {
      if (Number(serverId) !== Number(activeServerId)) return;
      leaveChannel(false);
      activeChannelId = Number(channelId);
      joinCurrentChannel();
    });
  }

  function setMe(user) {
    me = user;
  }

  function setSocket(s) {
    socket = s;
    bindSocket();
  }

  function setActiveServer(serverId) {
    if (activeServerId && activeServerId !== serverId) leaveChannel();
    activeServerId = serverId;
    voiceState = {};
  }

  function setActiveChannel(channelId, channelName) {
    activeChannelId = channelId;
    if (els.voiceChannelName) els.voiceChannelName.textContent = channelName || "Voice";
    updateJoinButton();
    renderParticipants();
  }

  function updateJoinButton() {
    if (!els.voiceJoinBtn) return;
    const inChannel =
      activeChannelId &&
      voiceState[String(activeChannelId)]?.some((u) => Number(u.publicId) === Number(me?.publicId));
    els.voiceJoinBtn.textContent = inChannel ? "Părăsește voice" : "Intră în voice";
    els.voiceJoinBtn.classList.toggle("btn-danger", !!inChannel);
    els.voiceLeaveBtn?.classList.toggle("hidden", !inChannel);
  }

  function usersInChannel(channelId) {
    return voiceState[String(channelId)] || voiceState[channelId] || [];
  }

  async function ensureLocalStream() {
    if (localStream) return localStream;
    if (getStream) localStream = await getStream();
    else localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return localStream;
  }

  async function joinCurrentChannel() {
    if (!socket || !activeServerId || !activeChannelId) return;
    try {
      await ensureLocalStream();
      applyMicMute();
      socket.emit("voice:join", { serverId: activeServerId, channelId: activeChannelId });
    } catch {
      alert("Permite accesul la microfon pentru voice.");
    }
  }

  function leaveChannel(emit = true) {
    if (emit && socket && activeServerId) socket.emit("voice:leave");
    closeAllPeers();
    updateJoinButton();
    renderParticipants();
  }

  function toggleMic() {
    micMuted = !micMuted;
    applyMicMute();
    els.voiceMicBtn?.classList.toggle("active-off", micMuted);
  }

  function toggleDeafen() {
    deafened = !deafened;
    peers.forEach(({ audio }) => {
      audio.muted = deafened;
    });
    els.voiceDeafenBtn?.classList.toggle("active-off", deafened);
  }

  function applyMicMute() {
    localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !micMuted;
    });
  }

  function closePeer(publicId) {
    const p = peers.get(publicId);
    if (!p) return;
    try {
      p.pc.close();
    } catch {}
    p.audio.remove();
    peers.delete(publicId);
  }

  function closeAllPeers() {
    [...peers.keys()].forEach(closePeer);
  }

  function createPeer(publicId) {
    if (peers.has(publicId)) return peers.get(publicId);
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.muted = deafened;
    audio.style.display = "none";
    document.body.appendChild(audio);

    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0];
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate || !socket) return;
      socket.emit("voice:signal", {
        serverId: activeServerId,
        channelId: activeChannelId,
        toPublicId: publicId,
        type: "ice",
        payload: e.candidate,
      });
    };

    if (localStream) {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    }

    const entry = { pc, audio };
    peers.set(publicId, entry);
    return entry;
  }

  async function syncPeersForChannel() {
    if (!activeChannelId) return;
    const users = usersInChannel(activeChannelId);
    const myPid = Number(me?.publicId);
    const inChannel = users.some((u) => Number(u.publicId) === myPid);
    updateJoinButton();
    renderParticipants();

    if (!inChannel) {
      closeAllPeers();
      return;
    }

    const remoteIds = new Set(users.map((u) => Number(u.publicId)).filter((id) => id !== myPid));

    for (const pid of peers.keys()) {
      if (!remoteIds.has(pid)) closePeer(pid);
    }

    for (const u of users) {
      const pid = Number(u.publicId);
      if (pid === myPid || peers.has(pid)) continue;
      const { pc } = createPeer(pid);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("voice:signal", {
          serverId: activeServerId,
          channelId: activeChannelId,
          toPublicId: pid,
          type: "offer",
          payload: offer,
        });
      } catch {
        closePeer(pid);
      }
    }
  }

  async function handleOffer(fromPublicId, offer) {
    const { pc } = createPeer(fromPublicId);
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("voice:signal", {
      serverId: activeServerId,
      channelId: activeChannelId,
      toPublicId: fromPublicId,
      type: "answer",
      payload: answer,
    });
  }

  async function handleAnswer(fromPublicId, answer) {
    const p = peers.get(fromPublicId);
    if (!p) return;
    await p.pc.setRemoteDescription(answer);
  }

  async function handleIce(fromPublicId, candidate) {
    const p = peers.get(fromPublicId);
    if (!p) return;
    try {
      await p.pc.addIceCandidate(candidate);
    } catch {
      // ignore
    }
  }

  function renderParticipants() {
    if (!els.voiceGrid) return;
    els.voiceGrid.innerHTML = "";
    if (!activeChannelId) return;
    const users = usersInChannel(activeChannelId);
    for (const u of users) {
      const card = document.createElement("div");
      card.className = "voice-participant-card";
      const av = document.createElement("div");
      av.className = "voice-participant-avatar";
      if (u.avatarUrl) {
        const img = document.createElement("img");
        img.src = u.avatarUrl;
        img.alt = "";
        av.appendChild(img);
      } else {
        av.textContent = (u.displayName || String(u.publicId))[0]?.toUpperCase() || "?";
      }
      const name = document.createElement("div");
      name.textContent = u.displayName || `User ${u.publicId}`;
      card.appendChild(av);
      card.appendChild(name);
      els.voiceGrid.appendChild(card);
    }
  }

  return {
    init,
    setMe,
    setSocket,
    setActiveServer,
    setActiveChannel,
    leaveChannel,
    getVoiceState: () => voiceState,
    isInVoice: () =>
      activeChannelId &&
      usersInChannel(activeChannelId).some((u) => Number(u.publicId) === Number(me?.publicId)),
  };
})();
