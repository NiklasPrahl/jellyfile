import { mkdirSync, copyFileSync, renameSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { MovieFile, AppConfig } from "../types"

export function plexName(m: MovieFile, config: AppConfig): string {
  return (config.folderPattern || "{title} ({year})")
    .replace("{title}", m.resolvedTitle)
    .replace("{year}", m.resolvedYear)
    .replace("{format}", m.confirmedFormat)
}

export function plexFile(m: MovieFile, ext: string, config: AppConfig): string {
  return (config.filePattern || "{title} ({year}) - [{format}]")
    .replace("{title}", m.resolvedTitle)
    .replace("{year}", m.resolvedYear)
    .replace("{format}", m.confirmedFormat) + `.${ext}`
}

export function organizeMovie(m: MovieFile, outputDir: string, config: AppConfig, mp4Path?: string): void {
  const dir = join(outputDir, plexName(m, config))
  mkdirSync(dir, { recursive: true })

  // MKV handling
  if (m.originalPath.toLowerCase().endsWith(".mkv")) {
    if (m.conversionMode !== "mp4_only") {
      const dest = join(dir, plexFile(m, "mkv", config))
      if (!existsSync(dest)) copyFileSync(m.originalPath, dest)
    }
  } else if (m.originalPath.toLowerCase().endsWith(".mp4")) {
    // If original is MP4, we just copy it to the right place (unless we converted it again, which shouldn't happen)
    if (!mp4Path) {
      const dest = join(dir, plexFile(m, "mp4", config))
      if (!existsSync(dest)) copyFileSync(m.originalPath, dest)
    }
  }

  // New MP4 handling (from conversion)
  if (mp4Path && existsSync(mp4Path)) {
    const dest = join(dir, plexFile(m, "mp4", config))
    if (!existsSync(dest)) renameSync(mp4Path, dest)
  }
}
