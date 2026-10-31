require('dotenv').config();
const path = require('path');
const http = require('http');
const { Readable } = require('stream');
const express = require('express');
const { WebSocketServer } = require('ws');
const {
  getStreamInfo,
  getTopLiveStreams,
  searchLiveChannels,
  getMasterPlaylistUrl,
  rewritePlaylist,
  getAdStats,
  ADFREE_PLAYER_TYPES,
} = require('./src/twitchProxy');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = process.env.PORT || 3000;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';

app.use(express.json());

// Serve local vendor libraries from node_modules so Discord's strict CSP ('self') is satisfied
app.use(
  '/vendor/hls',
  express.static(path.join(__dirname, 'node_modules', 'hls.js', 'dist'))
);
app.use(
  '/vendor/discord-sdk',
  express.static(path.join(__dirname, 'node_modules', '@discord', 'embedded-app-sdk', 'output'))
);

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// In-memory room state keyed by Discord Activity instanceId (or 'default' in browser)
// Default channel is null -> opens on the interactive Twitch Home Page!
const rooms = new Map();

async function getOrCreateRoom(instanceId) {
  const id = instanceId || 'default';
  if (!rooms.has(id)) {
    let initialHistory = ['caedrel', 'riotgames', 'ibai', 'shroud'];
    try {
      const topStreams = await getTopLiveStreams(6).catch(() => []);
      if (topStreams.length > 0) {
        initialHistory = topStreams.map((s) => s.login).slice(0, 8);
      }
    } catch {
      // ignore
    }

    rooms.set(id, {
      channel: null, // null = Twitch Home Page browse screen
      updatedBy: 'Twitch Home',
      updatedAt: Date.now(),
      history: initialHistory,
    });
  }
  return rooms.get(id);
}

// --- API Routes ---

// Public config for the frontend
app.get('/api/config', (req, res) => {
  res.json({
    clientId: DISCORD_CLIENT_ID,
    adStats: getAdStats(),
  });
});

// Optional Discord OAuth2 token exchange for Embedded App SDK
app.post('/api/token', async (req, res) => {
  const { code } = req.body || {};
  if (!code || !DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    return res.status(400).json({ error: 'Missing code or Discord OAuth credentials' });
  }

  try {
    const response = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }
    return res.json({ access_token: data.access_token });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Get room state
app.get('/api/room/:instanceId', async (req, res) => {
  const room = await getOrCreateRoom(req.params.instanceId);
  res.json(room);
});

// Change channel in room (or return to '__home__')
app.post('/api/room/:instanceId/channel', async (req, res) => {
  const instanceId = req.params.instanceId || 'default';
  const { channel, username } = req.body || {};

  if (channel === '__home__' || channel === null) {
    const room = await updateRoomChannel(instanceId, null, username || 'Viewer');
    broadcastToRoom(instanceId, { type: 'ROOM_STATE', room });
    return res.json(room);
  }

  const cleanChannel = extractChannelName(channel);
  if (!cleanChannel) {
    return res.status(400).json({ error: 'Invalid Twitch channel name' });
  }

  const room = await updateRoomChannel(instanceId, cleanChannel, username || 'Viewer');
  broadcastToRoom(instanceId, {
    type: 'ROOM_STATE',
    room,
  });

  res.json(room);
});

// Get currently top live Twitch streams for the Home Page
app.get('/api/twitch/top', async (req, res) => {
  try {
    const streams = await getTopLiveStreams(24);
    res.json({ streams });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search live Twitch channels for the Home Page
app.get('/api/twitch/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      const streams = await getTopLiveStreams(24);
      return res.json({ streams });
    }
    const streams = await searchLiveChannels(q, 20);
    res.json({ streams });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Twitch stream metadata
app.get('/api/twitch/:channel/info', async (req, res) => {
  try {
    const cleanChannel = extractChannelName(req.params.channel);
    const info = await getStreamInfo(cleanChannel);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CSP-safe Image Proxy for Twitch thumbnails & avatars (*.jtvnw.net / *.ttvnw.net)
app.get('/api/img', async (req, res) => {
  const encoded = req.query.u;
  if (!encoded || typeof encoded !== 'string') {
    return res.status(400).end();
  }
  try {
    const targetUrl = Buffer.from(encoded, 'base64url').toString('utf8');
    if (!isAllowedUpstreamHost(targetUrl)) {
      return res.status(403).end();
    }
    const upstream = await fetch(targetUrl);
    if (!upstream.ok) return res.status(upstream.status).end();
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=120');
    if (upstream.body) {
      return Readable.fromWeb(upstream.body).pipe(res);
    }
    const buf = await upstream.arrayBuffer();
    return res.end(Buffer.from(buf));
  } catch {
    return res.status(502).end();
  }
});

// Master HLS playlist for a Twitch channel (proxied & rewritten for Discord CSP)
app.get('/api/hls/:channel/master.m3u8', async (req, res) => {
  try {
    const cleanChannel = extractChannelName(req.params.channel);
    const requestedType = req.query.playerType || ADFREE_PLAYER_TYPES[0];
    const masterUrl = await getMasterPlaylistUrl(cleanChannel, requestedType);

    const upstream = await fetch(masterUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/x-mpegURL, application/vnd.apple.mpegurl, */*',
      },
    });

    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .json({ error: `Channel "${cleanChannel}" is offline or unavailable (${upstream.status})` });
    }

    const m3u8Text = await upstream.text();
    const rewritten = rewritePlaylist(m3u8Text, masterUrl);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    res.send(rewritten);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Security helper: allow only Twitch/TTVNW/IVS HLS & image CDN hosts
function isAllowedUpstreamHost(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host.endsWith('.ttvnw.net') ||
      host === 'ttvnw.net' ||
      host.endsWith('.live-video.net') ||
      host === 'live-video.net' ||
      host.endsWith('.jtvnw.net') ||
      host === 'jtvnw.net' ||
      host.endsWith('.twitch.tv') ||
      host === 'twitch.tv' ||
      host.endsWith('.cloudfront.net') ||
      host.endsWith('.akamaized.net')
    );
  } catch {
    return false;
  }
}

// Proxy HLS variant playlists (.m3u8) and transport stream segments (.ts / .mp4)
app.get('/api/hls/proxy', async (req, res) => {
  const encoded = req.query.u;
  if (!encoded || typeof encoded !== 'string') {
    return res.status(400).send('Missing parameter u');
  }

  let targetUrl;
  try {
    targetUrl = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return res.status(400).send('Invalid encoded URL');
  }

  if (!isAllowedUpstreamHost(targetUrl)) {
    return res.status(403).send('Forbidden upstream host');
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Connection: 'keep-alive',
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream error ${upstream.status}`);
    }

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const pathname = new URL(targetUrl).pathname.toLowerCase();
    const isM3u8 =
      pathname.endsWith('.m3u8') ||
      contentType.includes('mpegurl') ||
      contentType.includes('m3u8');

    if (isM3u8) {
      const text = await upstream.text();
      const rewritten = rewritePlaylist(text, targetUrl);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.send(rewritten);
    }

    // Stream binary video/audio segment (.ts / .mp4 / .aac) directly with zero buffering delay
    res.setHeader('Content-Type', contentType || 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=10');

    if (upstream.body) {
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on('error', () => {
        if (!res.writableEnded) res.end();
      });
      return nodeStream.pipe(res);
    }

    const arrayBuffer = await upstream.arrayBuffer();
    return res.end(Buffer.from(arrayBuffer));
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).send(`Proxy error: ${err.message}`);
    }
  }
});

// --- Helpers & WebSocket Sync ---

function extractChannelName(input) {
  if (!input) return '';
  let str = input.trim();
  try {
    if (str.includes('twitch.tv/')) {
      const match = str.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i);
      if (match && match[1]) {
        str = match[1];
      }
    }
  } catch {
    // ignore
  }
  return str.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
}

async function updateRoomChannel(instanceId, channel, username) {
  const room = await getOrCreateRoom(instanceId);
  room.channel = channel; // null means Twitch Home view
  room.updatedBy = username || 'Viewer';
  room.updatedAt = Date.now();
  if (channel) {
    room.history = [channel, ...room.history.filter((c) => c !== channel)].slice(0, 8);
  }
  return room;
}

function getRoomViewerCount(instanceId) {
  let count = 0;
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.instanceId === instanceId) {
      count++;
    }
  }
  return count;
}

function broadcastToRoom(instanceId, payload) {
  const data = JSON.stringify({
    ...payload,
    roomViewers: getRoomViewerCount(instanceId),
  });
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.instanceId === instanceId) {
      client.send(data);
    }
  }
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const instanceId = url.searchParams.get('instanceId') || 'default';
  ws.instanceId = instanceId;

  const room = await getOrCreateRoom(instanceId);
  if (ws.readyState === 1) {
    ws.send(
      JSON.stringify({
        type: 'ROOM_STATE',
        room,
        roomViewers: getRoomViewerCount(instanceId),
      })
    );
  }

  broadcastToRoom(instanceId, {
    type: 'VIEWER_COUNT',
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'SET_CHANNEL') {
        if (msg.channel === '__home__' || msg.channel === null) {
          const updatedRoom = await updateRoomChannel(
            instanceId,
            null,
            msg.username || 'Discord User'
          );
          broadcastToRoom(instanceId, {
            type: 'ROOM_STATE',
            room: updatedRoom,
          });
          return;
        }

        const clean = extractChannelName(msg.channel);
        if (clean) {
          const updatedRoom = await updateRoomChannel(
            instanceId,
            clean,
            msg.username || 'Discord User'
          );
          broadcastToRoom(instanceId, {
            type: 'ROOM_STATE',
            room: updatedRoom,
          });
        }
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    broadcastToRoom(instanceId, {
      type: 'VIEWER_COUNT',
    });
  });
});

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🎮 Twitch Discord Activity Server running!`);
  console.log(`🔗 Local Preview: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});
