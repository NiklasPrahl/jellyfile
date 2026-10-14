import type { AppConfig, MediaFormat, MovieFile } from "../types"

/**
 * Central place for all file/folder naming rules (Jellyfin-compatible).
 *
 * Rules implemented here:
 *  - Characters that are illegal on SMB/Windows/Jellyfin (< > : " / \ | ? *) never end up in names.
 *    A colon becomes " - " ("Star Wars: Episode IV" -> "Star Wars - Episode IV").
 *  - Names never end with a space or dot and never contain double spaces.
 *  - Every video file starts exactly with the folder name (incl. year and optional {tmdb-ID}),
 *    followed by " - [Tag]". This is required by Jellyfin for multiple versions of one movie.
 *  - The tag is the media format ("DVD", "Blu-ray", "Blu-ray-4K"). MP4 files get "-MP4" appended
 *    ("Blu-ray-MP4", "Blu-ray-4K-MP4") so that versions can be told apart in Jellyfin.
 *  - All names are Unicode-normalized (NFC) so that folder and file names always match
 *    byte for byte (macOS/SMB can otherwise mix NFC and NFD).
 */

const ILLEGAL = /[<>"\/\\|?*]/g

export function sanitizeTitle(raw: string): string {
  return (raw || "")
    .normalize("NFC")
    .replace(/\s*:\s*/g, " - ")
    .replace(ILLEGAL, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s.]+$/, "")
    .trim()
}

export function formatTag(format: MediaFormat, ext: string): string {
  return ext.replace(/^\./, "").toLowerCase() === "mp4" ? `${format}-MP4` : format
}

export function tmdbToken(m: MovieFile): string {
  return m.tmdbId ? `{tmdb-${m.tmdbId}}` : ""
}

/** If "TMDB ID in names" is on and the pattern has no {tmdb} yet, insert it at the right place. */
function withId(pattern: string, kind: "folder" | "file", config: AppConfig): string {
  if (pattern.includes("{tmdb}")) return pattern
  if (config.tmdbIdInFolder !== "on") return pattern
  if (kind === "folder") return `${pattern} {tmdb}`
  const i = pattern.indexOf(" - [")
  return i >= 0 ? `${pattern.slice(0, i)} {tmdb}${pattern.slice(i)}` : `${pattern} {tmdb}`
}

function render(pattern: string, m: MovieFile, tag: string): string {
  return pattern
    .replaceAll("{title}", sanitizeTitle(m.resolvedTitle))
    .replaceAll("{year}", (m.resolvedYear || "").trim())
    .replaceAll("{format}", tag)
    .replaceAll("{tmdb}", tmdbToken(m))
    .replace(/\s*\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .normalize("NFC")
}

export function folderName(m: MovieFile, config: AppConfig): string {
  const pattern = config.folderPattern || "{title} ({year})"
  return render(withId(pattern, "folder", config), m, m.confirmedFormat)
}

/** File name without extension, e.g. "Film (2020) - [Blu-ray-4K-MP4]" */
export function fileBase(m: MovieFile, ext: string, config: AppConfig): string {
  const pattern = config.filePattern || "{title} ({year}) - [{format}]"
  return render(withId(pattern, "file", config), m, formatTag(m.confirmedFormat, ext))
}

export function fileName(m: MovieFile, ext: string, config: AppConfig): string {
  return `${fileBase(m, ext, config)}.${ext.replace(/^\./, "")}`
}

/** Sanity check: Jellyfin needs "<folder name> - ..." as the start of every video file name. */
export function startsWithFolder(m: MovieFile, config: AppConfig): boolean {
  return fileBase(m, "mkv", config).startsWith(folderName(m, config))
}
