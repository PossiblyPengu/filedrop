# FileDrop

Peer-to-peer file transfer with end-to-end encryption. No server storage. Direct browser-to-browser transfer using WebRTC.

**Live Demo**: <https://yourusername.github.io/filedrop>

## Features

- **True P2P**: Files go directly from sender to receiver, never touch a server
- **AES-256-GCM Encryption**: Optional password-protected E2EE
- **No Installation**: Works in any modern browser
- **Large Files**: Chunked transfer with resume capability
- **Mobile Friendly**: QR code scanning, camera capture, touch-optimized UI
- **Privacy First**: Self-hosted dependencies, no tracking, no analytics

## Quick Start

### 1. Deploy to GitHub Pages (Free)

1. **Fork this repository** to your GitHub account
2. Go to **Settings** → **Pages** in your forked repo
3. Under "Build and deployment", select **GitHub Actions**
4. Go to **Actions** tab and enable workflows if prompted
5. Push any change (or trigger workflow manually) to deploy
6. Your site will be at `https://yourusername.github.io/filedrop`

### 2. Local Development

```bash
# Clone the repository
git clone https://github.com/yourusername/filedrop.git
cd filedrop

# Serve locally (Python 3)
python -m http.server 8080

# Or with Node.js
npx serve .

# Open http://localhost:8080
```

## Privacy Notes

FileDrop uses **public infrastructure by default**:

- **PeerJS Server** (0.peerjs.com): Handles signaling only, never sees file content
- **STUN Server** (Google): Helps establish direct P2P connections

**Privacy considerations**:

- Room codes are visible to the signaling server during connection setup
- Peers can see each other's IP addresses via WebRTC
- File content is encrypted with AES-256-GCM when password protection is enabled
- No tracking, analytics, or persistent storage

### Private PeerJS server
To use a **private PeerJS server**, edit the `PEERJS_CFG` constant in `index.html`.

### TURN server configuration
To support strict NATs or corporate networks, add a **TURN server** to the ICE configuration in `PEERJS_CFG`:

```
const PEERJS_CFG = {
	host: "0.peerjs.com", // or your private PeerJS server
	port: 443,
	path: "/",
	secure: true,
	config: {
		iceServers: [
			{ urls: "stun:stun.cloudflare.com:3478" },
			{ urls: "stun:stun.l.google.com:19302" },
			// Add your TURN server below
			{ urls: "turn:your.turn.server:3478", username: "user", credential: "pass" }
		],
	},
};
```

This enables relay through TURN for symmetric NATs and strict firewalls. See [PeerJS docs](https://peerjs.com/docs.html#api) for more.

## How It Works

1. **Sender** creates a room → gets a 6-digit code
2. **Receiver** enters code (or scans QR) → WebRTC connection established
3. **Key exchange** happens automatically if encryption enabled
4. **Files** transfer directly peer-to-peer in encrypted chunks
5. **No data** is stored on any server

## Security Considerations

| Component        | Risk                         | Mitigation                      |
| ---------------- | ---------------------------- | ------------------------------- |
| PeerJS Signaling | Room codes visible to server | Use private PeerJS server       |
| STUN/TURN        | IP address exposure          | Use authenticated TURN          |
| Encryption       | Optional (user can disable)  | Enable by default, PIN protects |
| File Metadata    | Names/sizes sent in clear    | Could encrypt metadata too      |


## File Size Limit

The maximum supported file size is **2GB** per file (browser memory constraint). Larger files will be blocked with a warning.

## Browser Support

- Chrome/Edge 80+
- Firefox 75+
- Safari 14+
- iOS Safari 14+
- Chrome Android 80+

## License

MIT License - Free to use, modify, and distribute.
