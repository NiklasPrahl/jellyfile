import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { AppConfig } from "./types"

const CONFIG_FILE = join(import.meta.dir, "..", "config.json")

export function loadConfig(): AppConfig {
  const defaults: AppConfig = {
    llmProvider: "gemini",
    geminiApiKey: "",
    groqApiKey: "",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "llama3",
    opensubsApiKey: "",
    opensubsUsername: "",
    opensubsPassword: "",
    handbrakePresetDVD: "HQ 480p30 Surround",
    handbrakePresetBluRay: "HQ 1080p30 Surround",
    handbrakePreset4K: "Super HQ 2160p60 4K HEVC Surround",
    handbrakePath: "HandBrakeCLI",
    mkvmergePath: "mkvmerge",
    mkvextractPath: "mkvextract",
    sourceDir: "./input",
    outputDir: "./output",
    folderPattern: "{title} ({year})",
    filePattern: "{title} ({year}) - [{format}]",
  }

  // Load from environment variables first (as base)
  const envMap: Record<string, keyof AppConfig> = {
    LLM_PROVIDER: "llmProvider",
    GEMINI_API_KEY: "geminiApiKey",
    GROQ_API_KEY: "groqApiKey",
    OLLAMA_BASE_URL: "ollamaBaseUrl",
    OLLAMA_MODEL: "ollamaModel",
    OPENSUBTITLES_API_KEY: "opensubsApiKey",
    SOURCE_DIR: "sourceDir",
    OUTPUT_DIR: "outputDir",
  }

  for (const [env, key] of Object.entries(envMap)) {
    if (process.env[env]) (defaults as any)[key] = process.env[env]
  }

  // Then override with config.json (persistent settings)
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
