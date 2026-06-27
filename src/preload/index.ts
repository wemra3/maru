import { contextBridge, clipboard, nativeImage } from 'electron'

contextBridge.exposeInMainWorld('maruAPI', {
  /** Read clipboard image as data URL (PNG). Returns null if no image. */
  readClipboardImage(): string | null {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    return img.toPNG().length > 0 ? `data:image/png;base64,${img.toPNG().toString('base64')}` : null
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
  }
})
