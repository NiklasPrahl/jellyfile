import { readdirSync, statSync } from "node:fs"
import { join, extname, basename } from "node:path"
import { spawnSync } from "node:child_process"
import type { MovieFile, MediaFormat, AppConfig } from "../types"

const GB = 1024 * 1024 * 1024

export function detectFormat(fullPath: string, sizeBytes: number, mkvmergePath: string): MediaFormat {
  const name = basename(fullPath).toLowerCase()
  // 1. Check explicit format tags in filename (e.g. [Blu-ray-4K-MP4], [Blu-ray], 2160p)
  if (/\[.*?(4k|2160p|uhd).*?\]/i.test(name) || /\b(2160p|4k|uhd)\b/i.test(name)) return "Blu-ray-4K"
  if (/\[.*?blu-ray.*?\]/i.test(name) || /\b(1080p|720p)\b/i.test(name)) return "Blu-ray"
  if (/\[.*?dvd.*?\]/i.test(name) || /\b(480p|576p)\b/i.test(name)) return "DVD"

  // 2. Video track pixel dimensions via mkvmerge (works for both MKV and MP4)
  try {
    const proc = spawnSync(mkvmergePath, ["--identify", "--identification-format", "json", fullPath])
    if (proc.status === 0) {
      const info = JSON.parse(proc.stdout.toString())
      const videoTrack = info.tracks?.find((t: any) => t.type === "video")
      if (videoTrack?.properties?.pixel_dimensions) {
        const dimensions = videoTrack.properties.pixel_dimensions
        const match = dimensions.match(/(\d+)x(\d+)/)
        if (match) {
          const w = parseInt(match[1], 10)
          const h = parseInt(match[2], 10)
          if (h >= 2160 || w >= 3840) return "Blu-ray-4K"
          if (h >= 720 || w >= 1280) return "Blu-ray"
          return "DVD"
        }
      }
    }
  } catch {}

  // 3. Fallback to size-based detection
  const gb = sizeBytes / GB
  if (gb > 50) return "Blu-ray-4K"
  if (gb >= 12) return "Blu-ray"
  return "DVD"
}

function humanSize(bytes: number): string {
  const gb = bytes / GB
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

export function extractYear(filename: string): string {
  const match = filename.match(/\((19\d{2}|20\d{2})\)/) || filename.match(/\b(19\d{2}|20\d{2})\b/)
  return match ? match[1] : ""
}

export function extractBaseName(filename: string): string {
  return basename(filename, extname(filename))
    .replace(/_t\d+$/i, "")
    .replace(/\s*\{tmdb-\d+\}/gi, "")
    .replace(/\s*-\s*\[.*?\]$/i, "")
    .replace(/\s*\((?:19\d{2}|20\d{2})\)/g, "")
    .replace(/_/g, " ")
    .trim()
}

export function scanDirectory(dir: string, config: AppConfig): MovieFile[] {
  const entries = readdirSync(dir)
  const movies: MovieFile[] = []

  for (const entry of entries) {
    if (entry.startsWith(".")) continue // skip hidden files such as macOS "._*" resource forks
    const ext = extname(entry).toLowerCase()
    if (ext !== ".mkv" && ext !== ".mp4") continue

    try {
      const fullPath = join(dir, entry)
      const stat = statSync(fullPath)
      const format = detectFormat(fullPath, stat.size, config.mkvmergePath)
      const isMkv = ext === ".mkv"
      const tmdbMatch = entry.match(/\{tmdb-(\d+)\}/i)

      movies.push({
        id: crypto.randomUUID(),
        originalPath: fullPath,
        originalName: entry,
        sizeBytes: stat.size,
        sizeHuman: humanSize(stat.size),
        detectedFormat: format,
        confirmedFormat: format,
        resolvedTitle: extractBaseName(entry),
        resolvedYear: extractYear(entry),
        keepMkv: isMkv,
        conversionMode: isMkv ? "keep_both" : "mp4_only",
        tmdbId: tmdbMatch ? parseInt(tmdbMatch[1], 10) : undefined,
        status: "pending",
      })
    } catch {}
  }

  return movies.sort((a, b) => a.originalName.localeCompare(b.originalName))
}
