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

const addFriendForm = el("addFriendForm");
const addFriendMsg = el("addFriendMsg");
const friendsList = el("friendsList");

const callStatus = el("callStatus");
const remoteAudio = el("remoteAudio");
const hangupBtn = el("hangupBtn");
const acceptBtn = el("acceptBtn");
const declineBtn = el("declineBtn");

let socket = null;
let me = null; // { publicId, email }
let pc = null;
let localStream = null;
let currentPeerPublicId = null;
let pendingIncoming = null; // { fromPublicId, offer }
let isCaller = false;
let reconnectTimer = null;

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

function computeAvatar(email) {
  const base = (email || "?").split("@")[0].trim();
  const letters = base
    .split(/[._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
  return letters || (email?.[0]?.toUpperCase() ?? "?");
}

async function refreshMe() {
  const data = await api("/api/me");
  if (!data.authenticated) {
    me = null;
    show("auth");
    return;
  }
  me = data.user;
  meEmail.textContent = me.email;
  if (meEmailPill) meEmailPill.textContent = me.email;
  avatarText.textContent = computeAvatar(me.email);
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
    });

    socket.on("call:answer", async ({ fromPublicId, answer }) => {
      if (!pc || currentPeerPublicId !== fromPublicId) return;
      await pc.setRemoteDescription(answer);
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
      cleanupCall();
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
    empty.textContent = "Nu ai prieteni încă. Adaugă pe cineva prin ID.";
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

    const stream = await getLocalAudio();
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("call:offer", { toPublicId, offer });
    setInCallUI(true);
  } catch (e) {
    setCallState("call_failed");
    cleanupCall();
  }
}

async function acceptIncoming() {
  if (!pendingIncoming || !socket) return;
  const { fromPublicId, offer } = pendingIncoming;
  pendingIncoming = null;
  setIncomingUI(false);

  try {
    setCallState("accepting...");
    makePeerConnection(fromPublicId);
    isCaller = false;

    const stream = await getLocalAudio();
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("call:answer", { toPublicId: fromPublicId, answer });
    setInCallUI(true);
    setCallState("in_call");
  } catch {
    setCallState("accept_failed");
    cleanupCall();
  }
}

function declineIncoming() {
  pendingIncoming = null;
  setIncomingUI(false);
  setCallState("idle");
}

function cleanupCall() {
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
  if (callStatus.textContent !== "idle") setCallState("idle");
}

initTabs();

// avatar click no longer reveals ID; we use email-based friend add now

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
  const email = form.get("email");
  const password = form.get("password");
  try {
    const data = await api("/api/signup", { method: "POST", body: JSON.stringify({ email, password }) });
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

hangupBtn.addEventListener("click", () => {
  cleanupCall();
});
acceptBtn.addEventListener("click", () => acceptIncoming());
declineBtn.addEventListener("click", () => declineIncoming());

// On load
refreshMe().catch(() => show("auth"));

