export type MediaFormat = "DVD" | "Blu-ray" | "Blu-ray-4K"
export type ConversionMode = "keep_both" | "mp4_only" | "mkv_only"
export type LlmProvider = "gemini" | "groq" | "ollama"
export type Toggle = "on" | "off"

export interface MovieFile {
  id: string
  originalPath: string
  originalName: string
  sizeBytes: number
  sizeHuman: string
  detectedFormat: MediaFormat
  confirmedFormat: MediaFormat
  resolvedTitle: string
  resolvedYear: string
  keepMkv: boolean
  conversionMode: ConversionMode
  // TMDB match (optional, only filled when a TMDB API key is configured)
  tmdbId?: number
  tmdbTitle?: string
  tmdbYear?: string
  tmdbPoster?: string
  tmdbChecked?: boolean
  status:
    | "pending"
    | "title-resolved"
    | "ready"
    | "converting"
    | "subtitles"
    | "organizing"
    | "artwork"
    | "done"
    | "error"
  error?: string
}

export interface AppConfig {
  llmProvider: LlmProvider
  geminiApiKey: string
  groqApiKey: string
  ollamaBaseUrl: string
  ollamaModel: string
  opensubsApiKey: string
  opensubsUsername: string
  opensubsPassword: string
  tmdbApiKey: string
  posterLanguages: string
  tmdbIdInFolder: Toggle
  handbrakePresetDVD: string
  handbrakePresetBluRay: string
  handbrakePreset4K: string
  handbrakePath: string
  mkvmergePath: string
  mkvextractPath: string
  sourceDir: string
  outputDir: string
  folderPattern: string
  filePattern: string
}

export type AppView = "init" | "scan" | "review" | "settings" | "progress"
