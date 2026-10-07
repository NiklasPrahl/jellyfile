/**
 * Offline self-test (no network, no HandBrake/mkvtoolnix needed). All HTTP calls are mocked.
 *   bun run scripts/selftest.ts
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AppConfig, MovieFile } from "../src/types"
import { sanitizeTitle, folderName, fileName, fileBase, formatTag, startsWithFolder } from "../src/services/naming"
import { pickBest, pickPoster, matchMovie, matchTmdb, downloadPoster, sniffImageExt, hasPoster } from "../src/services/artwork"
import { organizeMovie } from "../src/services/organizer"
import { duplicateSubtitles } from "../src/services/subtitles"
import { runPipeline } from "../src/services/pipeline"
import { resolveTitles } from "../src/services/gemini"

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

const baseConfig = (over: Partial<AppConfig> = {}): AppConfig => ({
  llmProvider: "gemini", geminiApiKey: "g", groqApiKey: "", ollamaBaseUrl: "", ollamaModel: "",
  opensubsApiKey: "", opensubsUsername: "", opensubsPassword: "",
  tmdbApiKey: "", posterLanguages: "de,en,null", tmdbIdInFolder: "off",
  handbrakePresetDVD: "", handbrakePresetBluRay: "", handbrakePreset4K: "",
  handbrakePath: "HandBrakeCLI-does-not-exist", mkvmergePath: "mkvmerge-does-not-exist", mkvextractPath: "x",
  sourceDir: "", outputDir: "", folderPattern: "{title} ({year})", filePattern: "{title} ({year}) - [{format}]",
  ...over,
})
const movie = (over: Partial<MovieFile> = {}): MovieFile => ({
  id: "id1", originalPath: "/in/a.mkv", originalName: "a.mkv", sizeBytes: 1, sizeHuman: "1 MB",
  detectedFormat: "Blu-ray", confirmedFormat: "Blu-ray", resolvedTitle: "Der Pate", resolvedYear: "1972",
  keepMkv: true, conversionMode: "keep_both", status: "ready", ...over,
})

const tests: { name: string; fn: () => void | Promise<void> }[] = []
const test = (name: string, fn: () => void | Promise<void>) => { tests.push({ name, fn }) }

// ---- mock TMDB / Gemini ----------------------------------------------------
const calls: string[] = []
const mockFetch = async (input: any, init?: any) => {
  const url = String(input)
  calls.push(url)
  const json = (data: any, status = 200) => ({
    ok: status < 400, status, headers: { get: () => null },
    json: async () => data, text: async () => JSON.stringify(data),
  })
  if (url.includes("generativelanguage.googleapis.com")) {
    const text = JSON.stringify([
      { original: "a.mkv", title: "Star Wars: Episode IV", year: "1977" },
      { original: "b.mkv", title: "Was?/Wer*", year: "2001" },
    ])
    return json({ candidates: [{ content: { parts: [{ text }] } }] })
  }
  if (url.includes("/search/movie")) {
    const q = new URL(url).searchParams.get("query")
    if (q === "Der Pate") return json({ results: [
      { id: 999, title: "Der Pate 3", original_title: "The Godfather Part III", release_date: "1990-12-20", popularity: 80 },
      { id: 238, title: "Der Pate", original_title: "The Godfather", release_date: "1972-03-14", popularity: 90, poster_path: "/fallback.jpg" },
    ] })
    if (q === "Unbekannt") return json({ results: [] })
    return json({ results: [] })
  }
  if (url.includes("/movie/238/images")) return json({ posters: [
    { file_path: "/en_low.jpg", iso_639_1: "en", vote_average: 3, vote_count: 5, width: 1000 },
    { file_path: "/de_low.jpg", iso_639_1: "de", vote_average: 5.1, vote_count: 9, width: 2000 },
    { file_path: "/de_best.png", iso_639_1: "de", vote_average: 5.5, vote_count: 12, width: 2000 },
    { file_path: "/none.jpg", iso_639_1: null, vote_average: 9, vote_count: 99, width: 2000 },
  ] })
  if (url.includes("/movie/404/images")) return json({ posters: [] })
  if (url.startsWith("https://image.tmdb.org/t/p/original/de_best.png"))
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => PNG.buffer }
  if (url.startsWith("https://image.tmdb.org/t/p/original/fallback.jpg"))
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => JPEG.buffer }
  return json({ error: "not mocked: " + url }, 404)
}
;(globalThis as any).fetch = mockFetch

const tmp = mkdtempSync(join(tmpdir(), "jellyfile-test-"))
process.chdir(tmp) // pipeline_error.log goes here

// ---- naming -----------------------------------------------------------------
test("sanitizeTitle: colon, illegal chars, spaces, trailing dot", () => {
  assert.equal(sanitizeTitle("Star Wars: Episode IV"), "Star Wars - Episode IV")
  assert.equal(sanitizeTitle('Was?/Wer*  <ist> "das"|'), "WasWer ist das")
  assert.equal(sanitizeTitle("Abc... "), "Abc")
  assert.equal(sanitizeTitle("Schindler's Liste"), "Schindler's Liste")
})
test("formatTag: MP4 gets -MP4, 4K spelled Blu-ray-4K", () => {
  assert.equal(formatTag("Blu-ray-4K", "mkv"), "Blu-ray-4K")
  assert.equal(formatTag("Blu-ray-4K", "mp4"), "Blu-ray-4K-MP4")
  assert.equal(formatTag("DVD", ".MP4"), "DVD-MP4")
})
test("names without TMDB id", () => {
  const m = movie(); const c = baseConfig()
  assert.equal(folderName(m, c), "Der Pate (1972)")
  assert.equal(fileName(m, "mkv", c), "Der Pate (1972) - [Blu-ray].mkv")
  assert.equal(fileName(m, "mp4", c), "Der Pate (1972) - [Blu-ray-MP4].mp4")
  assert.ok(startsWithFolder(m, c))
})
test("names with 4K and missing year", () => {
  const m = movie({ confirmedFormat: "Blu-ray-4K", resolvedYear: "" }); const c = baseConfig()
  assert.equal(folderName(m, c), "Der Pate")
  assert.equal(fileName(m, "mp4", c), "Der Pate - [Blu-ray-4K-MP4].mp4")
})
test("TMDB id opt-in: folder and files carry {tmdb-ID}", () => {
  const m = movie({ tmdbId: 238 }); const c = baseConfig({ tmdbIdInFolder: "on" })
  assert.equal(folderName(m, c), "Der Pate (1972) {tmdb-238}")
  assert.equal(fileName(m, "mkv", c), "Der Pate (1972) {tmdb-238} - [Blu-ray].mkv")
  assert.ok(startsWithFolder(m, c))
  assert.equal(folderName(movie(), c), "Der Pate (1972)") // no id known -> no suffix
  assert.equal(folderName(m, baseConfig()), "Der Pate (1972)") // off -> no suffix
})
test("explicit {tmdb} placeholder in patterns", () => {
  const m = movie({ tmdbId: 5 }); const c = baseConfig({ folderPattern: "{title} ({year}) {tmdb}", filePattern: "{title} ({year}) {tmdb} - [{format}]" })
  assert.equal(folderName(m, c), "Der Pate (1972) {tmdb-5}")
  assert.equal(fileBase(movie(), "mkv", c), "Der Pate (1972) - [Blu-ray]")
})
test("NFC normalization (NFD input gives identical folder/file names)", () => {
  const nfd = "Gl\u0075\u0308cksstern"
  const m = movie({ resolvedTitle: nfd }); const c = baseConfig()
  assert.ok(startsWithFolder(m, c))
  assert.equal(folderName(m, c).startsWith("Gl\u00fccksstern"), true)
})

// ---- artwork ------------------------------------------------------------------
test("pickBest: title+year, rejects wrong year / no title match", () => {
  const cands: any[] = [
    { id: 1, title: "Der Pate 3", original_title: "The Godfather Part III", release_date: "1990-01-01", popularity: 50 },
    { id: 2, title: "Der Pate", original_title: "The Godfather", release_date: "1972-03-14", popularity: 90 },
  ]
  assert.equal(pickBest(cands, "Der Pate", "1972")?.id, 2)
  assert.equal(pickBest(cands, "Der Pate", "1990")?.id, 1) // contains-match with exact year
  assert.equal(pickBest(cands, "Der Pate", "2010"), null)
  assert.equal(pickBest(cands, "Etwas ganz anderes", "1972"), null)
})
test("pickPoster: language order de > en > null, best rating inside language", () => {
  const posters = [
    { file_path: "/en", iso_639_1: "en", vote_average: 9 },
    { file_path: "/de1", iso_639_1: "de", vote_average: 1 },
    { file_path: "/de2", iso_639_1: "de", vote_average: 2 },
    { file_path: "/nul", iso_639_1: null, vote_average: 10 },
  ]
  assert.equal(pickPoster(posters, ["de", "en", "null"]).file_path, "/de2")
  assert.equal(pickPoster(posters, ["null", "de"]).file_path, "/nul")
  assert.equal(pickPoster([posters[0]], ["de"]).file_path, "/en") // fallback: anything
  assert.equal(pickPoster([], ["de"]), null)
})
test("sniffImageExt", () => {
  assert.equal(sniffImageExt(JPEG), "jpg"); assert.equal(sniffImageExt(PNG), "png")
  assert.equal(sniffImageExt(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])), null)
})
test("matchMovie sets id/title/year; unknown title stays unmatched", async () => {
  const c = baseConfig({ tmdbApiKey: "abc" })
  const m = movie(); assert.equal(await matchMovie(m, c), true)
  assert.equal(m.tmdbId, 238); assert.equal(m.tmdbYear, "1972"); assert.equal(m.tmdbChecked, true)
  const u = movie({ resolvedTitle: "Unbekannt" }); assert.equal(await matchMovie(u, c), false)
  assert.equal(u.tmdbId, undefined); assert.equal(u.tmdbChecked, true)
  assert.ok(calls.some((u) => u.includes("api_key=abc") && u.includes("language=de-DE")))
})
test("bearer token (eyJ...) is sent as header, not as query", async () => {
  const seen: any[] = []
  const prev = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (u: any, init: any) => { seen.push({ u: String(u), init }); return prev(u, init) }
  await matchMovie(movie(), baseConfig({ tmdbApiKey: "eyJhbGciOi.fake.token" }))
  ;(globalThis as any).fetch = prev
  assert.equal(seen[0].init.headers["Authorization"], "Bearer eyJhbGciOi.fake.token")
  assert.ok(!seen[0].u.includes("api_key="))
})
test("matchTmdb: progress callback + skips already checked", async () => {
  const c = baseConfig({ tmdbApiKey: "k" })
  const list = [movie(), movie({ resolvedTitle: "Unbekannt" }), movie({ tmdbChecked: true })]
  let last = 0
  await matchTmdb(list, c, (i) => { last = i })
  assert.equal(last, 2); assert.equal(list[0].tmdbId, 238)
})
test("downloadPoster: best German poster, saved unchanged as poster.png, never overwritten", async () => {
  const c = baseConfig({ tmdbApiKey: "k" })
  const dir = mkdtempSync(join(tmp, "m-")); const m = movie({ tmdbId: 238 })
  const r1 = await downloadPoster(m, dir, c)
  assert.equal(r1.ok, true); assert.ok(r1.file!.endsWith("poster.png"))
  assert.deepEqual(new Uint8Array(readFileSync(r1.file!)), PNG)
  const r2 = await downloadPoster(m, dir, c)
  assert.equal(r2.skipped, true) // already has poster
  assert.ok(hasPoster(dir))
  const dir2 = mkdtempSync(join(tmp, "m-")); writeFileSync(join(dir2, "poster.jpeg"), "mine")
  assert.equal((await downloadPoster(m, dir2, c)).skipped, true)
  assert.equal(readFileSync(join(dir2, "poster.jpeg"), "utf-8"), "mine")
  assert.equal((await downloadPoster(movie(), dir2, c)).ok, false) // no TMDB id
  const dir3 = mkdtempSync(join(tmp, "m-"))
  assert.equal((await downloadPoster(movie({ tmdbId: 404 }), dir3, c)).ok, false) // no posters, no fallback
})
test("downloadPoster: falls back to search poster_path", async () => {
  const prev = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (u: any, i: any) =>
    String(u).includes("/images") ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ posters: [] }) } : prev(u, i)
  const dir = mkdtempSync(join(tmp, "m-"))
  const r = await downloadPoster(movie({ tmdbId: 238, tmdbPoster: "/fallback.jpg" }), dir, baseConfig({ tmdbApiKey: "k" }))
  ;(globalThis as any).fetch = prev
  assert.ok(r.ok && r.file!.endsWith("poster.jpg"))
})

// ---- subtitles / organizer ----------------------------------------------------
test("duplicateSubtitles copies per language, never overwrites", () => {
  const d = mkdtempSync(join(tmp, "s-"))
  writeFileSync(join(d, "F - [Blu-ray].de.srt"), "de"); writeFileSync(join(d, "F - [Blu-ray].en.srt"), "en")
  writeFileSync(join(d, "F - [Blu-ray-MP4].en.srt"), "keep")
  assert.deepEqual(duplicateSubtitles(d, "F - [Blu-ray]", "F - [Blu-ray-MP4]"), ["de"])
  assert.equal(readFileSync(join(d, "F - [Blu-ray-MP4].en.srt"), "utf-8"), "keep")
})
test("organizeMovie: MKV + converted MP4 get matching names", () => {
  const out = mkdtempSync(join(tmp, "o-")); const src = mkdtempSync(join(tmp, "i-"))
  writeFileSync(join(src, "a.mkv"), "mkv"); writeFileSync(join(out, "conv.mp4"), "mp4")
  const m = movie({ originalPath: join(src, "a.mkv"), tmdbId: 238 })
  organizeMovie(m, out, baseConfig({ tmdbIdInFolder: "on" }), join(out, "conv.mp4"))
  assert.deepEqual(readdirSync(join(out, "Der Pate (1972) {tmdb-238}")).sort(),
    ["Der Pate (1972) {tmdb-238} - [Blu-ray-MP4].mp4", "Der Pate (1972) {tmdb-238} - [Blu-ray].mkv"])
})

// ---- pipeline (no HandBrake, no mkvtoolnix): MP4 source ------------------------
test("pipeline: MP4 source -> folder, -MP4 tag, poster", async () => {
  const out = mkdtempSync(join(tmp, "p-")); const src = mkdtempSync(join(tmp, "i-"))
  writeFileSync(join(src, "a.mp4"), "mp4")
  const m = movie({ originalPath: join(src, "a.mp4"), originalName: "a.mp4", conversionMode: "mkv_only" })
  await runPipeline([m], baseConfig({ outputDir: out, tmdbApiKey: "k", tmdbIdInFolder: "on" }), () => {})
  assert.equal(m.status, "done")
  const files = readdirSync(join(out, "Der Pate (1972) {tmdb-238}")).sort()
  assert.deepEqual(files, ["Der Pate (1972) {tmdb-238} - [Blu-ray-MP4].mp4", "poster.png"])
})
test("pipeline: MKV source (mkvmerge missing) still organizes; TMDB failure never fails the movie", async () => {
  const out = mkdtempSync(join(tmp, "p-")); const src = mkdtempSync(join(tmp, "i-"))
  writeFileSync(join(src, "a.mkv"), "mkv")
  const m = movie({ originalPath: join(src, "a.mkv"), conversionMode: "mkv_only", resolvedTitle: "Unbekannt", resolvedYear: "2000" })
  await runPipeline([m], baseConfig({ outputDir: out, tmdbApiKey: "k" }), () => {})
  assert.equal(m.status, "done")
  assert.deepEqual(readdirSync(join(out, "Unbekannt (2000)")), ["Unbekannt (2000) - [Blu-ray].mkv"])
  assert.ok(existsSync(join(tmp, "pipeline_error.log")))
})

// ---- title resolution -----------------------------------------------------------
test("resolveTitles: LLM titles are sanitized for Jellyfin", async () => {
  const list = [movie({ originalName: "a.mkv", status: "pending" }), movie({ id: "2", originalName: "b.mkv", status: "pending" })]
  await resolveTitles(list, baseConfig(), () => {})
  assert.equal(list[0].resolvedTitle, "Star Wars - Episode IV")
  assert.equal(list[1].resolvedTitle, "WasWer")
  assert.equal(list[0].status, "title-resolved")
})

async function main() {
  let passed = 0
  for (const t of tests) {
    try {
      await t.fn(); passed++; console.log("ok  ", t.name)
    } catch (e) {
      console.error("FAIL", t.name); console.error(e); process.exit(1)
    }
  }
  console.log(`\nAll ${passed} checks passed.`)
}
main()
