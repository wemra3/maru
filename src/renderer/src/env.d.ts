/// <reference types="vite/client" />

interface MaruAPI {
  // All clipboard ops are async (IPC to main) because sandbox:true is enabled (F-2)
  readClipboardImage(): Promise<string | null>
  readImageFromPath(filePath: string): Promise<string | null>  // drag & drop + file URL
  writeClipboardImage(dataUrl: string): Promise<void>
  writeClipboardText(text: string): Promise<void>
  createNewWindow(autoLoad?: boolean): Promise<void>  // #10
  captureScreen(): Promise<void>                      // #9
  onAutoPaste(callback: () => void): () => void       // #9 新窓の自動ペースト受信
}

declare interface Window {
  maruAPI: MaruAPI | undefined
  // #8: 音声入力 (Chrome / Electron 独自実装)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webkitSpeechRecognition: new () => any
}
