# Twitch Watch Party — Discord Activity

An official, ToS-compliant **Discord Activity** (Embedded App) that lets everyone in a Discord voice channel watch live Twitch streams together with real-time channel synchronization, **ultra-low-latency streaming**, **built-in HLS AdBlocker**, and **Discord-compatible Fullscreen mode**.

## Key Features
- **⚡ Ultra-Low-Latency Streaming**: Uses Twitch `low_latency=true` + `#EXT-X-TWITCH-PREFETCH` tail segment conversion + zero-buffering Node stream piping + automatic `hls.js` live-edge catch-up (`1.5s–2.5s` live delay).
- **🛡️ Built-In HLS AdBlocker**: Uses ad-free player token spoofing (`embed` / `popout`) and strips `#EXT-X-DATERANGE` `twitch-stitched-ad` / commercial segments from `.m3u8` playlists before they reach the player.
- **⛶ Fullscreen Inside Discord**: Works around Discord's Activity `<iframe>` fullscreen restriction with a full-viewport Cinema/Fullscreen mode (`⛶ Fullscreen` button, floating `⛶` button, double-click video, or press `F`).
- **👥 Real-Time Watch Together Sync**: Everyone in the same Discord Voice Channel automatically switches streams together via WebSockets.

---

## Quick Deploy with Docker

### Option 1: Run from Docker Hub
```bash
docker run -d \
  --name twitch-discord-activity \
  --restart unless-stopped \
  -p 3000:3000 \
  -e DISCORD_CLIENT_ID=1566158462042378290 \
  thekingziga/twitch-discord-streamer:latest
```

### Option 2: Docker Compose (`docker/docker-compose.yml`)
```bash
docker compose up -d
```

---

## Run Locally (Node.js)

```bash
npm install
npm start
```
Then open **http://localhost:3000** in your browser, or expose port `3000` via Cloudflare Tunnel / reverse proxy and set the Root Mapping (`/`) in the [Discord Developer Portal](https://discord.com/developers/applications) under **Activities → URL Mappings**.
