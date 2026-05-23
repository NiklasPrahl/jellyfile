import { readdirSync, statSync } from "node:fs"
import { join, extname, basename } from "node:path"
import { spawnSync } from "node:child_process"
import type { MovieFile, MediaFormat, AppConfig } from "../types"

const GB = 1024 * 1024 * 1024

function detectFormat(fullPath: string, sizeBytes: number, mkvmergePath: string): MediaFormat {
  try {
    const proc = spawnSync(mkvmergePath, ["--identify", "--identification-format", "json", fullPath])
    if (proc.status === 0) {
      const info = JSON.parse(proc.stdout.toString())
      const videoTrack = info.tracks?.find((t: any) => t.type === "video")
      if (videoTrack?.properties?.pixel_dimensions) {
        const dimensions = videoTrack.properties.pixel_dimensions
        const match = dimensions.match(/(\d+)x(\d+)/)
        if (match) {
          const w = parseInt(match[1])
          const h = parseInt(match[2])
          if (h >= 2160 || w >= 3840) return "Blu-ray_4K"
          if (h >= 1080 || w >= 1920) return "Blu-ray"
          return "DVD"
        }
      }
    }
  } catch {}

  // Fallback to size-based detection
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

export function scanDirectory(dir: string, config: AppConfig): MovieFile[] {
  const entries = readdirSync(dir)
  const movies: MovieFile[] = []

  for (const entry of entries) {
    const ext = extname(entry).toLowerCase()
    if (ext !== ".mkv" && ext !== ".mp4") continue

    try {
      const fullPath = join(dir, entry)
      const stat = statSync(fullPath)
      const format = detectFormat(fullPath, stat.size, config.mkvmergePath)

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
        keepMkv: ext === ".mkv",
        conversionMode: ext === ".mkv" ? "keep_both" : "mkv_only",
        status: "pending",
      })
    } catch {}
  }

  return movies.sort((a, b) => a.originalName.localeCompare(b.originalName))
}
