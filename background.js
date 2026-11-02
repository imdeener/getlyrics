// Network lives here (not in the content script) so YouTube's CORS/CSP never apply.
const BASE = 'https://lrclib.net/api';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cache = new Map(); // url -> response, so revisiting a video doesn't hit LRCLIB again
const busyUntil = {}; // request kind -> timestamp; skip kinds LRCLIB is currently shedding

// Under load LRCLIB sheds the expensive requests (free-text `q` search, lookup by id) with 503/429
// while structured artist+title requests keep working. So: one quick retry, then mark that kind
// busy for a minute and let callers fall through to the next query instead of failing outright.
function kind(path, params) {
  if (path.startsWith('/get/')) return 'id';
  return params?.q ? 'q' : path;
}

async function api(path, params) {
  const url = BASE + path + (params ? `?${new URLSearchParams(params)}` : '');
  if (cache.has(url)) return cache.get(url);
  const k = kind(path, params);
  if (busyUntil[k] > Date.now()) throw new Error('busy');
  // Artist+title search is shed only now and then, so it earns an extra try; q and id lookups are
  // shed wholesale, so a second failure is enough to bench them.
  for (const wait of k === '/search' ? [700, 1500, 0] : [800, 0]) {
    const res = await fetch(url, { headers: { 'Lrclib-Client': `getlyrics/${chrome.runtime.getManifest().version}` } }).catch(
      () => null, // network error: retry like an overload
    );
    // 5xx (503 overload, 502/504 from the CDN...) and 429 are worth retrying and must not be cached.
    if (!res || res.status >= 500 || res.status === 429) {
      if (wait) await sleep(wait);
      continue;
    }
    const body = res.ok ? await res.json().catch(() => null) : null; // e.g. an HTML error page
    cache.set(url, body);
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return body;
  }
  // Only the kinds that are shed wholesale get benched; a structured search can 503 just for one
  // unknown song, and benching it would block lookups for the next videos too.
  if (k !== '/search') busyUntil[k] = Date.now() + 60_000;
  throw new Error('busy');
}

// Runs [path, params, pick] queries in order and returns the first hit. A busy query is skipped,
// not fatal; only if nothing was found and an artist+title query was busy does it report 'busy'.
async function firstHit(queries) {
  let busy = false;
  for (const [path, params, pick] of queries) {
    try {
      const hit = pick(await api(path, params));
      if (hit) return hit;
    } catch (e) {
      if (e.message !== 'busy') throw e;
      // Only an artist+title lookup is a main query. Title-only and free-text queries are fallbacks:
      // if the main ones answered "nothing" and only a fallback was busy, the honest result is
      // "not found", not "couldn't reach LRCLIB".
      if (params?.artist_name) busy = true;
    }
  }
  if (busy) throw new Error('busy');
  return null;
}

/* global parseLrc, syncLooksBroken, titleKey */
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
  const diff = (r) => (duration ? Math.abs((r.duration || 0) - duration) : 0);
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
async function findLyrics({ candidates = [], raw, duration, pick }) {
  // A song the user picked by hand: by id, or (if lookups by id are being shed) by its saved name.
  if (pick) {
    const same = (r) => (Array.isArray(r) ? r.find((x) => x.id === pick.id) : r?.id && r);
    const byName = pick.track ? [['/search', { track_name: pick.track, artist_name: pick.artist }, same]] : [];
    const hit = await firstHit([[`/get/${pick.id}`, null, same], ...byName]).catch(() => null);
    if (hit) return demoteBrokenSync(hit);
  }
  // Title-only and free-text queries return any song sharing a word with the query, e.g.
  // "PLENG" matching "... Rong Pleng". Their hit must be titled like one of our guesses.
  const names = new Set(candidates.flatMap((c) => [c.track, ...(c.swap ? [c.artist] : [])]).map(titleKey).filter(Boolean));
  const named = (x) => names.has(titleKey(x.trackName));
  // Artist+title lookups are fuzzy too (junk like "04 - [...]" turns up), but our guess may carry
  // extra words, so for them one title containing the other is enough.
  const related = (x) => {
    const k = titleKey(x.trackName);
    return !!k && [...names].some((n) => k.includes(n) || n.includes(k));
  };
  // Short titles repeat across artists ("GenZ" by RESOA vs. by Polimá Westcoast). When the artist is
  // known (from "A - B" in the title, either order, or YouTube's credits) the match must be by them.
  // A channel-name guess (weak) can't rule anyone out.
  const artists = [
    ...new Set(
      candidates
        .filter((c) => !c.weak && c.artist)
        .flatMap((c) => [c.artist, ...(c.swap ? [c.track] : [])])
        .map(titleKey)
        .filter(Boolean),
    ),
  ];
  const byArtist = (x) => {
    if (!artists.length) return true;
    const k = titleKey(x.artistName);
    return !!k && artists.some((a) => k.includes(a) || a.includes(k));
  };
  const best = (r) => rank(r, duration).find((x) => related(x) && byArtist(x));
  const bestNamed = (r) => rank(r, duration).find((x) => named(x) && byArtist(x));
  // Title-only matches can still be a different song with the same name; require a close duration.
  const close = (r) =>
    rank(r, duration).find((x) => named(x) && byArtist(x) && (!duration || Math.abs((x.duration || 0) - duration) <= 30));
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
  const loose = unique([...candidates.map((c) => ({ track_name: c.track })), ...candidates.map((c) => ({ q: c.track })), { q: raw }]);
  return firstHit([...strict.map((q) => ['/search', q, q.q ? bestNamed : best]), ...loose.map((q) => ['/search', q, close])]);
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

// Fuzzy search returns strays (the swapped-order query especially), so order manual results by how
// well title and artist match what was typed, then synced first. Strays sink, they aren't hidden.
function byRelevance(results, parts) {
  const keys = parts.map(titleKey).filter(Boolean);
  const hits = (s) => {
    const k = titleKey(s);
    return !!k && keys.some((p) => k.includes(p) || p.includes(k));
  };
  const score = (r) => hits(r.trackName) + hits(r.artistName);
  return rank(results).sort((x, y) => score(y) - score(x) || !!y.syncedLyrics - !!x.syncedLyrics);
}

const handlers = {
  lyrics: async (msg) => ({ hit: await findLyrics(msg) }),
  // Manual search takes one free-form box. "A - B" is tried as artist+title both ways (the lookup
  // that survives load shedding) and the results merged; free text is the fallback.
  search: async ({ text }) => {
    const parts = text.split(/\s+[-–—|]\s+/).map((s) => s.trim()).filter(Boolean);
    const [a, b] = parts;
    const phases = [
      b ? [{ track_name: b, artist_name: a }, { track_name: a, artist_name: b }] : [{ track_name: text }],
      [{ q: parts.join(' ') }],
    ];
    let busy = false;
    for (const phase of phases) {
      const found = new Map(); // id -> result, merged across both orders
      for (const q of unique(phase)) {
        try {
          for (const r of rank(await api('/search', q))) found.set(r.id, r);
        } catch (err) {
          if (err.message !== 'busy') throw err;
          if (!q.q) busy = true;
        }
      }
      if (found.size) return { results: byRelevance([...found.values()], parts).slice(0, 10) };
    }
    if (busy) throw new Error('busy');
    return { results: [] };
  },
  color: async ({ id }) => ({ color: await thumbColor(id) }),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg.type];
  if (!handler) return;
  handler(msg).then(sendResponse, (e) => sendResponse({ error: e.message === 'busy' ? 'busy' : String(e) }));
  return true; // async response
});
