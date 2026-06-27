import { contextBridge, clipboard, nativeImage, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('maruAPI', {
  /** Read clipboard image as data URL (PNG). Returns null if no image. */
  readClipboardImage(): string | null {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const buf = img.toPNG()
    return buf.length > 0 ? `data:image/png;base64,${buf.toString('base64')}` : null
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

  /** Write both a PNG image and plain text to the clipboard simultaneously */
  writeClipboardBoth(dataUrl: string, text: string): void {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    const buf = Buffer.from(base64, 'base64')
    const img = nativeImage.createFromBuffer(buf)
    clipboard.write({ image: img, text })
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
