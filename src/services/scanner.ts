import { readdirSync, statSync } from "node:fs"
import { join, extname, basename } from "node:path"
import type { MovieFile, MediaFormat } from "../types"

const GB = 1024 * 1024 * 1024

function detectFormat(sizeBytes: number): MediaFormat {
  const gb = sizeBytes / GB
  if (gb > 50) return "Blu-ray_4K"
  if (gb >= 12) return "Blu-ray"
  return "DVD"
}

function humanSize(bytes: number): string {
  const gb = bytes / GB
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

function extractBaseName(filename: string): string {
  return basename(filename, extname(filename))
    .replace(/_t\d+$/, "")
    .replace(/_/g, " ")
    .trim()
}

export function scanDirectory(dir: string): MovieFile[] {
  const entries = readdirSync(dir)
  const movies: MovieFile[] = []

  for (const entry of entries) {
    const ext = extname(entry).toLowerCase()
    if (ext !== ".mkv" && ext !== ".mp4") continue

    try {
      const fullPath = join(dir, entry)
      const stat = statSync(fullPath)
      const format = detectFormat(stat.size)

      movies.push({
        id: crypto.randomUUID(),
        originalPath: fullPath,
        originalName: entry,
        sizeBytes: stat.size,
        sizeHuman: humanSize(stat.size),
        detectedFormat: format,
        confirmedFormat: format,
        resolvedTitle: extractBaseName(entry),
        resolvedYear: "",
        keepMkv: ext === ".mkv", // Default to true for MKV
        conversionMode: ext === ".mkv" ? "keep_both" : "mkv_only",
        status: "pending",
      })
    } catch {}
  }

  return movies.sort((a, b) => a.originalName.localeCompare(b.originalName))
}
