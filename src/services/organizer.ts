import { mkdirSync, copyFileSync, renameSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { MovieFile, AppConfig } from "../types"
import { folderName, fileName } from "./naming"

export function organizeMovie(m: MovieFile, outputDir: string, config: AppConfig, mp4Path?: string): void {
  const dir = join(outputDir, folderName(m, config))
  mkdirSync(dir, { recursive: true })

  // MKV handling
  if (m.originalPath.toLowerCase().endsWith(".mkv")) {
    if (m.conversionMode !== "mp4_only") {
      const dest = join(dir, fileName(m, "mkv", config))
      if (!existsSync(dest)) copyFileSync(m.originalPath, dest)
    }
  } else if (m.originalPath.toLowerCase().endsWith(".mp4")) {
    // If original is MP4, we just copy it to the right place (unless we converted it again, which shouldn't happen)
    if (!mp4Path) {
      const dest = join(dir, fileName(m, "mp4", config))
      if (!existsSync(dest)) copyFileSync(m.originalPath, dest)
    }
  }

  // New MP4 handling (from conversion)
  if (mp4Path && existsSync(mp4Path)) {
    const dest = join(dir, fileName(m, "mp4", config))
    if (!existsSync(dest)) renameSync(mp4Path, dest)
  }
}
