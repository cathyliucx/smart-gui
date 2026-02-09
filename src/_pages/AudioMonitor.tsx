import { useEffect, useRef, useState, useCallback, type FC } from "react"
import { Mic, MicOff, Send, Trash2, FolderOpen, RefreshCw, Camera, X, Image } from "lucide-react"

interface AudioMonitorProps {
  setView: (view: "queue" | "solutions" | "debug" | "audio") => void
  currentLanguage: string
  setLanguage: (language: string) => void
}

interface TranscriptionEntry {
  text: string
  timestamp: number
}

interface AnswerEntry {
  question: string
  answer: string
  timestamp: number
}

interface CapturedScreenshot {
  path: string
  preview: string
  timestamp: number
}

type InputMode = "audio" | "screenshot" | "audio+screenshot"

const AudioMonitor: FC<AudioMonitorProps> = ({
  setView,
  currentLanguage,
  setLanguage,
}) => {
  const [isRecording, setIsRecording] = useState(false)
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([])
  const [answers, setAnswers] = useState<AnswerEntry[]>([])
  const [statusMessage, setStatusMessage] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [isGenerating, setIsGenerating] = useState(false)
  const [kbPath, setKbPath] = useState("")
  const [kbDocCount, setKbDocCount] = useState(0)
  const [pendingChunks, setPendingChunks] = useState(0)
  const [inputMode, setInputMode] = useState<InputMode>("audio")
  const [screenshots, setScreenshots] = useState<CapturedScreenshot[]>([])

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const transcriptionEndRef = useRef<HTMLDivElement>(null)
  const answerEndRef = useRef<HTMLDivElement>(null)
  const pendingRef = useRef(0)

  // Load KB info on mount
  useEffect(() => {
    const loadKBInfo = async () => {
      try {
        const kbPathResult = await window.electronAPI.getKnowledgeBasePath()
        setKbPath(kbPathResult || "")
        const docs = await window.electronAPI.getKnowledgeBaseDocuments()
        setKbDocCount(docs.length)
      } catch (err) {
        console.error("Error loading KB info:", err)
      }
    }
    loadKBInfo()
  }, [])

  // Subscribe to audio events from main process
  useEffect(() => {
    const cleanups = [
      window.electronAPI.onAudioTranscriptionUpdate((data) => {
        setTranscriptions((prev) => [...prev, data])
        setErrorMessage("")
        pendingRef.current = Math.max(0, pendingRef.current - 1)
        setPendingChunks(pendingRef.current)
      }),
      window.electronAPI.onAudioAnswerUpdate((data) => {
        setAnswers((prev) => [...prev, data])
        setIsGenerating(false)
      }),
      window.electronAPI.onAudioError((data) => {
        setErrorMessage(data.message)
        setIsGenerating(false)
        pendingRef.current = Math.max(0, pendingRef.current - 1)
        setPendingChunks(pendingRef.current)
      }),
      window.electronAPI.onAudioStatus((data) => {
        setStatusMessage(data.message)
      }),
    ]

    return () => cleanups.forEach((fn) => fn())
  }, [])

  // Auto-scroll transcriptions
  useEffect(() => {
    transcriptionEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [transcriptions])

  // Auto-scroll answers
  useEffect(() => {
    answerEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [answers])

  /**
   * Start capturing system audio using timeslice for real-time streaming.
   */
  const startRecording = useCallback(async () => {
    try {
      setErrorMessage("")
      setStatusMessage("正在获取系统音频...")

      const sources = await window.electronAPI.getDesktopSources()
      if (!sources || sources.length === 0) {
        setErrorMessage("无法获取屏幕源，请检查权限设置")
        return
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "desktop",
          },
        } as any,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sources[0].id,
            maxWidth: 1,
            maxHeight: 1,
            maxFrameRate: 1,
          },
        } as any,
      })

      stream.getVideoTracks().forEach((track) => track.stop())

      const audioStream = new MediaStream(stream.getAudioTracks())
      streamRef.current = audioStream

      const recorder = new MediaRecorder(audioStream, {
        mimeType: "audio/webm;codecs=opus",
      })
      mediaRecorderRef.current = recorder

      recorder.ondataavailable = async (event) => {
        if (event.data.size > 500) {
          pendingRef.current++
          setPendingChunks(pendingRef.current)

          try {
            const arrayBuffer = await event.data.arrayBuffer()
            window.electronAPI.sendAudioChunk(arrayBuffer)
          } catch (err) {
            console.error("Error sending audio chunk:", err)
            pendingRef.current = Math.max(0, pendingRef.current - 1)
            setPendingChunks(pendingRef.current)
          }
        }
      }

      const config = await window.electronAPI.getConfig()
      const timesliceMs = Math.max(2000, (config.audioChunkInterval || 3) * 1000)

      recorder.start(timesliceMs)

      setIsRecording(true)
      setStatusMessage(`实时监听中（每 ${timesliceMs / 1000}s 一片段）...`)
    } catch (error: any) {
      console.error("Error starting audio capture:", error)
      setErrorMessage(
        `启动音频捕获失败: ${error.message}。请确保已授予屏幕录制权限。`
      )
      setIsRecording(false)
    }
  }, [])

  const stopRecording = useCallback(() => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop()
      mediaRecorderRef.current = null
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    setIsRecording(false)
    setStatusMessage("监听已停止")
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopRecording()
    }
  }, [stopRecording])

  /**
   * Take a screenshot and add it to the local list for multimodal processing.
   */
  const handleTakeScreenshot = useCallback(async () => {
    try {
      setStatusMessage("正在截图...")
      const result = await window.electronAPI.triggerScreenshot()
      if (result && !("error" in result)) {
        // Get the latest screenshot from the queue
        const screenshotList = await window.electronAPI.getScreenshots()
        if (screenshotList && Array.isArray(screenshotList) && screenshotList.length > 0) {
          const latest = screenshotList[screenshotList.length - 1] as { path: string; preview: string }
          setScreenshots((prev) => {
            const updated = [...prev, { ...latest, timestamp: Date.now() }]
            // Keep max 5 screenshots
            return updated.slice(-5)
          })
          setStatusMessage(`已截图 (${screenshots.length + 1}张)`)
        }
      }
    } catch (err: any) {
      console.error("Screenshot error:", err)
      setErrorMessage(`截图失败: ${err.message}`)
    }
  }, [screenshots.length])

  const handleRemoveScreenshot = useCallback((index: number) => {
    setScreenshots((prev) => prev.filter((_, i) => i !== index))
  }, [])

  /**
   * Generate answer using multimodal processing.
   * Sends audio + screenshots directly to the model in a single call.
   */
  const handleGenerateAnswer = useCallback(async () => {
    setIsGenerating(true)
    setErrorMessage("")

    const screenshotPaths = screenshots.map((s) => s.path)
    const hasScreenshots = screenshotPaths.length > 0

    if (inputMode === "screenshot" || (inputMode === "audio+screenshot" && hasScreenshots)) {
      // Use multimodal processing
      await window.electronAPI.processMultimodal({
        screenshotPaths: hasScreenshots ? screenshotPaths : undefined,
      })
    } else {
      // Audio-only: use multimodal (which handles audio-only too)
      await window.electronAPI.processMultimodal({})
    }
  }, [screenshots, inputMode])

  const handleClear = useCallback(async () => {
    setTranscriptions([])
    setAnswers([])
    setScreenshots([])
    setErrorMessage("")
    setStatusMessage("")
    pendingRef.current = 0
    setPendingChunks(0)
    await window.electronAPI.clearAudioHistory()
  }, [])

  const handleSelectKBFolder = useCallback(async () => {
    const result = await window.electronAPI.selectKnowledgeBaseFolder()
    if (result.success && result.path) {
      setKbPath(result.path)
      const docs = await window.electronAPI.getKnowledgeBaseDocuments()
      setKbDocCount(docs.length)
    }
  }, [])

  const handleReloadKB = useCallback(async () => {
    const result = await window.electronAPI.reloadKnowledgeBase()
    if (result.documents) {
      setKbDocCount(result.documents.length)
    }
  }, [])

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return d.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  }

  const canGenerate =
    isGenerating
      ? false
      : inputMode === "audio"
        ? transcriptions.length > 0
        : inputMode === "screenshot"
          ? screenshots.length > 0
          : transcriptions.length > 0 || screenshots.length > 0

  return (
    <div className="bg-black/80 text-white p-4 rounded-lg max-w-[600px] mx-auto select-none">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold tracking-wide text-white/90">
          多模态理解
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSelectKBFolder}
            className="flex items-center gap-1 px-2 py-1 text-[10px] rounded bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/80 transition-colors"
            title={kbPath || "点击选择知识库文件夹"}
          >
            <FolderOpen className="w-3 h-3" />
            {kbDocCount > 0 ? `知识库(${kbDocCount})` : "选择知识库"}
          </button>
          {kbDocCount > 0 && (
            <button
              onClick={handleReloadKB}
              className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
              title="重新加载知识库"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={() => setView("queue")}
            className="px-2 py-1 text-[10px] rounded bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/80 transition-colors"
          >
            返回截图模式
          </button>
        </div>
      </div>

      {/* Input Mode Selector */}
      <div className="flex items-center gap-1 mb-3">
        <span className="text-[10px] text-white/40 mr-1">输入模式:</span>
        {(["audio", "screenshot", "audio+screenshot"] as InputMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => setInputMode(mode)}
            className={`px-2 py-1 text-[10px] rounded transition-all ${
              inputMode === mode
                ? "bg-blue-500/80 text-white"
                : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70"
            }`}
          >
            {mode === "audio" ? "仅音频" : mode === "screenshot" ? "仅截图" : "音频+截图"}
          </button>
        ))}
      </div>

      {/* Control Bar */}
      <div className="flex items-center gap-2 mb-3">
        {/* Audio controls - show when mode includes audio */}
        {(inputMode === "audio" || inputMode === "audio+screenshot") && (
          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all ${
              isRecording
                ? "bg-red-500/80 hover:bg-red-500 text-white"
                : "bg-blue-500/80 hover:bg-blue-500 text-white"
            }`}
          >
            {isRecording ? (
              <>
                <MicOff className="w-3.5 h-3.5" />
                停止
              </>
            ) : (
              <>
                <Mic className="w-3.5 h-3.5" />
                监听
              </>
            )}
          </button>
        )}

        {/* Screenshot button - show when mode includes screenshot */}
        {(inputMode === "screenshot" || inputMode === "audio+screenshot") && (
          <button
            onClick={handleTakeScreenshot}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-purple-500/80 hover:bg-purple-500 text-white transition-all"
          >
            <Camera className="w-3.5 h-3.5" />
            截图{screenshots.length > 0 ? `(${screenshots.length})` : ""}
          </button>
        )}

        <button
          onClick={handleGenerateAnswer}
          disabled={!canGenerate}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all ${
            !canGenerate
              ? "bg-white/5 text-white/30 cursor-not-allowed"
              : "bg-green-500/80 hover:bg-green-500 text-white"
          }`}
        >
          <Send className="w-3.5 h-3.5" />
          {isGenerating ? "生成中..." : "生成答案"}
        </button>

        <button
          onClick={handleClear}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/80 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
          清除
        </button>

        {isRecording && (
          <div className="flex items-center gap-1.5 ml-auto">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-[10px] text-white/50">
              实时录音{pendingChunks > 0 ? ` · 转录中(${pendingChunks})` : ""}
            </span>
          </div>
        )}
      </div>

      {/* Screenshot Thumbnails - show when screenshots are captured */}
      {screenshots.length > 0 && (
        <div className="mb-3">
          <div className="text-[10px] font-medium text-white/40 uppercase tracking-wider mb-1">
            已截图 ({screenshots.length}/5)
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {screenshots.map((s, i) => (
              <div key={i} className="relative flex-shrink-0 group">
                <img
                  src={s.preview}
                  alt={`截图 ${i + 1}`}
                  className="w-20 h-14 object-cover rounded border border-white/10"
                />
                <button
                  onClick={() => handleRemoveScreenshot(i)}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-2.5 h-2.5 text-white" />
                </button>
                <span className="absolute bottom-0.5 left-0.5 text-[8px] text-white/50 bg-black/50 px-1 rounded">
                  {formatTime(s.timestamp)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status / Error */}
      {errorMessage && (
        <div className="mb-2 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20 text-[11px] text-red-400">
          {errorMessage}
        </div>
      )}
      {statusMessage && !errorMessage && (
        <div className="mb-2 px-2 py-1 text-[10px] text-white/40">
          {statusMessage}
        </div>
      )}

      {/* Two-panel layout */}
      <div className="flex gap-3" style={{ minHeight: 200 }}>
        {/* Left Panel: Transcription or Screenshot-only info */}
        <div className="flex-1 flex flex-col">
          <div className="text-[10px] font-medium text-white/40 uppercase tracking-wider mb-1">
            {inputMode === "screenshot" ? "截图输入" : "实时转录"}
          </div>
          <div className="flex-1 overflow-y-auto bg-white/5 rounded p-2 max-h-[300px] scrollbar-thin">
            {inputMode === "screenshot" ? (
              // Screenshot-only mode: show screenshot info
              screenshots.length === 0 ? (
                <div className="text-[11px] text-white/20 text-center mt-8">
                  点击"截图"按钮捕获屏幕内容
                </div>
              ) : (
                <div className="text-[11px] text-white/40 text-center mt-4">
                  <Image className="w-8 h-8 mx-auto mb-2 text-white/20" />
                  <p>已捕获 {screenshots.length} 张截图</p>
                  <p className="text-[10px] mt-1 text-white/20">
                    点击"生成答案"将截图发送给多模态模型理解
                  </p>
                </div>
              )
            ) : (
              // Audio mode: show transcriptions
              <>
                {transcriptions.length === 0 ? (
                  <div className="text-[11px] text-white/20 text-center mt-8">
                    {isRecording
                      ? "等待语音输入..."
                      : '点击"监听"捕获系统音频'}
                  </div>
                ) : (
                  transcriptions.map((t, i) => (
                    <div key={i} className="mb-1.5">
                      <span className="text-[9px] text-white/20 mr-1.5">
                        {formatTime(t.timestamp)}
                      </span>
                      <span className="text-[12px] text-white/80 leading-relaxed">
                        {t.text}
                      </span>
                    </div>
                  ))
                )}
                {isRecording && pendingChunks > 0 && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                    <span className="text-[10px] text-blue-400/60">转录中...</span>
                  </div>
                )}
              </>
            )}
            <div ref={transcriptionEndRef} />
          </div>
        </div>

        {/* Answer Panel */}
        <div className="flex-1 flex flex-col">
          <div className="text-[10px] font-medium text-white/40 uppercase tracking-wider mb-1">
            AI 回答
          </div>
          <div className="flex-1 overflow-y-auto bg-white/5 rounded p-2 max-h-[300px] scrollbar-thin">
            {answers.length === 0 ? (
              <div className="text-[11px] text-white/20 text-center mt-8">
                {isGenerating
                  ? "正在用多模态模型理解中..."
                  : inputMode === "audio"
                    ? "转录完成后点击生成答案"
                    : inputMode === "screenshot"
                      ? "截图后点击生成答案"
                      : "录音或截图后点击生成答案"}
              </div>
            ) : (
              answers.map((a, i) => (
                <div
                  key={i}
                  className="mb-3 pb-2 border-b border-white/5 last:border-b-0"
                >
                  <div className="text-[9px] text-white/20 mb-1">
                    {formatTime(a.timestamp)}
                  </div>
                  <div className="text-[12px] text-white/90 whitespace-pre-wrap leading-relaxed">
                    {a.answer}
                  </div>
                </div>
              ))
            )}
            {isGenerating && (
              <div className="flex items-center gap-2 mt-2">
                <div className="w-3 h-3 border border-white/20 border-t-white/60 rounded-full animate-spin" />
                <span className="text-[10px] text-white/40">
                  多模态模型理解中...
                </span>
              </div>
            )}
            <div ref={answerEndRef} />
          </div>
        </div>
      </div>

      {/* Shortcuts hint */}
      <div className="mt-2 flex items-center justify-between text-[9px] text-white/20">
        <span>Ctrl+M 切换模式 | Ctrl+Enter 生成答案 | Ctrl+R 重置</span>
        <span>
          {kbPath
            ? `知识库: ${kbPath.split(/[\\/]/).pop()}`
            : "未设置知识库"}
        </span>
      </div>
    </div>
  )
}

export default AudioMonitor
