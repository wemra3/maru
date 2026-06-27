/// <reference types="vite/client" />

interface MaruAPI {
  readClipboardImage(): string | null
  writeClipboardImage(dataUrl: string): void
  writeClipboardText(text: string): void
  writeClipboardBoth(dataUrl: string, text: string): void
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
