const video = document.getElementById('videoPlayer');
const videoStage = document.getElementById('videoStage');
const homeView = document.getElementById('homeView');
const homeGrid = document.getElementById('homeGrid');
const homeHeading = document.getElementById('homeHeading');
const homeSearchInput = document.getElementById('homeSearchInput');
const refreshHomeBtn = document.getElementById('refreshHomeBtn');
const homeBtn = document.getElementById('homeBtn');
const quickHomeChip = document.getElementById('quickHomeChip');
const playerControlsGroup = document.getElementById('playerControlsGroup');
const streamFooter = document.getElementById('streamFooter');

const channelForm = document.getElementById('channelForm');
const channelInput = document.getElementById('channelInput');
const qualitySelect = document.getElementById('qualitySelect');
const liveEdgeBtn = document.getElementById('liveEdgeBtn');
const latencyTextEl = document.getElementById('latencyText');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const floatingFsBtn = document.getElementById('floatingFsBtn');
const roomViewerCountEl = document.getElementById('roomViewerCount');
const historyChipsEl = document.getElementById('historyChips');
const syncedByTextEl = document.getElementById('syncedByText');
const sdkBadgeEl = document.getElementById('sdkBadge');
const adblockBadgeEl = document.getElementById('adblockBadge');
const unmuteBanner = document.getElementById('unmuteBanner');

const statusOverlay = document.getElementById('statusOverlay');
const statusSpinner = document.getElementById('statusSpinner');
const statusTitle = document.getElementById('statusTitle');
const statusSubtitle = document.getElementById('statusSubtitle');

const streamerAvatar = document.getElementById('streamerAvatar');
const streamerName = document.getElementById('streamerName');
const liveBadge = document.getElementById('liveBadge');
const streamerCategory = document.getElementById('streamerCategory');
const streamTitle = document.getElementById('streamTitle');
const twitchViewerStat = document.getElementById('twitchViewerStat');
const twitchViewerCount = document.getElementById('twitchViewerCount');

let hls = null;
let currentChannel = undefined; // null = Home View, string = active Twitch channel
let instanceId = 'default';
let currentUsername = 'Viewer';
let ws = null;
let metadataTimer = null;
let latencyTimer = null;
let searchDebounce = null;

/**
 * Initialize Discord Embedded App SDK if launched inside a Discord Activity iframe.
 */
async function initDiscordContext() {
  const params = new URLSearchParams(window.location.search);
  const frameId = params.get('frame_id');
  const urlInstanceId = params.get('instance_id');

  const configRes = await fetch('/api/config').catch(() => null);
  const config = configRes ? await configRes.json() : {};

  let clientId = config.clientId;
  if (!clientId && window.location.hostname.endsWith('.discordsays.com')) {
    clientId = window.location.hostname.split('.')[0];
  }

  if (urlInstanceId) {
    instanceId = urlInstanceId;
  }

  if (frameId && clientId) {
    try {
      const { DiscordSDK } = await import('/vendor/discord-sdk/index.mjs');
      const discordSdk = new DiscordSDK(clientId, {
        disableConsoleLogOverride: true,
      });
      await discordSdk.ready();
      sdkBadgeEl.textContent = 'Discord Activity';
      sdkBadgeEl.classList.add('discord-active');
      currentUsername = 'Discord Member';
    } catch (err) {
      console.warn('Discord SDK initialization fallback:', err);
      sdkBadgeEl.textContent = 'Discord Iframe';
    }
  } else {
    sdkBadgeEl.textContent = 'Browser Preview';
  }
}

/**
 * Toggle Fullscreen / Cinema Mode (works inside Discord Activity iframe & standalone browser)
 */
function toggleFullscreenMode() {
  const isFullscreenClass = document.body.classList.toggle('fullscreen-mode');
  fullscreenBtn.textContent = isFullscreenClass ? '✕ Exit Fullscreen' : '⛶ Fullscreen';
  floatingFsBtn.textContent = isFullscreenClass ? '✕' : '⛶';

  if (isFullscreenClass) {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  } else if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

fullscreenBtn.addEventListener('click', toggleFullscreenMode);
floatingFsBtn.addEventListener('click', toggleFullscreenMode);
video.addEventListener('dblclick', (e) => {
  e.preventDefault();
  toggleFullscreenMode();
});

window.addEventListener('keydown', (e) => {
  if (
    document.activeElement === channelInput ||
    document.activeElement === homeSearchInput
  ) {
    return;
  }
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault();
    toggleFullscreenMode();
  } else if (e.key === 'Escape' && document.body.classList.contains('fullscreen-mode')) {
    toggleFullscreenMode();
  }
});

/**
 * Show or hide the video status overlay
 */
function setOverlay(visible, title = '', subtitle = '', showSpinner = true) {
  if (!visible) {
    statusOverlay.classList.add('hidden');
    return;
  }
  statusOverlay.classList.remove('hidden');
  statusTitle.textContent = title;
  statusSubtitle.textContent = subtitle;
  if (showSpinner) {
    statusSpinner.classList.remove('hidden');
  } else {
    statusSpinner.classList.add('hidden');
  }
}

/**
 * Format viewer counts (e.g. 235400 -> 235.4K)
 */
function formatViewerCount(num) {
  const n = Number(num || 0);
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K viewers`;
  }
  return `${n} viewers`;
}

/**
 * Fetch and render the Twitch Home Page live stream grid
 */
async function loadTwitchHomeStreams(searchQuery = '') {
  homeGrid.innerHTML =
    '<p style="color:#adadb8;font-size:0.9rem;">Loading live Twitch channels...</p>';

  try {
    const endpoint = searchQuery.trim()
      ? `/api/twitch/search?q=${encodeURIComponent(searchQuery.trim())}`
      : '/api/twitch/top';

    const res = await fetch(endpoint);
    if (!res.ok) throw new Error('Failed to load streams');
    const data = await res.json();
    const streams = data.streams || [];

    homeHeading.textContent = searchQuery.trim()
      ? `Live Search Results for "${searchQuery.trim()}"`
      : 'Live Channels on Twitch';

    if (streams.length === 0) {
      homeGrid.innerHTML =
        '<p style="color:#adadb8;font-size:0.9rem;">No live streams found matching that search.</p>';
      return;
    }

    homeGrid.innerHTML = '';
    streams.forEach((s) => {
      const card = document.createElement('article');
      card.className = 'stream-card';
      card.innerHTML = `
        <div class="card-thumb-wrap">
          <img class="card-thumb" src="${s.thumbnail}" alt="${s.displayName}" loading="lazy" />
          <span class="card-live-pill">LIVE</span>
          <span class="card-viewers-pill">🔴 ${formatViewerCount(s.viewers)}</span>
        </div>
        <div class="card-body">
          <img class="card-avatar" src="${s.avatar}" alt="${s.displayName}" loading="lazy" />
          <div class="card-info">
            <div class="card-title" title="${(s.title || '').replace(/"/g, '&quot;')}">${
        s.title || s.displayName
      }</div>
            <div class="card-streamer">${s.displayName}</div>
            <span class="card-game">${s.game || 'Live'}</span>
          </div>
        </div>
      `;
      card.addEventListener('click', () => requestChannelSwitch(s.login));
      homeGrid.appendChild(card);
    });
  } catch (err) {
    homeGrid.innerHTML =
      '<p style="color:#adadb8;font-size:0.9rem;">Could not load live streams right now. Try clicking Refresh.</p>';
  }
}

/**
 * Switch UI to the Twitch Home Page browse view
 */
function showHomeView() {
  currentChannel = null;
  channelInput.value = '';

  if (hls) {
    hls.destroy();
    hls = null;
  }
  video.pause();
  video.removeAttribute('src');

  if (metadataTimer) clearInterval(metadataTimer);
  if (latencyTimer) clearInterval(latencyTimer);

  videoStage.classList.add('hidden');
  streamFooter.classList.add('hidden');
  playerControlsGroup.classList.add('hidden');
  homeView.classList.remove('hidden');
  quickHomeChip.classList.add('active');

  loadTwitchHomeStreams(homeSearchInput.value);
}

refreshHomeBtn.addEventListener('click', () => {
  loadTwitchHomeStreams(homeSearchInput.value);
});

homeSearchInput.addEventListener('input', () => {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    loadTwitchHomeStreams(homeSearchInput.value);
  }, 350);
});

homeBtn.addEventListener('click', () => {
  requestChannelSwitch('__home__');
});

quickHomeChip.addEventListener('click', () => {
  requestChannelSwitch('__home__');
});

/**
 * Fetch and display Twitch channel metadata (title, game, live viewers, avatar, ads blocked)
 */
async function refreshStreamMetadata(channel) {
  try {
    const res = await fetch(`/api/twitch/${encodeURIComponent(channel)}/info`);
    if (!res.ok) return;
    const info = await res.json();

    if (typeof info.adsBlocked === 'number' && info.adsBlocked > 0) {
      adblockBadgeEl.textContent = `🛡️ AdBlock (${info.adsBlocked})`;
    }

    if (!info.exists) {
      streamerName.textContent = channel;
      liveBadge.classList.add('hidden');
      streamerAvatar.classList.add('hidden');
      streamerCategory.textContent = '';
      streamTitle.textContent = 'Channel not found on Twitch.';
      twitchViewerStat.classList.add('hidden');
      return;
    }

    streamerName.textContent = info.displayName || info.login;
    if (info.avatar) {
      streamerAvatar.src = info.avatar;
      streamerAvatar.classList.remove('hidden');
    }

    if (info.isLive) {
      liveBadge.classList.remove('hidden');
      streamerCategory.textContent = info.game ? `• ${info.game}` : '';
      streamTitle.textContent = info.title || 'Live on Twitch';
      twitchViewerCount.textContent = Number(info.viewers || 0).toLocaleString();
      twitchViewerStat.classList.remove('hidden');
    } else {
      liveBadge.classList.add('hidden');
      streamerCategory.textContent = '• Offline';
      streamTitle.textContent = `${info.displayName || channel} is currently offline.`;
      twitchViewerStat.classList.add('hidden');
    }
  } catch (err) {
    console.warn('Metadata fetch error:', err);
  }
}

/**
 * Jump to the absolute real-time live edge of the HLS stream
 */
function snapToLiveEdge() {
  if (!video.seekable || video.seekable.length === 0) return;
  const liveEdge = video.seekable.end(video.seekable.length - 1);
  if (Number.isFinite(liveEdge) && liveEdge > 1.5) {
    video.currentTime = Math.max(0, liveEdge - 1.5);
  }
  video.playbackRate = 1.0;
  video.play().catch(() => {});
}

/**
 * Monitor stream latency and automatically speed up or snap to live edge so delay stays minimal
 */
function startLowLatencyMonitor() {
  if (latencyTimer) clearInterval(latencyTimer);
  latencyTimer = setInterval(() => {
    if (!video || video.paused || !video.seekable || video.seekable.length === 0) return;

    const liveEdge = video.seekable.end(video.seekable.length - 1);
    const delay = Math.max(0, liveEdge - video.currentTime);

    if (Number.isFinite(delay)) {
      latencyTextEl.textContent = `⚡ ${delay.toFixed(1)}s`;

      if (delay > 6.0) {
        video.currentTime = liveEdge - 1.8;
        video.playbackRate = 1.0;
      } else if (delay > 2.8) {
        video.playbackRate = 1.12;
      } else if (video.playbackRate !== 1.0) {
        video.playbackRate = 1.0;
      }
    }
  }, 1500);
}

/**
 * Load a Twitch channel's live HLS stream via our local low-latency + adblock proxy
 */
async function loadTwitchStream(channel) {
  const normalized = channel.trim().toLowerCase();
  if (!normalized || normalized === currentChannel) return;
  currentChannel = normalized;
  channelInput.value = normalized;

  homeView.classList.add('hidden');
  videoStage.classList.remove('hidden');
  streamFooter.classList.remove('hidden');
  playerControlsGroup.classList.remove('hidden');
  quickHomeChip.classList.remove('active');

  setOverlay(
    true,
    `Loading twitch.tv/${normalized}...`,
    'Connecting low-latency ad-free HLS stream...',
    true
  );

  refreshStreamMetadata(normalized);
  if (metadataTimer) clearInterval(metadataTimer);
  metadataTimer = setInterval(() => refreshStreamMetadata(normalized), 20000);

  if (hls) {
    hls.destroy();
    hls = null;
  }

  const playlistUrl = `/api/hls/${encodeURIComponent(normalized)}/master.m3u8`;

  if (window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({
      lowLatencyMode: true,
      liveSyncDuration: 1.8,
      liveMaxLatencyDuration: 4.5,
      maxLiveSyncPlaybackRate: 1.15,
      maxBufferLength: 6,
      maxMaxBufferLength: 12,
      backBufferLength: 4,
      highBufferWatchdogPeriod: 1,
      nudgeMaxRetry: 10,
      enableWorker: true,
    });

    hls.loadSource(playlistUrl);
    hls.attachMedia(video);

    hls.on(window.Hls.Events.MANIFEST_PARSED, (_, data) => {
      setOverlay(false);
      populateQualitySelector(data.levels);
      attemptPlayWithAudio();
      startLowLatencyMonitor();
    });

    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        switch (data.type) {
          case window.Hls.ErrorTypes.NETWORK_ERROR:
            setOverlay(
              true,
              `${normalized} is offline or unavailable`,
              'Click "Twitch Home" at the top left to browse live channels.',
              false
            );
            break;
          case window.Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            setOverlay(
              true,
              'Playback error',
              `Could not play stream for "${normalized}".`,
              false
            );
            hls.destroy();
            break;
        }
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = playlistUrl;
    video.addEventListener(
      'loadedmetadata',
      () => {
        setOverlay(false);
        attemptPlayWithAudio();
        startLowLatencyMonitor();
      },
      { once: true }
    );
  } else {
    setOverlay(true, 'HLS Unsupported', 'Your client does not support HLS video playback.', false);
  }
}

/**
 * Try playing with audio first; if blocked by browser autoplay policy, play muted and show unmute pill
 */
async function attemptPlayWithAudio() {
  try {
    video.muted = false;
    await video.play();
    unmuteBanner.classList.add('hidden');
  } catch {
    try {
      video.muted = true;
      await video.play();
      unmuteBanner.classList.remove('hidden');
    } catch {
      // User can click play manually
    }
  }
}

unmuteBanner.addEventListener('click', () => {
  video.muted = false;
  video.play().catch(() => {});
  unmuteBanner.classList.add('hidden');
});

video.addEventListener('volumechange', () => {
  if (!video.muted && video.volume > 0) {
    unmuteBanner.classList.add('hidden');
  }
});

/**
 * Populate the quality dropdown from parsed HLS variant levels
 */
function populateQualitySelector(levels) {
  qualitySelect.innerHTML = '<option value="-1">Quality: Auto</option>';
  levels.forEach((level, index) => {
    const height = level.height ? `${level.height}p` : '';
    const fps = level.frameRate && level.frameRate > 35 ? `${Math.round(level.frameRate)}` : '';
    const name = level.name || `${height}${fps}` || `Level ${index + 1}`;
    const opt = document.createElement('option');
    opt.value = String(index);
    opt.textContent = name;
    qualitySelect.appendChild(opt);
  });
}

qualitySelect.addEventListener('change', () => {
  if (!hls) return;
  hls.currentLevel = parseInt(qualitySelect.value, 10);
});

liveEdgeBtn.addEventListener('click', () => {
  snapToLiveEdge();
});

/**
 * Render quick-switch channel history chips
 */
function renderHistoryChips(history = [], activeChannel = null) {
  historyChipsEl.innerHTML = '';
  history.forEach((ch) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip ${ch === activeChannel ? 'active' : ''}`;
    btn.textContent = ch;
    btn.addEventListener('click', () => requestChannelSwitch(ch));
    historyChipsEl.appendChild(btn);
  });
}

/**
 * Broadcast channel switch (or '__home__') to everyone in the same Discord Activity instance
 */
async function requestChannelSwitch(rawInput) {
  const trimmed = rawInput ? rawInput.trim() : '__home__';
  if (!trimmed) return;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'SET_CHANNEL',
        channel: trimmed,
        username: currentUsername,
      })
    );
  } else {
    const res = await fetch(`/api/room/${encodeURIComponent(instanceId)}/channel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: trimmed, username: currentUsername }),
    });
    if (res.ok) {
      const room = await res.json();
      applyRoomState(room);
    }
  }
}

function applyRoomState(room) {
  if (!room) return;
  renderHistoryChips(room.history || [], room.channel);

  if (!room.channel) {
    syncedByTextEl.textContent = 'Browsing Twitch Home';
    if (currentChannel !== null) {
      showHomeView();
    }
  } else {
    if (room.updatedBy) {
      syncedByTextEl.textContent = `Switched to ${room.channel} by ${room.updatedBy}`;
    }
    if (room.channel !== currentChannel) {
      loadTwitchStream(room.channel);
    }
  }
}

/**
 * Connect WebSocket for real-time Watch Together sync in the voice channel
 */
function connectRoomWebSocket() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${window.location.host}/ws?instanceId=${encodeURIComponent(instanceId)}`;

  ws = new WebSocket(wsUrl);

  ws.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (typeof data.roomViewers === 'number') {
        roomViewerCountEl.textContent = String(data.roomViewers);
      }
      if (data.type === 'ROOM_STATE' && data.room) {
        applyRoomState(data.room);
      }
    } catch {
      // ignore
    }
  });

  ws.addEventListener('close', () => {
    setTimeout(connectRoomWebSocket, 3000);
  });
}

channelForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!channelInput.value.trim()) {
    requestChannelSwitch('__home__');
  } else {
    requestChannelSwitch(channelInput.value);
  }
});

// Boot the app
(async () => {
  await initDiscordContext();
  connectRoomWebSocket();

  try {
    const res = await fetch(`/api/room/${encodeURIComponent(instanceId)}`);
    if (res.ok) {
      const room = await res.json();
      applyRoomState(room);
    } else {
      showHomeView();
    }
  } catch {
    showHomeView();
  }
})();
