// AudioHelper.ts
// Handles audio transcription via AI providers and answer generation.
// Supports concurrent chunk processing for real-time transcription.
import fs from "node:fs"
import path from "node:path"
import { app, BrowserWindow } from "electron"
import { OpenAI } from "openai"
import * as axios from "axios"
import Anthropic from "@anthropic-ai/sdk"
import { configHelper } from "./ConfigHelper"
import { KnowledgeBaseHelper } from "./KnowledgeBaseHelper"

export interface AudioTranscriptionResult {
  text: string
  timestamp: number
  chunkId: number
}

export interface AudioAnswerResult {
  question: string
  answer: string
  timestamp: number
}

export const AUDIO_EVENTS = {
  TRANSCRIPTION_UPDATE: "audio-transcription-update",
  ANSWER_UPDATE: "audio-answer-update",
  AUDIO_ERROR: "audio-error",
  AUDIO_STATUS: "audio-status",
} as const

export class AudioHelper {
  private mainWindow: () => BrowserWindow | null
  private knowledgeBase: KnowledgeBaseHelper
  private transcriptionHistory: AudioTranscriptionResult[] = []
  private currentAbortController: AbortController | null = null
  private isProcessing = false

  // Concurrent pipeline state
  private chunkCounter = 0
  private activeTranscriptions = 0
  private readonly MAX_CONCURRENT = 3 // max parallel transcription requests

  constructor(
    getMainWindow: () => BrowserWindow | null,
    knowledgeBase: KnowledgeBaseHelper
  ) {
    this.mainWindow = getMainWindow
    this.knowledgeBase = knowledgeBase
  }

  /**
   * Transcribe an audio buffer using the configured AI provider.
   */
  public async transcribeAudio(audioBuffer: Buffer): Promise<string> {
    const config = configHelper.loadConfig()
    const provider = config.apiProvider

    if (provider === "openai") {
      return this.transcribeWithWhisper(audioBuffer, config)
    } else if (provider === "gemini") {
      return this.transcribeWithGemini(audioBuffer, config)
    } else if (provider === "anthropic") {
      // Anthropic has no native audio — fall back to Gemini-style endpoint
      return this.transcribeWithGemini(audioBuffer, config)
    }

    throw new Error("No supported transcription provider configured")
  }

  /**
   * OpenAI Whisper transcription
   */
  private async transcribeWithWhisper(
    audioBuffer: Buffer,
    config: any
  ): Promise<string> {
    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.openaiBaseUrl,
      timeout: 15000, // tighter timeout for real-time
    })

    const tmpPath = path.join(
      app.getPath("temp"),
      `audio-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.webm`
    )
    fs.writeFileSync(tmpPath, audioBuffer)

    try {
      const transcription = await client.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath) as any,
        model: "whisper-1",
        language: "zh",
        response_format: "text",
      })

      return (transcription as any).toString().trim()
    } finally {
      try { fs.unlinkSync(tmpPath) } catch {}
    }
  }

  /**
   * Gemini transcription — send audio as inline data
   */
  private async transcribeWithGemini(
    audioBuffer: Buffer,
    config: any
  ): Promise<string> {
    const rawBase =
      config.geminiBaseUrl || "https://generativelanguage.googleapis.com"
    const baseUrl = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase
    const modelName = config.geminiModel || "gemini-2.0-flash"
    const apiKey = config.apiKey

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "audio/webm",
                data: audioBuffer.toString("base64"),
              },
            },
            {
              text: '请将这段音频转录为文字。只输出转录结果，不要添加任何其他内容。如果音频中没有可辨别的语音内容，请输出"[无语音]"。',
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
      },
    }

    const response = await axios.default.post(
      `${baseUrl}/models/${modelName}:generateContent?key=${apiKey}`,
      body,
      { timeout: 15000 }
    )

    const candidates = response.data?.candidates || []
    if (!candidates.length) return ""

    const parts = candidates[0]?.content?.parts || []
    return parts
      .filter((p: any) => typeof p?.text === "string" && p.text.trim())
      .map((p: any) => p.text.trim())
      .join("\n")
      .trim()
  }

  /**
   * Process an audio chunk concurrently.
   * Does NOT block — fires the transcription request and resolves
   * immediately so the caller can keep sending new chunks.
   */
  public async processAudioChunk(audioData: Buffer): Promise<void> {
    // Don't queue too many concurrent requests
    if (this.activeTranscriptions >= this.MAX_CONCURRENT) {
      console.log(
        `Skipping chunk — ${this.activeTranscriptions} transcriptions already in-flight`
      )
      return
    }

    const chunkId = ++this.chunkCounter
    this.activeTranscriptions++

    // Fire-and-forget — don't await so the renderer can keep sending
    this.transcribeChunk(audioData, chunkId).finally(() => {
      this.activeTranscriptions--
    })
  }

  /**
   * Internal: transcribe a single chunk and emit the result to the renderer.
   */
  private async transcribeChunk(
    audioData: Buffer,
    chunkId: number
  ): Promise<void> {
    const win = this.mainWindow()
    if (!win || win.isDestroyed()) return

    try {
      const text = await this.transcribeAudio(audioData)

      if (!text || text === "[无语音]" || text.length < 2) {
        return // silence
      }

      const result: AudioTranscriptionResult = {
        text,
        timestamp: Date.now(),
        chunkId,
      }
      this.transcriptionHistory.push(result)

      // Keep last 100 entries
      if (this.transcriptionHistory.length > 100) {
        this.transcriptionHistory = this.transcriptionHistory.slice(-100)
      }

      win.webContents.send(AUDIO_EVENTS.TRANSCRIPTION_UPDATE, result)
    } catch (error: any) {
      console.error(`Transcription error (chunk ${chunkId}):`, error.message)
      // Only surface the error for the first few failures, not every chunk
      if (this.activeTranscriptions <= 1) {
        win.webContents.send(AUDIO_EVENTS.AUDIO_ERROR, {
          message: error.message || "转录失败",
        })
      }
    }
  }

  /**
   * Generate an AI answer based on accumulated transcriptions + knowledge base.
   */
  public async generateAnswer(customQuestion?: string): Promise<void> {
    const win = this.mainWindow()
    if (!win || win.isDestroyed()) return

    if (this.isProcessing) {
      win.webContents.send(AUDIO_EVENTS.AUDIO_STATUS, {
        message: "正在生成答案，请稍候...",
      })
      return
    }

    this.isProcessing = true
    this.currentAbortController = new AbortController()

    try {
      win.webContents.send(AUDIO_EVENTS.AUDIO_STATUS, {
        message: "正在分析问题并生成答案...",
      })

      const recentTranscriptions = this.transcriptionHistory
        .slice(-30)
        .map((t) => t.text)
        .join("\n")

      const question = customQuestion || recentTranscriptions

      if (!question.trim()) {
        win.webContents.send(AUDIO_EVENTS.AUDIO_ERROR, {
          message: "没有检测到语音内容，无法生成答案",
        })
        return
      }

      const kbContext = this.knowledgeBase.getContextForPrompt()
      const config = configHelper.loadConfig()
      const language = config.language || "python"

      const systemPrompt = `你是一个面试助手。根据听到的面试问题，给出准确、简洁的回答。

规则：
1. 如果是技术面试题（算法/数据结构/系统设计等），给出专业的技术回答
2. 如果涉及代码，使用 ${language} 语言，并用 Markdown 代码块包裹
3. 如果是行为面试题，给出结构化的回答（STAR 方法）
4. 回答要简洁但完整，重点突出
5. 如果提供了知识库内容，优先参考知识库中的信息来作答`

      const userMessage = kbContext
        ? `以下是我的个人知识库/笔记内容，请参考：
---
${kbContext}
---

面试官的问题/对话内容：
${question}

请根据以上内容给出回答。`
        : `面试官的问题/对话内容：
${question}

请给出回答。`

      let answerText = ""

      if (config.apiProvider === "openai") {
        const client = new OpenAI({
          apiKey: config.apiKey,
          baseURL: config.openaiBaseUrl,
          timeout: 60000,
          maxRetries: 2,
        })

        const response = await client.chat.completions.create({
          model: config.openaiModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          max_tokens: 4000,
          temperature: 0.3,
        })

        answerText = response.choices[0]?.message?.content || ""
      } else if (config.apiProvider === "gemini") {
        const rawBase =
          config.geminiBaseUrl || "https://generativelanguage.googleapis.com"
        const baseUrl = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase
        const modelName = config.geminiModel

        const body = {
          contents: [
            {
              role: "user",
              parts: [{ text: `${systemPrompt}\n\n${userMessage}` }],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 8192,
          },
        }

        const response = await axios.default.post(
          `${baseUrl}/models/${modelName}:generateContent?key=${config.apiKey}`,
          body,
          { signal: this.currentAbortController?.signal }
        )

        const candidates = response.data?.candidates || []
        if (candidates.length) {
          const parts = candidates[0]?.content?.parts || []
          answerText = parts
            .map((p: any) => p?.text || "")
            .join("\n")
            .trim()
        }
      } else if (config.apiProvider === "anthropic") {
        const client = new Anthropic({
          apiKey: config.apiKey,
          baseURL: config.anthropicBaseUrl,
          timeout: 60000,
          maxRetries: 2,
        })

        const response = await client.messages.create({
          model: config.anthropicModel,
          max_tokens: 4000,
          temperature: 0.3,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        })

        const textParts: string[] = []
        for (const part of response.content as Array<{
          type: string
          text?: string
        }>) {
          if (part.type === "text" && typeof part.text === "string") {
            textParts.push(part.text.trim())
          }
        }
        answerText = textParts.join("\n").trim()
      }

      if (!answerText) {
        throw new Error("模型未返回内容")
      }

      const answerResult: AudioAnswerResult = {
        question,
        answer: answerText,
        timestamp: Date.now(),
      }

      win.webContents.send(AUDIO_EVENTS.ANSWER_UPDATE, answerResult)
      win.webContents.send(AUDIO_EVENTS.AUDIO_STATUS, {
        message: "答案生成完成",
      })
    } catch (error: any) {
      console.error("Answer generation error:", error)
      if (!axios.isCancel(error)) {
        win.webContents.send(AUDIO_EVENTS.AUDIO_ERROR, {
          message: error.message || "答案生成失败",
        })
      }
    } finally {
      this.isProcessing = false
      this.currentAbortController = null
    }
  }

  public cancelGeneration(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    this.isProcessing = false
  }

  public clearHistory(): void {
    this.transcriptionHistory = []
    this.chunkCounter = 0
  }

  public getTranscriptionText(): string {
    return this.transcriptionHistory.map((t) => t.text).join("\n")
  }
}
