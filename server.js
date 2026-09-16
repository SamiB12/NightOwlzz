'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

/**
 * rooms: Map<roomCode, {
 *   video: { type: 'youtube' | 'direct', src: string, label: string } | null,
 *   isPlaying: boolean,
 *   currentTime: number,      // anchor position in seconds
 *   lastUpdate: number,       // ms epoch the anchor was recorded
 *   users: Map<socketId, name>,
 *   emptySince: number | null
 * }>
 */
const rooms = new Map();

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      video: null,
      isPlaying: false,
      currentTime: 0,
      lastUpdate: Date.now(),
      users: new Map(),
      emptySince: null
    };
    rooms.set(code, room);
  }
  return room;
}

// Where the video actually is right now, accounting for time elapsed since the
// last update if it has been playing since then.
function livePosition(room) {
  if (!room.isPlaying) return room.currentTime;
  return room.currentTime + (Date.now() - room.lastUpdate) / 1000;
}

function anchor(room, time, isPlaying) {
  if (Number.isFinite(time) && time >= 0) room.currentTime = time;
  if (typeof isPlaying === 'boolean') room.isPlaying = isPlaying;
  room.lastUpdate = Date.now();
}

function snapshot(room) {
  return {
    video: room.video,
    isPlaying: room.isPlaying,
    currentTime: livePosition(room),
    serverTime: Date.now(),
    users: Array.from(room.users.values())
  };
}

const YT_PATTERN =
  /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

function parseVideo(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return null;

  const yt = url.match(YT_PATTERN);
  if (yt) return { type: 'youtube', src: yt[1], label: `YouTube · ${yt[1]}` };

  // A bare 11-character YouTube ID pasted on its own.
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) {
    return { type: 'youtube', src: url, label: `YouTube · ${url}` };
  }

  if (/^https?:\/\//i.test(url)) {
    let label = url;
    try {
      const parsed = new URL(url);
      label = decodeURIComponent(parsed.pathname.split('/').pop()) || parsed.hostname;
    } catch (_) {
      /* keep the raw string */
    }
    return { type: 'direct', src: url, label };
  }

  return null;
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 24) || 'Guest';
}

function cleanCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 24);
}

io.on('connection', (socket) => {
  let roomCode = null;
  let name = null;

  const activity = (text) => {
    if (roomCode) io.to(roomCode).emit('activity', { text, at: Date.now() });
  };

  socket.on('join', (payload = {}, ack) => {
    roomCode = cleanCode(payload.room);
    name = cleanName(payload.name);
    if (!roomCode) {
      if (typeof ack === 'function') ack({ ok: false, error: 'That room code is not usable.' });
      return;
    }

    const room = getRoom(roomCode);
    room.users.set(socket.id, name);
    room.emptySince = null;
    socket.join(roomCode);

    if (typeof ack === 'function') ack({ ok: true, room: roomCode, name, state: snapshot(room) });

    io.to(roomCode).emit('users', Array.from(room.users.values()));
    socket.to(roomCode).emit('activity', { text: `${name} joined`, at: Date.now() });
  });

  socket.on('load', (payload = {}) => {
    if (!roomCode) return;
    const video = parseVideo(payload.url);
    if (!video) {
      socket.emit('load-error', 'Paste a YouTube link or a direct link to a video file.');
      return;
    }
    const room = getRoom(roomCode);
    room.video = video;
    anchor(room, 0, false);
    io.to(roomCode).emit('state', { ...snapshot(room), action: 'load', by: name, byId: socket.id });
    activity(`${name} loaded ${video.label}`);
  });

  socket.on('play', (payload = {}) => {
    if (!roomCode) return;
    const room = getRoom(roomCode);
    anchor(room, payload.time, true);
    io.to(roomCode).emit('state', { ...snapshot(room), action: 'play', by: name, byId: socket.id });
    activity(`${name} hit play`);
  });

  socket.on('pause', (payload = {}) => {
    if (!roomCode) return;
    const room = getRoom(roomCode);
    anchor(room, payload.time, false);
    io.to(roomCode).emit('state', { ...snapshot(room), action: 'pause', by: name, byId: socket.id });
    activity(`${name} hit pause`);
  });

  socket.on('seek', (payload = {}) => {
    if (!roomCode) return;
    const room = getRoom(roomCode);
    anchor(room, payload.time, room.isPlaying);
    io.to(roomCode).emit('state', { ...snapshot(room), action: 'seek', by: name, byId: socket.id });
    activity(`${name} jumped to ${formatTime(payload.time)}`);
  });

  // Quiet position report. Refreshes the stored anchor so a late joiner lands in
  // the right place. Nothing is broadcast, so nobody else's playback is touched.
  socket.on('heartbeat', (payload = {}) => {
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (payload.isPlaying !== room.isPlaying) return;
    anchor(room, payload.time, room.isPlaying);
  });

  // "I think I've drifted — where should I be?" Answered to this socket only.
  socket.on('resync', () => {
    if (!roomCode) return;
    socket.emit('sync', snapshot(getRoom(roomCode)));
  });

  socket.on('chat', (payload = {}) => {
    if (!roomCode) return;
    const text = String(payload.text || '').trim().slice(0, 500);
    if (!text) return;
    io.to(roomCode).emit('chat', { name, text, at: Date.now() });
  });

  socket.on('disconnect', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.users.delete(socket.id);
    io.to(roomCode).emit('users', Array.from(room.users.values()));
    io.to(roomCode).emit('activity', { text: `${name} left`, at: Date.now() });
    if (room.users.size === 0) room.emptySince = Date.now();
  });
});

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Empty rooms keep their state for an hour, so a refresh or a dropped
// connection doesn't lose everyone's place.
const ROOM_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.users.size === 0 && room.emptySince && now - room.emptySince > ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Watch Together is running on http://localhost:${PORT}`);
});
