# Herlink

[![GitHub Release][release-badge]][releases-link]
[![License][license-badge]][license-badge]
[![GitHub Stars][stars-badge]][stars-link]
[![GitHub Forks][forks-badge]][forks-link]

**Download videos from YouTube, X/Twitter, Instagram, TikTok and 1,600+ other sites — right from your terminal.**

Paste a URL, pick a resolution (or audio-only MP3), done. No popups, no fake download buttons, no sketchy redirects.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Quick Start

```sh
# Install globally (recommended)
npm install -g herlink

# Or try without installing
npx herlink

# Basic usage - pick a format from the picker
herlink https://youtu.be/dQw4w9WgXcQ

# Scriptable mode - best quality, no picker
herlink --best https://youtu.be/dQw4w9WgXcQ

# Audio-only MP3
herlink --mp3 https://youtu.be/dQw4w9WgXcQ

# Resume a partial download
herlink --continue https://youtu.be/dQw4w9WgXcQ

# Batch download from a file
herlink --file urls.txt
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## About The Project

**Herlink** is a terminal-based video downloader that puts you in control. Built with [Ink](https://github.com/vadimdemedes/ink) and [yt-dlp](https://github.com/yt-dlp/yt-dlp), it lets you:

- Download from YouTube, X/Twitter, Instagram, TikTok and 1,600+ sites
- Pick resolution, format, and audio quality before downloading
- Download multiple URLs in parallel with individual progress bars
- Resume interrupted downloads with `--continue`
- Embed metadata and cover art with `--embed-metadata`
- Use custom cookies with `--cookies`

Why was it created? Most terminal downloaders either require complex config or hide the format selection. Herlink puts the power in your hands with a beautiful TUI, mouse support, and keyboard navigation — all while keeping things simple and hackable.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [yt-dlp](https://yt-dlp.org/) (bundled on first run, or use your system version)
- [ffmpeg](https://ffmpeg.org/) (for merging high-res streams and MP3 extraction)

### Install

```sh
# Install globally (recommended)
npm install -g herlink

# Or from source
npm install
npm run build
# Then: npm link  # or: npx herlink
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Usage

### Basic format

```sh
herlink <url>
```

### Pick a format (interactive picker)

```sh
herlink https://youtu.be/dQw4w9WgXcQ
# Use ↑/↓ or j/k arrows, or number keys to select
# Enter to download, esc to go back, ^c to quit
```

### Scriptable mode (no picker)

```sh
# Best quality video (skips picker)
herlink --best <url>

# Audio-only MP3
herlink --mp3 <url>

# Best quality + embed metadata
herlink --best --embed-metadata <url>
```

### Flags reference

| Flag | What it does |
| ---- | ------------ |
| `--theme <auto\|light\|dark>` | starting theme for one launch |
| `--best` / `--mp3` | scriptable mode: no picker, applies to every url |
| `-o <dir>` | output folder (replaces `~/Downloads` for the run) |
| `--continue` | resume partial downloads (keeps `.part`) |
| `--cookies <file>` | Netscape-format cookies file for login-gated sites |
| `--subs [langs]` | download subtitles (`--subs=es,en`; empty = all languages) |
| `--embed-metadata` | embed title/thumbnail/metadata (requires ffmpeg) |
| `--no-update` | skip the bundled yt-dlp self-update for one run |
| `--file <file>` | read urls from a file (one per line) |
| `-h` / `-v` | help / version |

### Example: Download a playlist

```sh
herlink "https://youtube.com/playlist?list=..." --best --file playlist.txt
```

### Example: Download with cookies

```sh
herlink --cookies cookies.txt https://youtu.be/dQw4w9WgXcQ
```

### Example: Resume a download

```sh
herlink --continue https://youtu.be/dQw4w9WgXcQ
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## How It Works

- Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp). On first run, herlink downloads the standalone yt-dlp binary to `~/.herlink/bin` — no Python required. If you already have yt-dlp installed, it uses yours.
- ffmpeg (needed for merging high-res streams and mp3 extraction) is found on your PATH, with `ffmpeg-static` as a bundled fallback.
- The UI is [Ink](https://github.com/vadimdemedes/ink) — React for the terminal.
- Downloads run in parallel, each getting its own row with a progress bar.
- Interrupted downloads keep their `.part` files so `--continue` can resume them.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Roadmap

[x] Clipboard detection: launch bare and auto-suggest the url you copied
[x] `curl herlink.sh | sh` installer
[x] Publish to npm (`npm i -g herlink` / `npx herlink`)
[x] `--best` / `--mp3` flags to skip the picker (scriptable mode)
[x] `-o <dir>` to choose the output folder
[x] Batch queue: multiple urls / `--file`, parallel downloads
[x] Playlist and thread-with-multiple-videos support
[x] Resume (`--continue`), cookies (`--cookies`), subtitles (`--subs`),
      metadata embedding (`--embed-metadata`)
[x] Self-update for the bundled yt-dlp binary (`yt-dlp -U`, silent)

[] Clipboard detection: launch bare and auto-suggest the url you copied
[] `curl herlink.sh | sh` installer

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Development

```sh
# Build to dist/ with tsup
npm run build

# Watch for changes
npm run dev

# Typecheck
npm run typecheck

# Run tests
npm test
```

To try it as a global command without publishing: `npm link`, then run `herlink` anywhere.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".

Don't forget to give the project a star! Thanks again!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## License

Distributed under the MIT License. See `LICENSE.txt` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Contact

- GitHub: [@WilberHernan](https://github.com/WilberHernan)
- Twitter: [@wilberhernan06](https://twitter.com/wilberhernan06)
- Email: wilberhernan06@gmail.com

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

## Screenshots

<!-- Add screenshots of Herlink UI here with rounded borders -->

<p align="center">
  <img src="https://raw.githubusercontent.com/WilberHernan/Herlink/main/Screenshot_20260816_164457_Termux.jpg" alt="Herlink download screen" style="border-radius: 4px; border: 1px solid #e0e0e0; padding: 4px;">
</p>

<p align="center">
  <img src="PLACEHOLDER_2.png" alt="Herlink format picker" style="border-radius: 4px; border: 1px solid #e0e0e0; padding: 4px;">
</p>

<p align="center">
  <sub>Replace the placeholder URLs above with the actual paths to your screenshots.<br>
  Recommended: store images in the repo and use relative paths, or host on GitHub raw.</sub>
</p>

## Badges

<!-- Shields.io badges - update shields.io URLs with your project's actual metrics -->

[release-badge]: https://img.shields.io/github/v/release/WilberHernan/herlink.svg?style=for-the-badge
[releases-link]: https://github.com/WilberHernan/herlink/releases

[license-badge]: https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge
[license-link]: https://opensource.org/licenses/MIT

[stars-badge]: https://img.shields.io/github/stars/WilberHernan/herlink.svg?style=for-the-badge
[stars-link]: https://github.com/WilberHernan/herlink/stargazers

[forks-badge]: https://img.shields.io/github/forks/WilberHernan/herlink.svg?style=for-the-badge
[forks-link]: https://github.com/WilberHernan/herlink/forks