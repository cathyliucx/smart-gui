/**
 * TTS (Text-to-Speech) utility using Web Speech API.
 *
 * Key design:
 * - Splits long text into sentence-level chunks to prevent Chromium's
 *   SpeechSynthesis from silently truncating after ~15 seconds.
 * - Queues chunks and speaks them sequentially.
 * - Strips Markdown code blocks / formatting before speaking.
 * - Provides stop() to cancel immediately.
 */

let currentUtterances: SpeechSynthesisUtterance[] = []
let isSpeaking = false
let stopRequested = false

/**
 * Split text into speakable chunks (by sentence / paragraph).
 * Each chunk is short enough that SpeechSynthesis won't truncate it.
 */
function splitIntoChunks(text: string): string[] {
  // Strip markdown code blocks — don't read code aloud
  let cleaned = text.replace(/```[\s\S]*?```/g, "（代码块已省略）")
  // Strip inline code
  cleaned = cleaned.replace(/`[^`]+`/g, (match) => match.replace(/`/g, ""))
  // Strip markdown headers
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, "")
  // Strip bold/italic markers
  cleaned = cleaned.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
  // Strip bullet prefixes
  cleaned = cleaned.replace(/^[\s]*[-*•]\s+/gm, "")

  // Split by sentence-ending punctuation (Chinese and English)
  const sentences = cleaned.split(/(?<=[。！？.!?\n])\s*/).filter((s) => s.trim().length > 0)

  // Merge very short fragments, keep each chunk under ~200 chars
  const chunks: string[] = []
  let buffer = ""
  for (const sentence of sentences) {
    if (buffer.length + sentence.length > 200 && buffer.length > 0) {
      chunks.push(buffer.trim())
      buffer = ""
    }
    buffer += sentence
  }
  if (buffer.trim().length > 0) {
    chunks.push(buffer.trim())
  }

  return chunks
}

/**
 * Speak the given text using TTS.
 * If already speaking, stops current speech and starts the new one.
 * Does NOT truncate — speaks the full content by chunking.
 */
export function speak(text: string, lang = "zh-CN"): void {
  stop()

  if (!text || !window.speechSynthesis) return

  const chunks = splitIntoChunks(text)
  if (chunks.length === 0) return

  isSpeaking = true
  stopRequested = false
  currentUtterances = []

  const speakNext = (index: number) => {
    if (stopRequested || index >= chunks.length) {
      isSpeaking = false
      currentUtterances = []
      return
    }

    const utterance = new SpeechSynthesisUtterance(chunks[index])
    utterance.lang = lang
    utterance.rate = 1.1
    utterance.pitch = 1.0

    utterance.onend = () => {
      speakNext(index + 1)
    }

    utterance.onerror = (e) => {
      // 'interrupted' and 'canceled' are normal when stop() is called
      if (e.error !== "interrupted" && e.error !== "canceled") {
        console.error("TTS error:", e.error)
      }
      // Try to continue with next chunk on non-fatal errors
      if (!stopRequested) {
        speakNext(index + 1)
      }
    }

    currentUtterances.push(utterance)
    window.speechSynthesis.speak(utterance)
  }

  speakNext(0)
}

/**
 * Stop any ongoing TTS playback immediately.
 */
export function stop(): void {
  stopRequested = true
  isSpeaking = false
  currentUtterances = []
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel()
  }
}

/**
 * Check if TTS is currently active.
 */
export function isTTSSpeaking(): boolean {
  return isSpeaking
}
