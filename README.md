# getlyrics

Real-time synced lyrics beside the YouTube player, with karaoke-style word highlighting. A Chrome extension (Manifest V3) powered by [LRCLIB](https://lrclib.net). No account, no API key.

## Features

- **Auto-detects the song** from the video title. Strips clutter like `(Official MV)`, `[HD]`, `| Label`, `feat. ...`. Handles `Artist - Song`, `Song - Artist`, and K-pop style `ARTIST 'Song' M/V`.
- **Synced lyrics panel** at the top of the sidebar. The current line is highlighted and scrolls into view. Click any line to jump there.
- **Word-by-word highlight** that fills each word as it's sung. Uses real word timings when the lyrics include them (enhanced LRC). Otherwise it estimates them. Splits words correctly for languages without spaces (Thai, Japanese, Chinese) via `Intl.Segmenter`.
- **Fullscreen overlay** showing the current and next line over the video.
- **Timing offset**: `−` / `+` shift lyrics by 0.5s. The offset is saved per video.
- **Manual search**: if the auto-match is wrong or missing, press `⌕`, search, and pick a result. Your choice is remembered for that video.
- **Themes**: color from the video thumbnail, dark, or light.
- **Localized UI**: English and Thai. Follows the browser's language.

## Install

From source (until it's on the Chrome Web Store):

1. Clone the repo: `git clone https://github.com/imdeener/getlyrics`. Or download it as a ZIP and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repo folder.
4. Open any music video on youtube.com.

## How it works

| File | Role |
|---|---|
| `parse.js` | Pure functions: video title → artist/track, LRC → timed lines, line → word timings |
| `content.js` | Runs on youtube.com: watches SPA navigation, renders the panel and overlay, syncs to `<video>` |
| `background.js` | Service worker: queries the LRCLIB API, picks the best match by synced lyrics and duration, extracts the thumbnail color |
| `content.css` | Panel and overlay styles |
| `_locales/` | UI strings per language |

No build step and no dependencies.

## Privacy

getlyrics doesn't collect anything. To find lyrics it sends the detected artist, title, and duration of the video you're watching to `lrclib.net`. It also fetches the video thumbnail from `i.ytimg.com` to pick a theme color. Settings, offsets, and manual picks stay in your browser's local extension storage.

## Known limitations

- An MV with an intro plays ahead of the audio version that the lyrics are timed to. Fix it with `−` / `+`.
- A mid-song dance break or skit can't be fixed with a single offset.
- Coverage depends on LRCLIB. Lyrics there are community-contributed, so some songs are missing or slightly off.

## Contributing

Issues and PRs are welcome.

- **Add a language**: copy `_locales/en/messages.json` to `_locales/<code>/messages.json` and translate the `message` values. No code changes are needed.
- **Title parsing**: if a video title is detected wrongly, add it as a case in `test/parse.test.js` and fix `parse.js`. Run the tests with:

  ```sh
  node --test
  ```

  This needs Node 20 or newer.

## Credits

Lyrics data from [LRCLIB](https://lrclib.net), a free, community-maintained lyrics database. Please consider contributing lyrics there.

## License

[MIT](LICENSE)
