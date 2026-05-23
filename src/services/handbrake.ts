import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface ConvertResult {
  success: boolean
  outputPath: string
  error?: string
}

let activeProcess: ChildProcess | null = null

export function killActiveHandBrake() {
  if (activeProcess) {
    // SIGKILL is harsh but effective for stuck processes
    activeProcess.kill("SIGKILL")
    activeProcess = null
  }
}

/**
 * HandBrake GUI on macOS stores presets in a specific JSON file.
 */
export function getGuiPresets(): string[] {
  const possiblePaths = [
    join(homedir(), "Library/Containers/fr.handbrake.HandBrake/Data/Library/Application Support/HandBrake/UserPresets.json"),
    join(homedir(), "Library/Application Support/HandBrake/UserPresets.json"),
  ]

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      try {
        const content = JSON.parse(readFileSync(path, "utf-8"))
        const presets = content.UserPresets || []
        return presets.map((p: any) => p.PresetName).filter(Boolean)
      } catch {
        continue
      }
    }
  }
  return []
}

export function validatePreset(handbrakePath: string, preset: string): { ok: boolean; isGui?: boolean; fullPresetName: string; error?: string } {
  const logPath = join(process.cwd(), "pipeline_error.log")
  try {
    const proc = spawnSync(handbrakePath, ["--preset-import-gui", "--preset-list"], { stdio: ["ignore", "pipe", "pipe"] })
    
    let list = ""
    if (proc.status !== 0) {
      const fallback = spawnSync(handbrakePath, ["--preset-list"], { stdio: ["ignore", "pipe", "pipe"] })
      list = fallback.stdout.toString() + fallback.stderr.toString()
    } else {
      list = proc.stdout.toString() + proc.stderr.toString()
    }

    appendFileSync(logPath, `[HandBrake Preset List Output]\n${list}\n${"-".repeat(40)}\n`)
    const lines = list.split("\n").map(l => l.trim())
    
    let currentCategory = ""
    for (const line of lines) {
      if (line.endsWith("/")) {
        currentCategory = line
        continue
      }
      
      const fullPath = currentCategory + line
      if (line.toLowerCase() === preset.toLowerCase() || 
          fullPath.toLowerCase() === preset.toLowerCase() ||
          (line.length > 5 && line.includes(preset))) {
        return { ok: true, isGui: true, fullPresetName: fullPath }
      }
    }

    const guiPresets = getGuiPresets()
    const guiMatch = guiPresets.find(p => p.toLowerCase() === preset.toLowerCase())
    if (guiMatch) {
      return { ok: true, isGui: true, fullPresetName: guiMatch }
    }

    return { 
      ok: false, 
      fullPresetName: preset,
      error: `Preset "${preset}" not found in HandBrake!` 
    }
  } catch (err) {
    return { ok: false, fullPresetName: preset, error: `Execution failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function convertToMp4(
  inputPath: string,
  outputPath: string,
  preset: string,
  handbrakePath: string = "HandBrakeCLI",
  onProgress?: (percent: number) => void
): Promise<ConvertResult> {
  return new Promise((resolve) => {
    if (existsSync(outputPath)) {
      resolve({ success: true, outputPath })
      return
    }

    const validation = validatePreset(handbrakePath, preset)
    if (!validation.ok) {
      resolve({ success: false, outputPath, error: validation.error })
      return
    }

    const args = [
      "-i", inputPath,
      "-o", outputPath,
      "--preset", validation.fullPresetName,
      "--optimize",
    ]

    if (validation.isGui) {
      args.unshift("--preset-import-gui")
    }

    // Capture stdout too, just in case HandBrake uses it for progress on some systems
    activeProcess = spawn(handbrakePath, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    let lastLine = ""

    const handleData = (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text
      const lines = (lastLine + text).split(/[\r\n]/)
      lastLine = lines.pop() || ""
      for (const line of lines) {
        // Regex refined to be more specific to HandBrake encoding line
        const match = line.match(/Encoding: task \d+ of \d+, ([\d.]+)\s*%/)
        if (match) {
          const pct = parseFloat(match[1])
          if (!isNaN(pct)) onProgress?.(pct)
        } else {
           // Fallback for simpler progress lines
           const simpleMatch = line.match(/([\d.]+)\s*%/)
           if (simpleMatch) {
             const pct = parseFloat(simpleMatch[1])
             // Only update if it looks like a real progress update (e.g. not a version string)
             if (!isNaN(pct) && line.includes("Encoding")) onProgress?.(pct)
           }
        }
      }
    }

    activeProcess.stderr?.on("data", handleData)
    activeProcess.stdout?.on("data", handleData)

    activeProcess.on("error", (err) => {
      activeProcess = null
      resolve({ success: false, outputPath, error: `HandBrakeCLI error: ${err.message}` })
    })

    activeProcess.on("close", (code) => {
      activeProcess = null
      if (code === 0 && existsSync(outputPath)) {
        resolve({ success: true, outputPath })
      } else {
        resolve({ success: false, outputPath, error: `Exit code ${code}. ${stderr.slice(-300)}` })
      }
    })
  })
}
