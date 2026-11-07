import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { AppConfig, MovieFile } from "../types"

/**
 * Jellyfin NFO generator and updater for movies.
 *
 * Rules:
 *  1. Overall lock disabled: always writes <lockdata>false</lockdata> (never true),
 *     allowing Jellyfin to fetch backdrops, logos, and other metadata online.
 *  2. Lock title only: when a custom title is set, writes <title>...</title> and
 *     <lockedfields>Name</lockedfields>. If no custom title is set, writes NO <lockedfields> tag.
 *     Additional fields can be locked if explicitly passed (pipe-separated, e.g. Name|Overview).
 *  3. No forced image paths: never writes <art>, <thumb>, <fanart>, or <poster> tags for
 *     backdrops or logos, so Jellyfin can fetch online artwork without being blocked by local paths.
 *  4. Existing files: reads existing NFO files, preserves all untouched tags, replaces
 *     <lockdata>true</lockdata> with false, cleans <lockedfields> to only allowed fields (default: Name),
 *     escapes XML entities in title, and saves UTF-8 encoded as movie.nfo or <videoName>.nfo.
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

/** XML-escapes a string so it is safe to embed in element content (&, <, >, ", '). */
export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
export const escapeXml = esc

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

export interface NfoOptions {
  /** Custom movie title. When set, <lockedfields>Name</lockedfields> is added to lock the title. */
  customTitle?: string
  /** Explicit locked fields (e.g. ["Name", "Overview"] or "Name|Overview"). */
  lockedFields?: string[] | string
  /** Allowed locked fields when updating existing NFO (defaults to ["Name"]). */
  allowedLockedFields?: string[]
  /** Specific filename (e.g. "movie.nfo" or "Film.nfo"). */
  filename?: string
  /** If true and no filename specified, use `${videoBase}.nfo` instead of `movie.nfo`. */
  useVideoFileName?: boolean
  /** Force writing NFO even without TMDB match. */
  force?: boolean
}

function formatLockedFields(fields?: string[] | string): string {
  if (!fields) return ""
  if (Array.isArray(fields)) {
    return fields.map((f) => f.trim()).filter(Boolean).join("|")
  }
  return String(fields).trim()
}

function insertInsideMovie(xml: string, block: string): string {
  const match = xml.match(/<movie\b[^>]*>/i)
  if (!match || match.index === undefined) {
    return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<movie>\n${block}\n</movie>\n`
  }
  const idx = match.index + match[0].length
  return xml.slice(0, idx) + `\n${block}` + xml.slice(idx)
}

/**
 * Builds the full movie.nfo XML string.
 * Pure function – no I/O.
 */
export function buildNfoXml(d: any = {}, options?: NfoOptions): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    "<movie>",
  ]

  const t = (tag: string, value: string | number, indent = 2) =>
    lines.push(" ".repeat(indent) + `<${tag}>${esc(String(value))}</${tag}>`)

  const customTitle = options?.customTitle ?? d?.customTitle
  const hasCustomTitle = typeof customTitle === "string" && customTitle.trim().length > 0
  const title = hasCustomTitle ? customTitle.trim() : (d?.title ?? "")

  if (title) t("title", title)
  if (d?.original_title || (d?.title && d.title !== title)) {
    t("originaltitle", d.original_title ?? d.title ?? "")
  }

  // 1. Gesamtsperre abschalten: immer false, nie true
  t("lockdata", "false")

  // 2. Nur den Titel sperren:
  // - Wenn ein eigener Titel gesetzt ist, schreibe <lockedfields>Name</lockedfields>
  // - Wenn kein eigener Titel gesetzt ist, schreibe kein <lockedfields>-Tag
  // - Weitere Felder nur bei ausdrücklicher Angabe (pipe-getrennt)
  let lockedFieldsVal: string | undefined
  if (options?.lockedFields !== undefined) {
    lockedFieldsVal = formatLockedFields(options.lockedFields)
  } else if (hasCustomTitle) {
    lockedFieldsVal = "Name"
  }
  if (lockedFieldsVal) {
    t("lockedfields", lockedFieldsVal)
  }

  // 3. Keine Bildpfade erzwingen: keine <art>, <thumb>, <fanart>, <poster> Tags
  if (d?.overview) t("plot", d.overview)
  if (d?.original_language) t("originallanguage", d.original_language)

  // Crew
  const crew: any[] = d?.credits?.crew ?? []
  for (const p of crew) {
    if (p.job === "Director") t("director", p.name)
  }
  const writers: string[] = []
  for (const p of crew) {
    if (p.department === "Writing" && !writers.includes(p.name)) writers.push(p.name)
  }
  for (const n of writers) t("writer", n)
  for (const n of writers) t("credits", n)

  // Trailer (YouTube only)
  for (const v of d?.videos?.results ?? []) {
    if (v.site === "YouTube" && v.type === "Trailer") {
      t("trailer", `plugin://plugin.video.youtube/play/?video_id=${v.key}`)
      break
    }
  }

  // Ratings / dates
  if (d?.vote_average) t("rating", Math.round(d.vote_average * 1000) / 1000)
  const rd: string = d?.release_date ?? ""
  if (rd) t("year", rd.slice(0, 4))

  const fsk = getFsk(d)
  if (fsk) t("mpaa", fsk)

  // IDs
  if (d?.imdb_id) t("imdbid", d.imdb_id)
  if (d?.id) t("tmdbid", d.id)

  if (rd) {
    t("premiered", rd)
    t("releasedate", rd)
  }

  // Details
  if (d?.runtime) t("runtime", d.runtime)
  if (d?.tagline) t("tagline", d.tagline)
  for (const c of d?.production_countries ?? []) t("country", c.name)
  for (const g of d?.genres ?? []) t("genre", g.name)
  for (const s of d?.production_companies ?? []) t("studio", s.name)

  // Cast (≤15)
  const cast: any[] = (d?.credits?.cast ?? []).slice(0, 15)
  for (let i = 0; i < cast.length; i++) {
    const a = cast[i]
    lines.push("  <actor>")
    lines.push(`    <name>${esc(a.name)}</name>`)
    lines.push(`    <role>${esc(a.character ?? "")}</role>`)
    lines.push(`    <type>Actor</type>`)
    lines.push(`    <sortorder>${i}</sortorder>`)
    lines.push("  </actor>")
  }

  if (d?.imdb_id) t("id", d.imdb_id)

  if (d?.belongs_to_collection) {
    lines.push("  <set>")
    lines.push(`    <name>${esc(d.belongs_to_collection.name)}</name>`)
    lines.push("  </set>")
  }

  lines.push("</movie>")
  return lines.join("\n") + "\n"
}

/**
 * Updates an existing NFO XML string:
 * - Keeps all existing tags untouched (plot, year, director, actors, etc.)
 * - Replaces <lockdata>true</lockdata> with false (or adds <lockdata>false</lockdata>)
 * - Updates <title> if a custom title is set
 * - Cleans <lockedfields> to allowed fields (defaults to "Name" if custom title is set, or removes it if none)
 * - Removes any image paths (<art>, <thumb>, <fanart>, <poster>)
 */
export function updateNfoXml(existingXml: string, options?: NfoOptions): string {
  let xml = existingXml

  // 1. Gesamtsperre abschalten: <lockdata> auf false setzen
  let hasLockdataTag = false
  if (/<lockdata\b[^>]*>[\s\S]*?<\/lockdata>|<lockdata\b[^>]*\/>/i.test(xml)) {
    xml = xml.replace(/<lockdata\b[^>]*>[\s\S]*?<\/lockdata>|<lockdata\b[^>]*\/>/i, "<lockdata>false</lockdata>")
    hasLockdataTag = true
  }

  // 2. Titel aktualisieren (falls customTitle übergeben)
  const customTitle = options?.customTitle
  const hasCustomTitle = typeof customTitle === "string" && customTitle.trim().length > 0
  let hasTitleTag = false

  if (hasCustomTitle) {
    const titleTag = `<title>${esc(customTitle.trim())}</title>`
    if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(xml)) {
      xml = xml.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, titleTag)
      hasTitleTag = true
    }
  } else {
    hasTitleTag = /<title\b[^>]*>[\s\S]*?<\/title>/i.test(xml)
  }

  // 3. Locked fields
  let hasLockedfieldsTag = false
  const allowed = options?.allowedLockedFields ?? ["Name"]

  if (options?.lockedFields !== undefined) {
    const formatted = formatLockedFields(options.lockedFields)
    if (formatted) {
      const tag = `<lockedfields>${formatted}</lockedfields>`
      if (/<lockedfields\b[^>]*>[\s\S]*?<\/lockedfields>/i.test(xml)) {
        xml = xml.replace(/<lockedfields\b[^>]*>[\s\S]*?<\/lockedfields>/i, tag)
        hasLockedfieldsTag = true
      }
    } else {
      xml = xml.replace(/\s*<lockedfields\b[^>]*>[\s\S]*?<\/lockedfields>|\s*<lockedfields\b[^>]*\/>/gi, "")
      hasLockedfieldsTag = true // handled (removed)
    }
  } else if (hasCustomTitle) {
    // Custom title set: preserve only allowed locked fields, ensure "Name" is included
    if (/<lockedfields\b[^>]*>([\s\S]*?)<\/lockedfields>/i.test(xml)) {
      const match = xml.match(/<lockedfields\b[^>]*>([\s\S]*?)<\/lockedfields>/i)!
      const existingFields = match[1].split("|").map((s) => s.trim()).filter(Boolean)
      const filtered = existingFields.filter((f) => allowed.includes(f))
      if (allowed.includes("Name") && !filtered.includes("Name")) {
        filtered.unshift("Name")
      }
      const finalFields = filtered.length > 0 ? filtered.join("|") : "Name"
      xml = xml.replace(/<lockedfields\b[^>]*>[\s\S]*?<\/lockedfields>/i, `<lockedfields>${finalFields}</lockedfields>`)
      hasLockedfieldsTag = true
    }
  } else {
    // No custom title and no explicit locked fields: remove <lockedfields> tag
    xml = xml.replace(/\s*<lockedfields\b[^>]*>[\s\S]*?<\/lockedfields>|\s*<lockedfields\b[^>]*\/>/gi, "")
    hasLockedfieldsTag = true // handled (removed)
  }

  // 4. Keine Bildpfade erzwingen: <art>, <thumb>, <fanart>, <poster> entfernen
  xml = xml
    .replace(/\s*<art\b[^>]*>[\s\S]*?<\/art>|\s*<art\b[^>]*\/>/gi, "")
    .replace(/\s*<fanart\b[^>]*>[\s\S]*?<\/fanart>|\s*<fanart\b[^>]*\/>/gi, "")
    .replace(/\s*<thumb\b[^>]*>[\s\S]*?<\/thumb>|\s*<thumb\b[^>]*\/>/gi, "")
    .replace(/\s*<poster\b[^>]*>[\s\S]*?<\/poster>|\s*<poster\b[^>]*\/>/gi, "")

  // 5. Fehlende Tags nach <movie> einfügen
  const toInsert: string[] = []
  if (hasCustomTitle && !hasTitleTag) {
    toInsert.push(`  <title>${esc(customTitle!.trim())}</title>`)
  }
  if (!hasLockdataTag) {
    toInsert.push("  <lockdata>false</lockdata>")
  }
  if (!hasLockedfieldsTag) {
    if (options?.lockedFields !== undefined) {
      const formatted = formatLockedFields(options.lockedFields)
      if (formatted) toInsert.push(`  <lockedfields>${formatted}</lockedfields>`)
    } else if (hasCustomTitle) {
      toInsert.push("  <lockedfields>Name</lockedfields>")
    }
  }

  if (toInsert.length > 0) {
    xml = insertInsideMovie(xml, toInsert.join("\n"))
  }

  if (!xml.trim().startsWith("<?xml")) {
    xml = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n' + xml.trimStart()
  }
  if (!xml.endsWith("\n")) {
    xml += "\n"
  }

  return xml
}

export function resolveNfoPath(dir: string, m?: Partial<MovieFile>, options?: NfoOptions): string {
  if (options?.filename) {
    return join(dir, options.filename)
  }
  const defaultPath = join(dir, "movie.nfo")
  if (existsSync(defaultPath)) {
    return defaultPath
  }
  if (existsSync(dir)) {
    try {
      const files = readdirSync(dir)
      const existingNfo = files.find((f) => f.toLowerCase().endsWith(".nfo"))
      if (existingNfo) {
        return join(dir, existingNfo)
      }
    } catch {}
  }
  if (options?.useVideoFileName && m?.originalName) {
    const videoBase = m.originalName.replace(/\.[^.]+$/, "")
    return join(dir, `${videoBase}.nfo`)
  }
  return defaultPath
}

export interface NfoResult {
  ok: boolean
  skipped?: boolean
  updated?: boolean
  file?: string
  reason?: string
}

/**
 * Writes or updates a movie.nfo (or <videoName>.nfo) in `dir`.
 * - If an NFO file already exists: reads, cleans, and updates it (lockdata=false, title, lockedfields=Name).
 * - If no NFO file exists: fetches TMDB metadata and generates a new NFO.
 * - Errors never throw; returns NfoResult.
 */
export async function writeNfo(
  m: MovieFile,
  dir: string,
  config: AppConfig,
  options?: NfoOptions
): Promise<NfoResult> {
  const nfoPath = resolveNfoPath(dir, m, options)
  const customTitle = options?.customTitle ?? m.resolvedTitle

  // 4. Bestehende NFO-Dateien einlesen und aktualisieren
  if (existsSync(nfoPath)) {
    try {
      const existingXml = readFileSync(nfoPath, "utf-8")
      const updatedXml = updateNfoXml(existingXml, { ...options, customTitle })
      writeFileSync(nfoPath, updatedXml, { encoding: "utf-8" })
      return { ok: true, file: nfoPath, updated: true }
    } catch (err) {
      return {
        ok: false,
        reason: `failed to update existing NFO: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // Neue Datei anlegen
  if (!config.tmdbApiKey && !options?.force) {
    return { ok: false, reason: "no TMDB API key" }
  }
  if (!m.tmdbId && !options?.force) {
    return { ok: false, reason: "no TMDB match for this movie" }
  }

  try {
    let data: any = {}
    if (config.tmdbApiKey && m.tmdbId) {
      data = await tmdbGetFull(m.tmdbId, config.tmdbApiKey)
    }

    const xml = buildNfoXml(data, { ...options, customTitle })
    writeFileSync(nfoPath, xml, { encoding: "utf-8" })
    return { ok: true, file: nfoPath }
  } catch (err) {
    return {
      ok: false,
      reason: `failed to write NFO: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
