import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { exec } from 'child_process'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1e1e20',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  // In dev, electron-vite sets ELECTRON_RENDERER_URL
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// IPC: 新規ウィンドウ (#10)
ipcMain.handle('new-window', () => {
  createWindow()
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
