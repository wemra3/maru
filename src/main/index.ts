import { app, BrowserWindow, ipcMain, clipboard, nativeImage } from 'electron'
import { fileURLToPath } from 'url'
import { join } from 'path'
import { exec } from 'child_process'

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1e1e20',
    titleBarStyle: 'hiddenInset',
    // Fix #6: app icon (effective in dock during dev; .icns needed for production packaging)
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false, // F-6: explicit (default false, belt-and-suspenders)
      sandbox: true           // F-2: full sandbox; clipboard/nativeImage handled via IPC below
    }
  })

  // F-3: block all new-window opening attempts
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // F-3: block navigating away from the loaded URL
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const current = mainWindow.webContents.getURL()
    if (url !== current) e.preventDefault()
  })

  // In dev, electron-vite sets ELECTRON_RENDERER_URL
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// ── F-2: Clipboard IPC handlers (moved from preload so sandbox:true can be set) ──

/** Read clipboard image as PNG data URL. Handles file URLs (Finder-copied images) and raw bitmaps. */
ipcMain.handle('clipboard:read', (): string | null => {
  // Priority 1: file URL (Finder copy → nativeImage via system codecs)
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
      // fall through
    }
  }
  // Priority 2: raw bitmap (screenshots, browser copies)
  const img = clipboard.readImage()
  if (img.isEmpty()) return null
  const buf = img.toPNG()
  return buf.length > 0 ? `data:image/png;base64,${buf.toString('base64')}` : null
})

/** Load an image from a filesystem path (drag & drop) as PNG data URL. */
ipcMain.handle('clipboard:read-path', (_e, filePath: string): string | null => {
  try {
    const img = nativeImage.createFromPath(filePath)
    if (img.isEmpty()) return null
    const buf = img.toPNG()
    return buf.length > 0 ? `data:image/png;base64,${buf.toString('base64')}` : null
  } catch {
    return null
  }
})

/** Write a PNG data URL to the clipboard. */
ipcMain.handle('clipboard:write-image', (_e, dataUrl: string): void => {
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
  const buf = Buffer.from(base64, 'base64')
  const img = nativeImage.createFromBuffer(buf)
  clipboard.writeImage(img)
})

/** Write plain text to the clipboard. */
ipcMain.handle('clipboard:write-text', (_e, text: string): void => {
  clipboard.writeText(text)
})

// IPC: 新規ウィンドウ (#10)
// autoLoad=true の場合は読み込み完了後に auto-paste を送信 (#9)
ipcMain.handle('new-window', (_event, autoLoad: boolean = false) => {
  const win = createWindow()
  if (autoLoad) {
    win.webContents.once('did-finish-load', () => {
      win.webContents.send('auto-paste')
    })
  }
})

// IPC: インタラクティブスクリーンキャプチャ (#9)
// screencapture -i -c : 範囲選択 → クリップボードに書き込み
ipcMain.handle('capture-screen', () => {
  return new Promise<void>((resolve, reject) => {
    exec('screencapture -i -c', (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
})

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
