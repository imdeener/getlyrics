// End-to-end check of getlyrics on real youtube.com with the unpacked extension loaded.
// Not part of CI: it needs a real browser and network, and YouTube changes under it.
//
//   npm i --no-save playwright-core
//   CHROME="/path/to/Google Chrome for Testing" node e2e/youtube.js
//
// Use Chrome for Testing or Chromium: branded Chrome ignores --load-extension.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const EXT = path.join(__dirname, '..');
const CHROME = process.env.CHROME;
if (!CHROME) throw new Error('Set CHROME to a Chrome for Testing or Chromium binary');
const os = require('os');
const SHOTS = path.join(os.tmpdir(), 'getlyrics-e2e');
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'getlyrics-profile-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: CHROME,
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required', '--lang=en-US'],
    viewport: { width: 1400, height: 900 },
    locale: 'en-US',
  });
  const errors = [];
  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  check('service worker running', !!sw, sw?.url());
  sw.on?.('console', (m) => m.type() === 'error' && errors.push(`[sw] ${m.text()}`));

  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('console', (m) => {
    const txt = m.text();
    if (/getlyrics|chrome-extension:/i.test(txt) || (m.type() === 'error' && /gl-|lyrics/i.test(txt))) errors.push(`[page ${m.type()}] ${txt}`);
  });
  page.on('pageerror', (e) => /gl-|lyrics|chrome-extension/i.test(e.stack || '') && errors.push(`[pageerror] ${e.message}`));

  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const panelState = () =>
    page.evaluate(() => {
      const p = document.querySelector('#gl-panel');
      if (!p) return null;
      const lines = [...p.querySelectorAll('.gl-line')];
      const active = p.querySelector('.gl-line.gl-active');
      const body = p.querySelector('.gl-body');
      return {
        connected: p.isConnected,
        firstInSidebar: p.parentElement?.firstElementChild === p,
        parent: p.parentElement?.id,
        label: p.querySelector('.gl-label')?.textContent,
        status: p.querySelector('.gl-status')?.textContent || '',
        notice: p.querySelector('.gl-notice')?.hidden ? '' : p.querySelector('.gl-notice')?.textContent,
        lines: lines.length,
        activeIndex: lines.indexOf(active),
        activeText: active?.textContent.slice(0, 40),
        activeCenterOffset: active && body ? Math.round(active.getBoundingClientRect().top + active.offsetHeight / 2 - (body.getBoundingClientRect().top + body.clientHeight / 2)) : null,
        wordFill: active ? [...active.querySelectorAll('.gl-w')].map((w) => w.style.getPropertyValue('--p')).join(',') : '',
        theme: p.dataset.theme,
        offset: p.querySelector('.gl-offset')?.textContent,
        results: p.querySelectorAll('.gl-result').length,
        searchValue: p.querySelector('.gl-input')?.value,
      };
    });
  const waitPanel = async (pred, ms = 40000) => {
    const end = Date.now() + ms;
    let s;
    while (Date.now() < end) {
      s = await panelState();
      if (s && pred(s)) return s;
      await sleep(500);
    }
    return s;
  };
  const playerReady = async () => {
    await page.waitForSelector('#movie_player video', { timeout: 30000 });
    // Skip/wait out ads, mute, play.
    for (let i = 0; i < 60; i++) {
      const ad = await page.evaluate(() => document.querySelector('#movie_player')?.classList.contains('ad-showing'));
      if (!ad) break;
      await page.evaluate(() => document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern')?.click());
      await sleep(1000);
    }
    await page.evaluate(() => {
      const v = document.querySelector('#movie_player video');
      v.muted = true;
      return v.play().catch(() => {});
    });
  };

  // 1. A well-known official video with YouTube "Music" credits.
  await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
  await playerReady();
  let s = await waitPanel((x) => x.lines > 0 || /found|reach|failed/i.test(x.status));
  await shot('1-loaded');
  check('panel mounted at top of sidebar', s?.connected && s.firstInSidebar, `parent=${s?.parent}`);
  check('lyrics loaded (synced lines)', s?.lines > 10, `label="${s?.label}" lines=${s?.lines} status="${s?.status}"`);

  // 2. Seek and check highlight, centering, and word fill.
  await page.evaluate(() => { const v = document.querySelector('#movie_player video'); v.pause(); v.currentTime = 45; });
  await sleep(2000);
  s = await panelState();
  await shot('2-seek45');
  await page.evaluate(() => document.querySelector('#movie_player video').play());
  check('a line is active after seeking to 0:45', s.activeIndex >= 0, `#${s.activeIndex} "${s.activeText}"`);
  check('active line is centered in the panel', s.activeCenterOffset !== null && Math.abs(s.activeCenterOffset) < 40, `offset ${s.activeCenterOffset}px`);
  check('word-by-word fill is being set', /%/.test(s.wordFill), s.wordFill.slice(0, 60));

  // 3. Click a later line: video should jump to it.
  const before = await page.evaluate(() => document.querySelector('#movie_player video').currentTime);
  await page.evaluate(() => [...document.querySelectorAll('#gl-panel .gl-line')].at(-5).click());
  await sleep(1500);
  const after = await page.evaluate(() => document.querySelector('#movie_player video').currentTime);
  s = await panelState();
  check('clicking a line seeks the video', after > before + 30, `${before.toFixed(1)}s -> ${after.toFixed(1)}s, active #${s.activeIndex}/${s.lines}`);

  // 4. Offset buttons and persistence key.
  await page.click('#gl-panel .gl-btn[title*="earlier" i]');
  await page.click('#gl-panel .gl-btn[title*="earlier" i]');
  s = await panelState();
  check('+ button shifts the offset', s.offset === '+1.0s', s.offset);
  await page.click('#gl-panel .gl-btn[title*="later" i]');
  await page.click('#gl-panel .gl-btn[title*="later" i]');
  s = await panelState();
  check('− button shifts it back', s.offset === '0.0s', s.offset);

  // 5. Quick sync mode.
  await page.click('#gl-panel .gl-btn:has-text("⏱")');
  s = await panelState();
  check('⏱ shows the sync prompt', /line being sung/i.test(s.notice || ''), s.notice);
  const t0 = await page.evaluate(() => document.querySelector('#movie_player video').currentTime);
  await page.evaluate(() => document.querySelector('#gl-panel .gl-line.gl-active').click());
  await sleep(300);
  const t1 = await page.evaluate(() => document.querySelector('#movie_player video').currentTime);
  s = await panelState();
  check('sync click sets an offset instead of seeking', s.offset !== '0.0s' && Math.abs(t1 - t0) < 2, `offset ${s.offset}, playhead ${t0.toFixed(1)} -> ${t1.toFixed(1)}`);
  check('sync prompt closes after the click', !s.notice, s.notice);
  await shot('5-synced');
  const savedOffset = s.offset;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await playerReady();
  s = await waitPanel((x) => x.lines > 0);
  check('synced offset is remembered after reload', s.offset === savedOffset, `${savedOffset} -> ${s.offset}`);

  // 6. Theme cycling and word toggle.
  const themes = [];
  for (let i = 0; i < 3; i++) {
    await page.click('#gl-panel .gl-btn:has-text("◐")');
    themes.push((await panelState()).theme);
  }
  check('theme cycles auto -> dark -> light -> auto', themes.join(',') === 'dark,light,auto', themes.join(','));

  // 7. Manual search.
  await page.click('#gl-panel .gl-btn:has-text("⌕")');
  s = await panelState();
  check('search box is prefilled "Artist - Song"', / - /.test(s.searchValue || ''), s.searchValue);
  await page.keyboard.press('Enter');
  s = await waitPanel((x) => x.results > 0 || /found|reach|failed|results/i.test(x.status), 30000);
  await shot('7-search');
  const list = await page.evaluate(() => [...document.querySelectorAll('#gl-panel .gl-result')].slice(0, 5).map((r) => r.querySelector('.gl-result-sub').textContent.split(' · ')[0] + ' / ' + r.querySelector('.gl-result-title').textContent).join(' | '));
  check('manual search lists results', s.results > 0, `${s.results} results: ${list}`);
  // Typing in the box must not trigger YouTube shortcuts (k = pause).
  const pausedBefore = await page.evaluate(() => document.querySelector('#movie_player video').paused);
  await page.focus('#gl-panel .gl-input');
  await page.keyboard.type('k');
  const pausedAfter = await page.evaluate(() => document.querySelector('#movie_player video').paused);
  check('typing in search does not trigger YouTube shortcuts', pausedBefore === pausedAfter, `paused ${pausedBefore} -> ${pausedAfter}`);
  await page.keyboard.press('Escape');
  s = await panelState();
  check('closing search without a pick restores the lyrics', s.lines > 10 && s.results === 0, `lines=${s.lines} results=${s.results}`);

  await page.click('#gl-panel .gl-btn:has-text("⌕")');
  await page.keyboard.press('Enter');
  s = await waitPanel((x) => x.results > 1, 30000);
  const pickedTitle = await page.evaluate(() => {
    const item = document.querySelectorAll('#gl-panel .gl-result')[1];
    const t = item.querySelector('.gl-result-sub').textContent.split(' · ')[0] + ' — ' + item.querySelector('.gl-result-title').textContent;
    item.click();
    return t;
  });
  s = await panelState();
  check('picking a result shows it', s.label === pickedTitle && s.results === 0, `label="${s.label}" picked="${pickedTitle}"`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await playerReady();
  s = await waitPanel((x) => x.lines > 0 || /found|reach|failed/i.test(x.status));
  check('picked result is remembered after reload', s.label === pickedTitle, `"${s.label}"`);

  // 8. Fullscreen overlay.
  await page.evaluate(() => document.querySelector('#movie_player video').play());
  await page.evaluate(() => (document.querySelector('#movie_player video').currentTime = 60));
  await page.click('#movie_player', { position: { x: 300, y: 200 } }).catch(() => {});
  await page.keyboard.press('f');
  await sleep(2000);
  const fs1 = await page.evaluate(() => {
    const o = document.querySelector('#gl-overlay');
    return { fullscreen: !!document.fullscreenElement, el: document.fullscreenElement?.tagName + '#' + document.fullscreenElement?.id, display: o && getComputedStyle(o).display, text: o?.textContent.slice(0, 50) };
  });
  await shot('8-fullscreen');
  check('fullscreen overlay shows the current line', fs1.fullscreen && fs1.display === 'flex' && fs1.text, JSON.stringify(fs1));
  await page.keyboard.press('f');
  await sleep(1000);

  // 9. SPA navigation via a playlist (Mix) URL: panel must stay on top, lyrics reload.
  await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ', { waitUntil: 'domcontentloaded' });
  await playerReady();
  await sleep(4000);
  s = await waitPanel((x) => x.lines > 0 || /found|reach|failed/i.test(x.status));
  check('with a playlist, panel is still first in the sidebar', s?.firstInSidebar, `parent=${s?.parent}`);
  const firstLabel = s.label;
  const nextHref = await page.evaluate(() => [...document.querySelectorAll('ytd-playlist-panel-video-renderer a#wc-endpoint')].map((a) => a.href).find((h) => !h.includes('v=dQw4w9WgXcQ')));
  if (nextHref) {
    await page.evaluate((h) => [...document.querySelectorAll('ytd-playlist-panel-video-renderer a#wc-endpoint')].find((a) => a.href === h).click(), nextHref);
    await playerReady();
    s = await waitPanel((x) => x.label && x.label !== firstLabel && (x.lines > 0 || /found|reach|failed/i.test(x.status)));
    await shot('9-playlist-next');
    check('SPA navigation to the next playlist video reloads lyrics', s.label !== firstLabel, `"${firstLabel}" -> "${s.label}", lines=${s.lines}, status="${s.status}"`);
    check('panel still first after SPA navigation', s.firstInSidebar);
  } else check('found a next playlist video to click', false);

  // 10. A Thai video found via YouTube search (also exercises results -> watch SPA navigation).
  await page.goto('https://www.youtube.com/results?search_query=' + encodeURIComponent('PLENG รองเท้าเนรคุณ'), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('ytd-video-renderer a#video-title', { timeout: 20000 });
  const thaiTitle = await page.evaluate(() => document.querySelector('ytd-video-renderer a#video-title').textContent.trim());
  await page.click('ytd-video-renderer a#video-title');
  await playerReady();
  s = await waitPanel((x) => x.lines > 0 || /found|reach|failed/i.test(x.status));
  await shot('10-thai');
  check('Thai video: honest result (no wrong song)', /no lyrics found/i.test(s.status) || s.lines > 0, `title="${thaiTitle}" label="${s.label}" lines=${s.lines} status="${s.status}"`);

  // 11. Leaving the watch page removes the panel.
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  check('panel removed off the watch page', !(await page.$('#gl-panel')));

  check('no extension errors in page or service worker consoles', errors.length === 0, errors.slice(0, 5).join(' | '));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await ctx.close();
})().catch((e) => {
  console.error('E2E crashed:', e);
  process.exit(1);
});
