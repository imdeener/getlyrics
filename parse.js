// Pure helpers: video title -> {artist, track}, LRC text -> lines, line -> word timings.
// Loaded before content.js; also runnable in Node for tests.

const NOISE =
  /\b(official|music\s*video|m\/?v|lyrics?|lyric\s*video|audio|video|visuali[sz]er|hd|hq|4k|remaster(ed)?|live|performance|teaser|color\s*coded|eng\s*sub|karaoke|prod\.?)\b|ซับไทย|เนื้อเพลง|คาราโอเกะ|มิวสิค\s*วิดีโอ/i;
const CJK_PAREN = /\s*\((?=[^)]*[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af])[^)]*\)/g; // IU(아이유) -> IU
const FEAT = /\s*[(\[]?\b(ft|feat|featuring)\.?\s.*$|\s*ฟี(ท|ทเจอริ่ง)\s.*$/i;

function cleanArtist(s) {
  return s
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s+(official)$/i, '')
    .trim();
}

function parseTitle(title, channel = '') {
  let t = title
    .replace(/\[[^\]]*\]|【[^】]*】|「[^」]*」/g, ' ') // [HD], 【MV】 ...
    .replace(/\(([^)]*)\)/g, (m, inner) => (NOISE.test(inner) ? ' ' : m)) // (Official MV), keep (Remix)
    .split('|')
    // "A - B | Label" -> keep "A - B"; "Song | Official MV" -> drop the noise segment
    .filter((seg, i, all) => i === 0 || !(NOISE.test(seg) || /\s[-–—_]\s/.test(all[0])))
    .join(' ')
    .replace(/\s+(official\s+)?(music\s+)?(m\/?v|video|audio|lyrics?(\s+video)?)\s*$/i, '');

  let artist = '';
  let track = t;

  // "A - B": order is ambiguous (Thai titles are often "Song - Artist"); background tries both.
  const dash = t.match(/^(.*?)\s+[-–—_]\s+(.*)$/);
  // K-pop style: ARTIST 'Song' M/V
  const quoted = t.match(/^(.*?)\s*['"‘“]([^'"’”]+)['"’”]/);
  if (dash) [, artist, track] = dash;
  else if (quoted && quoted[1].trim()) [, artist, track] = quoted;
  else artist = cleanArtist(channel);

  const tidy = (s) => s.replace(CJK_PAREN, '').replace(FEAT, '').replace(/^['"‘“]|['"’”]$/g, '').replace(/\s+/g, ' ').trim();
  return { artist: tidy(artist), track: tidy(track), raw: t.replace(/\s+/g, ' ').trim() };
}

// Supports enhanced LRC word stamps: [00:12.00]<00:12.00>word <00:12.40>word
function parseLrc(lrc) {
  const out = [];
  for (const line of lrc.split('\n')) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const body = line.replace(/\[[^\]]*\]/g, '');
    const ws = [...body.matchAll(/<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g)];
    const words = ws.length ? ws.map(([, m, s, text]) => ({ time: +m * 60 + +s, text })) : undefined;
    const text = body.replace(/<[^>]*>/g, '').trim();
    for (const [, m, s] of stamps) out.push({ time: +m * 60 + +s, text, words });
  }
  return out.sort((a, b) => a.time - b.time);
}

// Intl.Segmenter splits Thai/CJK (no spaces) into real words; punctuation sticks to the previous word.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
function splitWords(text) {
  const out = [];
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (isWordLike || !out.length) out.push(segment);
    else out[out.length - 1] += segment;
  }
  return out;
}

// LRCLIB only has line times, so word times are estimated: spread a sung-length span
// (capped so it doesn't crawl through instrumental gaps) over words by character count.
function wordTimings(line, next) {
  const limit = next > line.time ? next : line.time + 5;
  if (line.words) {
    return line.words
      .map((w, i, a) => ({ text: w.text, start: w.time, end: a[i + 1]?.time ?? Math.min(limit, w.time + 1) }))
      .filter((w) => w.text);
  }
  const end = Math.min(limit, line.time + 0.5 + line.text.length * 0.09);
  const parts = splitWords(line.text);
  const total = parts.reduce((n, p) => n + p.trim().length, 0) || 1;
  let t = line.time;
  return parts.map((p) => {
    const d = ((end - line.time) * p.trim().length) / total;
    const w = { text: p, start: t, end: t + d };
    t += d;
    return w;
  });
}

// Some LRCLIB entries have nonsense timing, e.g. every line squeezed into the last minute.
// Flag: first line past the middle of the song, or lines averaging under 0.8s apart.
function syncLooksBroken(lines, duration = 0) {
  const timed = lines.filter((l) => l.text);
  if (timed.length < 2) return false;
  const first = timed[0].time;
  const last = timed.at(-1).time;
  const length = Math.max(duration, last); // some entries carry a bogus duration
  return first > length * 0.5 || (timed.length >= 20 && (last - first) / (timed.length - 1) < 0.8);
}

// YouTube's "Music" description section (song credits) from a watch page's ytInitialData.
// Found by its MUSIC icon, so it works in every UI language. Skips compilations (more than one song).
function musicFromWatchHtml(html) {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return null;
  let card = null;
  (function walk(o) {
    if (card || !o || typeof o !== 'object') return;
    const c = o.horizontalCardListRenderer;
    if (c?.footerButton?.buttonViewModel?.iconName === 'MUSIC') card = c;
    else for (const k in o) walk(o[k]);
  })(JSON.parse(m[1]));
  const songs = (card?.cards || []).map((c) => c.videoAttributeViewModel).filter(Boolean);
  if (songs.length !== 1) return null;
  const text = (v) => (typeof v === 'string' ? v : v?.content || '').trim();
  const song = { track: text(songs[0].title), artist: text(songs[0].subtitle) };
  return song.track ? song : null;
}

// "Song (7\" Mix) [Thai ver.]" -> "Song"
const bareTitle = (s) => s.replace(/\s*[(\[【][^)\]】]*[)\]】]/g, '').trim();

// Ordered, de-duplicated {artist, track, swap} guesses: each source as-is, then without brackets.
// swap: the artist/track order is a guess (from the video title), so background.js also tries it reversed.
function searchCandidates(...sources) {
  const out = [];
  const seen = new Set();
  for (const s of sources.filter(Boolean)) {
    for (const track of [s.track, bareTitle(s.track)]) {
      const key = `${s.artist}\n${track}`.toLowerCase();
      if (!track || seen.has(key)) continue;
      seen.add(key);
      out.push({ artist: s.artist || '', track, swap: !!s.swap });
    }
  }
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseTitle,
    parseLrc,
    splitWords,
    wordTimings,
    syncLooksBroken,
    musicFromWatchHtml,
    bareTitle,
    searchCandidates,
  };
}
