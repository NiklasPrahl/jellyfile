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
      model: "llama-3.3-70b-versatile",
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

export async function resolveTitles(
  movies: MovieFile[],
  config: AppConfig,
  onProgress?: (i: number, total: number) => void
): Promise<void> {
  const pending = movies.filter(m => m.status === "pending")
  if (!pending.length) return

  try {
    const results: any[] = []

    // Process in chunks of 10 movies to stay within token limits and handle thinking models safely
    const chunkSize = 10
    for (let i = 0; i < pending.length; i += chunkSize) {
      const chunk = pending.slice(i, i + chunkSize)
      let chunkResults: any[] = []

      if (config.llmProvider === "gemini") {
        if (!config.geminiApiKey) throw new Error("Gemini API Key missing")
        chunkResults = await callGemini(chunk, config.geminiApiKey)
      } else if (config.llmProvider === "groq") {
        if (!config.groqApiKey) throw new Error("Groq API Key missing")
        chunkResults = await callGroq(chunk, config.groqApiKey)
      } else if (config.llmProvider === "ollama") {
        chunkResults = await callOllama(chunk, config.ollamaBaseUrl, config.ollamaModel)
      }

      results.push(...chunkResults)
      onProgress?.(Math.min(i + chunk.length, pending.length), pending.length)
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
