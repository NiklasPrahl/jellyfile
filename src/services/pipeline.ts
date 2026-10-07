import { mkdirSync, appendFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import type { MovieFile, AppConfig } from "../types"
import { convertToMp4 } from "./handbrake"
import { downloadSubtitles, extractSubtitles, duplicateSubtitles } from "./subtitles"
import { organizeMovie } from "./organizer"
import { folderName, fileBase } from "./naming"
import { downloadPoster, matchMovie } from "./artwork"

export function logError(error: any, context: string) {
  const logPath = join(process.cwd(), "pipeline_error.log")
  const timestamp = new Date().toISOString()
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error ? error.stack : ""
  const entry = `[${timestamp}] [${context}] ERROR: ${message}\n${stack}\n${"-".repeat(80)}\n`
  appendFileSync(logPath, entry, "utf-8")
}

export async function runPipeline(
  movies: MovieFile[],
  config: AppConfig,
  onUpdate: (movies: MovieFile[], idx: number, pct: number) => void
): Promise<void> {
  const tmpDir = join(config.outputDir, ".tmp")
  try {
    mkdirSync(tmpDir, { recursive: true })
  } catch (e) {
    logError(e, "Setup TMP Directory")
  }

  for (let i = 0; i < movies.length; i++) {
    const m = movies[i]
    if (m.status === "error" || m.status === "done") continue

    try {
      // 0. TMDB match (only if not done yet, e.g. title/year was edited in the review step).
      // The TMDB ID may become part of the folder/file names, so this must happen before naming.
      if (config.tmdbApiKey && !m.tmdbChecked) {
        try {
          await matchMovie(m, config)
        } catch (e) {
          m.tmdbChecked = true
          logError(e, `TMDB match: ${m.originalName}`)
        }
      }

      const isMkvSource = m.originalPath.toLowerCase().endsWith(".mkv")
      const isMp4Source = m.originalPath.toLowerCase().endsWith(".mp4")
      const movieDir = join(config.outputDir, folderName(m, config))
      const mkvBase = fileBase(m, "mkv", config)
      const mp4Base = fileBase(m, "mp4", config)

      // 1. Convert MKV -> MP4 (if needed)
      let mp4Path: string | undefined
      if (m.conversionMode !== "mkv_only") {
        m.status = "converting"
        onUpdate(movies, i, 0)

        const preset = 
          m.confirmedFormat === "Blu-ray-4K" ? config.handbrakePreset4K :
          m.confirmedFormat === "Blu-ray" ? config.handbrakePresetBluRay :
          config.handbrakePresetDVD

        const mp4Tmp = join(tmpDir, `${m.id}.mp4`)
        const res = await convertToMp4(m.originalPath, mp4Tmp, preset, config.handbrakePath, (pct) => {
          onUpdate(movies, i, pct)
        })

        if (!res.success) {
          m.status = "error"
          m.error = res.error
          logError(res.error, `HandBrake: ${m.originalName}`)
          onUpdate(movies, i, 0)
          continue
        }
        mp4Path = mp4Tmp
      }

      // Which video files will exist in the movie folder?
      const hasMkvOut = isMkvSource && m.conversionMode !== "mp4_only"
      const hasMp4Out = !!mp4Path || isMp4Source
      // Subtitles are written for the first video file; a copy is made for the second one.
      const subBase = hasMkvOut ? mkvBase : mp4Base

      // 2. Subtitles
      m.status = "subtitles"
      onUpdate(movies, i, 0)

      let foundLangs: string[] = []

      if (isMkvSource) {
        try {
          // Folder is ONLY created here if we actually start subtitle extraction
          mkdirSync(movieDir, { recursive: true })
          const extRes = await extractSubtitles(
            m.originalPath, movieDir, subBase, 
            config.mkvmergePath, config.mkvextractPath, ["en", "de"]
          )
          foundLangs = extRes.filter(r => r.ok).map(r => r.lang)
        } catch (e) {
          logError(e, `Subtitle Extraction: ${m.originalName}`)
        }
      }

      if (config.opensubsApiKey && foundLangs.length < 2) {
        try {
          mkdirSync(movieDir, { recursive: true })
          await downloadSubtitles(
            m.resolvedTitle, m.resolvedYear, movieDir, subBase,
            config.opensubsApiKey, config.opensubsUsername, config.opensubsPassword,
            ["en", "de"], foundLangs
          )
        } catch (e) {
          logError(e, `OpenSubtitles: ${m.originalName}`)
        }
      }

      // MKV and MP4 have different tags, so the subtitles must exist under both names
      if (hasMkvOut && hasMp4Out) {
        try {
          duplicateSubtitles(movieDir, mkvBase, mp4Base, ["en", "de"])
        } catch (e) {
          logError(e, `Subtitle copy: ${m.originalName}`)
        }
      }

      // 3. Organize files into the Jellyfin structure
      m.status = "organizing"
      onUpdate(movies, i, 0)

      // Ensure folder exists before moving/copying
      mkdirSync(movieDir, { recursive: true })
      organizeMovie(m, config.outputDir, config, mp4Path)

      // Cleanup original MKV if mp4_only
      if (m.conversionMode === "mp4_only" && isMkvSource) {
        try {
          unlinkSync(m.originalPath)
        } catch (e) {
          logError(e, `Cleanup MKV: ${m.originalName}`)
        }
      }

      // 4. Artwork (optional, needs a TMDB API key). Errors never fail the movie.
      if (config.tmdbApiKey) {
        m.status = "artwork"
        onUpdate(movies, i, 0)
        try {
          const art = await downloadPoster(m, movieDir, config)
          if (!art.ok) logError(art.reason || "unknown", `Artwork: ${m.originalName}`)
        } catch (e) {
          logError(e, `Artwork: ${m.originalName}`)
        }
      }

      m.status = "done"
      onUpdate(movies, i, 100)
    } catch (e) {
      m.status = "error"
      m.error = e instanceof Error ? e.message : String(e)
      logError(e, `Processing Loop: ${m.originalName}`)
      onUpdate(movies, i, 0)
    }
  }
}
