import type { MovieFile, AppConfig } from "../types"
import { logError } from "./pipeline"
import { sanitizeTitle } from "./naming"

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent"
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

const PROMPT_TEMPLATE = (fileList: string) => `Du bist ein Experte für Filmdatenbanken. Ich gebe dir eine Liste von Videodateien mit ihren Dateigrößen. Für jede Datei:
1. Recherchiere den korrekten deutschen Filmtitel und das Erscheinungsjahr (Kinopremiere).
2. Nutze den offiziellen deutschen Verleihtitel (nicht den Originaltitel, sofern ein deutscher existiert).

Antworte ausschließlich als JSON-Array:
[
  {
    "original": "Filename.mkv",
    "title": "Filmtitel",
    "year": "1999"
  }
]

Regeln für den Titel:
- Korrekte deutsche Groß-/Kleinschreibung
- Sonderzeichen ' " , ? % & sind verboten. Ersetze & durch "and", alle anderen entfernen.
- Verboten sind außerdem < > / \\ | * Entferne sie. Einen Doppelpunkt ersetzt du durch " - " (z.B. "Star Wars - Episode IV").
- Umlaute sind erlaubt (ä, ö, ü, ß)

Hier sind die Dateien:
${fileList}`

async function callGemini(pending: MovieFile[], apiKey: string) {
  const fileList = pending.map(m => `- ${m.originalName} (${m.sizeHuman})`).join("\n")
  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT_TEMPLATE(fileList) }] }],
      generationConfig: { 
        temperature: 0.1, 
        maxOutputTokens: 8192,
        responseMimeType: "application/json" 
      },
    }),
  })
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`)
  const data = await res.json() as any
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]"
  try {
    return JSON.parse(text)
  } catch (err) {
    const snippet = text.substring(0, 150) + (text.length > 150 ? "..." : "")
    throw new Error(`JSON Parse Error: ${err instanceof Error ? err.message : String(err)} (Raw Response: ${snippet})`)
  }
}

async function callGroq(pending: MovieFile[], apiKey: string) {
  const fileList = pending.map(m => `- ${m.originalName} (${m.sizeHuman})`).join("\n")
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: PROMPT_TEMPLATE(fileList) }],
      temperature: 0.1,
      response_format: { type: "json_object" }
    }),
  })
  if (!res.ok) throw new Error(`Groq API ${res.status}: ${await res.text()}`)
  const data = await res.json() as any
  const content = data.choices?.[0]?.message?.content || "{}"

  let parsed: any
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    const snippet = content.substring(0, 150) + (content.length > 150 ? "..." : "")
    throw new Error(`JSON Parse Error: ${err instanceof Error ? err.message : String(err)} (Raw Response: ${snippet})`)
  }

  // If Groq returns { "movies": [...] } or similar, extract the array
  if (!Array.isArray(parsed)) {
    const key = Object.keys(parsed).find(k => Array.isArray(parsed[k]))
    if (key) parsed = parsed[key]
    else if (parsed.original && parsed.title) parsed = [parsed] // Single object fallback
  }
  return Array.isArray(parsed) ? parsed : []
}

async function callOllama(pending: MovieFile[], baseUrl: string, model: string) {
  const fileList = pending.map(m => `- ${m.originalName} (${m.sizeHuman})`).join("\n")
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model,
      prompt: PROMPT_TEMPLATE(fileList),
      stream: false,
      format: "json",
      options: { temperature: 0.1 }
    }),
  })
  if (!res.ok) throw new Error(`Ollama API ${res.status}: ${await res.text()}`)
  const data = await res.json() as any
  const responseText = data.response || "[]"

  let parsed: any
  try {
    parsed = JSON.parse(responseText)
  } catch (err) {
    const snippet = responseText.substring(0, 150) + (responseText.length > 150 ? "..." : "")
    throw new Error(`JSON Parse Error: ${err instanceof Error ? err.message : String(err)} (Raw Response: ${snippet})`)
  }

  if (!Array.isArray(parsed)) {
    const key = Object.keys(parsed).find(k => Array.isArray(parsed[k]))
    if (key) parsed = parsed[key]
    else if (parsed.original && parsed.title) parsed = [parsed]
  }
  return Array.isArray(parsed) ? parsed : []
}

// ── Retry helpers ────────────────────────────────────────────────────────────

const RETRY_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes

/** Returns true for server/network errors worth retrying. */
function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b(5\d{2}|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed)/i.test(msg)
}

/**
 * Waits `ms` milliseconds, but resolves early (returning false) if the
 * AbortSignal fires before then. Returns true on normal completion.
 */
function waitOrAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(false); return }
    const timer = setTimeout(() => { cleanup(); resolve(true) }, ms)
    function cleanup() { signal?.removeEventListener("abort", onAbort) }
    function onAbort() { clearTimeout(timer); cleanup(); resolve(false) }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** Dispatches one chunk to the configured LLM provider, with optional retry. */
async function callProvider(
  chunk: MovieFile[],
  config: AppConfig,
  opts: {
    autoRetry: boolean
    signal?: AbortSignal
    onRetry?: (secondsLeft: number, attempt: number) => void
  }
): Promise<any[]> {
  let attempt = 0
  while (true) {
    attempt++
    try {
      if (config.llmProvider === "gemini") {
        if (!config.geminiApiKey) throw new Error("Gemini API Key missing")
        return await callGemini(chunk, config.geminiApiKey)
      } else if (config.llmProvider === "groq") {
        if (!config.groqApiKey) throw new Error("Groq API Key missing")
        return await callGroq(chunk, config.groqApiKey)
      } else if (config.llmProvider === "ollama") {
        return await callOllama(chunk, config.ollamaBaseUrl, config.ollamaModel)
      }
      return []
    } catch (err) {
      if (!opts.autoRetry || !isTransient(err)) throw err
      if (opts.signal?.aborted) throw new Error("Vom Nutzer abgebrochen")

      // Count down RETRY_INTERVAL_MS in 1-second steps
      const totalSecs = RETRY_INTERVAL_MS / 1000
      for (let s = totalSecs; s > 0; s--) {
        if (opts.signal?.aborted) throw new Error("Vom Nutzer abgebrochen")
        opts.onRetry?.(s, attempt)
        const continued = await waitOrAbort(1000, opts.signal)
        if (!continued) throw new Error("Vom Nutzer abgebrochen")
      }
    }
  }
}


export interface ResolveTitlesOptions {
  /** Called after each chunk completes: processed count, total. */
  onProgress?: (i: number, total: number) => void
  /** Called every second during a retry wait: seconds left, attempt number. */
  onRetry?: (secondsLeft: number, attempt: number) => void
  /** Abort the retry countdown immediately (e.g. user presses Q). */
  signal?: AbortSignal
}

export async function resolveTitles(
  movies: MovieFile[],
  config: AppConfig,
  onProgressOrOpts?: ((i: number, total: number) => void) | ResolveTitlesOptions
): Promise<void> {
  // Accept both legacy `onProgress` callback and new options object
  const opts: ResolveTitlesOptions = typeof onProgressOrOpts === "function"
    ? { onProgress: onProgressOrOpts }
    : (onProgressOrOpts ?? {})

  const pending = movies.filter(m => m.status === "pending")
  if (!pending.length) return

  const autoRetry = config.llmAutoRetry === "on"

  try {
    const results: any[] = []

    // Process in chunks of 10 movies to stay within token limits
    const chunkSize = 10
    for (let i = 0; i < pending.length; i += chunkSize) {
      const chunk = pending.slice(i, i + chunkSize)

      const chunkResults = await callProvider(chunk, config, {
        autoRetry,
        signal: opts.signal,
        onRetry: opts.onRetry,
      })

      results.push(...chunkResults)
      opts.onProgress?.(Math.min(i + chunk.length, pending.length), pending.length)
    }

    for (const res of results) {
      const movie = pending.find(m => m.originalName === res.original)
      if (movie) {
        // Jellyfin-safe title (illegal characters removed, ":" -> " - ")
        movie.resolvedTitle = sanitizeTitle(String(res.title ?? ""))
        movie.resolvedYear = String(res.year ?? "").trim()
        movie.status = "title-resolved"
      }
    }

    // Mark remaining as error if not found in JSON
    for (const m of pending) {
      if (m.status === "pending") {
        m.status = "error"
        m.error = "Not found in LLM response"
      }
    }

  } catch (err) {
    logError(err, "LLM Title Resolution")
    for (const m of pending) {
      m.error = err instanceof Error ? err.message : String(err)
      m.status = "error"
    }
    throw err
  }
}
