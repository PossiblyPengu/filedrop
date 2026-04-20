// main.js - migrated from inline <script> in index.html
// Key improvements in this migration:
// - Externalized inline script for better caching and CSP options
// - Lazy-loads PeerJS and QR code libs when needed
// - Keeps original behavior and public globals for compatibility with inline handlers

const CHUNK = 1048576;
const MAX_BUFFER = 16 * 1024 * 1024;
const CHUNKS_PER_BATCH = 4;
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

// Small helper to dynamically inject a script and await its load
function loadScript(src) {
	return new Promise((resolve, reject) => {
		// If already present and loaded, resolve quickly
		const existing = document.querySelector('script[src="' + src + '"]');
		if (existing) {
			if (existing.hasAttribute('data-loaded')) return resolve();
			existing.addEventListener('load', () => resolve());
			existing.addEventListener('error', (e) => reject(e));
			return;
		}
		const s = document.createElement('script');
		s.src = src;
		s.async = true;
		s.addEventListener('load', () => {
			s.setAttribute('data-loaded', '1');
			resolve();
		});
		s.addEventListener('error', (e) => reject(e));
		document.head.appendChild(s);
	});
}

async function loadPeerLib() {
	if (window.Peer) return;
	try {
		await loadScript('lib/peerjs.min.js');
	} catch (e) {
		console.warn('Failed to load PeerJS library', e);
	}
}

async function requestWakeLock() {
	if (!('wakeLock' in navigator)) return;
	try {
		wakeLock = await navigator.wakeLock.request('screen');
	} catch (e) {}
}
function releaseWakeLock() {
	if (wakeLock) {
		try {
			wakeLock.release();
		} catch (e) {}
		wakeLock = null;
	}
}
function buzz(p) {
	if ('vibrate' in navigator) navigator.vibrate(p);
}
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible' && conn && conn.open) requestWakeLock();
});

async function pasteCode() {
	try {
		const t = await navigator.clipboard.readText();
		const code =
			extractRoomCode(t) ||
			t
				.trim()
				.toUpperCase()
				.replace(/[^A-Z0-9]/g, '')
				.slice(0, 6);
		if (code && code.length === 6) {
			document.getElementById('join-code-input').value = code;
		} else {
			showToast('No room code found in clipboard');
		}
	} catch (e) {
		showToast('Clipboard access denied');
	}
}
function randCode() {
	const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	const a = new Uint32Array(6);
	crypto.getRandomValues(a);
	return Array.from(a, (n) => c[n % c.length]).join('');
}
function fmtSize(b) {
	if (b < 1024) return b + ' B';
	if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
	if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
	return (b / 1073741824).toFixed(1) + ' GB';
}
function fmtETA(s) {
	if (s <= 0) return 'finishing…';
	const m = Math.floor(s / 60);
	return `${m}:${Math.floor(s % 60)
		.toString()
		.padStart(2, '0')} remaining`;
}
function fileIcon(n) {
	const e = (n.split('.').pop() || '').toLowerCase();
	if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic'].includes(e)) return '\uD83D\uDDBC\uFE0F';
	if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(e)) return '\uD83C\uDFAC';
	if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(e)) return '\uD83C\uDFB5';
	if (e === 'pdf') return '\uD83D\uDCC4';
	if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return '\uD83D\uDDDC\uFE0F';
	if (['js', 'ts', 'py', 'html', 'css', 'json', 'md', 'swift'].includes(e)) return '\uD83D\uDCBB';
	return '\uD83D\uDCC1';
}
function safeKey(n) {
	return n.replace(/[^a-z0-9]/gi, '_');
}
function sendProgPctId(file) {
	return 'spct_' + safeKey(file.name) + '_' + file.size;
}
function sendProgRetryId(file) {
	return 'sretry_' + safeKey(file.name) + '_' + file.size;
}
function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}
function roomURL(code) {
	const u = new URL(window.location.href);
	u.hash = '';
	u.search = '';
	u.searchParams.set('room', String(code).toUpperCase().slice(0, 6));
	return u.toString();
}
function show(id, animate = false) {
	const el = document.getElementById(id);
	el.classList.remove('hidden');
	if (animate) el.classList.add('view-transition');
}
function hide(id) {
	const el = document.getElementById(id);
	el.classList.add('hidden');
	el.classList.remove('view-transition');
}
function setDot(s) {
	const el = document.getElementById('room-dot');
	if (el) el.className = 'dot ' + s;
}
function setStatus(t) {
	const el = document.getElementById('room-status-text');
	if (el) el.textContent = t;
}

async function computeFingerprint(hostPub, guestPub) {
	const combined = new Uint8Array([...hostPub, ...guestPub]);
	const hash = await crypto.subtle.digest('SHA-256', combined);
	const hex = Array.from(new Uint8Array(hash))
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase();
	return hex.slice(0, 4) + ' ' + hex.slice(4, 8);
}
function showFingerprint(fp) {
	const el = document.getElementById('room-fingerprint');
	if (!el) return;
	el.innerHTML = `🔑 <span class="fp-value">${fp}</span><span class="fp-hint">&#8212; verify with peer</span>`;
	el.classList.remove('hidden');
}
function sanitizeMime(mime) {
	if (!mime || typeof mime !== 'string') return 'application/octet-stream';
	if (/^image\/(jpeg|png|gif|webp|svg\+xml|heic|heif|bmp|avif)$/i.test(mime)) return mime;
	if (/^video\/(mp4|webm|ogg|quicktime|x-msvideo|x-matroska|m4v|3gpp)$/i.test(mime)) return mime;
	if (/^audio\/(mpeg|wav|ogg|aac|flac|mp4|x-m4a|webm)$/i.test(mime)) return mime;
	if (/^application\/(pdf|zip|x-zip-compressed|x-rar-compressed|x-7z-compressed|gzip|json|octet-stream)$/i.test(mime)) return mime;
	if (/^text\/(plain|markdown|csv)$/i.test(mime)) return mime;
	return 'application/octet-stream';
}
async function genECDHKeyPair() {
	return await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
}
async function exportECDHPubKey(kp) {
	const buf = await crypto.subtle.exportKey('raw', kp.publicKey);
	return Array.from(new Uint8Array(buf));
}
async function deriveSharedAESKey(priv, remotePubArr) {
	const pub = await crypto.subtle.importKey('raw', new Uint8Array(remotePubArr), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	return await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptChunk(data, key) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
	const out = new Uint8Array(12 + enc.byteLength);
	out.set(iv, 0);
	out.set(new Uint8Array(enc), 12);
	return out.buffer;
}
async function decryptChunk(buf, key) {
	return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(buf, 0, 12) }, key, new Uint8Array(buf, 12));
}
async function waitForBuffer() {
	const dc = conn && (conn.dataChannel || conn._dc);
	if (!dc) return;
	while (dc.bufferedAmount > MAX_BUFFER) await new Promise((r) => setTimeout(r, 1));
}
function yieldControl() {
	return new Promise((r) => (requestAnimationFrame ? requestAnimationFrame(r) : setTimeout(r, 0)));
}

async function buildQR(containerId, code) {
	const el = document.getElementById(containerId);
	if (!el) return;
	el.innerHTML = '';
	const size = window.innerWidth < 460 ? 160 : 130;
	if (!window.QRCode) {
		try {
			await loadScript('lib/qrcode.min.js');
		} catch (e) {
			console.warn('Failed to load QR lib', e);
		}
	}
	if (window.QRCode) {
		try {
			new QRCode(el, {
				text: roomURL(code),
				width: size,
				height: size,
				colorDark: '#000',
				colorLight: '#fff',
				correctLevel: QRCode.CorrectLevel.M,
			});
		} catch (e) {
			el.textContent = 'QR unavailable';
		}
	} else {
		el.textContent = 'QR unavailable';
	}
}

function showEnlargedQR() {
	const code = document.getElementById('room-code-display').textContent;
	if (code.includes('\u00B7')) return;
	const modal = document.getElementById('qr-enlarge-modal');
	const container = document.getElementById('enlarged-qr-container');
	container.innerHTML = '';
	// buildQR will lazy-load the QR lib if needed
	buildQR('enlarged-qr-container', code);
	modal.classList.remove('hidden');
	setTimeout(() => modal.classList.add('active'), 10);
}

function closeEnlargedQR() {
	const modal = document.getElementById('qr-enlarge-modal');
	modal.classList.remove('active');
	setTimeout(() => modal.classList.add('hidden'), 300);
}

function showToast(msg) {
	const toast = document.getElementById('toast');
	toast.textContent = msg;
	toast.classList.add('show');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
}

function copyRoomCode() {
	const code = document.getElementById('room-code-display').textContent;
	const btn = document.getElementById('room-copy-btn');
	const orig = btn ? btn.textContent : '';
	navigator.clipboard
		.writeText(roomURL(code))
		.then(() => {
			if (btn) {
				btn.textContent = 'Copied!';
				setTimeout(() => (btn.textContent = orig), 2000);
			}
		})
		.catch(() => showToast('Copy failed — share the code manually'));
}
function shareRoomLink() {
	const code = document.getElementById('room-code-display').textContent;
	if (navigator.share) navigator.share({ title: 'FileDrop', url: roomURL(code) });
	else copyRoomCode();
}

function getHostPin() {
	const v = (id) => document.getElementById(id).value;
	const p = v('host-pin1') + v('host-pin2') + v('host-pin3') + v('host-pin4');
	return p.length === 4 ? p : null;
}
function clearGuestPin() {
	['guest-pin1', 'guest-pin2', 'guest-pin3', 'guest-pin4'].forEach((id) => (document.getElementById(id).value = ''));
	const g1 = document.getElementById('guest-pin1');
	if (g1) g1.focus();
}
function submitPin() {
	const v = (id) => document.getElementById(id).value;
	const p = v('guest-pin1') + v('guest-pin2') + v('guest-pin3') + v('guest-pin4');
	if (p.length === 4 && conn) conn.send({ type: 'pin', pin: p });
}

function onPinKey(e, el) {
	if (e.key === 'Backspace' && !el.value) {
		const prev = el.previousElementSibling;
		if (prev && prev.tagName === 'INPUT') {
			prev.focus();
			prev.select();
		}
	}
}
function onPinInput(el, isGuest = false) {
	el.value = el.value.replace(/[^0-9]/g, '').slice(0, 1);
	if (el.value) {
		const next = el.nextElementSibling;
		if (next && next.tagName === 'INPUT') {
			next.focus();
		} else if (isGuest && el.id === 'guest-pin4') submitPin();
	}
}

function goHome() {
	if (peer) {
		try {
			peer.destroy();
		} catch (e) {}
		peer = null;
	}
	conn = null;
	isHost = false;
	cryptoKey = null;
	roomPin = null;
	pinPending = false;
	localECDHKeyPair = null;
	pinFailCount = 0;
	hostPubKeyArr = null;
	releaseWakeLock();
	const fpEl = document.getElementById('room-fingerprint');
	if (fpEl) {
		fpEl.classList.add('hidden');
		fpEl.innerHTML = '';
	}
	receivedBlobURLs.forEach((u) => {
		try {
			URL.revokeObjectURL(u);
		} catch (e) {}
	});
	receivedBlobURLs = [];
	sendThumbURLs.forEach((u) => {
		try {
			URL.revokeObjectURL(u);
		} catch (e) {}
	});
	sendThumbURLs.clear();
	selectedFiles = [];
	sentFiles = [];
	recvBuffers = {};
	recvMeta = {};
	recvQueue = [];
	recvProcessing = false;
	transferCancelled = false;
	transferPaused = false;
	currentSendIdx = 0;
	currentSendProgress = 0;
	sendStartTime = 0;
	sendTotalBytes = 0;
	sendBytesSent = 0;
	recvStartTime = 0;
	recvTotalBytes = 0;
	recvBytesReceived = 0;
	if (recvSpeedInterval) {
		clearInterval(recvSpeedInterval);
		recvSpeedInterval = null;
	}
	currentRoomCode = '';
	reconnectAttempts = 0;
	pendingSendIdx = 0;
	clearTimeout(reconnectTimer);
	show('view-home');
	hide('view-join');
	hide('view-room');
	hide('camera-btn');
	hide('room-pin-setup');
	hide('room-pin-entry');
	document.getElementById('room-send-list').innerHTML = '';
	document.getElementById('room-recv-list').innerHTML = '<div class="empty">Waiting for files\u2026</div>';
	document.getElementById('room-progress-items').innerHTML = '';
	document.getElementById('room-recv-items').innerHTML = '';
	document.getElementById('room-send-progress').classList.add('hidden');
	document.getElementById('room-recv-progress').classList.add('hidden');
	const sb = document.getElementById('room-send-btn');
	if (sb) {
		sb.disabled = true;
		sb.textContent = 'Send Files';
		sb.style.opacity = '';
		sb.classList.remove('success-pulse');
	}
	const sf2 = document.getElementById('room-send-fill');
	if (sf2) {
		sf2.style.width = '0%';
		sf2.classList.remove('active');
	}
	const rf2 = document.getElementById('recv-overall-fill');
	if (rf2) {
		rf2.style.width = '0%';
		rf2.classList.remove('active');
	}
	const joinInput = document.getElementById('join-code-input');
	if (joinInput) joinInput.value = '';
	const joinBtn = document.getElementById('join-btn');
	if (joinBtn) joinBtn.disabled = false;
	const codeDisplay = document.getElementById('room-code-display');
	if (codeDisplay) codeDisplay.textContent = '\xB7\xB7\xB7\xB7\xB7\xB7';
	const qrCont = document.getElementById('room-qr-container');
	if (qrCont) qrCont.innerHTML = '';
	document.getElementById('view-room').classList.remove('connected-border');
	const sg2 = document.getElementById('room-share-grid');
	if (sg2) {
		sg2.classList.remove('collapsed');
		sg2.classList.add('hidden');
	}
	['host-pin1', 'host-pin2', 'host-pin3', 'host-pin4', 'guest-pin1', 'guest-pin2', 'guest-pin3', 'guest-pin4'].forEach((id) => {
		const el = document.getElementById(id);
		if (el) el.value = '';
	});
	history.replaceState({}, '', window.location.pathname);
}

function enterRoom(code) {
	const display = document.getElementById('room-code-display');
	if (display) display.textContent = code;
	if (isHost) {
		// buildQR will lazy-load the QR lib if needed
		buildQR('room-qr-container', code);
		const grid = document.getElementById('room-share-grid');
		if (grid) grid.classList.remove('hidden');
		const label = document.getElementById('room-label');
		if (label) label.textContent = 'Your Room';
	} else {
		const sg = document.getElementById('room-share-grid');
		if (sg) {
			sg.classList.add('hidden');
			sg.classList.remove('collapsed');
		}
		const label = document.getElementById('room-label');
		if (label) label.textContent = 'Joining Room';
	}
	hide('view-home');
	hide('view-join');
	show('view-room');
}

function onConnected() {
	reconnectAttempts = 0;
	setDot('connected');
	setStatus('Connected \u2014 E2EE secured');
	const vr = document.getElementById('view-room');
	if (vr) vr.classList.add('connected-border');
	hide('room-pin-setup');
	hide('room-pin-entry');
	show('camera-btn');
	updateSendBtn();
	closeEnlargedQR();
	requestWakeLock();
	buzz(50);
	const sg = document.getElementById('room-share-grid');
	if (sg) sg.classList.add('collapsed');
	if (pendingSendIdx > 0 && pendingSendIdx < selectedFiles.length) setTimeout(resumeSend, 600);
}

async function createRoom() {
	isHost = true;
	const code = randCode();
	enterRoom(code);
	show('room-pin-setup');
	setStatus('Initializing\u2026');
	await loadPeerLib();
	peer = new Peer(code, PEERJS_CFG);
	peer.on('open', () => {
		setDot('waiting');
		setStatus('Waiting for peer\u2026');
	});
	peer.on('connection', async (c) => {
		if (conn && conn.open) {
			try {
				c.send({ type: 'room-full' });
				c.close();
			} catch (e) {}
			showToast('Someone tried to join — room is occupied');
			return;
		}
		conn = c;
		conn.on('open', async () => {
			roomPin = getHostPin();
			try {
				localECDHKeyPair = await genECDHKeyPair();
				if (!conn || !conn.open) return;
				hostPubKeyArr = await exportECDHPubKey(localECDHKeyPair);
				conn.send({ type: 'ecdh-init', pubKey: hostPubKeyArr, hasPin: !!roomPin });
				setStatus('Exchanging keys\u2026');
			} catch (e) {
				console.error('ECDH init failed', e);
				setStatus('Encryption error \u2014 try reconnecting');
			}
		});
		conn.on('data', async (d) => {
			if (d.type === 'ecdh-reply') {
				if (d.pubKey && localECDHKeyPair) {
					try {
						cryptoKey = await deriveSharedAESKey(localECDHKeyPair.privateKey, d.pubKey);
						if (hostPubKeyArr) computeFingerprint(hostPubKeyArr, d.pubKey).then(showFingerprint);
					} catch (e) {
						console.error('Host ECDH derive failed', e);
					}
					localECDHKeyPair = null;
				}
				if (!cryptoKey) {
					setStatus('Encryption setup failed \u2014 ask guest to rejoin');
					return;
				}
				if (!roomPin) onConnected();
				else setStatus('Waiting for password\u2026');
			} else if (d.type === 'pin') {
				if (d.pin === roomPin) {
					pinFailCount = 0;
					conn.send({ type: 'pin-ok' });
					onConnected();
				} else {
					pinFailCount++;
					if (pinFailCount >= 3) {
						conn.send({ type: 'pin-fail' });
						setStatus('Too many wrong passwords \u2014 disconnecting');
						setTimeout(() => {
							if (conn) {
								try {
									conn.close();
								} catch (e) {}
							}
							conn = null;
							pinFailCount = 0;
							setDot('waiting');
							setStatus('Waiting for peer\u2026');
						}, 500);
					} else {
						conn.send({ type: 'pin-fail' });
						setStatus('Wrong password \u2014 waiting\u2026 (' + (3 - pinFailCount) + ' left)');
					}
				}
			} else await handleIncoming(d);
		});
		conn.on('close', () => {
			setDot('waiting');
			setStatus('Peer disconnected');
			conn = null;
			cryptoKey = null;
			localECDHKeyPair = null;
			releaseWakeLock();
			updateSendBtn();
			const sg = document.getElementById('room-share-grid');
			if (sg) sg.classList.remove('collapsed');
		});
		conn.on('error', () => {
			setDot('error');
			setStatus('Connection error');
		});
	});
	peer.on('error', (e) => {
		setDot('error');
		setStatus('Error: ' + e.type);
	});
}

function showJoin() {
	hide('view-home');
	show('view-join');
	const jc = document.getElementById('join-code-input');
	if (jc) jc.focus();
}

async function joinRoom(autoCode) {
	const code = (
		autoCode || (document.getElementById('join-code-input') && document.getElementById('join-code-input').value)
	)
		.trim()
		.toUpperCase();
	if (code.length !== 6) return;
	const joinBtnEl = document.getElementById('join-btn');
	if (joinBtnEl) joinBtnEl.disabled = true;
	const joinDot = document.getElementById('join-dot');
	if (joinDot) joinDot.className = 'dot waiting';
	const joinStatusText = document.getElementById('join-status-text');
	if (joinStatusText) joinStatusText.textContent = 'Connecting\u2026';
	isHost = false;
	currentRoomCode = code;
	reconnectAttempts = 0;
	enterRoom(code);
	setStatus('Connecting\u2026');
	setDot('waiting');
	if (peer) {
		try {
			peer.destroy();
		} catch (e) {}
	}
	await loadPeerLib();
	peer = new Peer(PEERJS_CFG);
	peer.on('open', () => doConnect(code));
	peer.on('error', (e) => {
		setDot('error');
		setStatus('Error: ' + e.type);
	});
}

function doConnect(code) {
	conn = peer.connect(code, { reliable: true });
	conn.on('open', () => setStatus('Securing channel\u2026'));
	conn.on('data', async (d) => {
		if (d.type === 'ecdh-init') {
			if (!d.pubKey) {
				setStatus('Host does not support encryption');
				if (conn) try { conn.close(); } catch (_) {}
				return;
			}
			try {
				localECDHKeyPair = await genECDHKeyPair();
				if (!conn || !conn.open) return;
				const [sharedKey, pubKeyArr] = await Promise.all([
					deriveSharedAESKey(localECDHKeyPair.privateKey, d.pubKey),
					exportECDHPubKey(localECDHKeyPair),
				]);
				cryptoKey = sharedKey;
				conn.send({ type: 'ecdh-reply', pubKey: pubKeyArr });
				computeFingerprint(d.pubKey, pubKeyArr).then(showFingerprint);
				localECDHKeyPair = null;
			} catch (e) {
				console.error('Guest ECDH failed', e);
				setStatus('Encryption error — try reconnecting');
				return;
			}
			if (!cryptoKey) {
				setStatus('Encryption setup failed — try reconnecting');
				return;
			}
			if (d.hasPin) {
				pinPending = true;
				show('room-pin-entry');
				clearGuestPin();
				setStatus('Enter room password');
			} else onConnected();
		} else if (d.type === 'pin-ok') {
			pinPending = false;
			onConnected();
		} else if (d.type === 'pin-fail') {
			clearGuestPin();
			setStatus('Wrong password — try again');
		} else if (d.type === 'room-full') {
			setDot('error');
			setStatus('Room is full — try a different room');
			const jb = document.getElementById('join-btn');
			if (jb) jb.disabled = false;
		} else await handleIncoming(d);
	});
	conn.on('close', () => {
		cryptoKey = null;
		localECDHKeyPair = null;
		releaseWakeLock();
		scheduleReconnect();
	});
	conn.on('error', () => {
		scheduleReconnect();
	});
}

function scheduleReconnect() {
	if (!currentRoomCode || reconnectAttempts >= MAX_RECONNECT) {
		setDot('error');
		setStatus('Connection lost');
		return;
	}
	reconnectAttempts++;
	const delay = Math.min(1500 * reconnectAttempts, 8000);
	setDot('waiting');
	setStatus(`Reconnecting\u2026 (${reconnectAttempts}/${MAX_RECONNECT})`);
	clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(() => {
		if (peer && !peer.destroyed) doConnect(currentRoomCode);
	}, delay);
}

async function resumeSend() {
	if (!conn || pendingSendIdx >= selectedFiles.length) return;
	if (!cryptoKey) return;
	transferCancelled = false;
	transferPaused = false;
	show('room-send-progress');
	const btn = document.getElementById('room-send-btn');
	if (btn) btn.disabled = true;
	sendStartTime = Date.now();
	sendBytesSent = 0;
	sendTotalBytes = selectedFiles.slice(pendingSendIdx).reduce((a, f) => a + f.size, 0);
	const interval = setInterval(updateSpeed, 500);
	let i = pendingSendIdx;
	while (i < selectedFiles.length) {
		if (transferCancelled) break;
		pendingSendIdx = i;
		currentSendIdx = i;
		currentSendProgress = 0;
		const ok = await sendOneFile(selectedFiles[i]);
		if (transferCancelled) break;
		if (ok) {
			const file = selectedFiles[i];
			if (!sentFiles.some((s) => s.name === file.name && s.size === file.size)) sentFiles.push(file);
			const k = file.name + file.size;
			if (sendThumbURLs.has(k)) {
				URL.revokeObjectURL(sendThumbURLs.get(k));
				sendThumbURLs.delete(k);
			}
			selectedFiles.splice(i, 1);
			pendingSendIdx = Math.min(i, selectedFiles.length);
			renderSendList();
			continue;
		}
		i++;
	}
	clearInterval(interval);
	if (!transferCancelled) pendingSendIdx = selectedFiles.length;
	const speedEl = document.getElementById('speed-val');
	const etaEl = document.getElementById('eta-val');
	if (speedEl) speedEl.textContent = '0 B/s';
	if (etaEl) etaEl.textContent = 'done';
	const b = document.getElementById('room-send-btn');
	if (b) {
		b.textContent = '\u2713 All Sent';
		b.style.opacity = '.6';
	}
}

function onDragOver(e) {
	e.preventDefault();
	document.getElementById('dropzone').classList.add('dragover');
}
function onDragLeave() {
	document.getElementById('dropzone').classList.remove('dragover');
}
function onDrop(e) {
	e.preventDefault();
	document.getElementById('dropzone').classList.remove('dragover');
	addFiles([...e.dataTransfer.files]);
}
function onFilesSelected(e) {
	addFiles([...e.target.files]);
	e.target.value = '';
}
function fileQueueKey(f) {
	return f.name + '\0' + f.size;
}
function dedupeSelectedFiles() {
	if (selectedFiles.length < 2) return;
	const seen = new Set();
	const kept = [];
	let removedBeforePending = 0;
	for (let j = 0; j < selectedFiles.length; j++) {
		const f = selectedFiles[j];
		const k = fileQueueKey(f);
		if (seen.has(k)) {
			if (j < pendingSendIdx) removedBeforePending++;
			continue;
		}
		seen.add(k);
		kept.push(f);
	}
	if (kept.length === selectedFiles.length) return;
	selectedFiles = kept;
	pendingSendIdx = Math.max(0, Math.min(pendingSendIdx - removedBeforePending, selectedFiles.length));
}
function addFiles(files) {
	files.forEach((f) => {
		if (!selectedFiles.some((x) => x.name === f.name && x.size === f.size)) selectedFiles.push(f);
	});
	dedupeSelectedFiles();
	renderSendList();
	updateSendBtn();
}
function removeFile(i) {
	const f = selectedFiles[i];
	if (!f) return;
	const k = f.name + f.size;
	if (sendThumbURLs.has(k)) {
		URL.revokeObjectURL(sendThumbURLs.get(k));
		sendThumbURLs.delete(k);
	}
	selectedFiles.splice(i, 1);
	if (i < pendingSendIdx) pendingSendIdx--;
	pendingSendIdx = Math.min(pendingSendIdx, selectedFiles.length);
	renderSendList();
	updateSendBtn();
}
function deleteSentFile(i) {
	const f = sentFiles[i];
	if (!f) return;
	sentFiles.splice(i, 1);
	const k = f.name + f.size;
	if (sendThumbURLs.has(k)) {
		URL.revokeObjectURL(sendThumbURLs.get(k));
		sendThumbURLs.delete(k);
	}
	renderSendList();
	updateSendBtn();
	if (conn && conn.open) conn.send({ type: 'del', name: f.name, size: f.size });
}
function getThumbURL(f) {
	const k = f.name + f.size;
	if (!sendThumbURLs.has(k)) sendThumbURLs.set(k, URL.createObjectURL(f));
	return sendThumbURLs.get(k);
}
function renderSendList() {
	dedupeSelectedFiles();
	const sendWrap = document.getElementById('room-send-list');
	const sentWrap = document.getElementById('room-sent-list');
	if (sendWrap) {
		sendWrap.innerHTML = selectedFiles
			.map((f, i) => {
				const isImg = f.type && f.type.startsWith('image/');
				const safeName = escapeHtml(f.name);
				const icon = isImg ? `<img src="${getThumbURL(f)}" class="fi-thumb" alt="${safeName}">` : `<span aria-hidden="true">${fileIcon(f.name)}</span>`;
				return `<div class="file-item file-item-enter" style="animation-delay:${i * 50}ms">${icon}<span class="fi-name" title="${safeName}">${safeName}</span><span class="fi-size">${fmtSize(f.size)}</span><button class="fi-remove" onclick="removeFile(${i})" aria-label="Remove" type="button">\u2715</button></div>`;
			})
			.join('');
	}
	if (sentWrap) {
		sentWrap.innerHTML = sentFiles
			.map((f, i) => {
				const safeName = escapeHtml(f.name);
				return `<div class="sent-item"><span aria-hidden="true">${fileIcon(f.name)}</span><span class="fi-name" title="${safeName}">${safeName}</span><span class="fi-size">${fmtSize(f.size)}</span><button class="fi-remove" onclick="deleteSentFile(${i})" title="Delete from all" aria-label="Delete" type="button">\u2715</button></div>`;
			})
			.join('');
	}
}
function updateSendBtn() {
	const ready = conn && !!cryptoKey && !pinPending && selectedFiles.length > 0;
	const btn = document.getElementById('room-send-btn');
	if (!btn) return;
	btn.disabled = !ready;
	btn.textContent = ready ? 'Send Files' : conn && !cryptoKey ? 'Securing\u2026' : 'Send Files';
}

function updateSpeed() {
	const elapsed = (Date.now() - sendStartTime) / 1000;
	if (elapsed < 0.5) return;
	const speed = sendBytesSent / elapsed;
	const remaining = (sendTotalBytes - sendBytesSent) / Math.max(speed, 1);
	const speedEl = document.getElementById('speed-val');
	const etaEl = document.getElementById('eta-val');
	if (speedEl) speedEl.textContent = fmtSize(speed) + '/s';
	if (etaEl) etaEl.textContent = fmtETA(remaining);
	const pct = sendTotalBytes > 0 ? Math.min(100, Math.round((sendBytesSent / sendTotalBytes) * 100)) : 0;
	const fill = document.getElementById('send-overall-fill');
	if (fill) {
		fill.style.width = pct + '%';
		fill.classList.toggle('active', pct > 0 && pct < 100);
	}
}

async function sendFiles() {
	if (!conn || !selectedFiles.length || pinPending) return;
	if (!cryptoKey) return;
	transferPaused = false;
	transferCancelled = false;
	const btn = document.getElementById('room-send-btn');
	if (btn) btn.disabled = true;
	const controls = document.getElementById('room-transfer-controls');
	const pauseBtn = document.getElementById('pause-btn');
	if (controls) controls.classList.remove('hidden');
	if (pauseBtn) pauseBtn.textContent = 'Pause';
	show('room-send-progress');
	sendStartTime = Date.now();
	sendTotalBytes = selectedFiles.reduce((a, f) => a + f.size, 0);
	sendBytesSent = 0;
	const interval = setInterval(updateSpeed, 500);
	const wrap = document.getElementById('room-progress-items');
	if (wrap) wrap.innerHTML = '';
	selectedFiles.forEach((f) => {
		const safeName = escapeHtml(f.name);
		const pid = sendProgPctId(f);
		const rid = sendProgRetryId(f);
		if (wrap) wrap.innerHTML += `<div class="xfer-file-item"><span class="prog-name" title="${safeName}">${safeName}</span><span class="prog-pct" id="${pid}">0%</span><span id="${rid}" class="retry-badge hidden"></span></div>`;
	});
	pendingSendIdx = 0;
	let i = 0;
	while (i < selectedFiles.length) {
		if (transferCancelled) break;
		pendingSendIdx = i;
		currentSendIdx = i;
		currentSendProgress = 0;
		const ok = await sendOneFile(selectedFiles[i]);
		if (transferCancelled) break;
		if (ok) {
			const file = selectedFiles[i];
			if (!sentFiles.some((s) => s.name === file.name && s.size === file.size)) sentFiles.push(file);
			const k = file.name + file.size;
			if (sendThumbURLs.has(k)) {
				URL.revokeObjectURL(sendThumbURLs.get(k));
				sendThumbURLs.delete(k);
			}
			selectedFiles.splice(i, 1);
			pendingSendIdx = Math.min(i, selectedFiles.length);
			renderSendList();
			continue;
		}
		i++;
	}
	if (!transferCancelled) pendingSendIdx = selectedFiles.length;
	clearInterval(interval);
	if (controls) controls.classList.add('hidden');
	if (transferCancelled) {
		if (btn) {
			btn.textContent = 'Cancelled';
			btn.style.opacity = '.6';
		}
		const sfc = document.getElementById('send-overall-fill');
		if (sfc) {
			sfc.style.width = '0%';
			sfc.classList.remove('active');
		}
		const speedEl = document.getElementById('speed-val');
		const etaEl = document.getElementById('eta-val');
		if (speedEl) speedEl.textContent = '0 B/s';
		if (etaEl) etaEl.textContent = 'cancelled';
	} else {
		const speedEl = document.getElementById('speed-val');
		const etaEl = document.getElementById('eta-val');
		if (speedEl) speedEl.textContent = '0 B/s';
		if (etaEl) etaEl.textContent = 'done';
		if (btn) {
			btn.textContent = '\u2713 All Sent';
			btn.style.opacity = '.6';
			btn.classList.add('success-pulse');
		}
		buzz([100, 50, 100]);
		const sfd = document.getElementById('send-overall-fill');
		if (sfd) {
			sfd.style.width = '100%';
			sfd.classList.remove('active');
			setTimeout(() => {
				sfd.style.width = '0%';
			}, 1500);
		}
	}
}

async function sendOneFile(file) {
	const totalChunks = Math.ceil(file.size / CHUNK) || 1;
	if (!conn || !conn.open || transferCancelled) return false;
	const startChunk = currentSendProgress > 0 ? Math.floor((currentSendProgress * totalChunks) / 100) : 0;
	conn.send({ type: 'meta', name: file.name, size: file.size, mime: file.type, totalChunks, startChunk });
	let batchCount = 0;
	for (let sent = startChunk; sent < totalChunks; sent++) {
		if (transferCancelled) return false;
		while (transferPaused && conn && conn.open && !transferCancelled) await new Promise((r) => setTimeout(r, 100));
		if (transferCancelled || !conn || !conn.open) return false;
		const start = sent * CHUNK;
		const chunkBuf = await file.slice(start, Math.min(start + CHUNK, file.size)).arrayBuffer();
		sendBytesSent += chunkBuf.byteLength;
		let retries = 0;
		while (true) {
			try {
				if (!conn || !conn.open || transferCancelled) return false;
				if (batchCount === 0) await waitForBuffer();
				batchCount = (batchCount + 1) % CHUNKS_PER_BATCH;
				const d = new Uint8Array(await encryptChunk(chunkBuf, cryptoKey));
				conn.send({ type: 'b', i: sent, d });
				currentSendProgress = Math.round(((sent + 1) / totalChunks) * 100);
				updateProg(file, currentSendProgress);
				break;
			} catch (e) {
				if (transferCancelled || !conn || !conn.open) return false;
				retries++;
				if (retries > MAX_RETRIES) return false;
				const badge = document.getElementById(sendProgRetryId(file));
				if (badge) {
					badge.textContent = 'retry ' + retries;
					badge.classList.remove('hidden');
				}
				await new Promise((r) => setTimeout(r, RETRY_DELAY * Math.min(retries, 3)));
				batchCount = 0;
			}
		}
		if (sent % 16 === 0) await yieldControl();
	}
	currentSendProgress = 0;
	return true;
}

function togglePause() {
	transferPaused = !transferPaused;
	const btn = document.getElementById('pause-btn');
	if (btn) btn.textContent = transferPaused ? 'Resume' : 'Pause';
	const eta = document.getElementById('eta-val');
	if (eta) eta.textContent = transferPaused ? 'paused' : 'resuming...';
}

function cancelTransfer() {
	transferCancelled = true;
	transferPaused = false;
	const pauseBtn = document.getElementById('pause-btn');
	if (pauseBtn) pauseBtn.textContent = 'Pause';
}

function updateProg(file, pct) {
	const l = document.getElementById(sendProgPctId(file));
	if (l) l.textContent = pct + '%';
}

async function handleIncoming(d) {
	if (d.type === 'meta') {
		recvTotalBytes += d.size;
		if (!recvStartTime) recvStartTime = Date.now();
		if (!recvSpeedInterval) recvSpeedInterval = setInterval(updateRecvSpeed, 500);
		recvMeta[d.name] = { ...d, received: 0, lastPct: 0, bytesReceived: 0 };
		recvBuffers[d.name] = new Array(d.totalChunks);
		show('room-recv-progress');
		const k = safeKey(d.name);
		const safeRecvName = escapeHtml(d.name);
		const itemsWrap = document.getElementById('room-recv-items');
		if (itemsWrap) itemsWrap.innerHTML += `<div class="xfer-file-item"><span class="prog-name" title="${safeRecvName}">${safeRecvName}</span><span class="prog-pct" id="rpct_${k}">0%</span></div>`;
		const list = document.getElementById('room-recv-list');
		if (list && list.querySelector('.empty')) list.innerHTML = '';
	} else if (d.type === 'b' && !pinPending) {
		const raw = d.d;
		const buf = raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
		recvQueue.push({ i: d.i, buf, byteLength: buf.byteLength });
		if (!recvProcessing) processRecvQueue();
	} else if (d.type === 'del') {
		deleteReceivedFile(d.name, d.size);
	}
}

function deleteReceivedFile(name, size) {
	const list = document.getElementById('room-recv-list');
	if (!list) return;
	const items = list.querySelectorAll('.recv-item');
	items.forEach((item) => {
		const nameEl = item.querySelector('.ri-name');
		if (nameEl && nameEl.textContent === name && nameEl.dataset.size === String(size)) {
			item.style.animation = 'slideOut .3s ease';
			setTimeout(() => item.remove(), 300);
		}
	});
	if (recvMeta[name]) {
		delete recvMeta[name];
		delete recvBuffers[name];
	}
}

function updateRecvSpeed() {
	const elapsed = (Date.now() - recvStartTime) / 1000;
	if (elapsed < 0.5) return;
	const speed = recvBytesReceived / elapsed;
	const remaining = (recvTotalBytes - recvBytesReceived) / Math.max(speed, 1);
	const speedEl = document.getElementById('recv-speed-val');
	const etaEl = document.getElementById('recv-eta-val');
	if (speedEl) speedEl.textContent = fmtSize(speed) + '/s';
	if (etaEl) etaEl.textContent = fmtETA(remaining);
	const pct = recvTotalBytes > 0 ? Math.min(100, Math.round((recvBytesReceived / recvTotalBytes) * 100)) : 0;
	const fill = document.getElementById('recv-overall-fill');
	if (fill) {
		fill.style.width = pct + '%';
		fill.classList.toggle('active', pct > 0 && pct < 100);
	}
}

async function processRecvQueue() {
	recvProcessing = true;
	while (recvQueue.length > 0) {
		const batch = recvQueue.splice(0, RECV_BATCH_SIZE);
		const meta = Object.values(recvMeta).find((m) => m.received < m.totalChunks);
		if (!meta) {
			recvProcessing = false;
			return;
		}
		let stored = 0;
		await Promise.all(
			batch.map(async (item) => {
				try {
					const data = await decryptChunk(item.buf, cryptoKey);
					if (item.i < 0 || item.i >= meta.totalChunks) return;
					recvBuffers[meta.name][item.i] = data;
					meta.bytesReceived += item.byteLength || 0;
					recvBytesReceived += item.byteLength || 0;
					stored++;
				} catch (e) {
					console.error('Decrypt error', e);
				}
			}),
		);
		meta.received += stored;
		const pct = Math.round((meta.received / meta.totalChunks) * 100);
		if (pct !== meta.lastPct) {
			meta.lastPct = pct;
			const k = safeKey(meta.name);
			const fill = document.getElementById('rfill_' + k);
			const label = document.getElementById('rpct_' + k);
			if (fill) fill.style.width = pct + '%';
			if (label) label.textContent = pct + '%';
		}
		if (meta.received >= meta.totalChunks) {
			const k = safeKey(meta.name);
			const fill = document.getElementById('rfill_' + k);
			if (fill) fill.classList.add('done');
			assembleFile(meta.name);
		}
		if (batch.length >= RECV_BATCH_SIZE) await yieldControl();
	}
	recvProcessing = false;
}

function assembleFile(name) {
	const meta = recvMeta[name];
	const mime = sanitizeMime(meta.mime);
	const blob = new Blob(recvBuffers[name], { type: mime });
	const url = URL.createObjectURL(blob);
	receivedBlobURLs.push(url);
	const div = document.createElement('div');
	div.className = 'recv-item recv-item-col recv-item-enter';
	const safeRecvName2 = escapeHtml(name);
	let preview = '';
	if (mime.startsWith('image/')) preview = `<img src="${url}" class="recv-preview" alt="${safeRecvName2}">`;
	else if (mime.startsWith('video/')) preview = `<video src="${url}" class="recv-preview" controls playsinline></video>`;
	else if (mime.startsWith('audio/')) preview = `<audio src="${url}" class="recv-audio" controls></audio>`;
	div.innerHTML = `${preview}<div class="recv-info"><span aria-hidden="true">${fileIcon(name)}</span><span class="ri-name" title="${safeRecvName2}" data-size="${meta.size}">${safeRecvName2}</span><span class="ri-size">${fmtSize(meta.size)}</span><a class="dl-btn" href="${url}" download="${safeRecvName2}">Save</a></div>`;
	const list = document.getElementById('room-recv-list');
	if (list) list.appendChild(div);
	setTimeout(() => div.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
	setTimeout(() => {
		try {
			URL.revokeObjectURL(url);
		} catch (e) {}
		const i = receivedBlobURLs.indexOf(url);
		if (i > -1) receivedBlobURLs.splice(i, 1);
	}, 60000);
	delete recvBuffers[name];
	delete recvMeta[name];
	const remaining = Object.values(recvMeta).filter((m) => m.received < m.totalChunks).length;
	if (remaining === 0) {
		if (recvSpeedInterval) {
			clearInterval(recvSpeedInterval);
			recvSpeedInterval = null;
		}
		const speedEl = document.getElementById('recv-speed-val');
		const etaEl = document.getElementById('recv-eta-val');
		if (speedEl) speedEl.textContent = '0 B/s';
		if (etaEl) etaEl.textContent = 'done';
		const rfd = document.getElementById('recv-overall-fill');
		if (rfd) {
			rfd.style.width = '100%';
			rfd.classList.remove('active');
			setTimeout(() => {
				rfd.style.width = '0%';
			}, 1500);
		}
	}
}

function openCamera() {
	const inp = document.getElementById('camera-input');
	if (inp) inp.click();
}

let _qrLibPromise = null;
async function loadQRLib() {
	if (window.Html5Qrcode) return;
	if (!_qrLibPromise)
		_qrLibPromise = new Promise((res, rej) => {
			const s = document.createElement('script');
			s.src = 'lib/html5-qrcode.min.js';
			s.onload = res;
			s.onerror = (e) => {
				_qrLibPromise = null;
				rej(e);
			};
			document.head.appendChild(s);
		});
	return _qrLibPromise;
}
async function openQRScanner() {
	await loadQRLib();
	const modal = document.getElementById('qr-scanner-modal');
	const hint = document.getElementById('scan-hint');
	const retryBtn = document.getElementById('qr-retry-btn');
	if (modal) {
		modal.classList.remove('hidden');
		modal.classList.add('active');
	}
	if (hint) hint.textContent = 'Starting camera...';
	if (retryBtn) retryBtn.classList.add('hidden');
	await new Promise((r) => setTimeout(r, 100));
	await startQRScanner(hint, retryBtn);
}

async function startQRScanner(hint, retryBtn) {
	const config = { fps: 10, qrbox: 200 };
	const onQRSuccess = (text) => {
		const code = extractRoomCode(text);
		if (code) {
			closeQRScanner();
			const jc = document.getElementById('join-code-input');
			if (jc) jc.value = code;
			joinRoom(code);
		}
	};
	const onQRError = () => {};
	try {
		if (qrScanner) {
			try {
				await qrScanner.stop();
			} catch (e) {}
			try {
				qrScanner.clear();
			} catch (e) {}
			qrScanner = null;
		}
		const readerWrap = document.getElementById('qr-reader');
		if (readerWrap) readerWrap.innerHTML = '';
		await new Promise((r) => setTimeout(r, 50));
		qrScanner = new Html5Qrcode('qr-reader');
		await qrScanner.start({ facingMode: 'environment' }, config, onQRSuccess, onQRError);
		if (hint) hint.textContent = 'Point your camera at a FileDrop room QR code';
		if (retryBtn) retryBtn.classList.add('hidden');
	} catch (err1) {
		console.log('Rear camera failed:', err1.name, err1.message);
		try {
			await qrScanner.start({ facingMode: 'user' }, config, onQRSuccess, onQRError);
			if (hint) hint.textContent = 'Point your camera at a FileDrop room QR code';
			if (retryBtn) retryBtn.classList.add('hidden');
		} catch (err2) {
			console.log('Front camera failed:', err2.name, err2.message);
			let msg = 'Camera error. ';
			if (err2.name === 'NotAllowedError') msg = 'Permission denied. ';
			else if (err2.name === 'NotFoundError') msg = 'No camera found. ';
			else if (err2.name === 'NotReadableError') msg = 'Camera in use. ';
			if (hint) hint.textContent = msg + 'Tap Retry to try again.';
			if (retryBtn) retryBtn.classList.remove('hidden');
		}
	}
}

function retryQRScanner() {
	const hint = document.getElementById('scan-hint');
	const retryBtn = document.getElementById('qr-retry-btn');
	if (hint) hint.textContent = 'Requesting camera access...';
	if (retryBtn) retryBtn.classList.add('hidden');
	startQRScanner(hint, retryBtn);
}

async function closeQRScanner() {
	const modal = document.getElementById('qr-scanner-modal');
	if (modal) {
		modal.classList.remove('active');
		setTimeout(() => modal.classList.add('hidden'), 300);
	}
	if (qrScanner) {
		try {
			await qrScanner.stop();
		} catch (e) {}
		try {
			qrScanner.clear();
		} catch (e) {}
		qrScanner = null;
	}
}

async function scanQRFromFile(e) {
	const file = e.target.files[0];
	if (!file) return;
	e.target.value = '';
	await loadQRLib();
	const hint = document.getElementById('scan-hint');
	if (hint) hint.textContent = 'Scanning image\u2026';
	if (qrScanner) {
		try {
			await qrScanner.stop();
		} catch (_) {}
		try {
			qrScanner.clear();
		} catch (_) {}
		qrScanner = null;
	}
	try {
		const reader = new Html5Qrcode('qr-reader');
		const text = await reader.scanFile(file, false);
		const code = extractRoomCode(text);
		if (code) {
			closeQRScanner();
			const jc = document.getElementById('join-code-input');
			if (jc) jc.value = code;
			joinRoom(code);
		} else {
			if (hint) hint.textContent = 'No QR code found \u2014 try again.';
		}
	} catch (err) {
		if (hint) hint.textContent = 'Could not read QR code \u2014 try again.';
	}
}

function extractRoomCode(text) {
	const match = text.match(/room=([A-Z0-9]{6})/i);
	if (match) return match[1].toUpperCase();
	const clean = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
	if (clean.length === 6) return clean;
	return null;
}
function onCameraCapture(e) {
	if (e.target.files && e.target.files[0]) {
		const f = e.target.files[0];
		const ext = f.type.startsWith('video') ? '.mp4' : '.jpg';
		const named = new File([f], 'camera_' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + ext, { type: f.type });
		addFiles([named]);
	}
	e.target.value = '';
}

window.addEventListener('dragenter', (e) => {
	e.preventDefault();
	document.getElementById('drag-overlay').classList.add('active');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
	if (e.relatedTarget === null) document.getElementById('drag-overlay').classList.remove('active');
});
window.addEventListener('drop', (e) => {
	e.preventDefault();
	document.getElementById('drag-overlay').classList.remove('active');
	if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
});
window.addEventListener('paste', (e) => {
	const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
	if (files.length) {
		addFiles(files);
		e.preventDefault();
	}
});

window.addEventListener('load', () => {
	if (window.matchMedia('(hover:none),(pointer:coarse)').matches) {
		const dz = document.querySelector('.dz-text');
		if (dz) dz.innerHTML = 'Tap to pick files';
	}
	const room = new URLSearchParams(window.location.hash.slice(1)).get('room') || new URLSearchParams(window.location.search).get('room');
	if (room && /^[A-Z0-9]{6}$/i.test(room)) {
		showJoin();
		const jc = document.getElementById('join-code-input');
		if (jc) jc.value = room.toUpperCase().slice(0, 6);
		setTimeout(() => joinRoom(room.toUpperCase().slice(0, 6)), 300);
	}
});
if ('serviceWorker' in navigator) {
	navigator.serviceWorker.register('./sw.js').catch(() => {});
}

window.addEventListener('beforeunload', () => {
	receivedBlobURLs.forEach((u) => {
		try {
			URL.revokeObjectURL(u);
		} catch (e) {}
	});
	sendThumbURLs.forEach((u) => {
		try {
			URL.revokeObjectURL(u);
		} catch (e) {}
	});
	if (peer) {
		try {
			peer.destroy();
		} catch (e) {}
	}
});

document.querySelectorAll('.mode-btn').forEach((btn) => {
	btn.addEventListener('mousemove', (e) => {
		const r = btn.getBoundingClientRect();
		btn.style.setProperty('--mouse-x', e.clientX - r.left + 'px');
		btn.style.setProperty('--mouse-y', e.clientY - r.top + 'px');
	});
});

// Expose some functions to global scope to preserve existing inline handlers
window.createRoom = createRoom;
window.showJoin = showJoin;
window.goHome = goHome;
window.joinRoom = joinRoom;
window.openQRScanner = openQRScanner;
window.copyRoomCode = copyRoomCode;
window.shareRoomLink = shareRoomLink;
window.openCamera = openCamera;
window.onFilesSelected = onFilesSelected;
window.onDrop = onDrop;
window.onDragOver = onDragOver;
window.onDragLeave = onDragLeave;
window.onCameraCapture = onCameraCapture;
window.pasteCode = pasteCode;

