// Run: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTitle, parseLrc, splitWords, wordTimings } = require('../parse.js');

const titleCases = [
  // [video title, channel, expected artist, expected track]
  ['Some Artist - Some Song (Official Music Video)', 'Some Artist', 'Some Artist', 'Some Song'],
  ['Some Artist - Some Song [HD]', 'SomeArtistVEVO', 'Some Artist', 'Some Song'],
  ['Some Artist - Some Song (Remix)', 'x', 'Some Artist', 'Some Song (Remix)'],
  ['Some Artist - Some Song (feat. Guest) [Official Audio]', 'x', 'Some Artist', 'Some Song'],
  ['Some Artist - Some Song ft. Guest', 'x', 'Some Artist', 'Some Song'],
  ['Some Song | Official MV', 'Some Band', 'Some Band', 'Some Song'],
  ['Some Artist - Some Song (Official MV) | Label', 'Label', 'Some Artist', 'Some Song'],
  ['Some Song', 'Some Artist - Topic', 'Some Artist', 'Some Song'],
  ["GROUP 'Some Song' M/V", 'Label', 'GROUP', 'Some Song'],
  ['GROUP (그룹) ‘Some Song’ Official MV', 'Label', 'GROUP', 'Some Song'],
  ['SINGER(가수) _ Song(노래) MV', 'Label', 'SINGER', 'Song'],
  ['(G)ROUP - Some Song (Official Music Video)', 'x', '(G)ROUP', 'Some Song'],
  ['ชื่อเพลง - ศิลปิน【OFFICIAL MV】', 'ค่าย', 'ชื่อเพลง', 'ศิลปิน'], // order swap is tried by background.js
  ['ชื่อเพลง - ศิลปิน ฟีท แขกรับเชิญ [เนื้อเพลง]', 'x', 'ชื่อเพลง', 'ศิลปิน'],
];

for (const [title, channel, artist, track] of titleCases) {
  test(`parseTitle: ${title}`, () => {
    const r = parseTitle(title, channel);
    assert.equal(r.artist, artist);
    assert.equal(r.track, track);
  });
}

test('parseLrc: sorts, expands multi-stamp lines, keeps empty lines', () => {
  const lines = parseLrc('[00:10.00][00:30.00]b\n[00:01.50]a\n[00:05.00]\nno stamp');
  assert.deepEqual(
    lines.map((l) => [l.time, l.text]),
    [[1.5, 'a'], [5, ''], [10, 'b'], [30, 'b']],
  );
});

test('parseLrc: enhanced LRC word stamps', () => {
  const [line] = parseLrc('[00:20.00]<00:20.00>one <00:20.50>two <00:21.20>three<00:22.00>');
  assert.equal(line.text, 'one two three');
  const words = wordTimings(line);
  assert.deepEqual(
    words.map((w) => [w.text, w.start, w.end]),
    [['one ', 20, 20.5], ['two ', 20.5, 21.2], ['three', 21.2, 22]],
  );
});

test('splitWords: Thai has no spaces but splits into words', () => {
  assert.deepEqual(splitWords('วันนี้อากาศดี'), ['วัน', 'นี้', 'อากาศ', 'ดี']);
  assert.deepEqual(splitWords('hello, world!'), ['hello, ', 'world!']);
});

test('wordTimings: estimates stay inside the line and before the next line', () => {
  const [line, next] = parseLrc('[00:10.00]a fairly long line of words\n[00:12.00]next');
  const words = wordTimings(line, next.time);
  assert.equal(words[0].start, 10);
  assert.ok(words.at(-1).end <= 12);
  words.forEach((w, i) => i && assert.equal(w.start, words[i - 1].end));
});

const { musicFromWatchHtml, bareTitle, searchCandidates } = require('../parse.js');

// Minimal stand-in for a watch page: ytInitialData with a "Music" card list.
const watchPage = (cards, iconName = 'MUSIC') => {
  const data = {
    engagementPanels: [{ structuredDescriptionContentRenderer: { items: [{ horizontalCardListRenderer: {
      cards: cards.map(([title, subtitle]) => ({ videoAttributeViewModel: { title, subtitle } })),
      footerButton: { buttonViewModel: { iconName } },
    } }] } }],
  };
  return `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;
};

test('musicFromWatchHtml: reads the single song credit', () => {
  assert.deepEqual(musicFromWatchHtml(watchPage([['Some Song (7" Mix)', 'Some Artist']])), {
    track: 'Some Song (7" Mix)',
    artist: 'Some Artist',
  });
});

test('musicFromWatchHtml: ignores compilations, non-music cards, and pages without data', () => {
  assert.equal(musicFromWatchHtml(watchPage([['A', 'X'], ['B', 'Y']])), null);
  assert.equal(musicFromWatchHtml(watchPage([['A', 'X']], 'GAMING')), null);
  assert.equal(musicFromWatchHtml('<html></html>'), null);
});

test('bareTitle strips bracketed versions', () => {
  assert.equal(bareTitle('Some Song (7" Mix) [Thai ver.]'), 'Some Song');
  assert.equal(bareTitle('Some Song'), 'Some Song');
});

test('searchCandidates: music credit first, then title guess, bare variants, no duplicates', () => {
  const music = { artist: 'Some Artist', track: 'Some Song (Remix)' };
  const parsed = { artist: 'Some Artist', track: 'Some Song', swap: true };
  assert.deepEqual(searchCandidates(music, parsed), [
    { artist: 'Some Artist', track: 'Some Song (Remix)', swap: false },
    { artist: 'Some Artist', track: 'Some Song', swap: false },
  ]);
  assert.deepEqual(searchCandidates(null, parsed), [{ artist: 'Some Artist', track: 'Some Song', swap: true }]);
});

const { syncLooksBroken } = require('../parse.js');
const lrcAt = (times) => parseLrc(times.map((s) => `[${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}]x`).join('\n'));

test('syncLooksBroken: all lines squeezed after the middle of the song', () => {
  // Real-world shape: 76 lines between 139s and 198s in a 198s track.
  const times = Array.from({ length: 76 }, (_, i) => 139 + (i * 59) / 75);
  assert.equal(syncLooksBroken(lrcAt(times), 198), true);
  assert.equal(syncLooksBroken(lrcAt(times), 1), true); // bogus duration on the entry
});

test('syncLooksBroken: normal and fast songs pass', () => {
  assert.equal(syncLooksBroken(lrcAt(Array.from({ length: 60 }, (_, i) => 12 + i * 3)), 200), false);
  assert.equal(syncLooksBroken(lrcAt(Array.from({ length: 90 }, (_, i) => 8 + i * 1.6)), 160), false); // fast rap
  assert.equal(syncLooksBroken(lrcAt([45, 50]), 200), false); // long intro is fine
});
