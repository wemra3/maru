/// <reference types="vite/client" />

interface MaruAPI {
  readClipboardImage(): string | null
  writeClipboardImage(dataUrl: string): void
  writeClipboardText(text: string): void
  writeClipboardBoth(dataUrl: string, text: string): void
}

declare interface Window {
  maruAPI: MaruAPI | undefined
}
