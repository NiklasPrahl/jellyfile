import { mkdirSync, appendFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import type { MovieFile, AppConfig } from "../types"
import { convertToMp4 } from "./handbrake"
import { downloadSubtitles, extractSubtitles } from "./subtitles"
import { organizeMovie, plexName } from "./organizer"

function logError(error: any, context: string) {
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
      const baseName = `${plexName(m, config)} - [${m.confirmedFormat}]`
      const movieDir = join(config.outputDir, plexName(m, config))

      // 1. Convert MKV -> MP4 (if needed)
      let mp4Path: string | undefined
      if (m.conversionMode !== "mkv_only") {
        m.status = "converting"
        onUpdate(movies, i, 0)

        const preset = 
          m.confirmedFormat === "Blu-ray_4K" ? config.handbrakePreset4K :
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

      // 2. Subtitles
      m.status = "subtitles"
      onUpdate(movies, i, 0)

      let foundLangs: string[] = []
      
      if (m.originalPath.toLowerCase().endsWith(".mkv")) {
        try {
          // Folder is ONLY created here if we actually start subtitle extraction
          mkdirSync(movieDir, { recursive: true })
          const extRes = await extractSubtitles(
            m.originalPath, movieDir, baseName, 
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
            m.resolvedTitle, m.resolvedYear, movieDir, baseName,
            config.opensubsApiKey, config.opensubsUsername, config.opensubsPassword,
            ["en", "de"], foundLangs
          )
        } catch (e) {
          logError(e, `OpenSubtitles: ${m.originalName}`)
        }
      }

      // 3. Organize files into Plex structure
      m.status = "organizing"
      onUpdate(movies, i, 0)
      
      // Ensure folder exists before moving/copying
      mkdirSync(movieDir, { recursive: true })
      organizeMovie(m, config.outputDir, config, mp4Path)

      // Cleanup original MKV if mp4_only
      if (m.conversionMode === "mp4_only" && m.originalPath.toLowerCase().endsWith(".mkv")) {
        try {
          unlinkSync(m.originalPath)
        } catch (e) {
          logError(e, `Cleanup MKV: ${m.originalName}`)
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
