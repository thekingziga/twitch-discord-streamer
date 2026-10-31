const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
// Standard public web Client-ID used by Twitch's web player
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// Never use 'embed' as primary because Twitch burns the purple "Commercial break in progress" slate into 'embed'!
const ADFREE_PLAYER_TYPES = ['site', 'popout', 'autoplay', 'thunderdome'];

// Ad-free region Twitch HLS proxy pool (TTV-LOL-PRO / Luminous servers)
// These generate the master M3U8 from ad-free countries so Twitch never injects ads or purple screens!
const LUMINOUS_PROXIES = [
  'https://eu.luminous.dev',
  'https://eu2.luminous.dev',
  'https://as.luminous.dev',
];

const adStats = {
  totalAdsStripped: 0,
  lastAdBlockedAt: null,
  sourceMode: 'Luminous Ad-Free',
};

function toProxiedImage(url) {
  if (!url) return '';
  return `/api/img?u=${Buffer.from(url, 'utf8').toString('base64url')}`;
}

/**
 * Fetch stream metadata (live status, title, category, viewer count, broadcaster info)
 * using Twitch's public GQL endpoint.
 */
async function getStreamInfo(channelLogin) {
  const login = channelLogin.trim().toLowerCase();
  const query = `
    query GetStreamInfo($login: String!) {
      user(login: $login) {
        id
        login
        displayName
        profileImageURL(width: 70)
        stream {
          id
          title
          type
          viewersCount
          createdAt
          game {
            name
          }
        }
      }
    }
  `;

  const response = await fetch(TWITCH_GQL_URL, {
    method: 'POST',
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: { login },
    }),
  });

  if (!response.ok) {
    throw new Error(`Twitch GQL metadata request failed: ${response.status}`);
  }

  const json = await response.json();
  const user = json?.data?.user;
  if (!user) {
    return { exists: false, isLive: false, login };
  }

  const stream = user.stream;
  return {
    exists: true,
    isLive: Boolean(stream && stream.type === 'live'),
    login: user.login,
    displayName: user.displayName,
    avatar: toProxiedImage(user.profileImageURL),
    title: stream?.title || '',
    game: stream?.game?.name || 'Just Chatting',
    viewers: stream?.viewersCount ?? 0,
    startedAt: stream?.createdAt || null,
    adsBlocked: adStats.totalAdsStripped,
    adblockSource: adStats.sourceMode,
  };
}

/**
 * Fetch top currently live streams on Twitch for the Twitch Home Page grid.
 */
async function getTopLiveStreams(limit = 24) {
  const query = `
    query GetTopStreams($first: Int!) {
      streams(first: $first) {
        edges {
          node {
            broadcaster {
              login
              displayName
              profileImageURL(width: 70)
            }
            title
            viewersCount
            previewImageURL(width: 440, height: 248)
            game {
              name
            }
          }
        }
      }
    }
  `;

  const response = await fetch(TWITCH_GQL_URL, {
    method: 'POST',
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: { first: limit },
    }),
  });

  if (!response.ok) {
    return [];
  }

  const json = await response.json();
  const edges = json?.data?.streams?.edges || [];
  return edges
    .map((e) => e?.node)
    .filter((n) => n && n.broadcaster?.login)
    .map((n) => ({
      login: n.broadcaster.login.toLowerCase(),
      displayName: n.broadcaster.displayName,
      avatar: toProxiedImage(n.broadcaster.profileImageURL),
      thumbnail: toProxiedImage(n.previewImageURL),
      title: n.title || '',
      viewers: n.viewersCount || 0,
      game: n.game?.name || 'Just Chatting',
    }));
}

/**
 * Search live channels on Twitch by keyword for the Home Page search bar.
 */
async function searchLiveChannels(searchQuery, limit = 16) {
  const query = `
    query SearchChannels($userQuery: String!, $first: Int!) {
      searchFor(userQuery: $userQuery, platform: "web") {
        channels(first: $first) {
          edges {
            item {
              login
              displayName
              profileImageURL(width: 70)
              stream {
                id
                title
                viewersCount
                previewImageURL(width: 440, height: 248)
                game {
                  name
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch(TWITCH_GQL_URL, {
    method: 'POST',
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      variables: { userQuery: searchQuery.trim(), first: limit },
    }),
  });

  if (!response.ok) return [];
  const json = await response.json();
  const edges = json?.data?.searchFor?.channels?.edges || [];
  return edges
    .map((e) => e?.item)
    .filter((item) => item && item.login && item.stream)
    .map((item) => ({
      login: item.login.toLowerCase(),
      displayName: item.displayName,
      avatar: toProxiedImage(item.profileImageURL),
      thumbnail: toProxiedImage(item.stream.previewImageURL),
      title: item.stream.title || '',
      viewers: item.stream.viewersCount || 0,
      game: item.stream.game?.name || 'Live',
    }));
}

/**
 * Fetch an ad-free Master M3U8 playlist text and its base URL.
 * Primary: Luminous TTV-LOL-PRO ad-free region proxies (0 pre-rolls, 0 mid-rolls, 0 purple commercial screens).
 * Fallback: Direct Twitch GQL with non-embed playerType ('site' / 'popout').
 */
async function fetchCleanMasterPlaylist(channelLogin, playerType = 'site') {
  const login = channelLogin.trim().toLowerCase();
  const queryParams = new URLSearchParams({
    allow_source: 'true',
    allow_audio_only: 'true',
    allow_spectre: 'true',
    fast_bread: 'true',
    low_latency: 'true',
    playlist_include_framerate: 'true',
    reassignments_supported: 'true',
    supported_codecs: 'avc1',
    p: String(Math.floor(Math.random() * 999999)),
  }).toString();

  // Layer 1: Try Luminous ad-free proxy servers first
  for (const host of LUMINOUS_PROXIES) {
    const targetUrl = `${host}/live/${encodeURIComponent(login)}?${queryParams}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'application/x-mpegURL, application/vnd.apple.mpegurl, */*',
        },
      });
      clearTimeout(timeout);

      if (res.ok) {
        const text = await res.text();
        if (text && text.includes('#EXTM3U') && text.includes('#EXT-X-STREAM-INF')) {
          adStats.sourceMode = `Luminous (${new URL(host).hostname.split('.')[0].toUpperCase()})`;
          return { m3u8Text: text, baseUrl: targetUrl };
        }
      }
    } catch {
      // Try next proxy node
    }
  }

  // Layer 2: Fallback to direct Twitch GQL using 'site' (never 'embed')
  const safePlayerType = playerType === 'embed' ? 'site' : playerType;
  const masterUrl = await getMasterPlaylistUrl(login, safePlayerType);
  const upstream = await fetch(masterUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'application/x-mpegURL, application/vnd.apple.mpegurl, */*',
    },
  });

  if (!upstream.ok) {
    throw new Error(`Channel "${login}" is offline or unavailable (${upstream.status})`);
  }

  adStats.sourceMode = `Direct (${safePlayerType})`;
  const m3u8Text = await upstream.text();
  return { m3u8Text, baseUrl: masterUrl };
}

/**
 * Fetch a PlaybackAccessToken for a live Twitch channel and build the Usher master M3U8 URL
 */
async function getMasterPlaylistUrl(channelLogin, playerType = 'site') {
  const login = channelLogin.trim().toLowerCase();
  const safeType = playerType === 'embed' ? 'site' : playerType;
  const query = {
    operationName: 'PlaybackAccessToken_Template',
    query: `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
      streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
        value
        signature
        __typename
      }
      videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
        value
        signature
        __typename
      }
    }`,
    variables: {
      isLive: true,
      login,
      isVod: false,
      vodID: '',
      playerType: safeType,
    },
  };

  const response = await fetch(TWITCH_GQL_URL, {
    method: 'POST',
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Content-Type': 'application/json',
      'Device-ID': 'twitch-web-wall-mason',
    },
    body: JSON.stringify(query),
  });

  if (!response.ok) {
    throw new Error(`Twitch token request failed with status ${response.status}`);
  }

  const data = await response.json();
  const tokenData = data?.data?.streamPlaybackAccessToken;
  if (!tokenData || !tokenData.value || !tokenData.signature) {
    throw new Error(`Could not obtain playback access token for channel "${login}"`);
  }

  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    token: tokenData.value,
    sig: tokenData.signature,
    allow_source: 'true',
    allow_audio_only: 'true',
    allow_spectre: 'true',
    fast_bread: 'true',
    low_latency: 'true',
    player_backend: 'mediaplayer',
    playlist_include_framerate: 'true',
    reassignments_supported: 'true',
    supported_codecs: 'avc1',
    p: String(Math.floor(Math.random() * 999999)),
  });

  return `https://usher.ttvnw.net/api/channel/hls/${encodeURIComponent(login)}.m3u8?${params.toString()}`;
}

/**
 * Strip mid-roll / pre-roll Twitch stitched ads from media playlists and rewrite all URLs
 * through our local `/api/hls/proxy?u=...` endpoint.
 */
function rewritePlaylist(m3u8Content, baseUrl) {
  const rawLines = m3u8Content.split(/\r?\n/);
  const isMediaPlaylist = rawLines.some((l) => l.startsWith('#EXTINF:'));

  const filteredLines = [];
  let skipNextUrl = false;
  let strippedAdSegments = 0;

  const liveSegmentCount = rawLines.filter(
    (l) => l.startsWith('#EXTINF:') && l.toLowerCase().includes('live')
  ).length;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (isMediaPlaylist) {
      if (
        trimmed.startsWith('#EXT-X-DATERANGE:') &&
        (trimmed.includes('twitch-stitched-ad') ||
          trimmed.includes('stitched-ad') ||
          trimmed.includes('X-TV-TWITCH-AD'))
      ) {
        continue;
      }

      if (trimmed.startsWith('#EXT-X-CUE-OUT') || trimmed.startsWith('#EXT-X-CUE-IN')) {
        continue;
      }

      if (trimmed.startsWith('#EXTINF:')) {
        const isAdSegment =
          !trimmed.toLowerCase().includes(',live') ||
          trimmed.includes('Amazon') ||
          trimmed.includes('stitched-ad');

        if (isAdSegment && liveSegmentCount > 0) {
          skipNextUrl = true;
          strippedAdSegments++;
          continue;
        }
      }

      if (skipNextUrl && !trimmed.startsWith('#') && trimmed.length > 0) {
        skipNextUrl = false;
        continue;
      }
    }

    filteredLines.push(line);
  }

  if (strippedAdSegments > 0) {
    adStats.totalAdsStripped += strippedAdSegments;
    adStats.lastAdBlockedAt = Date.now();
  }

  // Convert #EXT-X-TWITCH-PREFETCH low-latency segments into standard playable live tail segments
  const processedLines = [];
  for (const line of filteredLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
      const prefetchUrl = trimmed.slice('#EXT-X-TWITCH-PREFETCH:'.length).trim();
      if (prefetchUrl) {
        processedLines.push('#EXTINF:2.000,live');
        processedLines.push(prefetchUrl);
      }
      continue;
    }
    processedLines.push(line);
  }

  const rewritten = processedLines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const resolved = new URL(uri, baseUrl).toString();
        const encoded = Buffer.from(resolved, 'utf8').toString('base64url');
        return `URI="/api/hls/proxy?u=${encoded}"`;
      });
    }

    try {
      const resolved = new URL(trimmed, baseUrl).toString();
      const encoded = Buffer.from(resolved, 'utf8').toString('base64url');
      return `/api/hls/proxy?u=${encoded}`;
    } catch {
      return line;
    }
  });

  return rewritten.join('\n');
}

function getAdStats() {
  return adStats;
}

module.exports = {
  getStreamInfo,
  getTopLiveStreams,
  searchLiveChannels,
  fetchCleanMasterPlaylist,
  getMasterPlaylistUrl,
  rewritePlaylist,
  getAdStats,
  ADFREE_PLAYER_TYPES,
};
