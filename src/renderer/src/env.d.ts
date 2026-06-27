/// <reference types="vite/client" />

interface MaruAPI {
  readClipboardImage(): string | null
  writeClipboardImage(dataUrl: string): void
  writeClipboardText(text: string): void
  writeClipboardBoth(dataUrl: string, text: string): void
  createNewWindow(): Promise<void>   // #10
  captureScreen(): Promise<void>     // #9
}

declare interface Window {
  maruAPI: MaruAPI | undefined
  // #8: 音声入力 (Chrome / Electron 独自実装)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webkitSpeechRecognition: new () => any
}
