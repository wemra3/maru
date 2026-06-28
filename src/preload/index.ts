import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('maruAPI', {
  /**
   * Read clipboard image as PNG data URL.
   * Delegates to main process (IPC) so sandbox:true can be set on the renderer.
   * Priority 1: file URL (Finder-copied PNG/JPEG/HEIC → actual pixels via nativeImage).
   * Priority 2: raw bitmap (screenshots, screen captures).
   * Returns null if no usable image is found.
   */
  readClipboardImage(): Promise<string | null> {
    return ipcRenderer.invoke('clipboard:read')
  },

  /**
   * Load an image from a filesystem path as PNG data URL (for drag & drop).
   * Uses nativeImage in main process so macOS system codecs handle HEIC, JPEG, PNG, etc.
   * Returns null if the path cannot be read or decoded.
   */
  readImageFromPath(filePath: string): Promise<string | null> {
    return ipcRenderer.invoke('clipboard:read-path', filePath)
  },

  /** Write a data URL as PNG to the clipboard */
  writeClipboardImage(dataUrl: string): Promise<void> {
    return ipcRenderer.invoke('clipboard:write-image', dataUrl)
  },

  /** Write plain text to the clipboard */
  writeClipboardText(text: string): Promise<void> {
    return ipcRenderer.invoke('clipboard:write-text', text)
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
