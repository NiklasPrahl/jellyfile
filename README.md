# JELLYFILE - Movie Disc Digitization Pipeline TUI

Built with OpenTUI (https://opentui.com).

MakeMKV output -> Title Resolution -> Format Tagging -> HandBrake Conversion -> Subtitle Download -> Movie Library

## Features
- Scan MakeMKV output folders for MKV files
- AI Title Resolution via Multi-Provider LLM (Gemini, Groq, Ollama)
- Auto-detect media format (DVD / Blu-ray / 4K) via resolution metadata
- HandBrake conversion MKV to MP4 with per-format presets
- Subtitle extraction from MKV + download (EN + DE) via OpenSubtitles
- Media-compatible output structure
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
- MKVToolNix (mkvmerge, mkvextract)

## Setup
    cd jellyfile
    bun install
    cp .env.example .env
    # Edit .env with your API keys
    bun run start

## TUI Controls
S=Settings  Up/Down=Navigate  Enter=Execute  Esc=Cancel/Back  Q=Quit
F=Cycle format  M=Cycle conversion mode  E=Edit Title  Y=Edit Year

## Workflow
1. Initial Setup - Confirm input/output directories
2. Scan - Resolve titles via LLM
3. Review - Adjust formats, modes, and verify titles
4. Process - HandBrake + subtitles + organization

All interactive decisions happen BEFORE conversion so processing runs unattended.
