const el = (id) => document.getElementById(id);

const authView = el("authView");
const appView = el("appView");
const logoutBtn = el("logoutBtn");

const loginForm = el("loginForm");
const signupForm = el("signupForm");
const loginMsg = el("loginMsg");
const signupMsg = el("signupMsg");

const meEmail = el("meEmail");
const meEmailPill = el("meEmailPill");
const avatarText = el("avatarText");
const avatarBtn = el("avatarBtn");
const avatarImg = el("avatarImg");
const meName = el("meName");

const addFriendForm = el("addFriendForm");
const addFriendMsg = el("addFriendMsg");
const friendsList = el("friendsList");

const chatWith = el("chatWith");
const chatMessages = el("chatMessages");
const chatForm = el("chatForm");
const chatInput = el("chatInput");
const chatMsg = el("chatMsg");

const callStatus = el("callStatus");
const remoteAudio = el("remoteAudio");
const hangupBtn = el("hangupBtn");
const acceptBtn = el("acceptBtn");
const declineBtn = el("declineBtn");
const micMuteBtn = el("micMuteBtn");
const remoteMuteBtn = el("remoteMuteBtn");
const remoteVolume = el("remoteVolume");
const remoteVolumeLabel = el("remoteVolumeLabel");
const micVolume = el("micVolume");
const micVolumeLabel = el("micVolumeLabel");

let socket = null;
let me = null; // { publicId, email }
let pc = null;
let localStream = null;
let currentPeerPublicId = null;
let pendingIncoming = null; // { fromPublicId, offer }
let isCaller = false;
let reconnectTimer = null;

let chatPeer = null; // { publicId, email }
let audioCtx = null;
let audioUnlocked = false;

let remoteStreamSource = null;
let remoteGain = null;
let remoteMuted = false;
let micMuted = false;

let localGain = null;
let localRawTrack = null;
let localProcessedTrack = null;

let ringIn = null;
let ringBack = null;

function setMsg(node, text, kind = "muted") {
  node.textContent = text || "";
  node.style.color = kind === "error" ? "rgba(255,90,122,.95)" : "var(--muted)";
}

function show(view) {
  if (view === "auth") {
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    logoutBtn.classList.add("hidden");
  } else {
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    logoutBtn.classList.remove("hidden");
  }
}

function setCallState(state) {
  callStatus.textContent = state;
}

function setIncomingUI(on) {
  acceptBtn.classList.toggle("hidden", !on);
  declineBtn.classList.toggle("hidden", !on);
}

function setInCallUI(on) {
  hangupBtn.classList.toggle("hidden", !on);
}

async function api(path, options = {}) {
  const maxAttempts = 4;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutMs = attempt === 1 ? 12000 : 25000; // Render free can cold-start
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        ...options,
      });
      clearTimeout(t);

      let data = null;
      try {
        data = await res.json();
      } catch {
        // ignore
      }
      if (!res.ok) throw Object.assign(new Error("api_error"), { status: res.status, data });
      return data;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;

      // Retry only for network/timeout/5xx/proxy type errors
      const status = err?.status;
      const retryable =
        err?.name === "AbortError" ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        (typeof status !== "number" && attempt < maxAttempts);

      if (!retryable || attempt === maxAttempts) break;

      // backoff: 0.8s, 1.6s, 2.4s
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }

  throw lastErr || Object.assign(new Error("api_error"), { status: 0, data: null });
}

function initTabs() {
  const tabs = document.querySelectorAll(".tab");
  const loginTab = el("loginTab");
  const signupTab = el("signupTab");

  tabs.forEach((t) =>
    t.addEventListener("click", () => {
      tabs.forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      const name = t.dataset.tab;
      loginTab.classList.toggle("hidden", name !== "login");
      signupTab.classList.toggle("hidden", name !== "signup");
      setMsg(loginMsg, "");
      setMsg(signupMsg, "");
    })
  );
}

function computeAvatar(email, displayName) {
  const base = (displayName || "").trim() || (email || "?").split("@")[0].trim();
  const letters = base
    .split(/[._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return letters || (email?.[0]?.toUpperCase() ?? "?");
}

function unlockAudio() {
  if (audioUnlocked) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    // Ensure it’s running after a user gesture (required on many browsers)
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.01);
    audioUnlocked = true;
  } catch {
    // ignore
  }
}

function playBellMax() {
  unlockAudio();
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(1.0, now + 0.01); // max-ish
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);

  const osc1 = audioCtx.createOscillator();
  osc1.type = "sine";
  osc1.frequency.setValueAtTime(880, now);
  const osc2 = audioCtx.createOscillator();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(1320, now);

  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(audioCtx.destination);

  osc1.start(now);
  osc2.start(now);
  osc1.stop(now + 0.8);
  osc2.stop(now + 0.8);
}

function renderChatMessages(messages) {
  if (!chatMessages) return;
  chatMessages.innerHTML = "";
  for (const m of messages) {
    const b = document.createElement("div");
    b.className = "chat-bubble" + (m.fromPublicId === me?.publicId ? " me" : "");
    const meta = document.createElement("div");
    meta.className = "meta mono";
    meta.textContent = `${m.fromPublicId} • ${m.createdAt}`;
    const body = document.createElement("div");
    body.textContent = m.body;
    b.appendChild(meta);
    b.appendChild(body);
    chatMessages.appendChild(b);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function openChatWith(friend) {
  chatPeer = friend;
  if (chatWith) chatWith.textContent = friend ? `${friend.email}` : "-";
  if (!friend) return;

  try {
    setMsg(chatMsg, "Se încarcă...");
    const data = await api(`/api/messages/${friend.publicId}`);
    renderChatMessages(data.messages || []);
    setMsg(chatMsg, "");
    if (chatInput) chatInput.focus();
  } catch (err) {
    const code = err?.data?.error || "error";
    setMsg(chatMsg, code, "error");
  }
}

function ensureRingers() {
  if (!ringIn) {
    ringIn = new Audio("/sounds/sound1.mp3");
    ringIn.loop = true;
    ringIn.preload = "auto";
  }
  if (!ringBack) {
    ringBack = new Audio("/sounds/sound2.mp3");
    ringBack.loop = true;
    ringBack.preload = "auto";
  }
}

function stopAllRings() {
  for (const a of [ringIn, ringBack]) {
    if (!a) continue;
    try {
      a.pause();
      a.currentTime = 0;
    } catch {}
  }
}

async function startRingIn() {
  unlockAudio();
  ensureRingers();
  stopAllRings();
  try {
    await ringIn.play();
  } catch {
    // Autoplay can be blocked; user gesture will unlock
  }
}

async function startRingBack() {
  unlockAudio();
  ensureRingers();
  stopAllRings();
  try {
    await ringBack.play();
  } catch {}
}

function ensureRemoteAudioGraph(stream) {
  unlockAudio();
  if (!audioCtx) return;
  if (remoteStreamSource && remoteGain) return;
  try {
    remoteStreamSource = audioCtx.createMediaStreamSource(stream);
    remoteGain = audioCtx.createGain();
    remoteGain.gain.value = 1.0;
    remoteStreamSource.connect(remoteGain).connect(audioCtx.destination);
  } catch {}
}

function setRemoteVolumePercent(pct) {
  const v = Math.max(0, Math.min(200, Number(pct)));
  if (remoteVolumeLabel) remoteVolumeLabel.textContent = `${Math.round(v)}%`;
  if (remoteVolume) remoteVolume.value = String(Math.round(v));

  if (!remoteGain) return;
  if (remoteMuted) {
    remoteGain.gain.value = 0;
    return;
  }
  remoteGain.gain.value = v / 100;
}

function setRemoteMuted(on) {
  remoteMuted = !!on;
  if (remoteMuteBtn) remoteMuteBtn.textContent = remoteMuted ? "Unmute audio" : "Mute audio";
  setRemoteVolumePercent(remoteVolume?.value ?? 100);
}

function setMicMuted(on) {
  micMuted = !!on;
  if (micMuteBtn) micMuteBtn.textContent = micMuted ? "Unmute microfon" : "Mute microfon";
  if (localRawTrack) localRawTrack.enabled = !micMuted; // privacy: stop sending mic frames
  setMicVolumePercent(micVolume?.value ?? 100);
}

function setMicVolumePercent(pct) {
  const v = Math.max(0, Math.min(200, Number(pct)));
  if (micVolumeLabel) micVolumeLabel.textContent = `${Math.round(v)}%`;
  if (micVolume) micVolume.value = String(Math.round(v));
  if (!localGain) return;
  if (micMuted) {
    localGain.gain.value = 0;
    return;
  }
  localGain.gain.value = v / 100;
}

async function refreshMe() {
  const data = await api("/api/me");
  if (!data.authenticated) {
    me = null;
    show("auth");
    return;
  }
  me = data.user;
  if (meName) meName.textContent = me.displayName || computeAvatar(me.email, me.displayName);
  meEmail.textContent = me.email;
  if (meEmailPill) meEmailPill.textContent = me.email;
  const initials = computeAvatar(me.email, me.displayName);
  avatarText.textContent = initials;
  if (avatarImg) {
    if (me.avatarUrl) {
      avatarImg.src = me.avatarUrl;
      avatarImg.classList.remove("hidden");
      avatarText.classList.add("hidden");
    } else {
      avatarImg.classList.add("hidden");
      avatarText.classList.remove("hidden");
    }
  }
  setCallState("idle");
  setIncomingUI(false);
  setInCallUI(false);
  show("app");

  // Connect socket for signaling
  if (!socket) {
    socket = io();
    socket.on("connect", () => {
      socket.emit("auth", { publicId: me.publicId });
    });

    socket.on("presence:ready", () => {});

    socket.on("call:incoming", async ({ fromPublicId, offer }) => {
      // If we're already in a call with the same peer, treat as renegotiation (ICE restart, etc.)
      if (pc && currentPeerPublicId === fromPublicId) {
        try {
          await pc.setRemoteDescription(offer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("call:answer", { toPublicId: fromPublicId, answer });
          setCallState("reconnecting...");
          return;
        } catch {
          // fallthrough to busy/ignore
        }
      }

      if (pc || pendingIncoming) return; // busy

      pendingIncoming = { fromPublicId, offer };
      currentPeerPublicId = fromPublicId;
      isCaller = false;
      setCallState(`incoming from ${fromPublicId}`);
      setIncomingUI(true);
      startRingIn();
    });

    socket.on("call:answer", async ({ fromPublicId, answer }) => {
      if (!pc || currentPeerPublicId !== fromPublicId) return;
      await pc.setRemoteDescription(answer);
      stopAllRings();
      setCallState("in_call");
      setInCallUI(true);
    });

    socket.on("call:ice", async ({ fromPublicId, candidate }) => {
      if (!pc || currentPeerPublicId !== fromPublicId) return;
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // ignore
      }
    });

    socket.on("call:error", ({ error }) => {
      setCallState(`error: ${error}`);
      stopAllRings();
      cleanupCall();
    });

    socket.on("chat:message", (msg) => {
      // Bell at maximum (requires user gesture once)
      playBellMax();

      // If this is the currently opened chat, append & scroll
      if (chatPeer && (msg.fromPublicId === chatPeer.publicId || msg.toPublicId === chatPeer.publicId)) {
        // append bubble
        const b = document.createElement("div");
        b.className = "chat-bubble" + (msg.fromPublicId === me?.publicId ? " me" : "");
        const meta = document.createElement("div");
        meta.className = "meta mono";
        meta.textContent = `${msg.fromPublicId} • ${msg.createdAt}`;
        const body = document.createElement("div");
        body.textContent = msg.body;
        b.appendChild(meta);
        b.appendChild(body);
        chatMessages?.appendChild(b);
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
      } else {
        setMsg(chatMsg, "Mesaj nou primit.", "muted");
      }
    });
  }

  await refreshFriends();
}

async function refreshFriends() {
  const data = await api("/api/friends");
  friendsList.innerHTML = "";

  if (!data.friends.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "Nu ai prieteni încă. Adaugă pe cineva prin email.";
    friendsList.appendChild(empty);
    return;
  }

  for (const f of data.friends) {
    const row = document.createElement("div");
    row.className = "friend";

    const meta = document.createElement("div");
    meta.className = "meta";
    const top = document.createElement("div");
    top.className = "mono";
    top.textContent = String(f.publicId);
    const bottom = document.createElement("div");
    bottom.className = "muted";
    bottom.textContent = f.email;
    meta.appendChild(top);
    meta.appendChild(bottom);

    const actions = document.createElement("div");
    actions.className = "actions";
    const callBtn = document.createElement("button");
    callBtn.className = "btn btn-ghost";
    callBtn.textContent = "Sună";
    callBtn.addEventListener("click", () => startCall(f.publicId));
    actions.appendChild(callBtn);

    const chatBtn = document.createElement("button");
    chatBtn.className = "btn btn-ghost";
    chatBtn.textContent = "Chat";
    chatBtn.addEventListener("click", () => openChatWith(f));
    actions.appendChild(chatBtn);

    row.appendChild(meta);
    row.appendChild(actions);
    friendsList.appendChild(row);
  }
}

function makePeerConnection(toPublicId) {
  const config = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
    ],
  };
  pc = new RTCPeerConnection(config);
  currentPeerPublicId = toPublicId;

  pc.onicecandidate = (evt) => {
    if (evt.candidate) {
      socket.emit("call:ice", { toPublicId, candidate: evt.candidate });
    }
  };

  pc.ontrack = (evt) => {
    const [stream] = evt.streams;
    remoteAudio.srcObject = stream;
    // Route remote audio via WebAudio so 0–200% + mute works reliably
    remoteAudio.muted = true; // avoid double-audio from element output
    ensureRemoteAudioGraph(stream);
    setRemoteVolumePercent(remoteVolume?.value ?? 100);
  };

  pc.onconnectionstatechange = () => {
    const st = pc?.connectionState;
    if (st === "connected") setCallState("in_call");
    if (st === "failed") {
      attemptReconnect("failed");
      return;
    }
    if (st === "disconnected") {
      attemptReconnect("disconnected");
      return;
    }
    if (st === "closed") cleanupCall();
  };

  pc.oniceconnectionstatechange = () => {
    const st = pc?.iceConnectionState;
    if (st === "failed") attemptReconnect("ice_failed");
    if (st === "disconnected") attemptReconnect("ice_disconnected");
  };
}

async function attemptReconnect(reason) {
  if (!pc || !socket || !currentPeerPublicId) return;
  if (reconnectTimer) return;

  setCallState(`reconnecting (${reason})...`);

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!pc || !socket || !currentPeerPublicId) return;
    if (!isCaller) return; // caller drives ICE restart

    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      socket.emit("call:offer", { toPublicId: currentPeerPublicId, offer });
    } catch {
      cleanupCall();
    }
  }, 1200);
}

async function getLocalAudio() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });

  // Build a processed track so we can boost/cut mic volume 0–200%
  unlockAudio();
  const rawTrack = localStream.getAudioTracks()[0];
  localRawTrack = rawTrack || null;
  if (audioCtx && rawTrack) {
    try {
      const src = audioCtx.createMediaStreamSource(localStream);
      localGain = audioCtx.createGain();
      const dest = audioCtx.createMediaStreamDestination();
      src.connect(localGain).connect(dest);
      localProcessedTrack = dest.stream.getAudioTracks()[0] || null;
    } catch {
      localGain = null;
      localProcessedTrack = null;
    }
  }

  setMicMuted(micMuted);
  setMicVolumePercent(micVolume?.value ?? 100);
  return localStream;
}

async function startCall(toPublicId) {
  setMsg(addFriendMsg, "");
  if (!socket) return;
  if (pc || pendingIncoming) return;

  try {
    setCallState(`calling ${toPublicId}...`);
    makePeerConnection(toPublicId);
    isCaller = true;
    startRingBack();

    const stream = await getLocalAudio();
    // Send processed mic track if available (supports 0–200% outgoing volume)
    if (localProcessedTrack) {
      pc.addTrack(localProcessedTrack, stream);
    } else {
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("call:offer", { toPublicId, offer });
    setInCallUI(true);
  } catch (e) {
    setCallState("call_failed");
    stopAllRings();
    cleanupCall();
  }
}

async function acceptIncoming() {
  if (!pendingIncoming || !socket) return;
  const { fromPublicId, offer } = pendingIncoming;
  pendingIncoming = null;
  setIncomingUI(false);
  stopAllRings();

  try {
    setCallState("accepting...");
    makePeerConnection(fromPublicId);
    isCaller = false;

    const stream = await getLocalAudio();
    if (localProcessedTrack) {
      pc.addTrack(localProcessedTrack, stream);
    } else {
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    }

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("call:answer", { toPublicId: fromPublicId, answer });
    setInCallUI(true);
    setCallState("in_call");
  } catch {
    setCallState("accept_failed");
    stopAllRings();
    cleanupCall();
  }
}

function declineIncoming() {
  pendingIncoming = null;
  setIncomingUI(false);
  stopAllRings();
  setCallState("idle");
}

function cleanupCall() {
  stopAllRings();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  setIncomingUI(false);
  setInCallUI(false);
  currentPeerPublicId = null;
  pendingIncoming = null;
  isCaller = false;

  if (pc) {
    try {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.close();
    } catch {}
  }
  pc = null;
  remoteAudio.srcObject = null;
  // keep remote gain graph; it's connected to the element
  if (callStatus.textContent !== "idle") setCallState("idle");
}

initTabs();

// avatar click no longer reveals ID; we use email-based friend add now

// Unlock audio on first interaction so notification sound can play
window.addEventListener("pointerdown", unlockAudio, { once: true });

logoutBtn.addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {}
  if (socket) {
    try {
      socket.disconnect();
    } catch {}
  }
  socket = null;
  cleanupCall();
  show("auth");
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg(loginMsg, "Se conectează...");
  const form = new FormData(loginForm);
  const email = form.get("email");
  const password = form.get("password");
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });
    setMsg(loginMsg, "OK");
    await refreshMe();
  } catch (err) {
    const code = err?.data?.error || "error";
    setMsg(loginMsg, code, "error");
  }
});

signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg(signupMsg, "Creează cont...");
  const form = new FormData(signupForm);
  const displayName = form.get("displayName");
  const avatarUrl = form.get("avatarUrl");
  const email = form.get("email");
  const password = form.get("password");
  try {
    const data = await api("/api/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, displayName, avatarUrl }),
    });
    setMsg(signupMsg, `Cont creat. ID-ul tău: ${data.publicId}`);
    await refreshMe();
  } catch (err) {
    const code = err?.data?.error || "error";
    setMsg(signupMsg, code, "error");
  }
});

addFriendForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg(addFriendMsg, "Adaugă...");
  const form = new FormData(addFriendForm);
  const friendEmail = String(form.get("friendEmail") || "").trim().toLowerCase();
  if (!friendEmail.includes("@") || friendEmail.length > 254) {
    setMsg(addFriendMsg, "Email invalid.", "error");
    return;
  }
  try {
    await api("/api/friends/add", { method: "POST", body: JSON.stringify({ friendEmail }) });
    setMsg(addFriendMsg, "Gata.");
    addFriendForm.reset();
    await refreshFriends();
  } catch (err) {
    const code = err?.data?.error || "error";
    setMsg(addFriendMsg, code, "error");
  }
});

chatForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!chatPeer) {
    setMsg(chatMsg, "Selectează un prieten din listă (Chat).", "error");
    return;
  }
  const body = String(chatInput?.value || "").trim();
  if (!body) return;
  if (body.length > 2000) {
    setMsg(chatMsg, "Mesaj prea lung.", "error");
    return;
  }
  try {
    const data = await api("/api/messages/send", {
      method: "POST",
      body: JSON.stringify({ toPublicId: chatPeer.publicId, body }),
    });
    chatInput.value = "";
    setMsg(chatMsg, "");
    // append my own message immediately
    if (data?.message) {
      const msg = data.message;
      const b = document.createElement("div");
      b.className = "chat-bubble me";
      const meta = document.createElement("div");
      meta.className = "meta mono";
      meta.textContent = `${msg.fromPublicId} • ${msg.createdAt}`;
      const bodyEl = document.createElement("div");
      bodyEl.textContent = msg.body;
      b.appendChild(meta);
      b.appendChild(bodyEl);
      chatMessages?.appendChild(b);
      if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  } catch (err) {
    const code = err?.data?.error || "error";
    setMsg(chatMsg, code, "error");
  }
});

hangupBtn.addEventListener("click", () => {
  cleanupCall();
});
acceptBtn.addEventListener("click", () => acceptIncoming());
declineBtn.addEventListener("click", () => declineIncoming());

micMuteBtn?.addEventListener("click", () => {
  unlockAudio();
  setMicMuted(!micMuted);
});

remoteMuteBtn?.addEventListener("click", () => {
  unlockAudio();
  setRemoteMuted(!remoteMuted);
});

remoteVolume?.addEventListener("input", () => {
  unlockAudio();
  setRemoteVolumePercent(remoteVolume.value);
});

micVolume?.addEventListener("input", () => {
  unlockAudio();
  setMicVolumePercent(micVolume.value);
});

// Initialize UI defaults
setRemoteVolumePercent(100);
setRemoteMuted(false);
setMicMuted(false);
setMicVolumePercent(100);

// On load
refreshMe().catch(() => show("auth"));

