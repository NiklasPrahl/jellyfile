export type MediaFormat = "DVD" | "Blu-ray" | "Blu-ray_4K"
export type ConversionMode = "keep_both" | "mp4_only" | "mkv_only"
export type LlmProvider = "gemini" | "groq" | "ollama"

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
  status:
    | "pending"
    | "title-resolved"
    | "ready"
    | "converting"
    | "subtitles"
    | "organizing"
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
  handbrakePreset: string
  handbrakePath: string
  mkvmergePath: string
  mkvextractPath: string
  sourceDir: string
  outputDir: string
}

export type AppView = "scan" | "review" | "settings" | "progress"
