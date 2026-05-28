const el = (id) => document.getElementById(id);

const authView = el("authView");
const appView = el("appView");
const logoutBtn = el("logoutBtn");
const enableNotificationsBtn = el("enableNotificationsBtn");

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
const serverIcons = el("serverIcons");
const openServerModalBtn = el("openServerModalBtn");
const closeServerModalBtn = el("closeServerModalBtn");
const serverModal = el("serverModal");
const serverVoicePanel = el("serverVoicePanel");
const discordLayout = el("discordLayout");

const chatMessages = el("chatMessages");
const dmChatHeader = el("dmChatHeader");
const chatHeaderAvatar = el("chatHeaderAvatar");
const chatHeaderStatus = el("chatHeaderStatus");
const chatHeaderSub = el("chatHeaderSub");
const dmChatCallBtn = el("dmChatCallBtn");
const userSettingsModal = el("userSettingsModal");
const closeUserSettingsBtn = el("closeUserSettingsBtn");
const meBio = el("meBio");
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
const callDuration = el("callDuration");
const callMsg = el("callMsg");

const mainTitle = el("mainTitle");
const chatPanel = el("chatPanel");
const callPanel = el("callPanel");
const settingsBio = el("settingsBio");
const callOverlay = el("callOverlay");
const callOverlayIncoming = el("callOverlayIncoming");
const callOverlayActive = el("callOverlayActive");
const callOverlayCalling = el("callOverlayCalling");
const openSettingsBtn = el("openSettingsBtn");

const chatWrap = el("chatWrap");
const chatEmpty = el("chatEmpty");
const incomingCallBanner = el("incomingCallBanner");
const incomingCallText = el("incomingCallText");
const chatAcceptBtn = el("chatAcceptBtn");
const chatDeclineBtn = el("chatDeclineBtn");

const settingsForm = el("settingsForm");
const settingsMsg = el("settingsMsg");
const settingsDisplayName = el("settingsDisplayName");
const settingsAvatarUrl = el("settingsAvatarUrl");
const meIdPill = el("meIdPill");
const mePublicId = el("mePublicId");
const serverSettingsModal = el("serverSettingsModal");
const serverSettingsForm = el("serverSettingsForm");
const serverSettingsName = el("serverSettingsName");
const serverSettingsMsg = el("serverSettingsMsg");
const closeServerSettingsBtn = el("closeServerSettingsBtn");

let socket = null;
let me = null; // { publicId, email }
let pc = null;
let localStream = null;
let currentPeerPublicId = null;
let pendingIncoming = null; // { fromPublicId, offer }
let isCaller = false;
let reconnectTimer = null;
let socketReady = false;

let chatPeer = null; // { publicId, displayName, avatarUrl, online, bio }
/** @type {Map<number, object>} */
const friendsById = new Map();
/** Friends currently online (by publicId), from socket presence */
const onlinePublicIds = new Set();
let socketAuthPromise = null;
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
let callStartedAt = null;
let callTimer = null;
let outgoingNoAnswerTimer = null;

function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

function updateNotificationsButton() {
  if (!enableNotificationsBtn) return;
  if (!notificationsSupported()) {
    enableNotificationsBtn.classList.add("hidden");
    return;
  }
  const denied = Notification.permission === "denied";
  const granted = Notification.permission === "granted";
  enableNotificationsBtn.classList.toggle("hidden", granted);
  enableNotificationsBtn.textContent = denied ? "Notifications blocked in browser" : "Enable notifications";
  enableNotificationsBtn.disabled = denied;
}

async function requestNotificationsPermission() {
  if (!notificationsSupported()) return;
  try {
    await Notification.requestPermission();
  } catch {
    // ignore
  }
  updateNotificationsButton();
}

function showNotification(title, body) {
  if (!notificationsSupported()) return;
  if (Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, icon: "/favicon.ico" });
    setTimeout(() => n.close(), 6000);
  } catch {
    // ignore
  }
}

function setMsg(node, text, kind = "muted") {
  node.textContent = text || "";
  node.style.color = kind === "error" ? "rgba(255,90,122,.95)" : "var(--muted)";
}

function show(view) {
  if (view === "auth") {
    authView.classList.remove("hidden");
    appView.classList.add("hidden");
    document.body.classList.remove("app-logged-in", "mobile-content-open");
    logoutBtn.classList.add("hidden");
    enableNotificationsBtn?.classList.add("hidden");
  } else {
    authView.classList.add("hidden");
    appView.classList.remove("hidden");
    document.body.classList.add("app-logged-in");
    logoutBtn.classList.remove("hidden");
    updateNotificationsButton();
  }
}

function setCallState(state) {
  callStatus.textContent = state;
}

function formatDuration(totalSec) {
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function startCallTimer() {
  stopCallTimer();
  callStartedAt = Date.now();
  if (callDuration) callDuration.textContent = "00:00";
  callTimer = setInterval(() => {
    if (!callStartedAt || !callDuration) return;
    const sec = Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000));
    callDuration.textContent = formatDuration(sec);
    syncOverlayDuration();
  }, 1000);
}

function stopCallTimer() {
  if (callTimer) clearInterval(callTimer);
  callTimer = null;
  callStartedAt = null;
  if (callDuration) callDuration.textContent = "00:00";
}

function clearNoAnswerTimer() {
  if (outgoingNoAnswerTimer) clearTimeout(outgoingNoAnswerTimer);
  outgoingNoAnswerTimer = null;
}

function setIncomingUI(on) {
  acceptBtn.classList.toggle("hidden", !on);
  declineBtn.classList.toggle("hidden", !on);
  incomingCallBanner?.classList.toggle("hidden", !on);
}

function setInCallUI(on) {
  hangupBtn.classList.toggle("hidden", !on);
}

function setMainTab(name) {
  chatPanel?.classList.toggle("hidden", name !== "chat");
  serverVoicePanel?.classList.toggle("hidden", name !== "voice");
  callPanel?.classList.add("hidden");
}

function fillAvatarNode(node, user, fallbackLabel) {
  if (!node) return;
  node.innerHTML = "";
  if (user?.avatarUrl) {
    const img = document.createElement("img");
    img.src = user.avatarUrl;
    img.alt = "";
    img.loading = "lazy";
    node.appendChild(img);
  } else {
    node.textContent = computeAvatar(null, user?.displayName || fallbackLabel || "?");
  }
}

function setStatusDot(dotEl, online) {
  if (!dotEl) return;
  dotEl.classList.remove("online", "offline");
  dotEl.classList.add(online ? "online" : "offline");
}

function updateDmChatHeader(friend) {
  if (!dmChatHeader) return;
  if (!friend) {
    dmChatHeader.classList.add("hidden");
    return;
  }
  dmChatHeader.classList.remove("hidden");
  if (mainTitle) mainTitle.textContent = friend.displayName || `User ${friend.publicId}`;
  if (chatHeaderSub) chatHeaderSub.textContent = friend.online ? "Online" : "Offline";
  setStatusDot(chatHeaderStatus, !!friend.online);
  fillAvatarNode(chatHeaderAvatar, friend, String(friend.publicId));
  if (dmChatCallBtn) {
    dmChatCallBtn.onclick = () => startCall(friend.publicId);
  }
}

function buildChatMessageEl(m) {
  const isMe = m.fromPublicId === me?.publicId;
  const row = document.createElement("div");
  row.className = "chat-msg-row" + (isMe ? " me" : "");

  if (!isMe) {
    const av = document.createElement("div");
    av.className = "chat-msg-avatar";
    const peer =
      m.fromPublicId === chatPeer?.publicId
        ? chatPeer
        : friendsById.get(Number(m.fromPublicId)) || {
            displayName: m.fromDisplayName,
            avatarUrl: m.fromAvatarUrl,
            publicId: m.fromPublicId,
          };
    fillAvatarNode(av, peer, String(m.fromPublicId));
    row.appendChild(av);
  }

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";

  const nameEl = document.createElement("div");
  nameEl.className = "chat-msg-name";
  if (isMe) {
    nameEl.textContent = me?.displayName || "You";
  } else {
    nameEl.textContent =
      m.fromDisplayName || chatPeer?.displayName || friendsById.get(Number(m.fromPublicId))?.displayName || `User ${m.fromPublicId}`;
  }

  const bodyEl = document.createElement("div");
  bodyEl.className = "chat-msg-body";
  bodyEl.textContent = m.body;

  bubble.appendChild(nameEl);
  bubble.appendChild(bodyEl);
  row.appendChild(bubble);
  return row;
}

function fillCallAvatar(node, user, fallbackId) {
  if (!node) return;
  node.innerHTML = "";
  if (user?.avatarUrl) {
    const img = document.createElement("img");
    img.src = user.avatarUrl;
    img.alt = "";
    node.appendChild(img);
  } else {
    const label = user?.displayName || (fallbackId != null ? String(fallbackId) : "?");
    node.textContent = computeAvatar(null, label);
  }
}

let callOverlayMinimized = false;
let activeCallPeer = null;

function hideCallOverlay() {
  callOverlayMinimized = false;
  activeCallPeer = null;
  callOverlay?.classList.add("hidden");
  callOverlayIncoming?.classList.add("hidden");
  callOverlayActive?.classList.add("hidden");
  callOverlayCalling?.classList.add("hidden");
  document.body.classList.remove("in-call-mode", "call-docked");
  el("callDock")?.classList.add("hidden");
}

function minimizeCallOverlay() {
  if (!pc && !pendingIncoming) return;
  callOverlayMinimized = true;
  callOverlay?.classList.add("hidden");
  document.body.classList.remove("in-call-mode");
  document.body.classList.add("call-docked");
  const dock = el("callDock");
  dock?.classList.remove("hidden");
  const label = el("callDockLabel");
  if (label && activeCallPeer) {
    label.textContent = `În apel: ${activeCallPeer.displayName || activeCallPeer.publicId}`;
  }
}

function restoreCallOverlay() {
  if (!pc && !pendingIncoming) return;
  callOverlayMinimized = false;
  el("callDock")?.classList.add("hidden");
  document.body.classList.add("in-call-mode");
  document.body.classList.remove("call-docked");
  callOverlay?.classList.remove("hidden");
  if (pendingIncoming) {
    callOverlayIncoming?.classList.remove("hidden");
    callOverlayActive?.classList.add("hidden");
    callOverlayCalling?.classList.add("hidden");
  } else if (pc) {
    showCallOverlayActive(activeCallPeer || { publicId: currentPeerPublicId });
  } else if (isCaller) {
    showCallOverlayCalling(activeCallPeer || { publicId: currentPeerPublicId });
  }
}

let callVolumeMenu = null;
let callVolumeMenuDismissBound = false;

function closeCallVolumeMenu() {
  if (callVolumeMenu) {
    callVolumeMenu.remove();
    callVolumeMenu = null;
  }
}

function ensureCallVolumeMenuDismiss() {
  if (callVolumeMenuDismissBound) return;
  callVolumeMenuDismissBound = true;
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!callVolumeMenu) return;
      if (callVolumeMenu.contains(e.target)) return;
      closeCallVolumeMenu();
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCallVolumeMenu();
  });
  window.addEventListener("blur", () => closeCallVolumeMenu());
}

function openCallVolumeMenu(evt, anchorEl) {
  evt.preventDefault();
  evt.stopPropagation();
  closeCallVolumeMenu();
  ensureCallVolumeMenuDismiss();

  const menu = document.createElement("div");
  menu.className = "call-volume-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Volum apel");

  const w = 260;
  const h = 130;
  let left = evt.clientX;
  let top = evt.clientY;
  if (anchorEl) {
    const r = anchorEl.getBoundingClientRect();
    left = r.left + r.width / 2 - w / 2;
    top = r.bottom + 8;
  }
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.addEventListener("pointerdown", (e) => e.stopPropagation());
  menu.addEventListener("contextmenu", (e) => e.preventDefault());

  const rLabel = document.createElement("label");
  rLabel.textContent = "Îl auzi";
  rLabel.className = "muted";
  const rInput = document.createElement("input");
  rInput.type = "range";
  rInput.min = "0";
  rInput.max = "200";
  rInput.value = remoteVolume?.value || "100";
  rInput.addEventListener("input", () => {
    unlockAudio();
    setRemoteVolumePercent(rInput.value);
  });

  const mLabel = document.createElement("label");
  mLabel.textContent = "Te aude";
  mLabel.className = "muted";
  const mInput = document.createElement("input");
  mInput.type = "range";
  mInput.min = "0";
  mInput.max = "200";
  mInput.value = micVolume?.value || "100";
  mInput.addEventListener("input", () => {
    unlockAudio();
    setMicVolumePercent(mInput.value);
  });

  menu.appendChild(rLabel);
  menu.appendChild(rInput);
  menu.appendChild(mLabel);
  menu.appendChild(mInput);
  document.body.appendChild(menu);
  callVolumeMenu = menu;
}

function bindCallAvatarContextMenu(node) {
  if (!node || node.dataset.ctxBound) return;
  node.dataset.ctxBound = "1";
  node.addEventListener("contextmenu", (e) => openCallVolumeMenu(e, node));
}

function showCallOverlayIncoming(fromPublicId) {
  document.body.classList.add("in-call-mode");
  callOverlay?.classList.remove("hidden");
  callOverlayIncoming?.classList.remove("hidden");
  callOverlayActive?.classList.add("hidden");
  callOverlayCalling?.classList.add("hidden");
  const friend = chatPeer?.publicId === fromPublicId ? chatPeer : { publicId: fromPublicId };
  fillCallAvatar(el("callOverlayRemoteAvatar"), friend, fromPublicId);
  bindCallAvatarContextMenu(el("callOverlayRemoteAvatar"));
  const t = el("callOverlayIncomingText");
  if (t) t.textContent = `${friend.displayName || fromPublicId} te sună`;
  incomingCallBanner?.classList.add("hidden");
}

function showCallOverlayCalling(peer) {
  activeCallPeer = peer;
  if (callOverlayMinimized) return;
  document.body.classList.add("in-call-mode");
  callOverlay?.classList.remove("hidden");
  callOverlayCalling?.classList.remove("hidden");
  callOverlayIncoming?.classList.add("hidden");
  callOverlayActive?.classList.add("hidden");
  fillCallAvatar(el("callOverlayCallingAvatar"), peer, peer?.publicId);
  const n = el("callOverlayCallingName");
  if (n) n.textContent = peer?.displayName || `User ${peer?.publicId}`;
  const s = el("callOverlayCallingStatus");
  if (s) s.textContent = `Sună ${peer?.publicId}...`;
}

function showCallOverlayActive(peer) {
  activeCallPeer = peer;
  if (callOverlayMinimized) {
    const label = el("callDockLabel");
    if (label) label.textContent = `În apel: ${peer?.displayName || peer?.publicId}`;
    return;
  }
  document.body.classList.add("in-call-mode");
  document.body.classList.remove("call-docked");
  el("callDock")?.classList.add("hidden");
  callOverlay?.classList.remove("hidden");
  callOverlayActive?.classList.remove("hidden");
  callOverlayIncoming?.classList.add("hidden");
  callOverlayCalling?.classList.add("hidden");
  fillCallAvatar(el("callOverlayRemoteAvatarActive"), peer, peer?.publicId);
  fillCallAvatar(el("callOverlayLocalAvatar"), me, me?.publicId);
  bindCallAvatarContextMenu(el("callOverlayRemoteAvatarActive"));
  bindCallAvatarContextMenu(el("callOverlayLocalAvatar"));
  const rn = el("callOverlayRemoteName");
  if (rn) rn.textContent = peer?.displayName || `User ${peer?.publicId}`;
  const ln = el("callOverlayLocalName");
  if (ln) ln.textContent = me?.displayName || "Tu";
  syncOverlayDuration();
}

function syncOverlayDuration() {
  const od = el("callOverlayDuration");
  if (od && callDuration) od.textContent = callDuration.textContent;
}

function appendChatMessages(messages, appendOnly) {
  if (!chatMessages) return;
  if (!appendOnly) chatMessages.innerHTML = "";
  for (const m of messages) {
    chatMessages.appendChild(buildChatMessageEl(m));
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function getVoiceStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

function initServersModule() {
  const serverEls = {
    discordLayout,
    serverRail: el("serverRail"),
    serverIcons,
    homeBtn: el("homeBtn"),
    channelSidebar: el("channelSidebar"),
    channelServerName: el("channelServerName"),
    textChannelsList: el("textChannelsList"),
    voiceChannelsList: el("voiceChannelsList"),
    addTextChannelBtn: el("addTextChannelBtn"),
    addVoiceChannelBtn: el("addVoiceChannelBtn"),
    serverSettingsBtn: el("serverSettingsBtn"),
    openServerModalBtn,
    serverModal,
    createServerPanel: el("createServerPanel"),
    addServerPanel: el("addServerPanel"),
    createServerForm: el("createServerForm"),
    addServerForm: el("addServerForm"),
    serverModalMsg: el("serverModalMsg"),
    closeServerModalBtn,
    serverSettingsModal,
    serverSettingsForm,
    serverSettingsName,
    serverSettingsIconUrl: el("serverSettingsIconUrl"),
    serverSettingsMsg,
    closeServerSettingsBtn,
    inviteCodesBox: el("inviteCodesBox"),
    inviteAdminCode: el("inviteAdminCode"),
    inviteMemberCode: el("inviteMemberCode"),
    mobileMenuBtn: el("mobileMenuBtn"),
    mobileBackBtn: el("mobileBackBtn"),
    mobileCallBtn: el("mobileCallBtn"),
    mobileBackdrop: el("mobileBackdrop"),
    mobileHeaderTitle: el("mobileHeaderTitle"),
    mainTitle,
    chatMsg,
  };

  ServersUI.init({
    api,
    socket,
    me,
    setMsg,
    elements: serverEls,
    onTextChannelMessages: (messages, appendOnly) => {
      chatPeer = null;
      const ch = ServersUI.getCurrentChannel();
      updateDmChatHeader(null);
      if (chatWrap && chatEmpty) {
        chatWrap.classList.remove("hidden");
        chatEmpty.classList.add("hidden");
      }
      appendChatMessages(messages, appendOnly);
    },
    onShowChatPanel: () => {
      setMainTab("chat");
      updateMobileCallBtn(null);
    },
    onShowVoicePanel: () => {
      setMainTab("voice");
      updateMobileCallBtn(null);
    },
    onGoHome: () => {
      chatPeer = null;
      updateMobileCallBtn(null);
      updateDmChatHeader(null);
      if (chatWrap && chatEmpty) {
        chatWrap.classList.toggle("hidden", true);
        chatEmpty.classList.toggle("hidden", false);
      }
      setMainTab("chat");
    },
  });

  ServersUI.setChatPeerClear(() => {
    chatPeer = null;
  });

  VoiceChannels.init({
    socket,
    me,
    api,
    getStream: getVoiceStream,
    unlockAudio,
    getAudioContext: () => audioCtx,
    elements: {
      voiceGrid: el("voiceGrid"),
      voiceChannelName: el("voiceChannelName"),
      voiceJoinBtn: el("voiceJoinBtn"),
      voiceMicBtn: el("voiceMicBtn"),
      voiceDeafenBtn: el("voiceDeafenBtn"),
      voiceLeaveBtn: el("voiceLeaveBtn"),
      voiceStatus: el("voiceStatus"),
    },
  });

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = el(btn.getAttribute("data-copy"));
      if (!input?.value) return;
      navigator.clipboard?.writeText(input.value).catch(() => {
        input.select();
      });
    });
  });
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
  appendChatMessages(messages, false);
}

function updateMobileCallBtn(friend) {
  const btn = el("mobileCallBtn");
  if (!btn) return;
  if (friend && ServersUI?.isMobileViewport?.()) {
    btn.classList.remove("hidden");
    btn.onclick = () => startCall(friend.publicId);
  } else {
    btn.classList.add("hidden");
    btn.onclick = null;
  }
}

function applyPresenceToFriendList() {
  if (!friendsList) return;
  for (const [pid, f] of friendsById) {
    const online = onlinePublicIds.has(pid) || !!f.online;
    f.online = online;
    const row = friendsList.querySelector(`.friend[data-public-id="${pid}"]`);
    const dot = row?.querySelector(".status-dot");
    setStatusDot(dot, online);
  }
  if (chatPeer) {
    const pid = Number(chatPeer.publicId);
    chatPeer.online = onlinePublicIds.has(pid);
    updateDmChatHeader(chatPeer);
  }
}

function setFriendOnline(publicId, online) {
  const pid = Number(publicId);
  if (!Number.isFinite(pid)) return;
  if (online) onlinePublicIds.add(pid);
  else onlinePublicIds.delete(pid);
  const f = friendsById.get(pid);
  if (f) f.online = online;
  if (chatPeer && Number(chatPeer.publicId) === pid) {
    chatPeer.online = online;
    updateDmChatHeader(chatPeer);
  }
  const row = friendsList?.querySelector(`.friend[data-public-id="${pid}"]`);
  const dot = row?.querySelector(".status-dot");
  if (dot) setStatusDot(dot, online);
}

function ensureSocketAuth() {
  if (!socket || !me?.publicId) return Promise.resolve();
  if (socket.connected && socketReady) return Promise.resolve();
  if (socketAuthPromise) return socketAuthPromise;

  socketAuthPromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.off("presence:ready", onReady);
      clearTimeout(timer);
      socketAuthPromise = null;
      resolve();
    };
    const onReady = () => finish();
    socket.on("presence:ready", onReady);
    const timer = setTimeout(finish, 8000);
    if (!socket.connected) socket.connect();
    socket.emit("auth", { publicId: me.publicId });
  });
  return socketAuthPromise;
}

async function openChatWith(friend) {
  ServersUI?.selectHome();
  chatPeer = friend;
  const label = friend ? friend.displayName || `User ${friend.publicId}` : "";
  updateDmChatHeader(friend);
  if (chatWrap && chatEmpty) {
    chatWrap.classList.toggle("hidden", !friend);
    chatEmpty.classList.toggle("hidden", !!friend);
  }
  setMainTab("chat");
  updateMobileCallBtn(friend);
  if (friend) {
    ServersUI?.openMobileContentPane?.(label);
  } else {
    ServersUI?.closeMobileContentPane?.();
  }
  if (!friend) return;

  try {
    setMsg(chatMsg, "Loading…");
    const data = await api(`/api/messages/${friend.publicId}`);
    if (data.friend) {
      chatPeer = { ...friend, ...data.friend, online: friend.online };
      friendsById.set(Number(chatPeer.publicId), chatPeer);
      updateDmChatHeader(chatPeer);
    }
    renderChatMessages(data.messages || []);
    setMsg(chatMsg, "");
    if (chatInput) chatInput.focus();
  } catch (err) {
    const code = err?.data?.error || "error";
    const readable = code === "not_friends" ? "You are no longer friends." : "Could not load chat.";
    setMsg(chatMsg, readable, "error");
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
  el("overlayRemoteMuteBtn")?.classList.toggle("active-off", remoteMuted);
  el("callDockDeafenBtn")?.classList.toggle("active-off", remoteMuted);
  setRemoteVolumePercent(remoteVolume?.value ?? 100);
}

function setMicMuted(on) {
  micMuted = !!on;
  if (micMuteBtn) micMuteBtn.textContent = micMuted ? "Unmute microfon" : "Mute microfon";
  el("overlayMicBtn")?.classList.toggle("active-off", micMuted);
  el("callDockMicBtn")?.classList.toggle("active-off", micMuted);
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
  ServersUI?.setMe(me);
  VoiceChannels?.setMe(me);
  if (meIdPill) meIdPill.textContent = String(me.publicId || "");
  if (mePublicId) mePublicId.textContent = `ID: ${String(me.publicId || "-")}`;
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
  updateNotificationsButton();
  if (notificationsSupported() && Notification.permission === "default") {
    requestNotificationsPermission();
  }

  // prefill settings
  if (settingsDisplayName) settingsDisplayName.value = me.displayName || "";
  if (settingsAvatarUrl) settingsAvatarUrl.value = me.avatarUrl || "";
  if (settingsBio) settingsBio.value = me.bio || "";
  if (meBio) {
    if (me.bio) {
      meBio.textContent = me.bio;
      meBio.classList.remove("hidden");
    } else {
      meBio.textContent = "";
      meBio.classList.add("hidden");
    }
  }

  // Connect socket for signaling
  if (!socket) {
    socket = io();
    socket.on("connect", () => {
      socketReady = false;
      if (me?.publicId) socket.emit("auth", { publicId: me.publicId });
    });

    socket.on("presence:ready", ({ onlinePublicIds: ids }) => {
      socketReady = true;
      if (Array.isArray(ids)) {
        for (const pid of ids) setFriendOnline(pid, true);
      }
      applyPresenceToFriendList();
    });

    socket.on("presence:update", ({ publicId, online }) => {
      setFriendOnline(publicId, online);
    });

    socket.on("disconnect", () => {
      socketReady = false;
    });

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
      if (incomingCallText) incomingCallText.textContent = `${fromPublicId} is calling you`;
      setCallState(`incoming from ${fromPublicId}`);
      setIncomingUI(true);
      showCallOverlayIncoming(fromPublicId);
      startRingIn();
      if (document.hidden) showNotification("Incoming call", `${fromPublicId} is calling you`);
    });

    socket.on("call:answer", async ({ fromPublicId, answer }) => {
      if (!pc || currentPeerPublicId !== fromPublicId) return;
      await pc.setRemoteDescription(answer);
      clearNoAnswerTimer();
      stopAllRings();
      setCallState("in_call");
      setMsg(callMsg, "");
      startCallTimer();
      setInCallUI(true);
      const peer = chatPeer?.publicId === fromPublicId ? chatPeer : { publicId: fromPublicId };
      activeCallPeer = peer;
      showCallOverlayActive(peer);
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
      const readable = error === "friend_offline" ? "Utilizatorul este offline." : "Eroare la apel.";
      setCallState("idle");
      setMsg(callMsg, readable, "error");
      stopAllRings();
      cleanupCall();
    });

    socket.on("chat:message", (msg) => {
      // Bell at maximum (requires user gesture once)
      playBellMax();

      // If this is the currently opened chat, append & scroll
      if (chatPeer && (msg.fromPublicId === chatPeer.publicId || msg.toPublicId === chatPeer.publicId)) {
        chatMessages?.appendChild(buildChatMessageEl(msg));
        if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
      } else {
        setMsg(chatMsg, "New message received.", "muted");
      }
      if (document.hidden && msg.fromPublicId !== me?.publicId) {
        const fromName = msg.fromDisplayName || msg.fromPublicId;
        showNotification("New message", `${fromName}: ${String(msg.body || "").slice(0, 80)}`);
      }
    });

  }

  ServersUI?.setSocket(socket);
  VoiceChannels?.setSocket(socket);
  await ensureSocketAuth();
  await refreshFriends();
  applyPresenceToFriendList();
  await ServersUI?.loadServers();
}

async function refreshFriends() {
  const data = await api("/api/friends");
  friendsList.innerHTML = "";
  friendsById.clear();

  if (!data.friends.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No friends yet. Add someone by ID.";
    friendsList.appendChild(empty);
    return;
  }

  for (const f of data.friends) {
    const pid = Number(f.publicId);
    f.online = !!f.online || onlinePublicIds.has(pid);
    if (f.online) onlinePublicIds.add(pid);
    friendsById.set(pid, f);

    const row = document.createElement("div");
    row.className = "friend";
    row.dataset.publicId = String(f.publicId);

    const meta = document.createElement("div");
    meta.className = "meta friend-meta";

    const avWrap = document.createElement("div");
    avWrap.className = "avatar-with-status";

    const avatar = document.createElement("div");
    avatar.className = "friend-avatar";
    fillAvatarNode(avatar, f, String(f.publicId));

    const dot = document.createElement("span");
    dot.className = "status-dot " + (f.online || onlinePublicIds.has(pid) ? "online" : "offline");
    avWrap.appendChild(avatar);
    avWrap.appendChild(dot);

    const who = document.createElement("div");
    who.className = "friend-who";
    const name = document.createElement("div");
    name.className = "friend-name";
    name.textContent = f.displayName || `User ${f.publicId}`;
    who.appendChild(name);

    meta.appendChild(avWrap);
    meta.appendChild(who);

    const chevron = document.createElement("div");
    chevron.className = "friend-chevron";
    chevron.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    row.appendChild(meta);
    row.appendChild(chevron);
    friendsList.appendChild(row);

    row.addEventListener("click", () => {
      document.querySelectorAll(".friend.active").forEach((n) => n.classList.remove("active"));
      row.classList.add("active");
      openChatWith(f);
    });
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
    if (st === "connected") {
      clearNoAnswerTimer();
      setCallState("in_call");
      setMsg(callMsg, "");
      if (!callStartedAt) startCallTimer();
    }
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
  if (!socketReady) {
    setCallState("connecting...");
    setMsg(callMsg, "Așteaptă 1-2 secunde și încearcă din nou (socket încă se autentifică).", "error");
    return;
  }
  if (pc || pendingIncoming) return;

  const peer = chatPeer?.publicId === toPublicId ? chatPeer : { publicId: toPublicId, displayName: null, avatarUrl: null };
  activeCallPeer = peer;

  try {
    setCallState(`calling ${toPublicId}...`);
    setMsg(callMsg, "");
    showCallOverlayCalling(peer);
    makePeerConnection(toPublicId);
    isCaller = true;
    startRingBack();
    clearNoAnswerTimer();
    outgoingNoAnswerTimer = setTimeout(() => {
      if (pc && isCaller) {
        setCallState("idle");
        setMsg(callMsg, "Nu a răspuns. Apel închis automat.", "error");
        cleanupCall();
      }
    }, 30000);

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
    setMsg(callMsg, "Apelul nu a pornit.", "error");
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
    setMsg(callMsg, "");
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
    startCallTimer();
    const peer = chatPeer?.publicId === fromPublicId ? chatPeer : { publicId: fromPublicId };
    showCallOverlayActive(peer);
  } catch {
    setCallState("accept_failed");
    setMsg(callMsg, "Nu am putut accepta apelul.", "error");
    stopAllRings();
    cleanupCall();
  }
}

function declineIncoming() {
  pendingIncoming = null;
  setIncomingUI(false);
  stopAllRings();
  setCallState("idle");
  setMsg(callMsg, "");
  hideCallOverlay();
}

function cleanupCall() {
  stopAllRings();
  clearNoAnswerTimer();
  stopCallTimer();
  hideCallOverlay();
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
  const friendPublicId = Number(form.get("friendPublicId"));
  if (!Number.isInteger(friendPublicId)) {
    setMsg(addFriendMsg, "ID invalid.", "error");
    return;
  }
  try {
    await api("/api/friends/add", { method: "POST", body: JSON.stringify({ friendPublicId }) });
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
  const serverChannel = ServersUI?.getCurrentChannel();
  const server = ServersUI?.getCurrentServer();
  if (!chatPeer && !serverChannel) {
    setMsg(chatMsg, "Selectează un prieten sau un canal text.", "error");
    return;
  }
  const body = String(chatInput?.value || "").trim();
  if (!body) return;
  if (body.length > 2000) {
    setMsg(chatMsg, "Mesaj prea lung.", "error");
    return;
  }
  try {
    const data =
      server && serverChannel?.type === "text"
        ? await ServersUI.sendChannelMessage(body)
        : await api("/api/messages/send", {
            method: "POST",
            body: JSON.stringify({ toPublicId: chatPeer.publicId, body }),
          });
    chatInput.value = "";
    setMsg(chatMsg, "");
    // append my own message immediately
    if (data?.message) {
      chatMessages?.appendChild(buildChatMessageEl(data.message));
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
chatAcceptBtn?.addEventListener("click", () => acceptIncoming());
chatDeclineBtn?.addEventListener("click", () => declineIncoming());

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

el("overlayAcceptBtn")?.addEventListener("click", () => acceptIncoming());
el("overlayDeclineBtn")?.addEventListener("click", () => declineIncoming());
el("overlayHangupBtn")?.addEventListener("click", () => cleanupCall());
el("overlayCancelCallBtn")?.addEventListener("click", () => cleanupCall());
el("overlayMicBtn")?.addEventListener("click", () => {
  unlockAudio();
  setMicMuted(!micMuted);
});
el("overlayRemoteMuteBtn")?.addEventListener("click", () => {
  unlockAudio();
  setRemoteMuted(!remoteMuted);
});
el("overlayCloseTabBtn")?.addEventListener("click", () => minimizeCallOverlay());
el("callDockOpenBtn")?.addEventListener("click", () => restoreCallOverlay());
el("callDockMicBtn")?.addEventListener("click", () => {
  unlockAudio();
  setMicMuted(!micMuted);
});
el("callDockDeafenBtn")?.addEventListener("click", () => {
  unlockAudio();
  setRemoteMuted(!remoteMuted);
});
openSettingsBtn?.addEventListener("click", () => {
  userSettingsModal?.classList.remove("hidden");
});
closeUserSettingsBtn?.addEventListener("click", () => userSettingsModal?.classList.add("hidden"));
userSettingsModal?.addEventListener("click", (e) => {
  if (e.target === userSettingsModal) userSettingsModal.classList.add("hidden");
});
enableNotificationsBtn?.addEventListener("click", () => requestNotificationsPermission());
settingsForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg(settingsMsg, "Salvez...");
  const form = new FormData(settingsForm);
  const displayName = String(form.get("displayName") || "").trim();
  const avatarUrl = String(form.get("avatarUrl") || "").trim();
  const bio = String(form.get("bio") || "").trim();
  try {
    const data = await api("/api/profile", { method: "POST", body: JSON.stringify({ displayName, avatarUrl, bio }) });
    me = data.user;
    setMsg(settingsMsg, "Gata.");
    await refreshMe();
  } catch (err) {
    const code = err?.data?.error || "error";
    setMsg(settingsMsg, code, "error");
  }
});

function reauthSocket() {
  if (socket && me?.publicId) {
    socketReady = false;
    socket.emit("auth", { publicId: me.publicId });
  }
}
window.reauthSocket = reauthSocket;

// Initialize UI defaults
initServersModule();
setRemoteVolumePercent(100);
setRemoteMuted(false);
setMicMuted(false);
setMicVolumePercent(100);
setMainTab("chat");
if (chatWrap && chatEmpty) {
  chatWrap.classList.add("hidden");
  chatEmpty.classList.remove("hidden");
}

// On load
refreshMe().catch(() => show("auth"));

