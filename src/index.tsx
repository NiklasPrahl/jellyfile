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
let view: AppView = "init"
let flowStep: "init" | "scan" | "review" | "progress" = "init"
let sel = 0
let status = ""
let error = ""
let procIdx = -1
let procPct = 0
let editIdx = -1
let editType: "setting" | "title" | "year" = "setting"
let editVal = ""
let isProcessing = false
let isPasting = false
let scrollOffset = 0

const VERSION = "0.0.2"
const FORMATS: MediaFormat[] = ["DVD", "Blu-ray", "Blu-ray_4K"]

const SETTINGS_GROUPS = [
  {
    label: "Directories",
    items: [
      { key: "sourceDir" as const, label: "Input Directory", secret: false },
      { key: "outputDir" as const, label: "Output Directory", secret: false },
    ]
  },
  {
    label: "LLM (AI Title Resolution)",
    items: [
      { key: "llmProvider" as const, label: "Provider (gemini/groq/ollama)", secret: false },
      { key: "geminiApiKey" as const, label: "Gemini API Key", secret: true },
      { key: "groqApiKey" as const, label: "Groq API Key", secret: true },
      { key: "ollamaBaseUrl" as const, label: "Ollama Base URL", secret: false },
      { key: "ollamaModel" as const, label: "Ollama Model", secret: false },
    ]
  },
  {
    label: "HandBrake Presets",
    items: [
      { key: "handbrakePresetDVD" as const, label: "DVD Preset", secret: false },
      { key: "handbrakePresetBluRay" as const, label: "Blu-ray Preset", secret: false },
      { key: "handbrakePreset4K" as const, label: "4K Preset", secret: false },
    ]
  },
  {
    label: "Tool Paths",
    items: [
      { key: "handbrakePath" as const, label: "HandBrake Path", secret: false },
      { key: "mkvmergePath" as const, label: "mkvmerge Path", secret: false },
      { key: "mkvextractPath" as const, label: "mkvextract Path", secret: false },
    ]
  },
  {
    label: "Subtitle Services",
    items: [
      { key: "opensubsApiKey" as const, label: "OpenSubtitles API Key", secret: true },
      { key: "opensubsUsername" as const, label: "OpenSubtitles User", secret: false },
      { key: "opensubsPassword" as const, label: "OpenSubtitles Password", secret: true },
    ]
  }
]

const ALL_SETTINGS = SETTINGS_GROUPS.flatMap(g => g.items)

// ── Colors ─────────────────────────────────────────────────────────────────
const C = {
  bg: "#0d1117", panel: "#161b22", border: "#30363d",
  accent: "#AA5CC3", green: "#3fb950", red: "#f85149",
  yellow: "#d29922", dim: "#8b949e", text: "#e6edf3",
}

// RESTORED USER BANNER: Preserving the manually adjusted spaces before Y block
const bannerLines = [
  "      ██╗███████╗██╗     ██╗    ██╗   ██╗███████╗██╗██╗     ███████╗",
  "      ██║██╔════╝██║     ██║    ╚██╗ ██╔╝██╔════╝██║██║     ██╔════╝",
  "      ██║█████╗  ██║     ██║     ╚████╔╝ █████╗  ██║██║     █████╗  ",
  "██╗   ██║██╔══╝  ██║     ██║      ╚██╔╝  ██╔══╝  ██║██║     ██╔══╝  ",
  "╚██████╔╝███████╗███████╗███████╗  ██║   ██║     ██║███████╗███████╗",
  " ╚═════╝ ╚══════╝╚══════╝╚══════╝  ╚═╝   ╚═╝     ╚═╝╚══════╝╚══════╝"
]

const bannerColors = [
  "#00A4DC", "#2295D6", "#4486D1", "#6677CC", "#8868C7", "#AA5CC3"
]

const fmtColor = (f: MediaFormat) =>
  f === "Blu-ray_4K" ? C.yellow : f === "Blu-ray" ? C.accent : C.dim

const renderer = await createCliRenderer({ 
  exitOnCtrlC: true,
  consoleMode: "disabled",
})

const quit = () => {
  killActiveHandBrake()
  renderer.destroy()
  process.stdout.write("\x1b[?2004l\n")
  process.exit(0)
}

function setView(v: AppView) {
  view = v
  status = "" 
  error = ""
  sel = 0 
  scrollOffset = 0
  render()
}

renderer.keyInput.on("paste", (event) => {
  if (editIdx >= 0) {
    const pasted = new TextDecoder().decode(event.bytes)
    editVal += pasted.replace(/[\r\n]/g, "")
    render()
  }
})

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  try {
    for (const child of renderer.root.getChildren().slice()) {
      renderer.root.remove(child.id)
      child.destroyRecursively()
    }

    const children: any[] = []

    // 1. TOP MARGIN (2 LINES)
    children.push(Box({ width: "100%", height: 2 }))

    // 2. BANNER
    children.push(
      Box({ width: "100%", flexDirection: "column", alignItems: "center", marginBottom: 0 },
        ...bannerLines.map((line, i) => Text({ content: t`${fg(bannerColors[i])(line)}` }))
      )
    )

    // 3. BLANK LINE AFTER BANNER / BEFORE SUBTITLE
    children.push(Box({ width: "100%", height: 1 }))

    // 4. SUBTITLE
    children.push(
      Box(
        { width: "100%", height: 1, justifyContent: "center", alignItems: "center", marginBottom: 0 },
        Text({ content: t`${bold(fg(C.dim)("Movie Disc Digitization Pipeline"))}` }),
      )
    )

    // 5. BLANK LINE AFTER SUBTITLE
    children.push(Box({ width: "100%", height: 1 }))

    // 6. NAVIGATION
    if (view !== "init") {
      const steps = [
        { v: "scan" as const, l: "1. SCAN", icon: "\uD83D\uDD0D" },
        { v: "review" as const, l: "2. REVIEW", icon: "\u2705" },
        { v: "progress" as const, l: "3. PROCESS", icon: "\uD83C\uDF79" },
      ]
      
      children.push(
        Box(
          { width: "100%", height: 1, flexDirection: "row", gap: 3, justifyContent: "center", marginBottom: 1 },
          ...steps.map((s) => {
            const isActive = view === s.v
            const isDone = (s.v === "scan" && flowStep !== "scan") || (s.v === "review" && flowStep === "progress")
            const color = isActive ? C.accent : (isDone ? C.green : C.dim)
            const label = isActive ? `[ ${s.icon} ${s.l} ]` : `${s.icon} ${s.l}`
            return Text({ content: t`${isActive ? bold(fg(color)(label)) : fg(color)(label)}` })
          })
        )
      )
    }

    // 7. MAIN CONTENT BOX
    const mainContent = renderContent()
    
    children.push(
      Box(
        { width: "100%", paddingLeft: 4, paddingRight: 4, flexDirection: "column", alignItems: "center" },
        Box(
          {
            width: "100%",
            height: 16,
            borderStyle: "rounded",
            borderColor: C.border,
            flexDirection: "column",
            padding: 0
          },
          Box(
            {
              width: "100%",
              height: "100%",
              flexDirection: "column",
              backgroundColor: C.panel,
              padding: 1,
              flexGrow: 1
            },
            ...[
              error ? Box({ paddingLeft: 1, marginBottom: 0 }, Text({ content: t`${fg(C.red)(("\u2717 " + error).substring(0, 80))}` })) : null,
              status && !isProcessing ? Box({ paddingLeft: 1, marginBottom: 0 }, Text({ content: t`${fg(C.green)(("\u25CF " + status).substring(0, 80))}` })) : null,
              ...mainContent
            ].filter(Boolean)
          )
        )
      )
    )

    // 8. FOOTER
    children.push(
      Box({ width: "100%", height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 6, paddingRight: 6, marginTop: 1 },
        Text({ content: t`${fg(C.dim)("Press ")}${bold(fg(C.text)("Q"))}${fg(C.dim)(" to Quit | ")}${bold(fg(view === "settings" ? C.accent : C.text)("S"))}${fg(C.dim)(" for Settings")}` }),
        Text({ content: t`${fg(C.dim)(`v${VERSION}`)}` })
      )
    )

    renderer.root.add(
      Box({ width: "100%", height: "100%", flexDirection: "column", backgroundColor: C.bg },
        ...children)
    )
    renderer.requestRender()
  } catch (e) {
    console.error("Critical Render Error:", e)
  }
}

function renderContent(): any[] {
  switch (view) {
    case "init": return renderInit()
    case "settings": return renderSettings()
    case "scan": return renderScan()
    case "review": return renderReview()
    case "progress": return renderProgress()
    default: return []
  }
}

// ── Init View ──────────────────────────────────────────────────────────────
function renderInit(): any[] {
  const out: any[] = [
    Box({ width: "100%", alignItems: "center", marginTop: 0, marginBottom: 1 },
      Text({ content: t`${bold(fg(C.text)("Welcome to Jellyfile!"))}` }),
      Text({ content: t`${fg(C.dim)("Verify your directories to get started.")}` }),
    ),
  ]
  const initItems = [{ key: "sourceDir" as const, label: "Input Directory" }, { key: "outputDir" as const, label: "Output Directory" }]
  for (let i = 0; i < initItems.length; i++) {
    const item = initItems[i]; const isSel = i === sel; const val = (config as any)[item.key]
    const labelStr = (isSel ? "\u25B8 " : "  ") + item.label + ": "
    
    if (editIdx === i && editType === "setting") {
      out.push(Box({ flexDirection: "row", backgroundColor: "#252b37", width: "100%", paddingLeft: 2 },
        Text({ content: t`${fg(C.accent)(labelStr)}${fg(C.green)((editVal + "\u2588").padEnd(60))}` })
      ))
    } else {
      out.push(Box({ flexDirection: "row", backgroundColor: isSel ? "#252b37" : undefined, width: "100%", paddingLeft: 2 },
        Text({ content: t`${fg(isSel ? C.accent : C.text)(labelStr)}${fg(C.dim)((val || "(not set)").padEnd(60))}` })
      ))
    }
  }
  out.push(Box({ width: "100%", height: 3 }))
  out.push(Box({ width: "100%", height: 3, justifyContent: "center", alignItems: "center", borderStyle: "double", borderColor: sel === 2 ? C.accent : C.border, backgroundColor: sel === 2 ? "#252b37" : undefined },
    Text({ content: t`${sel === 2 ? bold(fg(C.accent)(">>> START SCAN <<<")) : fg(C.dim)("START SCAN")}` })
  ))
  return out
}

// ── Settings View ──────────────────────────────────────────────────────────
function renderSettings(): any[] {
  const viewportSize = 12 
  const out: any[] = [
    Box({ flexDirection: "row", justifyContent: "space-between", width: "100%", marginBottom: 1 },
      Text({ content: t`${bold(fg(C.text)("Settings"))}` }),
      Text({ content: t`${fg(C.dim)("Arrows to scroll")}` }),
    ),
  ]

  const rows: any[] = []
  const rowToItemMap: (number | null)[] = []
  
  for (const group of SETTINGS_GROUPS) {
    const groupHeader = group.label.toUpperCase().padEnd(70)
    rows.push(Box({ width: "100%", paddingLeft: 1 }, 
      Text({ content: t`${bold(fg(C.accent)(groupHeader))}` })
    ))
    rowToItemMap.push(null)
    
    for (const s of group.items) {
      const currentAbs = ALL_SETTINGS.indexOf(s)
      const isSel = currentAbs === sel
      const val = (config as any)[s.key]
      const disp = (s.secret && val ? "\u25CF".repeat(Math.min(val.length, 16)) : val || "(not set)")
      
      const labelStr = s.label.padEnd(24)
      const prefixStr = isSel ? "\u25B8 " : "  "
      const color = isSel ? C.accent : C.text

      if (editIdx === currentAbs && editType === "setting") {
        rows.push(Box({ flexDirection: "row", width: "100%", backgroundColor: "#252b37", paddingLeft: 2 },
          Text({ content: t`${fg(C.accent)(prefixStr + labelStr + ": ")}${fg(C.green)((editVal + "\u2588").padEnd(50))}` })
        ))
      } else {
        rows.push(Box({ flexDirection: "row", width: "100%", backgroundColor: isSel ? "#252b37" : undefined, paddingLeft: 2 },
          Text({ content: t`${fg(color)(prefixStr + labelStr + ": ")}${fg(C.dim)(disp.padEnd(50))}` })
        ))
      }
      rowToItemMap.push(currentAbs)
    }
    rows.push(Box({ width: "100%", height: 1 }, Text({ content: "".padEnd(70) })))
    rowToItemMap.push(null)
  }

  const selectedRowIdx = rowToItemMap.indexOf(sel)
  if (selectedRowIdx < scrollOffset) scrollOffset = selectedRowIdx
  if (selectedRowIdx >= scrollOffset + viewportSize) scrollOffset = selectedRowIdx - viewportSize + 1
  
  scrollOffset = Math.max(0, Math.min(scrollOffset, rows.length - viewportSize))
  if (rows.length <= viewportSize) scrollOffset = 0

  out.push(...rows.slice(scrollOffset, scrollOffset + viewportSize))
  return out
}

// ── Scan View ──────────────────────────────────────────────────────────────
function renderScan(): any[] {
  const out: any[] = [Box({ width: "100%", alignItems: "center", marginBottom: 1 }, Text({ content: t`${bold(fg(C.text)("Step 1: Scan Source Directory"))}` }))]
  if (movies.length > 0) {
    out.push(Text({ content: t`${bold(fg(C.accent)(`Found ${movies.length} files:`))}` }))
    const scanVisible = 6
    for (const m of movies.slice(0, scanVisible)) {
      const line = `${m.sizeHuman.padStart(8)}  ${m.resolvedTitle.slice(0, 40)}`.padEnd(70)
      out.push(Box({ flexDirection: "row", gap: 2, paddingLeft: 2 },
        Text({ content: t`${fg(C.green)(line)}` }),
      ))
    }
    out.push(Box({ width: "100%", alignItems: "center", marginTop: 1 }, Text({ content: t`${bold(fg(C.accent)("Press ENTER to proceed."))}` })))
  } else {
    out.push(Box({ width: "100%", flexGrow: 1, justifyContent: "center", alignItems: "center" }, Text({ content: t`${fg(C.accent)("Press ENTER to scan.")}` })))
  }
  return out
}

// ── Review View ────────────────────────────────────────────────────────────
function renderReview(): any[] {
  const out: any[] = [Box({ flexDirection: "row", justifyContent: "space-between", width: "100%", marginBottom: 1 }, Text({ content: t`${bold(fg(C.text)("Step 2: Review"))}` }), Text({ content: t`${fg(C.dim)("F/M/E/Y cycle/edit")}` }))]
  const reviewVisible = 4; const start = Math.max(0, sel - reviewVisible + 1); const slice = movies.slice(start, start + reviewVisible)
  for (let i = 0; i < slice.length; i++) {
    const m = slice[i]; const actualIdx = start + i; const isSel = actualIdx === sel; const rc = isSel ? C.accent : C.text;
    const modeLabels: Record<string, string> = { "keep_both": "Both", "mp4_only": "MP4", "mkv_only": "MKV" }
    const line = `${(isSel ? "\u25B8" : " ") + (actualIdx + 1).toString().padEnd(3)} [${m.confirmedFormat.slice(0, 3)}] (${modeLabels[m.conversionMode].padEnd(4)}) ${m.resolvedTitle.slice(0, 30)}`.padEnd(70)
    out.push(Box({ flexDirection: "row", backgroundColor: isSel ? "#252b37" : undefined, paddingLeft: 2 },
      Text({ content: t`${fg(rc)(line)}` }),
    ))
  }
  if (movies[sel]) {
    const previewStr = ` Preview: ${movies[sel].resolvedTitle}`.padEnd(80)
    out.push(Box({ flexDirection: "column", borderStyle: "rounded", borderColor: C.border, padding: 0, width: "100%", backgroundColor: "#0d1117", marginTop: 0 },
      Text({ content: t`${bold(fg(C.accent)(previewStr))}` })))
  }
  return out
}

// ── Progress View ──────────────────────────────────────────────────────────
function renderProgress(): any[] {
  const out: any[] = [Box({ width: "100%", alignItems: "center", marginBottom: 1 }, Text({ content: t`${bold(fg(C.text)("Step 3: Processing"))}` }))]
  for (const m of movies.slice(0, 8)) {
    let icon = "\u25CB", color = C.dim
    if (m.status === "converting") { icon = "\u25C9"; color = C.yellow }
    else if (m.status === "done") { icon = "\u2713"; color = C.green }
    else if (m.status === "error") { icon = "\u2717"; color = C.red }
    const bar = m.status === "converting" && procIdx === movies.indexOf(m) ? ` ${Math.round(procPct)}%` : ""
    const line = `${icon} ${m.resolvedTitle.slice(0, 35)}${bar}`.padEnd(70)
    out.push(Box({ flexDirection: "row", gap: 1, paddingLeft: 2 }, Text({ content: t`${fg(color)(line)}` })))
  }
  return out
}

// ── Key Handling ───────────────────────────────────────────────────────────
renderer.keyInput.on("keypress", async (keyEvent) => {
  const key = (keyEvent.name || keyEvent.sequence || "").toLowerCase();
  if (key === "q") quit()
  if (isProcessing) return
  error = ""

  if (editIdx >= 0) {
    if (key === "escape") { editIdx = -1; editVal = ""; render(); return }
    if (key === "return") {
      const isInit = view === "init"
      const keyToEdit = isInit ? (editIdx === 0 ? "sourceDir" : "outputDir") : ALL_SETTINGS[editIdx].key;
      (config as any)[keyToEdit] = editVal
      saveConfig(config)
      status = `Updated!`
      editIdx = -1; editVal = ""; render(); return
    }
    if (key === "backspace") { editVal = editVal.slice(0, -1); render(); return }
    if (!isPasting && keyEvent.sequence && keyEvent.sequence.length === 1) { editVal += keyEvent.sequence; render(); return }
    return
  }

  if (key === "s") {
    if (view === "settings") setView(flowStep as AppView)
    else { view = "settings"; render() }
    return
  }
  if (view === "settings" && key === "escape") { setView(flowStep as AppView); return }

  const maxIdx = view === "settings" ? ALL_SETTINGS.length - 1 : view === "init" ? 2 : view === "review" ? movies.length - 1 : 0
  if (key === "up" && sel > 0) { sel--; render(); return }
  if (key === "down" && sel < maxIdx) { sel++; render(); return }

  if (view === "init" && key === "return") {
    if (sel === 2) { flowStep = "scan"; setView("scan") }
    else { editIdx = sel; editType = "setting"; editVal = (config as any)[sel === 0 ? "sourceDir" : "outputDir"]; render() }
    return
  }
  if (view === "settings" && key === "return") { editIdx = sel; editType = "setting"; editVal = (config as any)[ALL_SETTINGS[sel].key]; render(); return }
  if (view === "scan" && key === "return") {
    if (movies.length > 0) { flowStep = "review"; setView("review"); return }
    status = "Scanning..."; render()
    try {
      movies = scanDirectory(config.sourceDir, config)
      if (!movies.length) { error = `No files found!`; render(); return }
      status = `Resolving titles...`; render()
      await resolveTitles(movies, config, (i, n) => { status = `Resolving: ${i}/${n}`; render() })
      status = `Done! ENTER to proceed.`; render()
    } catch (e) { error = e instanceof Error ? e.message : String(e); render() }
    return
  }
  if (view === "review") {
    if (key === "f") { if (movies[sel]) { const idx = FORMATS.indexOf(movies[sel].confirmedFormat); movies[sel].confirmedFormat = FORMATS[(idx + 1) % 3]; render() }; return }
    if (key === "m") { if (movies[sel]) { const MODES = ["keep_both", "mp4_only", "mkv_only"] as const; const idx = MODES.indexOf(movies[sel].conversionMode as any); movies[sel].conversionMode = MODES[(idx + 1) % 3]; render() }; return }
    if (key === "e") { if (movies[sel]) { editIdx = sel; editType = "title"; editVal = movies[sel].resolvedTitle; render() }; return }
    if (key === "y") { if (movies[sel]) { editIdx = sel; editType = "year"; editVal = movies[sel].resolvedYear; render() }; return }
    if (key === "return") { for (const m of movies) if (m.status === "title-resolved" || m.status === "pending") m.status = "ready"; flowStep = "progress"; setView("progress"); return }
    if (key === "escape") { flowStep = "scan"; setView("scan"); return }
  }
  if (view === "progress" && key === "return") {
    const ready = movies.filter((m) => m.status === "ready" || m.status === "title-resolved")
    if (!ready.length) { error = "No movies ready."; render(); return }
    isProcessing = true; status = "Processing..."; render()
    try { await runPipeline(movies, config, (updated, idx, pct) => { movies = updated; procIdx = idx; procPct = pct; render() }); status = "All done!" } catch (e) { error = e instanceof Error ? e.message : String(e) }
    isProcessing = false; render()
  }
  if (view === "progress" && key === "escape") { flowStep = "review"; setView("review"); return }
})

try {
  render()
  render()
} catch (e) {
  console.error("Critical Startup Error:", e)
}
