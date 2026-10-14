import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AppConfig, MovieFile } from "../types"

/**
 * Jellyfin NFO generator for movies.
 *
 * The XML structure follows the Jellyfin / Kodi movie.nfo specification and
 * mirrors what the reference script tmdb_nfo.py produces:
 *   plot, lockdata, title, originaltitle, originallanguage,
 *   director, writer, credits, trailer, rating, year, mpaa (FSK),
 *   imdbid, tmdbid, premiered, releasedate, runtime, tagline,
 *   country, genre, studio, actor (≤15), id, set
 */

const API = "https://api.themoviedb.org/3"

/** TMDB v4 read-access token is a JWT; v3 keys are short hex strings. */
function isBearer(key: string): boolean {
  return key.startsWith("eyJ")
}

async function tmdbGetFull(tmdbId: number, apiKey: string): Promise<any> {
  const url = new URL(`${API}/movie/${tmdbId}`)
  url.searchParams.set("language", "de-DE")
  url.searchParams.set("append_to_response", "credits,release_dates,videos")
  const headers: Record<string, string> = { Accept: "application/json" }
  if (isBearer(apiKey)) {
    headers["Authorization"] = `Bearer ${apiKey}`
  } else {
    url.searchParams.set("api_key", apiKey)
  }
  const res = await fetch(url.toString(), { headers })
  if (!res.ok) throw new Error(`TMDB NFO fetch ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

/** XML-escapes a string so it is safe to embed in element content. */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/** Returns the German FSK rating string (e.g. "FSK-12") from TMDB release_dates, or "". */
function getFsk(d: any): string {
  for (const country of d?.release_dates?.results ?? []) {
    if (country.iso_3166_1 === "DE") {
      for (const r of country.release_dates ?? []) {
        if (r.certification) return `FSK-${r.certification}`
      }
    }
  }
  return ""
}

/**
 * Builds the full movie.nfo XML string from a TMDB detail response.
 * Pure function – no I/O.
 */
export function buildNfoXml(d: any): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    "<movie>",
  ]

  const t = (tag: string, value: string | number, indent = 2) =>
    lines.push(" ".repeat(indent) + `<${tag}>${esc(String(value))}</${tag}>`)

  // ── Core metadata ──────────────────────────────────────────────────────────
  if (d.overview) t("plot", d.overview)
  t("lockdata", "true")
  t("title", d.title ?? "")
  t("originaltitle", d.original_title ?? d.title ?? "")
  t("originallanguage", d.original_language ?? "")

  // ── Crew ──────────────────────────────────────────────────────────────────
  const crew: any[] = d.credits?.crew ?? []
  for (const p of crew) {
    if (p.job === "Director") t("director", p.name)
  }
  const writers: string[] = []
  for (const p of crew) {
    if (p.department === "Writing" && !writers.includes(p.name)) writers.push(p.name)
  }
  for (const n of writers) t("writer", n)
  for (const n of writers) t("credits", n)

  // ── Trailer (YouTube only) ─────────────────────────────────────────────────
  for (const v of d.videos?.results ?? []) {
    if (v.site === "YouTube" && v.type === "Trailer") {
      t("trailer", `plugin://plugin.video.youtube/play/?video_id=${v.key}`)
      break // one trailer is enough
    }
  }

  // ── Ratings / dates ────────────────────────────────────────────────────────
  if (d.vote_average) t("rating", Math.round(d.vote_average * 1000) / 1000)
  const rd: string = d.release_date ?? ""
  if (rd) t("year", rd.slice(0, 4))

  const fsk = getFsk(d)
  if (fsk) t("mpaa", fsk)

  // ── IDs ───────────────────────────────────────────────────────────────────
  if (d.imdb_id) t("imdbid", d.imdb_id)
  t("tmdbid", d.id)

  if (rd) {
    t("premiered", rd)
    t("releasedate", rd)
  }

  // ── Details ───────────────────────────────────────────────────────────────
  if (d.runtime) t("runtime", d.runtime)
  if (d.tagline) t("tagline", d.tagline)
  for (const c of d.production_countries ?? []) t("country", c.name)
  for (const g of d.genres ?? []) t("genre", g.name)
  for (const s of d.production_companies ?? []) t("studio", s.name)

  // ── Cast (up to 15) ───────────────────────────────────────────────────────
  const cast: any[] = (d.credits?.cast ?? []).slice(0, 15)
  for (let i = 0; i < cast.length; i++) {
    const a = cast[i]
    lines.push("  <actor>")
    lines.push(`    <name>${esc(a.name)}</name>`)
    lines.push(`    <role>${esc(a.character ?? "")}</role>`)
    lines.push(`    <type>Actor</type>`)
    lines.push(`    <sortorder>${i}</sortorder>`)
    lines.push("  </actor>")
  }

  // ── Legacy ID + collection ─────────────────────────────────────────────────
  if (d.imdb_id) t("id", d.imdb_id)

  if (d.belongs_to_collection) {
    lines.push("  <set>")
    lines.push(`    <name>${esc(d.belongs_to_collection.name)}</name>`)
    lines.push("  </set>")
  }

  lines.push("</movie>")
  return lines.join("\n") + "\n"
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface NfoResult {
  ok: boolean
  skipped?: boolean
  file?: string
  reason?: string
}

/**
 * Fetches full TMDB metadata and writes movie.nfo into `dir`.
 * - Requires a TMDB match on the MovieFile (m.tmdbId must be set).
 * - Never overwrites an existing movie.nfo.
 * - Returns { ok: false } with a reason on any failure; never throws.
 */
export async function writeNfo(m: MovieFile, dir: string, config: AppConfig): Promise<NfoResult> {
  if (!config.tmdbApiKey) return { ok: false, reason: "no TMDB API key" }
  if (!m.tmdbId)          return { ok: false, reason: "no TMDB match for this movie" }

  const nfoPath = join(dir, "movie.nfo")
  if (existsSync(nfoPath)) return { ok: true, skipped: true, reason: "movie.nfo already exists" }

  const data = await tmdbGetFull(m.tmdbId, config.tmdbApiKey)
  const xml = buildNfoXml(data)
  writeFileSync(nfoPath, xml, { encoding: "utf-8" })
  return { ok: true, file: nfoPath }
}
