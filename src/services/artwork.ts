import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AppConfig, MovieFile } from "../types"

/**
 * TMDB integration: matches movies and downloads the selected poster unchanged
 * as "poster.<ext>" into the movie folder. Never overwrites an existing poster.
 *
 * NOTE (TMDB API terms): TMDB data is only used here for IDs and artwork. It must never be
 * passed to the LLM prompts. Attribution: see TMDB_ATTRIBUTION (shown in the app and README).
 */

export const TMDB_ATTRIBUTION = "This product uses the TMDB API but is not endorsed or certified by TMDB."

const API = "https://api.themoviedb.org/3"
const IMAGE_BASE = "https://image.tmdb.org/t/p/original"
const DEFAULT_LANGS = ["de", "en", "null"]

interface TmdbCandidate {
  id: number
  title: string
  original_title?: string
  release_date?: string
  popularity?: number
  poster_path?: string | null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fold(s: string): string {
  return (s || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

function yearOf(date?: string): string {
  return (date || "").slice(0, 4)
}

/** TMDB v4 "API Read Access Token" is a JWT (starts with eyJ); v3 keys are short hex strings. */
function isBearer(key: string): boolean {
  return key.startsWith("eyJ")
}

async function tmdbGet(path: string, params: Record<string, string>, apiKey: string, retries = 2): Promise<any> {
  const url = new URL(API + path)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const headers: Record<string, string> = { Accept: "application/json" }
  if (isBearer(apiKey)) headers["Authorization"] = `Bearer ${apiKey}`
  else url.searchParams.set("api_key", apiKey)

  const res = await fetch(url.toString(), { headers })
  if (res.status === 429 && retries > 0) {
    const wait = Math.min(Number(res.headers.get("retry-after") || "1") || 1, 10)
    await sleep(wait * 1000)
    return tmdbGet(path, params, apiKey, retries - 1)
  }
  if (res.status === 401) throw new Error("TMDB API key rejected (401)")
  if (!res.ok) throw new Error(`TMDB API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

/** Picks the best search hit. Requires a title match; if a year is known it must be within +-1. */
export function pickBest(cands: TmdbCandidate[], title: string, year: string): TmdbCandidate | null {
  const q = fold(title)
  if (!q) return null
  const wantYear = /^\d{4}$/.test(year) ? parseInt(year, 10) : null
  let best: TmdbCandidate | null = null
  let bestScore = 0

  for (const c of cands) {
    const names = [c.title, c.original_title].filter(Boolean).map((n) => fold(n as string))
    const exact = names.some((n) => n === q)
    const partial = names.some((n) => n.length >= 4 && q.length >= 4 && (n.includes(q) || q.includes(n)))
    if (!exact && !partial) continue

    const cy = parseInt(yearOf(c.release_date), 10)
    const dy = wantYear !== null && !isNaN(cy) ? Math.abs(cy - wantYear) : null
    if (wantYear !== null && (dy === null || dy > 1)) continue

    let score = exact ? 100 : 60
    if (dy === 0) score += 30
    else if (dy === 1) score += 10
    score += Math.min(c.popularity || 0, 100) / 10
    if (score > bestScore) { best = c; bestScore = score }
  }
  return best
}

export async function matchMovie(m: MovieFile, config: AppConfig): Promise<boolean> {
  m.tmdbChecked = true
  m.tmdbId = undefined; m.tmdbTitle = undefined; m.tmdbYear = undefined; m.tmdbPoster = undefined
  if (!config.tmdbApiKey || !m.resolvedTitle) return false

  const year = /^\d{4}$/.test(m.resolvedYear) ? m.resolvedYear : ""
  const base: Record<string, string> = { query: m.resolvedTitle, language: "de-DE", include_adult: "false" }

  let results: TmdbCandidate[] = (await tmdbGet("/search/movie", year ? { ...base, year } : base, config.tmdbApiKey)).results || []
  let best = pickBest(results, m.resolvedTitle, year)
  if (!best && year) {
    results = (await tmdbGet("/search/movie", base, config.tmdbApiKey)).results || []
    best = pickBest(results, m.resolvedTitle, year)
  }
  if (!best) return false

  m.tmdbId = best.id
  m.tmdbTitle = best.title
  m.tmdbYear = yearOf(best.release_date)
  m.tmdbPoster = best.poster_path || undefined
  return true
}

/** Matches all movies sequentially (polite to the API). Auth errors abort, other errors are skipped. */
export async function matchTmdb(
  movies: MovieFile[],
  config: AppConfig,
  onProgress?: (i: number, total: number) => void
): Promise<void> {
  if (!config.tmdbApiKey) return
  const todo = movies.filter((m) => m.status !== "error" && !m.tmdbChecked)
  for (let i = 0; i < todo.length; i++) {
    try {
      await matchMovie(todo[i], config)
    } catch (err) {
      if (err instanceof Error && err.message.includes("401")) throw err
      todo[i].tmdbChecked = true
    }
    onProgress?.(i + 1, todo.length)
    await sleep(120)
  }
}

export function parseLanguages(raw: string): string[] {
  const langs = (raw || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  return langs.length ? langs : DEFAULT_LANGS
}

/** Poster choice: first language in the list that has posters; inside a language best rated wins. */
export function pickPoster(posters: any[], langs: string[]): any | null {
  const rank = (a: any, b: any) =>
    (b.vote_average || 0) - (a.vote_average || 0) ||
    (b.vote_count || 0) - (a.vote_count || 0) ||
    (b.width || 0) - (a.width || 0)

  for (const l of langs) {
    const code = l === "null" ? null : l
    const group = posters.filter((p) => (p.iso_639_1 ?? null) === code)
    if (group.length) return [...group].sort(rank)[0]
  }
  return posters.length ? [...posters].sort(rank)[0] : null
}

export function sniffImageExt(buf: Uint8Array): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg"
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png"
  if (buf.length > 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "webp"
  return null
}

export function hasPoster(dir: string): boolean {
  if (!existsSync(dir)) return false
  return readdirSync(dir).some((f) => /^poster\.(jpe?g|png|webp)$/i.test(f))
}

export interface PosterResult {
  ok: boolean
  skipped?: boolean
  file?: string
  reason?: string
}

export async function downloadPoster(m: MovieFile, dir: string, config: AppConfig): Promise<PosterResult> {
  if (!config.tmdbApiKey) return { ok: false, reason: "no TMDB API key" }
  if (!m.tmdbId) return { ok: false, reason: "no TMDB match" }
  if (hasPoster(dir)) return { ok: true, skipped: true, reason: "poster already exists" }

  const langs = parseLanguages(config.posterLanguages)
  const data = await tmdbGet(
    `/movie/${m.tmdbId}/images`,
    { include_image_language: langs.join(",") },
    config.tmdbApiKey
  )
  const chosen = pickPoster(data.posters || [], langs)
  const path: string | undefined = chosen?.file_path || m.tmdbPoster
  if (!path) return { ok: false, reason: "TMDB has no poster for this movie" }

  const res = await fetch(`${IMAGE_BASE}${path}`)
  if (!res.ok) return { ok: false, reason: `poster download failed (${res.status})` }
  const buf = new Uint8Array(await res.arrayBuffer())
  const ext = sniffImageExt(buf)
  if (!ext) return { ok: false, reason: "downloaded file is not a known image format" }

  const file = join(dir, `poster.${ext}`)
  writeFileSync(file, buf, { flag: "wx" }) // "wx": never overwrite
  return { ok: true, file }
}
