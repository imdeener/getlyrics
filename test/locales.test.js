// Every locale must have exactly the keys and placeholders of the default (en) locale,
// and every t('key') used in content.js must exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const load = (lang) => JSON.parse(fs.readFileSync(path.join(root, '_locales', lang, 'messages.json'), 'utf8'));
const en = load('en');
const placeholders = (msg) => (msg.match(/\$[A-Z_]+\$/g) || []).sort();

for (const lang of fs.readdirSync(path.join(root, '_locales'))) {
  test(`locale ${lang}: same keys and placeholders as en`, () => {
    const messages = load(lang);
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      assert.ok(messages[key].message.trim(), `${lang}.${key} is empty`);
      assert.deepEqual(placeholders(messages[key].message), placeholders(en[key].message), `${lang}.${key}`);
    }
  });
}

test('every t() key used in content.js exists', () => {
  const src = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const used = [...src.matchAll(/\bt\('([A-Za-z_]+)'/g)].map((m) => m[1]);
  used.push('theme_auto', 'theme_dark', 'theme_light'); // built as t(`theme_${name}`)
  assert.deepEqual(used.filter((k) => !en[k]), []);
});
