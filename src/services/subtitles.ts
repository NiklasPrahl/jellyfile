import { writeFileSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"

const BASE = "https://api.opensubtitles.com/api/v1"

export async function extractSubtitles(
  mkvPath: string,
  outputDir: string,
  baseName: string,
  mkvmergePath: string,
  mkvextractPath: string,
  languages: string[] = ["en", "de"]
): Promise<{ lang: string; ok: boolean; source: "mkv" | "opensubs" }[]> {
  const results: { lang: string; ok: boolean; source: "mkv" | "opensubs" }[] = []

  // 1. Identify tracks
  let idProc;
  try {
    idProc = spawnSync(mkvmergePath, ["--identify", "--identification-format", "json", mkvPath])
  } catch (err) {
    throw new Error(`mkvmerge not found or failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  
  if (idProc.status !== 0) {
    if (idProc.error) throw new Error(`mkvmerge error: ${idProc.error.message}`)
    return [] // Possibly just an invalid MKV or no tracks
  }

  const info = JSON.parse(idProc.stdout.toString())
  const tracks = info.tracks || []

  const extractMap: Record<string, string> = {
    "eng": "en", "ger": "de", "deu": "de", "en": "en", "de": "de"
  }

  const toExtract: { id: number; lang: string; outPath: string }[] = []

  for (const lang of languages) {
    const track = tracks.find((t: any) => 
      t.type === "subtitles" && 
      (extractMap[t.properties?.language] === lang || t.properties?.language === lang) &&
      (t.codec === "SubRip/SRT" || t.codec === "S_TEXT/UTF8")
    )

    if (track) {
      const outPath = `${outputDir}/${baseName}.${lang}.srt`
      toExtract.push({ id: track.id, lang, outPath })
    }
  }

  if (toExtract.length > 0) {
    const args = ["tracks", mkvPath]
    for (const item of toExtract) {
      args.push(`${item.id}:${item.outPath}`)
    }
    let extProc;
    try {
      extProc = spawnSync(mkvextractPath, args)
    } catch (err) {
      throw new Error(`mkvextract not found or failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    
    if (extProc.status === 0) {
      for (const item of toExtract) {
        if (existsSync(item.outPath)) {
          results.push({ lang: item.lang, ok: true, source: "mkv" })
        }
      }
    } else {
       if (extProc.error) throw new Error(`mkvextract error: ${extProc.error.message}`)
    }
  }

  return results
}

export async function downloadSubtitles(
  title: string,
  year: string,
  outputDir: string,
  baseName: string,
  apiKey: string,
  username: string,
  password: string,
  languages: string[] = ["en", "de"],
  alreadyFound: string[] = []
): Promise<{ lang: string; ok: boolean; source: "mkv" | "opensubs"; error?: string }[]> {
  const headers: Record<string, string> = {
    "Api-Key": apiKey,
    "Content-Type": "application/json",
    "User-Agent": "PlexIngest v1.0",
  }

  let token = ""
  if (username && password) {
    try {
      const r = await fetch(`${BASE}/login`, {
        method: "POST", headers,
        body: JSON.stringify({ username, password }),
      })
      if (r.ok) token = ((await r.json()) as any).token || ""
    } catch {}
  }

  const results: { lang: string; ok: boolean; source: "mkv" | "opensubs"; error?: string }[] = []

  for (const lang of languages) {
    if (alreadyFound.includes(lang)) continue

    const outPath = `${outputDir}/${baseName}.${lang}.srt`
    try {
      const params = new URLSearchParams({
        query: title, year, languages: lang,
        order_by: "download_count", order_direction: "desc",
      })
      const sr = await fetch(`${BASE}/subtitles?${params}`, { headers })
      if (!sr.ok) throw new Error(`Search ${sr.status}`)

      const subs = ((await sr.json()) as any).data || []
      if (!subs.length) { results.push({ lang, ok: false, source: "opensubs", error: "Not found" }); continue }

      const fileId = subs[0].attributes?.files?.[0]?.file_id
      if (!fileId) { results.push({ lang, ok: false, source: "opensubs", error: "No file" }); continue }

      const dlH = { ...headers }
      if (token) dlH["Authorization"] = `Bearer ${token}`

      const dr = await fetch(`${BASE}/download`, {
        method: "POST", headers: dlH,
        body: JSON.stringify({ file_id: fileId }),
      })
      if (!dr.ok) throw new Error(`Download req ${dr.status}`)

      const link = ((await dr.json()) as any).link
      if (!link) throw new Error("No download link")

      const fr = await fetch(link)
      if (!fr.ok) throw new Error(`File download ${fr.status}`)

      writeFileSync(outPath, await fr.text(), "utf-8")
      results.push({ lang, ok: true, source: "opensubs" })
    } catch (err) {
      results.push({ lang, ok: false, source: "opensubs", error: err instanceof Error ? err.message : String(err) })
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  return results
}
