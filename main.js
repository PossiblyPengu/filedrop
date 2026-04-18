// Main JS moved from index.html
// ...all app logic from the previous inline <script> block in index.html...
// (See previous extraction, including all functions, variables, and event handlers)

// === Begin migrated app logic from index.html ===

// (All code from the previous inline <script> block in index.html, including all variables, functions, and event handlers, should be pasted here. See previous extraction for the full code.)

const RECV_BATCH_SIZE = 8;
const PEERJS_CFG = {
  host: "0.peerjs.com",
  port: 443,
  path: "/",
  secure: true,
  config: {
    iceServers: [
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "stun:stun.l.google.com:19302" },
    ],
  },
};
let peer = null,
  conn = null,
  isHost = false;
let selectedFiles = [],
  sentFiles = [],
  recvBuffers = {},
  recvMeta = {};
let cryptoKey = null,
  roomPin = null,
  pinPending = false;
let localECDHKeyPair = null,
  pinFailCount = 0,
  receivedBlobURLs = [],
  sendThumbURLs = new Map();
let sendStartTime = 0,
  sendTotalBytes = 0,
  sendBytesSent = 0;
let recvStartTime = 0,
  recvTotalBytes = 0,
  recvBytesReceived = 0,
  recvSpeedInterval = null;
let currentRoomCode = "",
  reconnectAttempts = 0,
  reconnectTimer = null,
  toastTimer = null,
  pendingSendIdx = 0;
const MAX_RETRIES = 5,
  RETRY_DELAY = 100,
  MAX_RECONNECT = 5;
let qrScanner = null;
let transferPaused = false,
  transferCancelled = false,
  currentSendIdx = 0,
  currentSendProgress = 0;
let recvQueue = [],
  recvProcessing = false;
let wakeLock = null,
  hostPubKeyArr = null;

// ...all other functions and logic from the previous inline script...

// === End migrated app logic ===

// --- Auto-join room from URL (?room=XXXXXX) ---
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room && /^[A-Z0-9]{6}$/i.test(room)) {
    // Show join UI, fill code, and auto-join
    if (typeof showJoin === 'function') showJoin();
    const input = document.getElementById('join-code-input');
    if (input) input.value = room.toUpperCase();
    if (typeof joinRoom === 'function') joinRoom(room.toUpperCase());
  }
});
