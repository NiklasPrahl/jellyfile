import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { AppConfig } from "./types"

const CONFIG_FILE = join(import.meta.dir, "..", "config.json")

export function loadConfig(): AppConfig {
  const defaults: AppConfig = {
    llmProvider: (process.env.LLM_PROVIDER as any) || "gemini",
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    groqApiKey: process.env.GROQ_API_KEY || "",
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    ollamaModel: process.env.OLLAMA_MODEL || "llama3",
    opensubsApiKey: process.env.OPENSUBTITLES_API_KEY || "",
    opensubsUsername: process.env.OPENSUBTITLES_USERNAME || "",
    opensubsPassword: process.env.OPENSUBTITLES_PASSWORD || "",
    handbrakePreset: process.env.HANDBRAKE_PRESET || "HQ 1080p30 Surround",
    handbrakePath: process.env.HANDBRAKE_PATH || "HandBrakeCLI",
    mkvmergePath: process.env.MKVMERGE_PATH || "mkvmerge",
    mkvextractPath: process.env.MKVEXTRACT_PATH || "mkvextract",
    sourceDir: process.env.SOURCE_DIR || "./input",
    outputDir: process.env.OUTPUT_DIR || "./output",
  }

  if (existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
      Object.assign(defaults, saved)
    } catch {}
  }

  return defaults
}

export function saveConfig(config: AppConfig): void {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8")
}
