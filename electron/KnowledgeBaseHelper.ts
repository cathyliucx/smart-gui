// KnowledgeBaseHelper.ts
// Manages loading and indexing of user's knowledge base documents
import fs from "node:fs"
import path from "node:path"
import { app, dialog } from "electron"
import { configHelper } from "./ConfigHelper"

interface KBDocument {
  filename: string
  content: string
  size: number
}

export class KnowledgeBaseHelper {
  private documents: KBDocument[] = []
  private kbPath: string | null = null
  private maxContextChars = 8000 // Limit context size sent to AI

  constructor() {
    this.loadFromConfig()
    configHelper.on("config-updated", () => {
      this.loadFromConfig()
    })
  }

  private loadFromConfig(): void {
    const config = configHelper.loadConfig()
    const configKbPath = (config as any).knowledgeBasePath
    if (configKbPath && configKbPath !== this.kbPath) {
      this.kbPath = configKbPath
      this.loadDocuments()
    }
  }

  /**
   * Set the knowledge base directory path and load documents
   */
  public setPath(dirPath: string): void {
    this.kbPath = dirPath
    this.loadDocuments()
  }

  /**
   * Get the current knowledge base path
   */
  public getPath(): string | null {
    return this.kbPath
  }

  /**
   * Load all supported documents from the knowledge base directory
   */
  public loadDocuments(): void {
    this.documents = []

    if (!this.kbPath || !fs.existsSync(this.kbPath)) {
      console.log("Knowledge base path not set or does not exist:", this.kbPath)
      return
    }

    const supportedExtensions = [".txt", ".md", ".markdown", ".text", ".json", ".csv"]

    try {
      const files = this.walkDir(this.kbPath, supportedExtensions)

      for (const filePath of files) {
        try {
          const stat = fs.statSync(filePath)
          // Skip files larger than 500KB
          if (stat.size > 500 * 1024) {
            console.log(`Skipping large file: ${filePath} (${stat.size} bytes)`)
            continue
          }

          const content = fs.readFileSync(filePath, "utf-8")
          const filename = path.relative(this.kbPath!, filePath)

          this.documents.push({
            filename,
            content: content.trim(),
            size: stat.size,
          })
        } catch (err) {
          console.error(`Error reading KB file ${filePath}:`, err)
        }
      }

      console.log(`Loaded ${this.documents.length} knowledge base documents`)
    } catch (err) {
      console.error("Error loading knowledge base:", err)
    }
  }

  /**
   * Recursively walk directory and collect files with matching extensions
   */
  private walkDir(dir: string, extensions: string[]): string[] {
    const results: string[] = []

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)

        // Skip hidden directories and node_modules
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          continue
        }

        if (entry.isDirectory()) {
          // Limit recursion depth to 3 levels
          const depth = fullPath.replace(this.kbPath!, "").split(path.sep).length
          if (depth <= 4) {
            results.push(...this.walkDir(fullPath, extensions))
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase()
          if (extensions.includes(ext)) {
            results.push(fullPath)
          }
        }
      }
    } catch (err) {
      console.error(`Error walking directory ${dir}:`, err)
    }

    return results
  }

  /**
   * Get formatted context string for inclusion in AI prompts.
   * Truncates to maxContextChars.
   */
  public getContextForPrompt(): string {
    if (this.documents.length === 0) {
      return ""
    }

    let context = ""
    let remaining = this.maxContextChars

    for (const doc of this.documents) {
      const header = `\n【${doc.filename}】\n`
      const available = remaining - header.length

      if (available <= 100) break // Not enough space for meaningful content

      const content =
        doc.content.length > available
          ? doc.content.substring(0, available) + "...(截断)"
          : doc.content

      context += header + content + "\n"
      remaining -= header.length + content.length + 1

      if (remaining <= 100) break
    }

    return context.trim()
  }

  /**
   * Get list of loaded documents (for UI display)
   */
  public getDocumentList(): Array<{ filename: string; size: number }> {
    return this.documents.map((d) => ({
      filename: d.filename,
      size: d.size,
    }))
  }

  /**
   * Reload documents from the current path
   */
  public reload(): void {
    this.loadDocuments()
  }

  /**
   * Open a folder selection dialog and set the knowledge base path
   */
  public async selectFolder(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "选择知识库文件夹",
      buttonLabel: "选择此文件夹",
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const selectedPath = result.filePaths[0]
    this.setPath(selectedPath)
    return selectedPath
  }
}
