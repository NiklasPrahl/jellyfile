import type { MovieFile, AppConfig } from "../types"

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
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
        maxOutputTokens: 2048,
        responseMimeType: "application/json" 
      },
    }),
  })
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`)
  const data = await res.json() as any
  return JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "[]")
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
  
  let parsed = JSON.parse(content)
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
  let parsed = JSON.parse(data.response || "[]")
  
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
    let results: any[] = []
    
    if (config.llmProvider === "gemini") {
      if (!config.geminiApiKey) throw new Error("Gemini API Key missing")
      results = await callGemini(pending, config.geminiApiKey)
    } else if (config.llmProvider === "groq") {
      if (!config.groqApiKey) throw new Error("Groq API Key missing")
      results = await callGroq(pending, config.groqApiKey)
    } else if (config.llmProvider === "ollama") {
      results = await callOllama(pending, config.ollamaBaseUrl, config.ollamaModel)
    }

    for (const res of results) {
      const movie = pending.find(m => m.originalName === res.original)
      if (movie) {
        movie.resolvedTitle = res.title
        movie.resolvedYear = res.year
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
    for (const m of pending) {
      m.error = err instanceof Error ? err.message : String(err)
      m.status = "error"
    }
  }
  
  onProgress?.(movies.length, movies.length)
}
