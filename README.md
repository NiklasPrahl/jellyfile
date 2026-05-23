# PLEX INGEST - Blu-ray Digitization Pipeline TUI

Built with OpenTUI (https://opentui.com).

MakeMKV output -> Title Resolution -> Format Tagging -> HandBrake Conversion -> Subtitle Download -> Plex Library

## Features
- Scan MakeMKV output folders for MKV files
- AI Title Resolution via Google Gemini 2.0 Flash (free tier)
- Auto-detect media format (DVD / Blu-ray / 4K) from file size, manually adjustable
- HandBrake conversion MKV to MP4 with configurable presets
- Subtitle download (EN + DE) via OpenSubtitles API
- Plex-compatible output structure
- Settings panel for all API keys and paths

## Output Structure
    Film Title (2024)/
      Film Title (2024) - [Blu-ray].mp4
      Film Title (2024) - [Blu-ray].mkv      (optional)
      Film Title (2024) - [Blu-ray].en.srt
      Film Title (2024) - [Blu-ray].de.srt

## Prerequisites
- Bun (https://bun.sh, v1.0+)
- HandBrakeCLI (https://handbrake.fr/downloads2.php)
- Google Gemini API Key (free: https://aistudio.google.com/apikey)
- OpenSubtitles API Key (free: https://www.opensubtitles.com/consumers)

## Setup
    cd plex-ingest
    bun install
    cp .env.example .env
    # Edit .env with your API keys
    bun run start

## TUI Controls
T=Settings  S=Scan  R=Review  P=Process
Up/Down=Navigate  F=Cycle format  K=Toggle keep MKV
Enter=Execute  Esc=Cancel  Q=Quit

## Workflow
1. Settings - Configure API keys and directories
2. Scan - Enter to scan source dir and resolve titles via Gemini
3. Review - Adjust formats, toggle MKV retention, verify titles
4. Process - Enter to start HandBrake + subtitles + file organization

All interactive decisions happen BEFORE conversion so HandBrake runs unattended.

