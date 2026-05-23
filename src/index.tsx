import {
  Box, Text, createCliRenderer,
  t, bold, fg,
} from "@opentui/core"
import { loadConfig, saveConfig } from "./config"
import { scanDirectory } from "./services/scanner"
import { resolveTitles } from "./services/gemini"
import { runPipeline } from "./services/pipeline"
import { killActiveHandBrake } from "./services/handbrake"
import type { MovieFile, AppConfig, AppView, MediaFormat } from "./types"

// ── State ──────────────────────────────────────────────────────────────────
let config = loadConfig()
let movies: MovieFile[] = []
let view: AppView = "settings"
let sel = 0
let status = ""
let error = ""
let procIdx = -1
let procPct = 0
let editIdx = -1
let editType: "setting" | "title" | "year" = "setting"
let editVal = ""
let isProcessing = false

const FORMATS: MediaFormat[] = ["DVD", "Blu-ray", "Blu-ray_4K"]
const SETTINGS = [
  { key: "sourceDir" as const, label: "Source Directory", secret: false },
  { key: "outputDir" as const, label: "Output Directory", secret: false },
  { key: "llmProvider" as const, label: "LLM Provider (gemini/groq/ollama)", secret: false },
  { key: "geminiApiKey" as const, label: "Gemini API Key", secret: true },
  { key: "groqApiKey" as const, label: "Groq API Key", secret: true },
  { key: "ollamaBaseUrl" as const, label: "Ollama Base URL", secret: false },
  { key: "ollamaModel" as const, label: "Ollama Model", secret: false },
  { key: "opensubsApiKey" as const, label: "OpenSubtitles API Key", secret: true },
  { key: "opensubsUsername" as const, label: "OpenSubtitles User", secret: false },
  { key: "opensubsPassword" as const, label: "OpenSubtitles Password", secret: true },
  { key: "handbrakePreset" as const, label: "HandBrake Preset", secret: false },
  { key: "handbrakePath" as const, label: "HandBrake Path", secret: false },
  { key: "mkvmergePath" as const, label: "mkvmerge Path", secret: false },
  { key: "mkvextractPath" as const, label: "mkvextract Path", secret: false },
]

// ── Colors ─────────────────────────────────────────────────────────────────
const C = {
  bg: "#0d1117", panel: "#161b22", border: "#30363d",
  accent: "#58a6ff", green: "#3fb950", red: "#f85149",
  yellow: "#d29922", dim: "#8b949e", text: "#e6edf3",
}

const fmtColor = (f: MediaFormat) =>
  f === "Blu-ray_4K" ? C.yellow : f === "Blu-ray" ? C.accent : C.dim

const renderer = await createCliRenderer({ 
  exitOnCtrlC: true,
  consoleMode: "disabled",
})

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  for (const child of renderer.root.getChildren().slice()) {
    renderer.root.remove(child.id)
    child.destroyRecursively()
  }

  const children: any[] = []

  // Header
  children.push(
    Box(
      { width: "100%", height: 3, borderStyle: "rounded", borderColor: C.accent,
        justifyContent: "center", alignItems: "center", flexDirection: "row", gap: 2 },
      Text({ content: t`${bold(fg(C.accent)("\uD83D\uDCC0 PLEX INGEST"))}` }),
      Text({ content: t`${fg(C.dim)("Blu-ray Digitization Pipeline")}` }),
    )
  )

  // Nav bar
  const navItems = [
    { v: "settings" as const, l: "[T] Settings" },
    { v: "scan" as const, l: "[S] Scan" },
    { v: "review" as const, l: "[R] Review" },
    { v: "progress" as const, l: "[P] Process" },
  ]
  children.push(
    Box(
      { width: "100%", height: 1, flexDirection: "row", gap: 2, paddingLeft: 1, marginTop: 1 },
      ...navItems.map((n) =>
        Text({
          content: view === n.v
            ? t`${bold(fg(C.accent)(n.l))}`
            : t`${fg(C.dim)(n.l)}`,
        })
      ),
      Text({ content: t`${fg(C.dim)("  q=quit")}` }),
    )
  )

  // Messages
  if (error) {
    children.push(
      Box({ width: "100%", height: 1, paddingLeft: 1, marginTop: 1 },
        Text({ content: t`${fg(C.red)("\u2717 " + error)}` }))
    )
  }
  if (status) {
    children.push(
      Box({ width: "100%", height: 1, paddingLeft: 1, marginTop: 1 },
        Text({ content: t`${fg(C.green)("\u25CF " + status)}` }))
    )
  }

  // Content area
  children.push(
    Box(
      { width: "100%", flexGrow: 1, marginTop: 1, paddingLeft: 1, paddingRight: 1,
        flexDirection: "column" },
      ...renderContent()
    )
  )

  renderer.root.add(
    Box({ width: "100%", height: "100%", flexDirection: "column", backgroundColor: C.bg },
      ...children)
  )
  renderer.requestRender()
}

function renderContent(): any[] {
  switch (view) {
    case "settings": return renderSettings()
    case "scan": return renderScan()
    case "review": return renderReview()
    case "progress": return renderProgress()
  }
}

// ── Settings View ──────────────────────────────────────────────────────────
function renderSettings(): any[] {
  const out: any[] = [
    Text({ content: t`${bold(fg(C.text)("Settings"))}` }),
    Text({ content: t`${fg(C.dim)("\u2191/\u2193 navigate  |  Enter = edit  |  Esc = cancel")}` }),
    Box({ width: "100%", height: 1 }),
  ]

  for (let i = 0; i < SETTINGS.length; i++) {
    const s = SETTINGS[i]
    const isSel = i === sel
    const val = (config as any)[s.key]
    const disp = s.secret && val ? "\u25CF".repeat(Math.min(val.length, 24)) : val || "(not set)"

    if (editIdx === i && editType === "setting") {
      out.push(Box({ flexDirection: "row", gap: 1, backgroundColor: "#1c2333" },
        Text({ content: t`${fg(C.accent)("\u25B8 " + s.label + ":")}` }),
        Text({ content: t`${fg(C.green)(editVal + "\u2588")}` }),
      ))
    } else {
      out.push(Box(
        { flexDirection: "row", gap: 1, backgroundColor: isSel ? "#1c2333" : undefined },
        Text({ content: t`${fg(isSel ? C.accent : C.text)((isSel ? "\u25B8 " : "  ") + s.label + ":")}` }),
        Text({ content: t`${fg(C.dim)(disp)}` }),
      ))
    }
  }

  return out
}

// ── Scan View ──────────────────────────────────────────────────────────────
function renderScan(): any[] {
  const out: any[] = [
    Text({ content: t`${bold(fg(C.text)("Scan MKV Files"))}` }),
    Text({ content: t`${fg(C.dim)("Source: " + config.sourceDir)}` }),
    Text({ content: t`${fg(C.dim)("Press Enter to scan and resolve titles via Gemini.")}` }),
  ]

  if (movies.length > 0) {
    out.push(Box({ width: "100%", height: 1 }))
    out.push(Text({ content: t`${bold(fg(C.text)(`${movies.length} file(s):`))}` }))

    for (const m of movies) {
      const titlePart =
        m.status === "title-resolved" || m.status === "ready"
          ? t`${fg(C.green)(`${m.resolvedTitle} (${m.resolvedYear})`)}`
          : m.status === "error"
            ? t`${fg(C.red)(`${m.originalName} \u2717 ${m.error || ""}`)}`
            : t`${fg(C.yellow)(`${m.originalName} \u23F3`)}`

      out.push(Box({ flexDirection: "row", gap: 2 },
        Text({ content: t`${fg(C.dim)(m.sizeHuman.padStart(10))}` }),
        Text({ content: t`${fg(fmtColor(m.confirmedFormat))(`[${m.confirmedFormat}]`.padEnd(14))}` }),
        Text({ content: titlePart }),
      ))
    }
  }

  return out
}

// ── Review View ────────────────────────────────────────────────────────────
function renderReview(): any[] {
  if (!movies.length) {
    return [Text({ content: t`${fg(C.dim)("No movies. Scan first.")}` })]
  }

  const out: any[] = [
    Text({ content: t`${bold(fg(C.text)("Review & Configure"))}` }),
    Text({ content: t`${fg(C.dim)("\u2191/\u2193 nav | F=format | M=mode | E=edit title | Y=edit year | Enter=confirm all")}` }),
    Box({ width: "100%", height: 1 }),
    // Header
    Box({ flexDirection: "row", gap: 1 },
      Text({ content: t`${bold(fg(C.accent)("  #".padEnd(5)))}` }),
      Text({ content: t`${bold(fg(C.accent)("Size".padEnd(10)))}` }),
      Text({ content: t`${bold(fg(C.accent)("Format".padEnd(14)))}` }),
      Text({ content: t`${bold(fg(C.accent)("Mode".padEnd(12)))}` }),
      Text({ content: t`${bold(fg(C.accent)("Title"))}` }),
    ),
  ]

  for (let i = 0; i < movies.length; i++) {
    const m = movies[i]
    const isSel = i === sel
    const rc = isSel ? C.accent : C.text

    const modeLabels: Record<string, string> = {
      "keep_both": "Both",
      "mp4_only": "MP4 only",
      "mkv_only": "MKV only"
    }

    let titleDisp = t`${fg(rc)(`${m.resolvedTitle} (${m.resolvedYear})`)}`
    if (editIdx === i && editType === "title") {
      titleDisp = t`${fg(C.green)(editVal + "\u2588")} ${fg(rc)(`(${m.resolvedYear})`)}`
    } else if (editIdx === i && editType === "year") {
      titleDisp = t`${fg(rc)(m.resolvedTitle)} ${fg(C.green)(`(${editVal}\u2588)`)}`
    }

    out.push(Box(
      { flexDirection: "row", gap: 1, backgroundColor: isSel ? "#1c2333" : undefined },
      Text({ content: t`${fg(rc)(((isSel ? "\u25B8" : " ") + (i + 1)).padEnd(5))}` }),
      Text({ content: t`${fg(C.dim)(m.sizeHuman.padEnd(10))}` }),
      Text({ content: t`${fg(fmtColor(m.confirmedFormat))(`[${m.confirmedFormat}]`.padEnd(14))}` }),
      Text({ content: t`${fg(C.green)((modeLabels[m.conversionMode] || "Both").padEnd(12))}` }),
      Text({ content: titleDisp }),
    ))
  }

  // Preview box for selected movie
  if (movies[sel]) {
    const m = movies[sel]
    const n = `${m.resolvedTitle} (${m.resolvedYear})`
    out.push(Box({ width: "100%", height: 1 }))
    out.push(Box(
      { flexDirection: "column", borderStyle: "rounded", borderColor: C.border, padding: 1, width: 72 },
      Text({ content: t`${bold(fg(C.accent)("Plex Preview:"))}` }),
      Text({ content: t`${fg(C.text)(`${n}/`)}` }),
      ...(m.conversionMode !== "mkv_only" ? [Text({ content: t`${fg(C.green)(`  ${n} - [${m.confirmedFormat}].mp4`)}` })] : []),
      ...(m.conversionMode !== "mp4_only" && m.originalName.toLowerCase().endsWith(".mkv") ? [Text({ content: t`${fg(C.yellow)(`  ${n} - [${m.confirmedFormat}].mkv`)}` })] : []),
      Text({ content: t`${fg(C.dim)(`  ${n} - [${m.confirmedFormat}].en.srt`)}` }),
      Text({ content: t`${fg(C.dim)(`  ${n} - [${m.confirmedFormat}].de.srt`)}` }),
    ))
  }

  return out
}

// ── Progress View ──────────────────────────────────────────────────────────
function renderProgress(): any[] {
  if (!movies.length) {
    return [Text({ content: t`${fg(C.dim)("No movies. Scan and Review first.")}` })]
  }

  const out: any[] = [
    Text({ content: t`${bold(fg(C.text)("Processing Pipeline"))}` }),
    Text({ content: t`${fg(C.dim)(isProcessing ? "Running..." : "Press Enter to start.")}` }),
    Box({ width: "100%", height: 1 }),
  ]

  for (let i = 0; i < movies.length; i++) {
    const m = movies[i]
    let icon = "\u25CB", color = C.dim

    switch (m.status) {
      case "converting": icon = "\u25C9"; color = C.yellow; break
      case "subtitles": icon = "\u25C9"; color = C.accent; break
      case "organizing": icon = "\u25C9"; color = C.accent; break
      case "done": icon = "\u2713"; color = C.green; break
      case "error": icon = "\u2717"; color = C.red; break
    }

    const bar = m.status === "converting" && procIdx === i
      ? ` [${"#".repeat(Math.floor(procPct / 5))}${".".repeat(20 - Math.floor(procPct / 5))}] ${Math.round(procPct)}%`
      : ""

    const lbl = m.status === "converting" ? " Converting..."
      : m.status === "subtitles" ? " Subtitles..."
      : m.status === "organizing" ? " Organizing..."
      : m.status === "done" ? " Done"
      : m.status === "error" ? ` Error: ${m.error || ""}`
      : ""

    out.push(Box({ flexDirection: "row", gap: 1 },
      Text({ content: t`${fg(color)(`${icon} ${m.resolvedTitle} (${m.resolvedYear})`)}` }),
      Text({ content: t`${fg(C.dim)(lbl + bar)}` }),
    ))
  }

  return out
}

// ── Key Handling ───────────────────────────────────────────────────────────
renderer.keyInput.on("keypress", async (keyEvent) => {
  const key = keyEvent.name || keyEvent.sequence;
  
  // EXIT logic must be first and always available
  if (key === "q") {
    killActiveHandBrake()
    process.exit(0)
  }

  if (isProcessing) return
  error = ""

  // Editing mode
  if (editIdx >= 0) {
    if (key === "escape") { editIdx = -1; editVal = ""; render(); return }
    if (key === "return") {
      if (editType === "setting") {
        const f = SETTINGS[editIdx];
        (config as any)[f.key] = editVal
        saveConfig(config)
        status = `Saved: ${f.label}`
      } else if (editType === "title") {
        movies[editIdx].resolvedTitle = editVal
      } else if (editType === "year") {
        movies[editIdx].resolvedYear = editVal
      }
      editIdx = -1; editVal = ""; render(); return
    }
    if (key === "backspace") { editVal = editVal.slice(0, -1); render(); return }
    if (key.length === 1) { editVal += key; render(); return }
    return
  }

  // Global nav
  if (key === "s") { view = "scan"; sel = 0; render(); return }
  if (key === "r") { view = "review"; sel = 0; render(); return }
  if (key === "t") { view = "settings"; sel = 0; render(); return }
  if (key === "p") { view = "progress"; render(); return }

  // Arrow keys
  const maxIdx = view === "settings" ? SETTINGS.length - 1
    : view === "review" ? movies.length - 1 : 0

  if (key === "up" && sel > 0) { sel--; render(); return }
  if (key === "down" && sel < maxIdx) { sel++; render(); return }

  // View-specific actions
  if (view === "settings" && key === "return") {
    editIdx = sel
    editType = "setting"
    editVal = (config as any)[SETTINGS[sel].key]
    render()
    return
  }

  if (view === "scan" && key === "return") {
    status = "Scanning..."; render()
    try {
      movies = scanDirectory(config.sourceDir)
      if (!movies.length) { error = `No MKV files in: ${config.sourceDir}`; render(); return }
      status = `Found ${movies.length} files. Resolving titles...`; render()
      await resolveTitles(movies, config, (i, n) => {
        status = `Resolving: ${i}/${n}...`; render()
      })
      status = `${movies.length} titles resolved. Press R to review.`
      render()
    } catch (e) { error = e instanceof Error ? e.message : String(e); render() }
    return
  }

  if (view === "review") {
    if (key === "f" || key === "F") {
      if (movies[sel]) {
        const idx = FORMATS.indexOf(movies[sel].confirmedFormat)
        movies[sel].confirmedFormat = FORMATS[(idx + 1) % 3]
        render()
      }
      return
    }
    if (key === "m" || key === "M") {
      if (movies[sel]) {
        const MODES = ["keep_both", "mp4_only", "mkv_only"] as const
        const idx = MODES.indexOf(movies[sel].conversionMode as any)
        movies[sel].conversionMode = MODES[(idx + 1) % 3]
        render()
      }
      return
    }
    if (key === "e" || key === "E") {
      if (movies[sel]) {
        editIdx = sel
        editType = "title"
        editVal = movies[sel].resolvedTitle
        render()
      }
      return
    }
    if (key === "y" || key === "Y") {
      if (movies[sel]) {
        editIdx = sel
        editType = "year"
        editVal = movies[sel].resolvedYear
        render()
      }
      return
    }
    if (key === "return") {
      for (const m of movies) {
        if (m.status === "title-resolved" || m.status === "pending") m.status = "ready"
      }
      view = "progress"
      status = "Press Enter to start processing."
      render()
      return
    }
  }

  if (view === "progress" && key === "return") {
    const ready = movies.filter((m) => m.status === "ready" || m.status === "title-resolved")
    if (!ready.length) { error = "No movies ready."; render(); return }
    isProcessing = true
    status = "Processing..."
    render()
    try {
      await runPipeline(movies, config, (updated, idx, pct) => {
        movies = updated; procIdx = idx; procPct = pct; 
        render()
      })
      status = "All done! Check your output directory."
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    isProcessing = false
    render()
  }
})

// Initial render
render()
render()
