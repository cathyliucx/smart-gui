import { useEffect, useRef, useState, useCallback, type FC } from "react"
import { Mic, MicOff, Send, Trash2, FolderOpen, RefreshCw } from "lucide-react"

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
        // Decrement pending counter
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
   *
   * Key difference from batch mode:
   * - MediaRecorder.start(timesliceMs) fires ondataavailable every timesliceMs
   *   WITHOUT stopping the recording. This gives a continuous stream of small
   *   audio blobs that are immediately sent for transcription.
   * - Multiple transcription requests run concurrently (up to MAX_CONCURRENT
   *   in AudioHelper) so we don't wait for one to finish before sending the next.
   */
  const startRecording = useCallback(async () => {
    try {
      setErrorMessage("")
      setStatusMessage("正在获取系统音频...")

      // Get desktop sources from main process
      const sources = await window.electronAPI.getDesktopSources()
      if (!sources || sources.length === 0) {
        setErrorMessage("无法获取屏幕源，请检查权限设置")
        return
      }

      // Request system audio via desktopCapturer constraints
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

      // Remove video track — we only need audio
      stream.getVideoTracks().forEach((track) => track.stop())

      // Keep only audio tracks
      const audioStream = new MediaStream(stream.getAudioTracks())
      streamRef.current = audioStream

      // Create MediaRecorder with timeslice-based streaming
      const recorder = new MediaRecorder(audioStream, {
        mimeType: "audio/webm;codecs=opus",
      })
      mediaRecorderRef.current = recorder

      // Each ondataavailable fires a small blob that gets sent immediately
      recorder.ondataavailable = async (event) => {
        if (event.data.size > 500) {
          // Increment pending counter
          pendingRef.current++
          setPendingChunks(pendingRef.current)

          try {
            const arrayBuffer = await event.data.arrayBuffer()
            // Fire-and-forget: AudioHelper handles concurrency
            window.electronAPI.sendAudioChunk(arrayBuffer)
          } catch (err) {
            console.error("Error sending audio chunk:", err)
            pendingRef.current = Math.max(0, pendingRef.current - 1)
            setPendingChunks(pendingRef.current)
          }
        }
      }

      // Get chunk interval from config (default 3s for real-time feel)
      const config = await window.electronAPI.getConfig()
      const timesliceMs = Math.max(2000, (config.audioChunkInterval || 3) * 1000)

      // Start recording with timeslice — ondataavailable fires every timesliceMs
      // automatically, no need to stop/restart the recorder
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

  /**
   * Stop recording
   */
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

  const handleGenerateAnswer = useCallback(async () => {
    setIsGenerating(true)
    setErrorMessage("")
    await window.electronAPI.generateAudioAnswer()
  }, [])

  const handleClear = useCallback(async () => {
    setTranscriptions([])
    setAnswers([])
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

  return (
    <div className="bg-black/80 text-white p-4 rounded-lg max-w-[600px] mx-auto select-none">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold tracking-wide text-white/90">
          实时音频监听
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

      {/* Control Bar */}
      <div className="flex items-center gap-2 mb-3">
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
              停止监听
            </>
          ) : (
            <>
              <Mic className="w-3.5 h-3.5" />
              开始监听
            </>
          )}
        </button>

        <button
          onClick={handleGenerateAnswer}
          disabled={isGenerating || transcriptions.length === 0}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-all ${
            isGenerating || transcriptions.length === 0
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
        {/* Transcription Panel */}
        <div className="flex-1 flex flex-col">
          <div className="text-[10px] font-medium text-white/40 uppercase tracking-wider mb-1">
            实时转录
          </div>
          <div className="flex-1 overflow-y-auto bg-white/5 rounded p-2 max-h-[300px] scrollbar-thin">
            {transcriptions.length === 0 ? (
              <div className="text-[11px] text-white/20 text-center mt-8">
                {isRecording
                  ? "等待语音输入..."
                  : '点击"开始监听"捕获系统音频'}
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
                  ? "正在生成答案..."
                  : "转录完成后点击生成答案"}
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
                  正在分析并生成答案...
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
