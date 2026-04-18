// Main JS moved from index.html
// ...existing code from previous inline script should be pasted here...

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
