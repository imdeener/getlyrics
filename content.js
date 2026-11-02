/* global parseTitle, parseLrc, wordTimings */
// YouTube is an SPA: react to yt-navigate-finish, find title, fetch lyrics, sync to <video>.
// No innerHTML anywhere — YouTube enforces Trusted Types.

const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THEMES = ['auto', 'dark', 'light'];
// UI strings live in _locales/<lang>/messages.json; Chrome picks the browser's language.
const t = (key, ...subs) => chrome.i18n.getMessage(key, subs) || key;

let currentId = null;
let token = 0;
let lastTitle = '';
let meta = null;
let lines = []; // [{time, text, el, words: [{start, end, el, oel}]}]
let active = -1;
let offset = 0; // seconds, user-adjustable for MVs with intros
let userScrollUntil = 0;
let panel, body, label, offsetLabel, searchBox, searchInput, themeBtn, wordBtn;
let notice; // duration-mismatch hint above the lyrics
let keepTop; // MutationObserver keeping the panel first in the sidebar
let overlay, overlayCur, overlayNext; // fullscreen lyrics, lives inside #movie_player

// picks: videoId -> LRCLIB id, offsets: videoId -> seconds
const settings = { theme: 'auto', words: true, picks: {}, offsets: {} };
const ready = chrome.storage.local.get(Object.keys(settings)).then((s) => Object.assign(settings, s));
const save = (key) => chrome.storage.local.set({ [key]: settings[key] });

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    return { error: String(e) }; // e.g. extension reloaded under an open tab
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function button(text, title, onclick) {
  const b = el('button', 'gl-btn', text);
  b.title = title;
  b.onclick = onclick;
  return b;
}

const video = () => $('#movie_player video');
const adShowing = () => $('#movie_player')?.classList.contains('ad-showing');
const metaLabel = () => [meta?.artist, meta?.track].filter(Boolean).join(' — ');
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function waitFor(fn, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(250);
  }
  return fn();
}

// The h1 lags behind navigation; wait until it changes (or give up after 5s).
async function readMeta() {
  const h1 = () => $('ytd-watch-metadata h1')?.textContent.trim();
  const title =
    (await waitFor(() => (h1() && h1() !== lastTitle ? h1() : null), 5000)) ||
    h1() ||
    document.title.replace(/ - YouTube$/, '');
  lastTitle = title;
  const channel = $('ytd-watch-metadata ytd-channel-name a')?.textContent.trim() || '';
  await waitFor(() => !adShowing() && isFinite(video()?.duration), 10000);
  const duration = !adShowing() && isFinite(video()?.duration) ? Math.round(video().duration) : undefined;
  return { ...parseTitle(title, channel), duration };
}

function buildPanel() {
  panel = el('div');
  panel.id = 'gl-panel';
  label = el('div', 'gl-label');
  offsetLabel = el('span', 'gl-offset');
  offsetLabel.title = t('syncHint');
  themeBtn = button('◐', '', cycleTheme);
  wordBtn = button(t('wordButton'), t('wordTitle'), toggleWords);
  const head = el('div', 'gl-head');
  head.append(
    label,
    button('−', t('offsetLater'), () => setOffset(offset - 0.5, true)),
    offsetLabel,
    button('+', t('offsetEarlier'), () => setOffset(offset + 0.5, true)),
    button('⌕', t('searchTitle'), () => toggleSearch()),
    wordBtn,
    themeBtn,
  );

  searchInput = el('input', 'gl-input');
  searchInput.placeholder = t('searchPlaceholder');
  // Keep YouTube's single-key shortcuts (k, f, j...) from firing while typing.
  for (const type of ['keydown', 'keyup', 'keypress']) searchInput.addEventListener(type, (e) => e.stopPropagation());
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && searchInput.value.trim()) manualSearch(searchInput.value.trim());
    if (e.key === 'Escape') toggleSearch(false);
  });
  searchBox = el('div', 'gl-search');
  searchBox.hidden = true;
  searchBox.append(searchInput);

  body = el('div', 'gl-body');
  body.addEventListener('wheel', () => (userScrollUntil = Date.now() + 3000), { passive: true });
  notice = el('div', 'gl-notice');
  notice.hidden = true;
  panel.append(head, searchBox, notice, body);
  setOffset(0);
  applySettings();
}

function applySettings() {
  panel.dataset.theme = settings.theme;
  panel.classList.toggle('gl-words', settings.words);
  overlay?.classList.toggle('gl-words', settings.words);
  wordBtn.classList.toggle('gl-on', settings.words);
  themeBtn.title = t('themeTitle', t(`theme_${settings.theme}`));
}

function cycleTheme() {
  settings.theme = THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length];
  save('theme');
  applySettings();
}

function toggleWords() {
  settings.words = !settings.words;
  save('words');
  applySettings();
}

function setOffset(v, persist) {
  offset = Math.round(v * 10) / 10;
  offsetLabel.textContent = `${offset > 0 ? '+' : ''}${offset.toFixed(1)}s`;
  if (!persist) return;
  if (offset) settings.offsets[currentId] = offset;
  else delete settings.offsets[currentId];
  save('offsets');
}

function toggleSearch(force) {
  searchBox.hidden = !(force ?? searchBox.hidden);
  if (searchBox.hidden) return;
  searchInput.value = metaLabel().replace(' — ', ' ');
  searchInput.focus();
  searchInput.select();
}

async function mount() {
  if (!panel) buildPanel();
  mountOverlay();
  const host = (await waitFor(() => $('#secondary-inner'), 10000)) || $('#secondary');
  if (!host) return;
  if (host.firstElementChild !== panel) host.prepend(panel);
  // YouTube can render the playlist (or other panels) above us after we mount; move back to the top.
  if (keepTop?.host === host) return;
  keepTop?.disconnect();
  keepTop = new MutationObserver(() => {
    if (currentId && host.firstElementChild !== panel) host.prepend(panel);
  });
  keepTop.host = host;
  keepTop.observe(host, { childList: true });
}

// pad: lyrics need big top/bottom padding so the first/last line can sit in the middle.
function show(nodes, pad) {
  body.classList.toggle('gl-pad', pad);
  body.replaceChildren(...nodes);
  body.scrollTop = 0;
}

function mountOverlay() {
  if (!overlay) {
    overlay = el('div');
    overlay.id = 'gl-overlay';
    overlayCur = el('div', 'gl-cur');
    overlayNext = el('div', 'gl-next');
    overlay.append(overlayCur, overlayNext);
    overlay.classList.toggle('gl-words', settings.words);
  }
  if (!overlay.isConnected) $('#movie_player')?.append(overlay);
}

// Current line (word spans of its own, filled by tick) + a dim preview of the next one.
function updateOverlay(i) {
  if (!overlay) return;
  if (!overlay.isConnected) mountOverlay(); // player may not have existed at first mount
  const cur = lines[i];
  const next = lines[i + 1];
  overlayCur.replaceChildren(...(cur?.words.length ? cur.words.map((w) => (w.oel = el('span', 'gl-w', w.text))) : []));
  if (cur && !cur.words.length) overlayCur.textContent = '♪';
  overlayNext.textContent = next?.text || '';
  overlay.classList.toggle('gl-show', !!(cur || next));
}

function setStatus(text) {
  notice.hidden = true;
  lines = [];
  updateOverlay(-1);
  active = -1;
  show([el('div', 'gl-status', text)], false);
}

function render(hit) {
  label.textContent = hit ? `${hit.artistName} — ${hit.trackName}` : metaLabel();
  if (!hit) return setStatus(t('notFound'));
  if (hit.instrumental) return setStatus(`♪ ${t('instrumental')}`);
  if (!hit.syncedLyrics) {
    setStatus('');
    return show([el('div', 'gl-plain', hit.plainLyrics)], false);
  }

  const parsed = parseLrc(hit.syncedLyrics);
  lines = parsed.map((l, i) => {
    const e = el('p', 'gl-line', l.text ? null : '♪');
    const words = l.text ? wordTimings(l, parsed[i + 1]?.time) : [];
    for (const w of words) e.append((w.el = el('span', 'gl-w', w.text)));
    e.onclick = (ev) => {
      const v = video();
      if (!v) return;
      if (ev.altKey) {
        // "This line starts now": derive the offset from the playhead instead of seeking.
        setOffset(l.time - v.currentTime, true);
        notice.hidden = true;
      } else {
        v.currentTime = Math.max(0, l.time - offset);
      }
      userScrollUntil = 0;
    };
    return { time: l.time, text: l.text, el: e, words };
  });
  active = -1;
  show(lines.map((l) => l.el), true);
  updateOverlay(-1);

  // A big length mismatch (MV intro, different version) usually means the timing is off.
  const diff = Math.round(Math.abs((meta?.duration ?? hit.duration) - hit.duration));
  notice.textContent = t('durationMismatch', String(diff));
  notice.hidden = diff <= 10 || !!settings.offsets[currentId];
}

function renderResults(results) {
  lines = [];
  active = -1;
  if (!results?.length) return setStatus(t('noResults'));
  show(
    results.map((r) => {
      const item = el('button', 'gl-result');
      const sub = [r.artistName, fmt(r.duration), t(r.syncedLyrics ? 'synced' : r.instrumental ? 'instrumental' : 'unsynced')];
      item.append(el('div', 'gl-result-title', r.trackName), el('div', 'gl-result-sub', sub.join(' · ')));
      item.onclick = () => {
        settings.picks[currentId] = r.id; // remembered for this video
        save('picks');
        toggleSearch(false);
        render(r);
      };
      return item;
    }),
    false,
  );
}

async function manualSearch(q) {
  const my = token;
  setStatus(t('searching'));
  const res = await send({ type: 'search', q });
  if (my !== token) return;
  if (res?.error) return setStatus(t('searchFailed'));
  renderResults(res.results);
}

function setActive(i) {
  lines.forEach((l, j) => {
    l.el.classList.toggle('gl-active', j === i);
    l.el.classList.toggle('gl-past', j < i);
  });
  active = i;
  lines[i]?.words.forEach((w) => (w.p = undefined)); // force a repaint of the fresh overlay spans
  updateOverlay(i);
  const line = lines[i]?.el;
  if (line && Date.now() > userScrollUntil) {
    body.scrollTo({ top: line.offsetTop - body.clientHeight / 2 + line.offsetHeight / 2, behavior: 'smooth' });
  }
}

function tick() {
  const v = video();
  if (lines.length && v && !adShowing()) {
    const now = v.currentTime + offset;
    let i = -1;
    while (i + 1 < lines.length && lines[i + 1].time <= now) i++;
    if (i !== active) setActive(i);
    if (settings.words && i >= 0) {
      for (const w of lines[i].words) {
        const p = w.end > w.start ? Math.min(1, Math.max(0, (now - w.start) / (w.end - w.start))) : +(now >= w.start);
        if (p === w.p) continue;
        w.p = p;
        w.el.style.setProperty('--p', `${p * 100}%`);
        w.oel?.style.setProperty('--p', `${p * 100}%`);
      }
    }
  }
  requestAnimationFrame(tick);
}

async function onNavigate() {
  const id = location.pathname === '/watch' && new URLSearchParams(location.search).get('v');
  if (!id) {
    panel?.remove();
    currentId = null;
    return;
  }
  if (id === currentId && panel?.isConnected) return;
  currentId = id;
  const my = ++token;

  await ready;
  await mount();
  setOffset(settings.offsets[id] || 0);
  toggleSearch(false);
  meta = null;
  label.textContent = '';
  setStatus(t('loading'));

  panel.style.removeProperty('--gl-auto');
  send({ type: 'color', id }).then((r) => {
    if (my === token && r?.color) panel.style.setProperty('--gl-auto', r.color);
  });

  meta = await readMeta();
  if (my !== token) return;
  label.textContent = metaLabel();

  const res = await send({ type: 'lyrics', ...meta, pickId: settings.picks[id] });
  if (my !== token) return;
  if (res?.error) return setStatus(t('loadFailed'));
  render(res.hit);
}

document.addEventListener('yt-navigate-finish', onNavigate);
onNavigate();
requestAnimationFrame(tick);
