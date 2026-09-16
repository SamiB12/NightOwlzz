# Watch Together

A small watch-party site. Two or more people enter the same room code, load a video, and playback stays in sync: when one person hits play, pauses, or drags the scrub bar, everyone moves with them. There's a chat box, an activity log, and a resync button for when someone drifts.

Built with Node.js, Express and Socket.IO. Room state lives in memory on the server.

## What it works with

**Works:**
- YouTube links — `youtube.com/watch?v=...`, `youtu.be/...`, `/shorts/...`, `/embed/...`
- Direct links to video files — an `.mp4`, `.webm` or `.ogg` URL that a browser can play on its own

**Does not work:** Netflix, Disney+, Max, Hulu, Prime Video, Apple TV+, or any other subscription streaming service.

This isn't a gap in the code. Those services wrap their video in DRM (Widevine, PlayReady, FairPlay) and serve it only through their own player on their own domain. No third-party site can embed that player or read its playback position — the browser deliberately prevents it.

For those services, use a browser extension that runs *inside* their site instead:
- **[Teleparty](https://www.teleparty.com/)** — Chrome/Edge extension. Netflix, Disney+, Max, Hulu, Prime Video.
- **[Scener](https://scener.com/)** — Chrome extension with video chat alongside. Similar catalogue.
- Both require each person to have their own subscription to the service.

One more caveat for direct file URLs: the file has to be reachable by both people and served with CORS allowed. A file sitting on your own hard drive won't work — put it somewhere public (an S3 bucket, a static host) or use a YouTube link.

## Running it locally

Requires Node 18 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000. Open a second browser window (or an incognito window) to the same room code to test the sync with yourself.

Localhost is fine for testing, but it only exists on your machine — the other person can't reach it. For an actual watch party you need the server on the public internet. See below.

## Deploying it for free

Both people's browsers need to talk to the *same* server, so it has to be publicly reachable. Two good free options:

### Render.com

1. Push this folder to a GitHub repository.
2. Sign in at [render.com](https://render.com) with GitHub.
3. **New → Web Service**, pick the repo.
4. Settings: Runtime `Node`, Build command `npm install`, Start command `npm start`.
5. Pick the **Free** instance type and create the service.
6. You'll get a URL like `https://watch-together-xxxx.onrender.com`. Share it.

Notes on the free plan:
- Services spin down after 15 minutes with no inbound traffic and take about a minute to wake up. Load the URL a couple of minutes before your watch party starts.
- Active WebSocket traffic counts as inbound traffic, so it won't fall asleep in the middle of a movie.
- Each workspace gets 750 free instance hours per month, which is enough to keep one service alive continuously.
- The filesystem is ephemeral and the server restarts drop all room state. That's fine here — rooms are in memory by design.

### Railway.app

1. Push to GitHub.
2. Sign in at [railway.app](https://railway.app), then **New Project → Deploy from GitHub repo**.
3. Railway detects Node and runs `npm install` / `npm start` automatically.
4. Under **Settings → Networking**, click **Generate Domain** to get a public URL.

Railway gives a small monthly trial credit rather than a permanent free tier, but it doesn't sleep.

Either way, the app reads `process.env.PORT`, so no config changes are needed.

## How the syncing works

The server keeps one record per room code:

```
{ video, isPlaying, currentTime, lastUpdate }
```

`currentTime` is an anchor, not a live clock. When someone joins or asks to resync, the server computes the live position as `currentTime + (now - lastUpdate)` if the video is playing, so a late joiner lands in the right second rather than wherever the last pause happened.

Play, pause, seek and load each re-anchor that record and broadcast to everyone in the room. Clients also send a quiet `heartbeat` every five seconds while playing — it refreshes the server's anchor but is never broadcast, so nobody else's playback is disturbed.

Socket events are emitted only from the custom controls, never from playback ticks. Native controls are hidden on both players (`controls: 0` for the YouTube IFrame API, no `controls` attribute on the `<video>` element) so there's no second, unsynced way to scrub.

Rooms with nobody in them are kept for an hour, then dropped.

## Files

```
server.js           Express + Socket.IO, room state, YouTube URL parsing
public/index.html   The whole UI
public/style.css    Styling
public/app.js       Player abstraction, sync logic, chat
```
