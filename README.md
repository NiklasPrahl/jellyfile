
```text
      ██╗███████╗██╗     ██╗    ██╗   ██╗███████╗██╗██╗     ███████╗
      ██║██╔════╝██║     ██║    ╚██╗ ██╔╝██╔════╝██║██║     ██╔════╝
      ██║█████╗  ██║     ██║     ╚████╔╝ █████╗  ██║██║     ███╗  
██╗   ██║██╔══╝  ██║     ██║      ╚██╔╝  ██╔══╝  ██║██║     ██╔══╝  
╚██████╔╝███████╗███████╗███████╗  ██║   ██║     ██║███████╗███████╗
 ╚═════╝ ╚══════╝╚══════╝╚══════╝  ╚═╝   ╚═╝     ╚═╝╚══════╝╚══════╝
```

# Jellyfile

A specialized TUI-based pipeline for automated movie disc digitization and organization.

---

## Features
- **Automated Scanning**: Detects and scans movie disc directories.
- **AI-Powered Metadata**: Uses Gemini, Groq, or Ollama to resolve titles and release years automatically.
- **HandBrake Integration**: Fully automated conversion pipeline for DVD, Blu-ray, and 4K media.
- **Subtitle Support**: Automated subtitle extraction and OpenSubtitles integration.
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

3. **Configure the application:**
   Copy the example environment file and fill in your settings:
   ```bash
   cp .env.example .env
   # Edit .env and configure your paths and API keys
   ```

4. **Run the application:**
   ```bash
   bun run src/index.tsx
   ```

---

## Usage

- **Navigation**: Use Up/Down arrow keys.
- **Settings**: Press `S` to access the settings panel.
- **Execution**: Press `Enter` to start scans or proceed through steps.
- **Quit**: Press `Q` at any time.

---

## Customization

The application allows full control over your media organization patterns via the **Settings** menu:

- **Folder Pattern**: e.g., `{title} ({year})`
- **File Pattern**: e.g., `{title} ({year}) - [{format}]`

Supported tags: `{title}`, `{year}`, `{format}`.
