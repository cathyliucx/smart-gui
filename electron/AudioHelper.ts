// AudioHelper.ts
// Handles multimodal understanding via AI providers.
// Supports: audio only, screenshot only, audio + screenshot combined.
// Uses native multimodal capabilities of models (Gemini audio+vision, OpenAI GPT-4o vision, Claude vision).
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

  // Accumulated audio chunks for multimodal processing
  private audioChunks: Buffer[] = []

  constructor(
    getMainWindow: () => BrowserWindow | null,
    knowledgeBase: KnowledgeBaseHelper
  ) {
    this.mainWindow = getMainWindow
    this.knowledgeBase = knowledgeBase
  }

  /**
   * Transcribe an audio buffer using the configured AI provider.
   * Used for real-time transcription display.
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
      timeout: 15000,
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
   * Also accumulates audio chunks for later multimodal processing.
   */
  public async processAudioChunk(audioData: Buffer): Promise<void> {
    // Accumulate for multimodal processing
    this.audioChunks.push(audioData)
    // Keep last 20 chunks (~60s at 3s/chunk)
    if (this.audioChunks.length > 20) {
      this.audioChunks = this.audioChunks.slice(-20)
    }

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
      if (this.activeTranscriptions <= 1) {
        win.webContents.send(AUDIO_EVENTS.AUDIO_ERROR, {
          message: error.message || "转录失败",
        })
      }
    }
  }

  /**
   * Multimodal understanding: send audio and/or screenshots directly to the model.
   * This is the core method — replaces the old two-step transcribe→answer flow.
   *
   * Supported modes:
   * - Audio only: sends recent audio chunks directly to the model
   * - Screenshot only: sends screenshot images to the model
   * - Audio + Screenshot: sends both for combined understanding
   *
   * Provider capabilities:
   * - Gemini: native audio + vision (best for multimodal)
   * - OpenAI: vision + whisper transcription (audio sent as text)
   * - Anthropic: vision only (audio sent as text via whisper/gemini)
   */
  public async processMultimodal(
    screenshotPaths?: string[],
    customQuestion?: string
  ): Promise<void> {
    const win = this.mainWindow()
    if (!win || win.isDestroyed()) return

    if (this.isProcessing) {
      win.webContents.send(AUDIO_EVENTS.AUDIO_STATUS, {
        message: "正在处理中，请稍候...",
      })
      return
    }

    this.isProcessing = true
    this.currentAbortController = new AbortController()

    try {
      const config = configHelper.loadConfig()
      const language = config.language || "python"
      const kbContext = this.knowledgeBase.getContextForPrompt()

      const hasAudio = this.audioChunks.length > 0
      const hasScreenshots = screenshotPaths && screenshotPaths.length > 0
      const hasTranscription = this.transcriptionHistory.length > 0

      if (!hasAudio && !hasScreenshots && !hasTranscription && !customQuestion) {
        win.webContents.send(AUDIO_EVENTS.AUDIO_ERROR, {
          message: "没有音频或截图输入，无法生成答案",
        })
        return
      }

      // Build status message
      const inputTypes: string[] = []
      if (hasAudio) inputTypes.push("音频")
      if (hasScreenshots) inputTypes.push(`截图(${screenshotPaths!.length}张)`)
      if (customQuestion) inputTypes.push("自定义问题")
      win.webContents.send(AUDIO_EVENTS.AUDIO_STATUS, {
        message: `正在用多模态模型理解 ${inputTypes.join(" + ")}...`,
      })

      // Load screenshot data
      const screenshotDataList: Array<{ base64: string; mimeType: string }> = []
      if (hasScreenshots) {
        for (const p of screenshotPaths!) {
          if (fs.existsSync(p)) {
            const data = fs.readFileSync(p)
            screenshotDataList.push({
              base64: data.toString("base64"),
              mimeType: "image/png",
            })
          }
        }
      }

      // Merge recent audio into one buffer for multimodal providers
      let mergedAudioBase64: string | null = null
      if (hasAudio) {
        const recentChunks = this.audioChunks.slice(-10) // last ~30s
        const merged = Buffer.concat(recentChunks)
        mergedAudioBase64 = merged.toString("base64")
      }

      // Get transcription text as fallback for providers that don't support audio
      const transcriptionText = this.transcriptionHistory
        .slice(-30)
        .map((t) => t.text)
        .join("\n")

      const systemPrompt = `你是一个面试助手。你会接收到面试过程中的音频、截图或两者的组合。
请理解所有输入内容，并给出准确、简洁的回答。

规则：
1. 如果是技术面试题（算法/数据结构/系统设计等），给出专业的技术回答
2. 如果涉及代码，使用 ${language} 语言，并用 Markdown 代码块包裹
3. 如果是行为面试题，给出结构化的回答（STAR 方法）
4. 如果是选择题，直接给出选项字母和简短解释
5. 回答要简洁但完整，重点突出
6. 如果同时有音频和截图，综合两者的信息来理解题意
7. 如果提供了知识库内容，优先参考知识库中的信息来作答`

      let answerText = ""

      if (config.apiProvider === "gemini") {
        answerText = await this.processMultimodalGemini(
          config, systemPrompt, kbContext, customQuestion,
          mergedAudioBase64, screenshotDataList, transcriptionText
        )
      } else if (config.apiProvider === "openai") {
        answerText = await this.processMultimodalOpenAI(
          config, systemPrompt, kbContext, customQuestion,
          mergedAudioBase64, screenshotDataList, transcriptionText
        )
      } else if (config.apiProvider === "anthropic") {
        answerText = await this.processMultimodalAnthropic(
          config, systemPrompt, kbContext, customQuestion,
          screenshotDataList, transcriptionText
        )
      }

      if (!answerText) {
        throw new Error("模型未返回内容")
      }

      const answerResult: AudioAnswerResult = {
        question: customQuestion || transcriptionText || "[多模态输入]",
        answer: answerText,
        timestamp: Date.now(),
      }

      win.webContents.send(AUDIO_EVENTS.ANSWER_UPDATE, answerResult)
      win.webContents.send(AUDIO_EVENTS.AUDIO_STATUS, {
        message: "答案生成完成",
      })
    } catch (error: any) {
      console.error("Multimodal processing error:", error)
      if (!axios.isCancel(error)) {
        win.webContents.send(AUDIO_EVENTS.AUDIO_ERROR, {
          message: error.message || "多模态处理失败",
        })
      }
    } finally {
      this.isProcessing = false
      this.currentAbortController = null
    }
  }

  /**
   * Gemini: native multimodal — audio + images in a single request.
   */
  private async processMultimodalGemini(
    config: any,
    systemPrompt: string,
    kbContext: string,
    customQuestion: string | undefined,
    audioBase64: string | null,
    screenshots: Array<{ base64: string; mimeType: string }>,
    transcriptionText: string
  ): Promise<string> {
    const rawBase = config.geminiBaseUrl || "https://generativelanguage.googleapis.com"
    const baseUrl = rawBase.endsWith("/") ? rawBase.slice(0, -1) : rawBase
    const modelName = config.geminiModel || "gemini-2.0-flash"

    const parts: any[] = []

    // Add audio data natively
    if (audioBase64) {
      parts.push({
        inlineData: {
          mimeType: "audio/webm",
          data: audioBase64,
        },
      })
    }

    // Add screenshots natively
    for (const s of screenshots) {
      parts.push({
        inlineData: {
          mimeType: s.mimeType,
          data: s.base64,
        },
      })
    }

    // Build text prompt
    let textPrompt = systemPrompt + "\n\n"
    if (kbContext) {
      textPrompt += `以下是知识库内容，请参考：\n---\n${kbContext}\n---\n\n`
    }
    if (customQuestion) {
      textPrompt += `用户问题：${customQuestion}\n\n`
    }
    if (audioBase64) {
      textPrompt += "请理解上面的音频内容。"
    }
    if (screenshots.length > 0) {
      textPrompt += "请理解上面的截图内容。"
    }
    if (audioBase64 && screenshots.length > 0) {
      textPrompt = textPrompt.replace(
        "请理解上面的音频内容。请理解上面的截图内容。",
        "请综合理解上面的音频和截图内容。"
      )
    }
    textPrompt += "\n请给出回答。"

    parts.push({ text: textPrompt })

    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192,
      },
    }

    const response = await axios.default.post(
      `${baseUrl}/models/${modelName}:generateContent?key=${config.apiKey}`,
      body,
      { signal: this.currentAbortController?.signal, timeout: 60000 }
    )

    const candidates = response.data?.candidates || []
    if (!candidates.length) return ""

    const respParts = candidates[0]?.content?.parts || []
    return respParts
      .map((p: any) => p?.text || "")
      .join("\n")
      .trim()
  }

  /**
   * OpenAI: vision + text. Audio is transcribed first then sent as text.
   * GPT-4o supports images natively but not raw audio.
   */
  private async processMultimodalOpenAI(
    config: any,
    systemPrompt: string,
    kbContext: string,
    customQuestion: string | undefined,
    audioBase64: string | null,
    screenshots: Array<{ base64: string; mimeType: string }>,
    transcriptionText: string
  ): Promise<string> {
    const client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.openaiBaseUrl,
      timeout: 60000,
      maxRetries: 2,
    })

    // For OpenAI, transcribe audio to text first if we have new audio
    let audioText = transcriptionText
    if (audioBase64 && !audioText) {
      const audioBuffer = Buffer.from(audioBase64, "base64")
      audioText = await this.transcribeWithWhisper(audioBuffer, config)
    }

    // Build user content with images
    const contentParts: any[] = []

    let userText = ""
    if (kbContext) {
      userText += `知识库内容：\n---\n${kbContext}\n---\n\n`
    }
    if (audioText) {
      userText += `面试中听到的内容：\n${audioText}\n\n`
    }
    if (customQuestion) {
      userText += `用户问题：${customQuestion}\n\n`
    }
    if (screenshots.length > 0) {
      userText += "请同时参考以下截图内容。\n"
    }
    userText += "请给出回答。"

    contentParts.push({ type: "text", text: userText })

    for (const s of screenshots) {
      contentParts.push({
        type: "image_url",
        image_url: { url: `data:${s.mimeType};base64,${s.base64}` },
      })
    }

    const response = await client.chat.completions.create({
      model: config.openaiModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: contentParts },
      ],
      max_tokens: 4000,
      temperature: 0.3,
    })

    return response.choices[0]?.message?.content || ""
  }

  /**
   * Anthropic: vision + text. Audio is transcribed first then sent as text.
   * Claude supports images natively but not raw audio.
   */
  private async processMultimodalAnthropic(
    config: any,
    systemPrompt: string,
    kbContext: string,
    customQuestion: string | undefined,
    screenshots: Array<{ base64: string; mimeType: string }>,
    transcriptionText: string
  ): Promise<string> {
    const client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.anthropicBaseUrl,
      timeout: 60000,
      maxRetries: 2,
    })

    const contentParts: any[] = []

    let userText = ""
    if (kbContext) {
      userText += `知识库内容：\n---\n${kbContext}\n---\n\n`
    }
    if (transcriptionText) {
      userText += `面试中听到的内容：\n${transcriptionText}\n\n`
    }
    if (customQuestion) {
      userText += `用户问题：${customQuestion}\n\n`
    }
    if (screenshots.length > 0) {
      userText += "请同时参考以下截图内容。\n"
    }
    userText += "请给出回答。"

    contentParts.push({ type: "text", text: userText })

    for (const s of screenshots) {
      contentParts.push({
        type: "image",
        source: {
          type: "base64",
          media_type: s.mimeType,
          data: s.base64,
        },
      })
    }

    const response = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: 4000,
      temperature: 0.3,
      system: systemPrompt,
      messages: [{ role: "user", content: contentParts }],
    })

    const textParts: string[] = []
    for (const part of response.content as Array<{ type: string; text?: string }>) {
      if (part.type === "text" && typeof part.text === "string") {
        textParts.push(part.text.trim())
      }
    }
    return textParts.join("\n").trim()
  }

  /**
   * Legacy: Generate an AI answer based on accumulated transcriptions + knowledge base.
   * Kept for backward compatibility. Internally delegates to processMultimodal.
   */
  public async generateAnswer(customQuestion?: string): Promise<void> {
    return this.processMultimodal(undefined, customQuestion)
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
    this.audioChunks = []
    this.chunkCounter = 0
  }

  public getTranscriptionText(): string {
    return this.transcriptionHistory.map((t) => t.text).join("\n")
  }
}
