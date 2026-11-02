// Network lives here (not in the content script) so YouTube's CORS/CSP never apply.
const BASE = 'https://lrclib.net/api';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cache = new Map(); // url -> response, so revisiting a video doesn't hit LRCLIB again

// LRCLIB answers 503/429 when it's overloaded: back off and retry, then fail as 'busy'
// so the UI can say "try again" instead of a false "no lyrics found".
async function api(path, params) {
  const url = BASE + path + (params ? `?${new URLSearchParams(params)}` : '');
  if (cache.has(url)) return cache.get(url);
  for (const wait of [1000, 3000, 0]) {
    const res = await fetch(url, { headers: { 'Lrclib-Client': `getlyrics/${chrome.runtime.getManifest().version}` } });
    if (res.status === 503 || res.status === 429) {
      if (wait) await sleep(wait);
      continue;
    }
    const body = res.ok ? await res.json() : null;
    cache.set(url, body);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return body;
  }
  throw new Error('busy');
}

/* global parseLrc, syncLooksBroken */
importScripts('parse.js');

// Broken synced timing is worse than none: demote it to plain lyrics and say why.
function demoteBrokenSync(r) {
  if (!r.syncedLyrics) return r;
  const lines = parseLrc(r.syncedLyrics);
  if (!syncLooksBroken(lines, r.duration)) return r;
  const plain = r.plainLyrics || lines.map((l) => l.text).join('\n');
  return { ...r, syncedLyrics: null, plainLyrics: plain, brokenSync: true };
}

// Synced first, then closest duration to the video.
function rank(results, duration) {
  const diff = (r) => (duration ? Math.abs(r.duration - duration) : 0);
  return (Array.isArray(results) ? results : []) // LRCLIB can answer with an error object
    .map(demoteBrokenSync)
    .filter((r) => r.syncedLyrics || r.plainLyrics || r.instrumental)
    .sort((a, b) => !!b.syncedLyrics - !!a.syncedLyrics || diff(a) - diff(b));
}

const filled = (q) => Object.values(q).every(Boolean);

// Ordered, de-duplicated query list.
function unique(queries) {
  const seen = new Set();
  return queries.filter((q) => {
    const key = JSON.stringify(q).toLowerCase();
    return filled(q) && !seen.has(key) && seen.add(key);
  });
}

// candidates: [{artist, track, swap}] best guess first (see searchCandidates in parse.js).
// Queries run one at a time and stop at the first hit, to go easy on LRCLIB.
async function findLyrics({ candidates = [], raw, duration, pickId }) {
  if (pickId) {
    const hit = await api(`/get/${pickId}`);
    if (hit?.id) return demoteBrokenSync(hit);
  }
  const strict = unique(
    candidates
      .filter((c) => c.artist)
      .flatMap((c) => [
        { track_name: c.track, artist_name: c.artist },
        // Title order is a guess: Thai titles are often "Song - Artist".
        ...(c.swap ? [{ track_name: c.artist, artist_name: c.track }] : []),
        { q: `${c.artist} ${c.track}` },
      ]),
  );
  // Title-only queries can hit a different song with the same name; require a close duration.
  const loose = unique([...candidates.map((c) => ({ q: c.track })), { q: raw }]);

  for (const q of strict) {
    const [hit] = rank(await api('/search', q), duration);
    if (hit) return hit;
  }
  for (const q of loose) {
    const hit = rank(await api('/search', q), duration).find((r) => !duration || Math.abs(r.duration - duration) <= 30);
    if (hit) return hit;
  }
  return null;
}

function hsl(r, g, b) {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(h * 60 + 360) % 360, Math.round(s * 100)];
}

// Saturation-weighted average of the thumbnail, pushed dark enough for white text.
async function thumbColor(id) {
  const res = await fetch(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`);
  const bmp = await createImageBitmap(await res.blob());
  const ctx = new OffscreenCanvas(32, 18).getContext('2d');
  ctx.drawImage(bmp, 0, 0, 32, 18);
  const d = ctx.getImageData(0, 0, 32, 18).data;
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const wt = (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2])) / 255 + 0.05;
    r += d[i] * wt;
    g += d[i + 1] * wt;
    b += d[i + 2] * wt;
    w += wt;
  }
  const [h, s] = hsl(r / w, g / w, b / w);
  return `hsl(${h} ${Math.min(s, 55)}% 24%)`;
}

const handlers = {
  lyrics: async (msg) => ({ hit: await findLyrics(msg) }),
  search: async ({ q }) => ({ results: rank(await api('/search', { q })).slice(0, 10) }),
  color: async ({ id }) => ({ color: await thumbColor(id) }),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg.type];
  if (!handler) return;
  handler(msg).then(sendResponse, (e) => sendResponse({ error: e.message === 'busy' ? 'busy' : String(e) }));
  return true; // async response
});
