
```text
      ██╗███████╗██╗     ██╗   ██╗   ██╗███████╗██╗██╗     ███████╗
      ██║██╔════╝██║     ██║   ╚██╗ ██╔╝██╔════╝██║██║     ██╔════╝
      ██║█████╗  ██║     ██║    ╚████╔╝ █████╗  ██║██║     █████╗  
██╗   ██║██╔══╝  ██║     ██║     ╚██╔╝  ██╔══╝  ██║██║     ██╔══╝  
╚██████╔╝███████╗███████╗███████╗ ██║   ██║     ██║███████╗███████╗
 ╚═════╝ ╚══════╝╚══════╝╚══════╝ ╚═╝   ╚═╝     ╚═╝╚══════╝╚══════╝
```

# Jellyfile

> DISCLAIMER: The programm is currently in an experimental stage and should therfore be used with caution. Keep a backup of your files before each run and verify outputs!

A specialized TUI-based pipeline for automated movie disc digitization and organization, producing a library that works with **Jellyfin** (and Plex).

---

## Features
- **Automated Scanning**: Detects and scans movie disc directories.
- **AI-Powered Metadata**: Uses Gemini, Groq, or Ollama to resolve titles and release years automatically.
- **HandBrake Integration**: Fully automated conversion pipeline for DVD, Blu-ray, and 4K media.
- **Subtitle Support**: Automated subtitle extraction and OpenSubtitles integration.
- **Jellyfin-ready Naming**: One folder per movie, versions told apart by a tag, subtitles that match the video names (see below).
- **Artwork (optional)**: Downloads the poster from TMDB in original quality as `poster.jpg`/`poster.png` into the movie folder. Existing posters are never overwritten, so you can swap them any time.
- **Customizable Organization**: Define your own folder and file naming structures.

---

## Setup Instructions

### Prerequisites
- [Bun](https://bun.sh/) (required for runtime)
- HandBrakeCLI, mkvmerge, and mkvextract installed on your system.

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/jellyfile.git
   cd jellyfile
   ```

2. **Install dependencies:**
   ```bash
   bun install
   ```

3. **Run the application:**
   ```bash
   bun run src/index.tsx
   ```
   *The application will automatically initialize a `config.json` file on the first run. You can manage all your settings, including API keys and paths, via the in-app Settings menu (press `S`).*

4. **(Optional) Self-test without network or external tools:**
   ```bash
   bun run selftest
   ```

---

## Usage

- **Navigation**: Use Up/Down arrow keys.
- **Settings**: Press `S` to access the settings panel.
- **Execution**: Press `Enter` to start scans or proceed through steps.
- **Quit**: Press `Q` at any time.

---

## Naming scheme (Jellyfin)

```
Der Pate (1972)/
  Der Pate (1972) - [Blu-ray].mkv
  Der Pate (1972) - [Blu-ray-MP4].mp4
  Der Pate (1972) - [Blu-ray].de.srt
  Der Pate (1972) - [Blu-ray].en.srt
  Der Pate (1972) - [Blu-ray-MP4].de.srt     <- copy, so Jellyfin finds it for the MP4, too
  Der Pate (1972) - [Blu-ray-MP4].en.srt
  poster.jpg
```

- The tag is the media format: `DVD`, `Blu-ray`, `Blu-ray-4K`. **MP4 files always get `-MP4`** (`[Blu-ray-4K-MP4]`) so the versions can be told apart in Jellyfin.
- Every video file starts exactly with the folder name (including year and optional `{tmdb-ID}`), as Jellyfin requires for multiple versions.
- Characters that are illegal on SMB/Windows/Jellyfin (`< > : " / \ | ? *`) are removed; a colon becomes ` - `. Names are Unicode-normalized (NFC).
- Subtitles are named like the video plus language (`.de.srt`, `.en.srt`). For movies with both MKV and MP4 they are written under both names.
- Optionally the TMDB ID is added: `Der Pate (1972) {tmdb-238}` (Settings: "TMDB ID in names", default `off`).

## Customization

The application allows full control over your media organization patterns via the **Settings** menu:

- **Folder Pattern**: e.g., `{title} ({year})`
- **File Pattern**: e.g., `{title} ({year}) - [{format}]`

Supported tags: `{title}`, `{year}`, `{format}` (the tag incl. `-MP4` for MP4 files), `{tmdb}` (`{tmdb-ID}` or empty).

Keep the file pattern starting with the same text as the folder pattern; otherwise Jellyfin cannot group versions of one movie.

---

## Artwork via TMDB

1. Create a free account at [themoviedb.org](https://www.themoviedb.org/) and request an API key (Settings > API). Both the v3 API key and the v4 "API Read Access Token" work.
2. Enter it in **Settings > Artwork (TMDB) > TMDB API Key** (or set `TMDB_API_KEY`).
3. In the review step a new column shows which TMDB movie was matched. If it is wrong, edit title/year (`T` / `Y`); the match is refreshed automatically.
4. During processing the poster is saved next to the movie. Poster language order: `Poster Langs` (default `de,en,null`; `null` = poster without text).

Without a TMDB key nothing changes: the artwork step is skipped.

TMDB data is only used for IDs and artwork and is never sent to the LLM.

**Attribution:** This product uses the TMDB API but is not endorsed or certified by TMDB. ([TMDB](https://www.themoviedb.org/))
