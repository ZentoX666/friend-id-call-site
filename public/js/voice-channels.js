/**
 * Voice channel WebRTC mesh + Socket.IO presence.
 */
window.VoiceChannels = (function () {
  let socket = null;
  let me = null;
  let getStream = null;
  let unlockAudioFn = null;
  let getAudioCtx = null;

  let activeServerId = null;
  let activeChannelId = null;
  let localStream = null;
  let micMuted = false;
  let deafened = false;
  let voiceCtx = null;

  /** @type {Map<number, { pc, iceQueue, gain, source, audioEl }>} */
  const peers = new Map();
  let voiceState = {};

  const els = {};

  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ];

  function init(deps) {
    socket = deps.socket;
    me = deps.me;
    getStream = deps.getStream;
    unlockAudioFn = deps.unlockAudio;
    getAudioCtx = deps.getAudioContext;
    Object.assign(els, deps.elements);
    bindSocket();
    bindControls();
  }

  function unlockPlayback() {
    try {
      unlockAudioFn?.();
    } catch {
      // ignore
    }
  }

  function getVoiceAudioContext() {
    unlockPlayback();
    if (!voiceCtx) {
      try {
        voiceCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        return null;
      }
    }
    if (voiceCtx.state === "suspended") voiceCtx.resume().catch(() => {});
    return voiceCtx;
  }

  /** Canalul în care suntem conectați la voice (din prezență server). */
  function findMyVoiceChannelId() {
    const myPid = Number(me?.publicId);
    if (!myPid) return activeChannelId;
    for (const [chId, users] of Object.entries(voiceState)) {
      const list = users || [];
      if (list.some((u) => Number(u.publicId) === myPid)) return Number(chId);
    }
    return activeChannelId;
  }

  function channelMatchesSession(channelId) {
    const myCh = findMyVoiceChannelId();
    return Number(channelId) === Number(myCh);
  }

  function iAmOfferer(remotePid) {
    return Number(me?.publicId) < Number(remotePid);
  }

  function bindControls() {
    els.voiceJoinBtn?.addEventListener("click", () => {
      unlockPlayback();
      if (isInVoice()) leaveChannel();
      else joinCurrentChannel();
    });
    els.voiceMicBtn?.addEventListener("click", toggleMic);
    els.voiceDeafenBtn?.addEventListener("click", toggleDeafen);
    els.voiceLeaveBtn?.addEventListener("click", () => leaveChannel());
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
      const myCh = findMyVoiceChannelId();
      if (myCh) {
        if (Number(activeChannelId) !== Number(myCh)) {
          activeChannelId = myCh;
          const ch = window.ServersUI?.getChannelById?.(myCh);
          if (ch) window.ServersUI?.focusVoiceChannel?.(myCh, { rejoin: false });
        }
        syncPeersForChannel();
      } else {
        closeAllPeers();
        updateJoinButton();
        renderParticipants();
      }
    });

    socket.on("voice:signal", async ({ serverId, channelId, fromPublicId, type, payload }) => {
      if (Number(serverId) !== Number(activeServerId) || !channelMatchesSession(channelId)) return;
      if (Number(channelId) !== Number(activeChannelId)) activeChannelId = Number(channelId);
      const pid = Number(fromPublicId);
      if (pid === Number(me?.publicId)) return;
      try {
        if (type === "offer") await handleOffer(pid, payload);
        else if (type === "answer") await handleAnswer(pid, payload);
        else if (type === "ice") await handleIce(pid, payload);
      } catch (err) {
        setStatus("Semnal voice: " + (err?.message || "eroare"));
      }
    });

    socket.on("voice:moved", async ({ serverId, channelId }) => {
      if (Number(serverId) !== Number(activeServerId)) return;
      const newCid = Number(channelId);
      closeAllPeers();
      activeChannelId = newCid;
      window.ServersUI?.focusVoiceChannel?.(newCid, { rejoin: false });
      try {
        await ensureLocalStream();
        applyMicMute();
      } catch {
        // mic optional for listen-only after move
      }
      syncPeersForChannel();
      setTimeout(() => syncPeersForChannel(), 600);
      setTimeout(() => syncPeersForChannel(), 1500);
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

  function isInVoice() {
    if (!activeChannelId || !me?.publicId) return false;
    const users = usersInChannel(activeChannelId);
    return users.some((u) => Number(u.publicId) === Number(me.publicId));
  }

  function updateJoinButton() {
    if (!els.voiceJoinBtn) return;
    const inCh = isInVoice();
    els.voiceJoinBtn.textContent = inCh ? "Părăsește voice" : "Intră în voice";
    els.voiceJoinBtn.classList.toggle("btn-danger", inCh);
    els.voiceLeaveBtn?.classList.toggle("hidden", !inCh);
  }

  function usersInChannel(channelId) {
    return voiceState[String(channelId)] || voiceState[channelId] || [];
  }

  function setStatus(text) {
    if (els.voiceStatus) els.voiceStatus.textContent = text || "";
  }

  async function ensureLocalStream() {
    if (localStream) return localStream;
    unlockPlayback();
    getVoiceAudioContext();
    if (getStream) localStream = await getStream();
    else {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    }
    return localStream;
  }

  function ensureLocalTracksOnPc(pc) {
    if (!localStream || !pc) return;
    const hasAudio = pc.getSenders().some((s) => s.track?.kind === "audio");
    if (!hasAudio) {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    }
  }

  function connectRemoteAudio(entry, stream) {
    unlockPlayback();
    getVoiceAudioContext();

    if (entry.audioEl) {
      try {
        entry.audioEl.srcObject = null;
        entry.audioEl.remove();
      } catch {}
      entry.audioEl = null;
    }

    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.playsInline = true;
    audio.setAttribute("playsinline", "true");
    audio.srcObject = stream;
    audio.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;pointer-events:none;";
    document.body.appendChild(audio);
    entry.audioEl = audio;

    const ctx = voiceCtx;
    if (ctx) {
      try {
        if (entry.source) {
          try {
            entry.source.disconnect();
          } catch {}
        }
        if (entry.gain) {
          try {
            entry.gain.disconnect();
          } catch {}
        }
        entry.source = ctx.createMediaStreamSource(stream);
        entry.gain = ctx.createGain();
        entry.gain.gain.value = deafened ? 0 : 1;
        entry.source.connect(entry.gain).connect(ctx.destination);
        audio.muted = true;
      } catch {
        audio.muted = deafened;
        audio.play().catch(() => {});
      }
    } else {
      audio.muted = deafened;
      audio.play().catch(() => {});
    }
  }

  async function joinCurrentChannel() {
    if (!socket || !activeServerId || !activeChannelId) {
      setStatus("Selectează un canal voice.");
      return;
    }
    if (!socket.connected) {
      setStatus("Socket neconectat. Reîncarcă pagina.");
      return;
    }
    try {
      setStatus("Conectare la voice...");
      unlockPlayback();
      getVoiceAudioContext();
      await ensureLocalStream();
      applyMicMute();
      socket.emit("voice:join", { serverId: activeServerId, channelId: activeChannelId });
      setStatus("Conectat. Așteaptă alți utilizatori...");
      setTimeout(() => syncPeersForChannel(), 400);
    } catch {
      alert("Permite accesul la microfon pentru voice.");
    }
  }

  function leaveChannel(emit = true) {
    if (emit && socket && activeServerId) socket.emit("voice:leave");
    closeAllPeers();
    setStatus("");
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
    peers.forEach((p) => {
      if (p.gain) p.gain.gain.value = deafened ? 0 : 1;
      if (p.audioEl) p.audioEl.muted = deafened || !!p.gain;
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
      if (p.source) p.source.disconnect();
      if (p.gain) p.gain.disconnect();
      if (p.audioEl) {
        p.audioEl.srcObject = null;
        p.audioEl.remove();
      }
      p.pc.close();
    } catch {}
    peers.delete(publicId);
  }

  function closeAllPeers() {
    [...peers.keys()].forEach(closePeer);
  }

  function createPeer(publicId) {
    if (peers.has(publicId)) {
      ensureLocalTracksOnPc(peers.get(publicId).pc);
      return peers.get(publicId);
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, iceQueue: [], gain: null, source: null, audioEl: null };

    pc.ontrack = (e) => {
      const stream = e.streams?.[0] || (e.track ? new MediaStream([e.track]) : null);
      if (stream) connectRemoteAudio(entry, stream);
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

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setStatus("Conexiune voice activă — ar trebui să auzi.");
        unlockPlayback();
        getVoiceAudioContext();
      }
      if (pc.connectionState === "failed") {
        setStatus("Reconectare voice…");
        closePeer(publicId);
        setTimeout(() => syncPeersForChannel(), 500);
      }
    };

    ensureLocalTracksOnPc(pc);
    peers.set(publicId, entry);
    return entry;
  }

  async function flushIce(publicId) {
    const p = peers.get(publicId);
    if (!p || !p.pc.remoteDescription) return;
    while (p.iceQueue.length) {
      const c = p.iceQueue.shift();
      try {
        await p.pc.addIceCandidate(c);
      } catch {
        // ignore
      }
    }
  }

  async function syncPeersForChannel() {
    const channelId = findMyVoiceChannelId() || activeChannelId;
    if (!channelId) return;
    activeChannelId = channelId;
    await ensureLocalStream().catch(() => {});

    const users = usersInChannel(channelId);
    const myPid = Number(me?.publicId);
    const inChannel = users.some((u) => Number(u.publicId) === myPid);
    updateJoinButton();
    renderParticipants();

    if (!inChannel) {
      closeAllPeers();
      return;
    }

    const remoteUsers = users.filter((u) => Number(u.publicId) !== myPid);
    setStatus(
      remoteUsers.length
        ? `În voice cu ${remoteUsers.length} persoană(e).`
        : "Ești singur în canal. Așteaptă pe cineva."
    );

    const remoteIds = new Set(remoteUsers.map((u) => Number(u.publicId)));

    for (const pid of peers.keys()) {
      if (!remoteIds.has(pid)) closePeer(pid);
    }

    for (const u of remoteUsers) {
      const pid = Number(u.publicId);
      if (peers.has(pid)) {
        ensureLocalTracksOnPc(peers.get(pid).pc);
        continue;
      }
      if (!iAmOfferer(pid)) continue;

      const entry = createPeer(pid);
      const { pc } = entry;
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true });
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
    unlockPlayback();
    getVoiceAudioContext();
    await ensureLocalStream().catch(() => {});

    let entry = peers.get(fromPublicId);
    if (!entry) entry = createPeer(fromPublicId);

    const { pc } = entry;
    if (pc.signalingState === "have-local-offer") {
      try {
        await pc.setLocalDescription({ type: "rollback" });
      } catch {
        closePeer(fromPublicId);
        entry = createPeer(fromPublicId);
      }
    }

    ensureLocalTracksOnPc(entry.pc);
    await entry.pc.setRemoteDescription(offer);
    await flushIce(fromPublicId);
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
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
    await flushIce(fromPublicId);
    unlockPlayback();
  }

  async function handleIce(fromPublicId, candidate) {
    const p = peers.get(fromPublicId);
    if (!p) return;
    if (!p.pc.remoteDescription) {
      p.iceQueue.push(candidate);
      return;
    }
    try {
      await p.pc.addIceCandidate(candidate);
    } catch {
      p.iceQueue.push(candidate);
    }
  }

  function renderParticipants() {
    if (!els.voiceGrid) return;
    els.voiceGrid.innerHTML = "";
    if (!activeChannelId) return;
    const users = usersInChannel(activeChannelId);
    for (const u of users) {
      const card = document.createElement("div");
      card.className = "voice-participant-card" + (Number(u.publicId) === Number(me?.publicId) ? " me" : "");
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
      if (Number(u.publicId) === Number(me?.publicId)) name.textContent += " (tu)";
      card.appendChild(av);
      card.appendChild(name);
      els.voiceGrid.appendChild(card);
    }
  }

  function resyncPeers() {
    syncPeersForChannel();
  }

  return {
    init,
    setMe,
    setSocket,
    setActiveServer,
    setActiveChannel,
    joinCurrentChannel,
    leaveChannel,
    isInVoice,
    toggleMic,
    toggleDeafen,
    resyncPeers,
    getVoiceState: () => voiceState,
  };
})();
