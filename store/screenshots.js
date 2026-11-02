// Renders Chrome Web Store screenshots (1280x800) from mock pages that use the real content.css.
// The song, artist, and lyrics are fictional, so no third-party video or lyrics show up.
//
// Usage: CHROME=/path/to/chrome node store/screenshots.js
// (any Chrome/Chromium binary works, e.g. Playwright's chrome-headless-shell)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const outDir = path.join(__dirname, 'screenshots');
const css = fs.readFileSync(path.join(root, 'content.css'), 'utf8');
const chrome = process.env.CHROME;
if (!chrome) throw new Error('Set CHROME to a Chrome/Chromium binary');

const song = { artist: 'Aria Vale', track: 'Paper Satellites' };
const lyrics = [
  'We drew a map on the back of the night',
  'Folded the stars into paper and light',
  'Every street hums a tune that we know',
  "Hold on, hold on, we're letting it glow",
  'Paper satellites over the town',
  'Spinning up high, never coming down',
  '',
  'If the morning comes too soon',
  "We'll keep dancing on the moon",
  'Paper satellites, paper satellites',
];
const ACTIVE = 3;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// Active line: words before `upTo` are sung, word `upTo` is `partial` filled.
function words(text, upTo, partial) {
  return text
    .split(/(?<= )/)
    .map((w, i) => `<span class="gl-w" style="--p:${i < upTo ? 100 : i === upTo ? partial : 0}%">${esc(w)}</span>`)
    .join('');
}

function lyricLines({ upTo = 3, partial = 55, hover = false } = {}) {
  return lyrics
    .map((l, i) => {
      const cls = (i === ACTIVE ? 'gl-active' : i < ACTIVE ? 'gl-past' : '') + (hover && i === ACTIVE ? ' gl-mock-hover' : '');
      const body = !l ? '♪' : i === ACTIVE ? words(l, upTo, partial) : words(l, -1, 0);
      return `<p class="gl-line ${cls}">${body}</p>`;
    })
    .join('');
}

function panel({ theme = 'auto', body, notice = '', search = false, syncing = false, offset = '+0.0s' }) {
  return `
  <div id="gl-panel" data-theme="${theme}" class="gl-words ${syncing ? 'gl-syncing' : ''}" style="--gl-auto: hsl(18 32% 20%)">
    <div class="gl-head">
      <div class="gl-label">${song.artist} — ${song.track}</div>
      <button class="gl-btn">−</button><span class="gl-offset">${offset}</span><button class="gl-btn">+</button>
      <button class="gl-btn ${syncing ? 'gl-on' : ''}">⏱</button>
      <button class="gl-btn ${search ? 'gl-on' : ''}">⌕</button>
      <button class="gl-btn gl-on">Word</button><button class="gl-btn">◐</button>
    </div>
    ${search ? `<div class="gl-search"><input class="gl-input" value="aria vale paper satellites"></div>` : ''}
    ${notice ? `<div class="gl-notice">${notice}</div>` : ''}
    ${body}
  </div>`;
}

const videoArt = `
  background:
    radial-gradient(ellipse 60% 30% at 30% 100%, #121418 98%, transparent 100%),
    radial-gradient(ellipse 70% 26% at 85% 100%, #1a1d22 98%, transparent 100%),
    radial-gradient(circle at 62% 64%, #f4c67e 0 7%, rgb(244 198 126 / .35) 7.5%, transparent 22%),
    linear-gradient(180deg, #1f2533 0%, #4a3d4c 45%, #a8644a 72%, #c98a5c 80%);`;

function page({ caption, sub, content }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${css}
  * { box-sizing: border-box; }
  body { margin: 0; width: 1280px; height: 800px; overflow: hidden; background: #0f0f0f; color: #f1f1f1;
         font-family: Roboto, "Helvetica Neue", Arial, sans-serif; }
  .cap { height: 96px; padding: 18px 40px; background: #f2eee6; color: #141413; }
  .cap h1 { margin: 0; font-size: 30px; font-weight: 700; letter-spacing: -0.015em; }
  .cap mark { background: linear-gradient(transparent 55%, #ffd23f 55%, #ffd23f 92%, transparent 92%); color: inherit; padding: 0 2px; }
  .cap p { margin: 6px 0 0; font-size: 16px; color: rgb(20 20 19 / .7); }
  .bar { height: 48px; display: flex; align-items: center; justify-content: center; border-bottom: 1px solid #222; }
  .bar div { width: 420px; height: 32px; border: 1px solid #303030; border-radius: 16px; background: #121212; }
  .watch { display: flex; gap: 24px; padding: 20px 24px 0; }
  .video { width: 818px; height: 460px; border-radius: 12px; position: relative; overflow: hidden; ${videoArt} }
  .progress { position: absolute; left: 12px; right: 12px; bottom: 14px; height: 4px; border-radius: 2px; background: rgb(255 255 255 / .3); }
  .progress i { display: block; width: 38%; height: 100%; border-radius: 2px; background: #fff; }
  .title { font-size: 20px; font-weight: 600; margin: 12px 0 4px; }
  .meta { font-size: 14px; color: #aaa; }
  .side { width: 390px; }
  .full { position: relative; height: 704px; ${videoArt} }
  #gl-overlay.gl-show { display: flex; }
  /* :hover can't be captured in a static shot */
  .gl-syncing .gl-line.gl-mock-hover { color: rgb(var(--gl-fg)); outline: 2px dashed rgb(var(--gl-fg) / 0.5); outline-offset: 4px; border-radius: 4px; }
  </style></head><body>
  <div class="cap"><h1>${caption}</h1><p>${sub}</p></div>
  ${content}
  <script>
    // Center the active line like the extension does.
    const b = document.querySelector('.gl-body.gl-pad'), a = b && b.querySelector('.gl-active');
    if (a) b.scrollTop = a.offsetTop - b.clientHeight / 2 + a.offsetHeight / 2;
  </script></body></html>`;
}

const watch = (side) => `
  <div class="bar"><div></div></div>
  <div class="watch">
    <div>
      <div class="video"><div class="progress"><i></i></div></div>
      <div class="title">${song.artist} - ${song.track} (Official Video)</div>
      <div class="meta">${song.artist} · 1.2M views</div>
    </div>
    <div class="side">${side}</div>
  </div>`;

const results = [
  ['Paper Satellites', 'Aria Vale · 3:42 · synced'],
  ['Paper Satellites (Acoustic)', 'Aria Vale · 3:58 · synced'],
  ['Paper Satellites (Live at Harbor Hall)', 'Aria Vale · 4:31 · synced'],
  ['Paper Satellites', 'Aria Vale, Nightbus · 3:40 · not synced'],
]
  .map(([t, s]) => `<button class="gl-result"><div class="gl-result-title">${t}</div><div class="gl-result-sub">${s}</div></button>`)
  .join('');

const shots = {
  '1-synced-panel': page({
    caption: '<mark>Synced lyrics</mark>, right beside the video',
    sub: "Lines light up as they're sung. Click any line to jump there.",
    content: watch(panel({ body: `<div class="gl-body gl-pad">${lyricLines()}</div>` })),
  }),
  '2-fullscreen': page({
    caption: 'Sing along in <mark>fullscreen</mark>',
    sub: 'Karaoke-style word highlighting that works in any language.',
    content: `<div class="full"><div class="progress"><i></i></div>
      <div id="gl-overlay" class="gl-show gl-words" style="bottom: 12%">
        <div class="gl-cur">${words(lyrics[ACTIVE], 3, 55)}</div>
        <div class="gl-next">${lyrics[ACTIVE + 1]}</div>
      </div></div>`,
  }),
  '3-quick-sync': page({
    caption: 'Out of sync? <mark>One click</mark> fixes it',
    sub: 'Press ⏱ and click the line being sung. getlyrics saves the timing for that video.',
    content: watch(
      panel({
        theme: 'dark',
        syncing: true,
        offset: '+4.5s',
        notice: 'Click the line being sung right now. Press ⏱ again to cancel.',
        body: `<div class="gl-body gl-pad">${lyricLines({ upTo: 99, partial: 0, hover: true })}</div>`,
      }),
    ),
  }),
  '4-search-and-themes': page({
    caption: 'Wrong version? <mark>Pick the right one</mark>',
    sub: 'Search LRCLIB and getlyrics remembers your choice. Themes: thumbnail color, dark, or light.',
    content: watch(panel({ theme: 'light', search: true, body: `<div class="gl-body">${results}</div>` })),
  }),
};

fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-shots-'));
for (const [name, html] of Object.entries(shots)) {
  const file = path.join(tmp, `${name}.html`);
  fs.writeFileSync(file, html);
  const out = path.join(outDir, `${name}.png`);
  execFileSync(chrome, ['--headless', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1280,800', `--screenshot=${out}`, `file://${file}`], { stdio: 'ignore' });
  console.log(out);
}
