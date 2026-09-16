'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  setup: $('setup'),
  name: $('name-input'),
  room: $('room-input'),
  dice: $('dice'),
  join: $('join'),
  setupError: $('setup-error'),

  roomView: $('room'),
  roomLabel: $('room-label'),
  watchers: $('watchers'),
  copyLink: $('copy-link'),

  ytWrap: $('yt-wrap'),
  html5: $('player-html5'),
  empty: $('empty'),
  gesture: $('gesture'),

  toggle: $('toggle'),
  scrub: $('scrub'),
  timeCurrent: $('time-current'),
  timeTotal: $('time-total'),
  resync: $('resync'),

  loadForm: $('load-form'),
  url: $('url-input'),
  loadError: $('load-error'),
  nowPlaying: $('now-playing'),

  activity: $('activity'),
  chat: $('chat'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input')
};

let socket = null;
let myName = '';
let roomCode = '';

let mode = null;          // 'youtube' | 'direct'
let current = null;       // { type, src, label }
let yt = null;            // YT.Player instance
let ytCuedResolve = null;

let localPlaying = false; // what our own player is meant to be doing
let dragging = false;     // the user has hold of the scrub bar
let applying = false;     // we're applying a remote state, so don't emit
let gestureTimer = null;

const DRIFT_TOLERANCE = 1.0; // seconds

/* ---------------- helpers ---------------- */

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function clockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function once(target, event, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      target.removeEventListener(event, finish);
      resolve();
    };
    target.addEventListener(event, finish, { once: true });
    if (timeoutMs) setTimeout(finish, timeoutMs);
  });
}

const ytApiReady = new Promise((resolve) => {
  if (window.YT && window.YT.Player) resolve();
  else window.onYouTubeIframeAPIReady = resolve;
});

/* ---------------- player abstraction ---------------- */

function getTime() {
  try {
    if (mode === 'youtube' && yt && yt.getCurrentTime) return yt.getCurrentTime() || 0;
    if (mode === 'direct') return els.html5.currentTime || 0;
  } catch (_) { /* player not ready yet */ }
  return 0;
}

function getDuration() {
  try {
    if (mode === 'youtube' && yt && yt.getDuration) return yt.getDuration() || 0;
    if (mode === 'direct') return Number.isFinite(els.html5.duration) ? els.html5.duration : 0;
  } catch (_) { /* player not ready yet */ }
  return 0;
}

function reallyPlaying() {
  try {
    if (mode === 'youtube' && yt && yt.getPlayerState) return yt.getPlayerState() === 1;
    if (mode === 'direct') return !els.html5.paused && !els.html5.ended;
  } catch (_) { /* player not ready yet */ }
  return false;
}

function doPlay() {
  if (mode === 'youtube' && yt) yt.playVideo();
  else if (mode === 'direct') {
    const p = els.html5.play();
    if (p && p.catch) p.catch(() => showGesture());
  }
}

function doPause() {
  if (mode === 'youtube' && yt) yt.pauseVideo();
  else if (mode === 'direct') els.html5.pause();
}

function doSeek(seconds) {
  const t = Math.max(0, seconds);
  if (mode === 'youtube' && yt) yt.seekTo(t, true);
  else if (mode === 'direct') els.html5.currentTime = t;
}

async function createYtPlayer(videoId) {
  await ytApiReady;
  return new Promise((resolve) => {
    yt = new YT.Player('player-yt', {
      videoId,
      playerVars: {
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        fs: 0,
        playsinline: 1,
        iv_load_policy: 3
      },
      events: {
        onReady: () => resolve(),
        onStateChange: onYtStateChange
      }
    });
  });
}

function onYtStateChange(event) {
  if (event.data === YT.PlayerState.CUED && ytCuedResolve) {
    ytCuedResolve();
    ytCuedResolve = null;
  }
  if (event.data === YT.PlayerState.ENDED) setPlayButton(false);
  if (!applying) {
    // Reflect reality in the button without emitting anything: only our own
    // controls are allowed to broadcast.
    if (event.data === YT.PlayerState.PLAYING) setPlayButton(true);
  }
}

async function ensureVideo(video) {
  if (current && current.type === video.type && current.src === video.src) return;
  current = video;

  els.empty.hidden = true;
  els.nowPlaying.hidden = false;
  els.nowPlaying.textContent = `Now playing: ${video.label}`;

  if (video.type === 'youtube') {
    mode = 'youtube';
    els.html5.pause();
    els.html5.removeAttribute('src');
    els.html5.load();
    els.html5.classList.remove('on');
    els.ytWrap.classList.add('on');

    if (!yt) {
      await createYtPlayer(video.src);
    } else {
      const cued = new Promise((resolve) => { ytCuedResolve = resolve; });
      yt.cueVideoById(video.src);
      await Promise.race([cued, new Promise((r) => setTimeout(r, 2500))]);
    }
  } else {
    mode = 'direct';
    els.ytWrap.classList.remove('on');
    if (yt && yt.stopVideo) yt.stopVideo();
    els.html5.classList.add('on');
    els.html5.src = video.src;
    await Promise.race([once(els.html5, 'loadedmetadata', 8000), new Promise((r) => setTimeout(r, 8000))]);
  }
}

/* ---------------- applying shared state ---------------- */

async function applyState(state, force) {
  applying = true;
  try {
    if (state.video) await ensureVideo(state.video);
    if (!mode) return;

    const targetTime = Number(state.currentTime) || 0;
    if (force || Math.abs(getTime() - targetTime) > DRIFT_TOLERANCE) doSeek(targetTime);

    if (state.isPlaying) {
      doPlay();
      watchForBlockedPlayback();
    } else {
      doPause();
      hideGesture();
    }
    setPlayButton(!!state.isPlaying);
    paint();
  } finally {
    setTimeout(() => { applying = false; }, 500);
  }
}

// Browsers refuse to start audio/video without a click. If the room is playing
// and we're not, offer a one-tap catch-up instead of silently drifting.
function watchForBlockedPlayback() {
  clearTimeout(gestureTimer);
  gestureTimer = setTimeout(() => {
    if (localPlaying && !reallyPlaying()) showGesture();
    else hideGesture();
  }, 1500);
}

function showGesture() { els.gesture.hidden = false; }
function hideGesture() { els.gesture.hidden = true; }

function setPlayButton(playing) {
  localPlaying = playing;
  els.toggle.classList.toggle('playing', playing);
  els.toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function paint() {
  const duration = getDuration();
  const time = getTime();
  els.timeTotal.textContent = formatTime(duration);
  if (!dragging) {
    const pct = duration > 0 ? (time / duration) * 100 : 0;
    els.scrub.value = String(Math.round(pct * 10));
    els.scrub.style.setProperty('--progress', `${pct}%`);
    els.timeCurrent.textContent = formatTime(time);
  }
}

setInterval(paint, 250);

// Quiet position report so late joiners land in the right second.
setInterval(() => {
  if (socket && mode && localPlaying && reallyPlaying()) {
    socket.emit('heartbeat', { time: getTime(), isPlaying: true });
  }
}, 5000);

/* ---------------- local controls ---------------- */

els.toggle.addEventListener('click', () => {
  if (!mode) return;
  hideGesture();
  if (localPlaying) {
    doPause();
    setPlayButton(false);
    socket.emit('pause', { time: getTime() });
  } else {
    doPlay();
    setPlayButton(true);
    socket.emit('play', { time: getTime() });
  }
});

els.scrub.addEventListener('input', () => {
  if (!mode) return;
  dragging = true;
  const pct = Number(els.scrub.value) / 10;
  els.scrub.style.setProperty('--progress', `${pct}%`);
  els.timeCurrent.textContent = formatTime((pct / 100) * getDuration());
});

els.scrub.addEventListener('change', () => {
  if (!mode) { dragging = false; return; }
  const pct = Number(els.scrub.value) / 10;
  const time = (pct / 100) * getDuration();
  dragging = false;
  doSeek(time);
  socket.emit('seek', { time });
});

els.resync.addEventListener('click', () => {
  if (socket) socket.emit('resync');
});

els.gesture.addEventListener('click', () => {
  hideGesture();
  doPlay();               // must happen inside the click to satisfy autoplay rules
  if (socket) socket.emit('resync');
});

els.loadForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = els.url.value.trim();
  if (!url) return;
  els.loadError.hidden = true;
  socket.emit('load', { url });
  els.url.value = '';
});

els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;
  socket.emit('chat', { text });
  els.chatInput.value = '';
});

/* ---------------- rail ---------------- */

function addActivity(text, at) {
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = clockTime(at || Date.now());
  li.append(time, document.createTextNode(text));
  els.activity.append(li);
  els.activity.scrollTop = els.activity.scrollHeight;
  while (els.activity.children.length > 120) els.activity.firstChild.remove();
}

function addChat(name, text, mine) {
  const li = document.createElement('li');
  const who = document.createElement('span');
  who.className = mine ? 'who mine' : 'who';
  who.textContent = name;
  li.append(who, document.createTextNode(text));
  els.chat.append(li);
  els.chat.scrollTop = els.chat.scrollHeight;
}

/* ---------------- joining ---------------- */

const params = new URLSearchParams(location.search);
if (params.get('room')) els.room.value = params.get('room').toUpperCase();
function rememberName(value) {
  try { localStorage.setItem('wt-name', value); } catch (_) { /* storage blocked */ }
}
function recallName() {
  try { return localStorage.getItem('wt-name') || ''; } catch (_) { return ''; }
}

els.name.value = recallName();
(els.room.value ? els.name : els.room).focus();

const WORDS = ['POPCORN', 'SOFA', 'RERUN', 'MATINEE', 'INTERMISSION', 'CREDITS', 'PROJECTOR'];
els.dice.addEventListener('click', () => {
  const word = WORDS[Math.floor(Math.random() * WORDS.length)];
  els.room.value = `${word}-${Math.floor(100 + Math.random() * 900)}`;
});

els.join.addEventListener('click', join);
els.room.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
els.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

function join() {
  const name = els.name.value.trim();
  const room = els.room.value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!name) return fail('Enter a name so the other person knows who did what.');
  if (!room) return fail('Enter a room code. Letters, numbers and dashes.');

  if (typeof io === 'undefined') {
    return fail('The page loaded without its connection script. Open it through the server address (http://localhost:3000 or your Render URL), not by double-clicking index.html.');
  }

  rememberName(name);
  els.setupError.hidden = true;
  els.join.disabled = true;

  socket = io();
  wireSocket();

  socket.on('connect_error', (err) => {
    fail(`Can't reach the server: ${err.message}. Is it still running?`);
  });

  const noReply = setTimeout(() => {
    fail('The server accepted the connection but never answered. Check the server log for an error.');
  }, 8000);

  socket.emit('join', { name, room }, (res) => {
    clearTimeout(noReply);
    els.join.disabled = false;
    if (!res || !res.ok) return fail((res && res.error) || 'Could not join that room.');

    myName = res.name;
    roomCode = res.room;
    els.setup.hidden = true;
    els.roomView.hidden = false;
    els.roomLabel.textContent = roomCode;

    const url = new URL(location.href);
    url.searchParams.set('room', roomCode);
    history.replaceState({}, '', url);

    addActivity(`You joined ${roomCode}`);
    if (res.state.video) applyState(res.state, true);
  });
}

function fail(message) {
  els.setupError.textContent = message;
  els.setupError.hidden = false;
  els.join.disabled = false;
}

function wireSocket() {
  socket.on('state', (state) => {
    // Our own play/pause/seek already happened locally; re-applying it would
    // stutter. A load still gets applied, because we never load locally.
    if (state.byId === socket.id && state.action !== 'load') return;
    applyState(state, state.action === 'seek' || state.action === 'load');
  });

  socket.on('sync', (state) => applyState(state, true));

  socket.on('activity', (msg) => addActivity(msg.text, msg.at));

  socket.on('chat', (msg) => addChat(msg.name, msg.text, msg.name === myName));

  socket.on('users', (users) => {
    els.watchers.textContent = users.length === 1
      ? 'just you so far'
      : `${users.length} watching · ${users.join(', ')}`;
  });

  socket.on('load-error', (message) => {
    els.loadError.textContent = message;
    els.loadError.hidden = false;
  });

  socket.on('disconnect', () => addActivity('Lost connection — reconnecting'));
  socket.on('connect', () => {
    if (roomCode) socket.emit('join', { name: myName, room: roomCode }, () => socket.emit('resync'));
  });
}

els.copyLink.addEventListener('click', async () => {
  const url = new URL(location.href);
  url.searchParams.set('room', roomCode);
  try {
    await navigator.clipboard.writeText(url.toString());
    els.copyLink.textContent = 'Copied';
  } catch (_) {
    els.copyLink.textContent = url.toString();
  }
  setTimeout(() => { els.copyLink.textContent = 'Copy invite link'; }, 1800);
});
