import { fileURLToPath } from 'url'
import { contextBridge, clipboard, nativeImage, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('maruAPI', {
  /**
   * Read clipboard image as PNG data URL.
   * Priority 1: file URL (Finder-copied PNG/JPEG/HEIC → actual pixels via nativeImage, not file icon).
   * Priority 2: raw bitmap (screenshots, screen captures).
   * Returns null if no usable image is found.
   */
  readClipboardImage(): string | null {
    // macOS Finder copy writes 'public.file-url' with a file:// URL
    const fileUrl = clipboard.read('public.file-url')
    if (fileUrl && fileUrl.startsWith('file://')) {
      try {
        const filePath = fileURLToPath(fileUrl)
        const img = nativeImage.createFromPath(filePath)
        if (!img.isEmpty()) {
          const buf = img.toPNG()
          if (buf.length > 0) return `data:image/png;base64,${buf.toString('base64')}`
        }
      } catch {
        // fall through to readImage()
      }
    }
    // Fallback: raw bitmap (screenshot / ⌘C on image in browser etc.)
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const buf = img.toPNG()
    return buf.length > 0 ? `data:image/png;base64,${buf.toString('base64')}` : null
  },

  /**
   * Load an image from a filesystem path as PNG data URL (for drag & drop).
   * Uses nativeImage so macOS system codecs handle HEIC, JPEG, PNG, etc.
   * Returns null if the path cannot be read or decoded.
   */
  readImageFromPath(filePath: string): string | null {
    try {
      const img = nativeImage.createFromPath(filePath)
      if (img.isEmpty()) return null
      const buf = img.toPNG()
      return buf.length > 0 ? `data:image/png;base64,${buf.toString('base64')}` : null
    } catch {
      return null
    }
  },

  /** Write a data URL as PNG to the clipboard */
  writeClipboardImage(dataUrl: string): void {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    const buf = Buffer.from(base64, 'base64')
    const img = nativeImage.createFromBuffer(buf)
    clipboard.writeImage(img)
  },

  /** Write plain text to the clipboard */
  writeClipboardText(text: string): void {
    clipboard.writeText(text)
  },

  /** 新規ウィンドウを開く (#10)。autoLoad=true で開いた窓に auto-paste を送信 (#9) */
  createNewWindow(autoLoad: boolean = false): Promise<void> {
    return ipcRenderer.invoke('new-window', autoLoad)
  },

  /** (#9) 新窓の auto-paste イベントを受信するリスナーを登録。戻り値でアンレジスタ可能 */
  onAutoPaste(callback: () => void): () => void {
    const listener = (): void => callback()
    ipcRenderer.on('auto-paste', listener)
    return () => ipcRenderer.removeListener('auto-paste', listener)
  },

  /** インタラクティブスクリーンキャプチャ → クリップボードに書き込み (#9) */
  captureScreen(): Promise<void> {
    return ipcRenderer.invoke('capture-screen')
  }
})
