import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { AppConfig } from "./types"

const CONFIG_FILE = join(import.meta.dir, "..", "config.json")

export function loadConfig(): AppConfig {
  const defaults: AppConfig = {
    llmProvider: "gemini",
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    groqApiKey: process.env.GROQ_API_KEY || "",
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_MODEL || "llama3",
    opensubsApiKey: "",
    opensubsUsername: "",
    opensubsPassword: "",
    tmdbApiKey: process.env.TMDB_API_KEY || "",
    posterLanguages: "de,en,null",
    tmdbIdInFolder: "off",
    handbrakePresetDVD: "HQ 480p30 Surround",
    handbrakePresetBluRay: "HQ 1080p30 Surround",
    handbrakePreset4K: "Super HQ 2160p60 4K HEVC Surround",
    handbrakePath: "HandBrakeCLI",
    mkvmergePath: "mkvmerge",
    mkvextractPath: "mkvextract",
    sourceDir: process.env.SOURCE_DIR || "./input",
    outputDir: process.env.OUTPUT_DIR || "./output",
    folderPattern: "{title} ({year})",
    filePattern: "{title} ({year}) - [{format}]",
  }

  if (existsSync(CONFIG_FILE)) {
    try {
      return { ...defaults, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) }
    } catch (e) {
      console.error("Error parsing config.json, using defaults.", e)
    }
  } else {
    // Create config.json with current environment/defaults if it doesn't exist
    saveConfig(defaults)
  }

  return defaults
}

export function saveConfig(config: AppConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8")
}
