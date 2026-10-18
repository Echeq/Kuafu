'use strict'

// Kuafu — unofficial Quark Cloud client (夸克网盘) for Hyprland / Omarchy.
//
// Wraps https://pan.quark.cn/ in its own window:
//   - Custom titlebar (with minimize/close buttons), colored from the active
//     Omarchy theme at runtime.
//   - Closing / minimizing hides the app to the system tray (omarchy.tray)
//     instead of quitting.
//   - Single instance: relaunching shows/focuses the existing window.
//   - Own persistent session (QR login survives restarts).
//   - Downloads go to the system Downloads folder, with a notification.

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const {
  app,
  BrowserWindow,
  WebContentsView,
  Tray,
  Menu,
  Notification,
  ipcMain,
  shell,
  session,
  nativeImage,
  dialog,
} = require('electron')

const { downloadFolder, parseFolderFromUrl } = require('./quark-download')

const APP_NAME = 'Kuafu'
const APP_URL = 'https://pan.quark.cn/'
const ROOT = path.join(__dirname, '..')
const ICON_256 = path.join(ROOT, 'assets', 'quark-cloud-256.png')
const ICON_TRAY = path.join(ROOT, 'assets', 'quark-cloud-tray.png')
const TITLEBAR_HEIGHT = 38
const THEME_FILE = path.join(
  os.homedir(), '.local', 'state', 'omarchy', 'current', 'theme', 'colors.toml'
)

// Hosts that stay inside the app; anything else opens in the system browser.
const IN_APP_HOSTS = /(^|\.)(quark\.cn|uc\.cn|ucweb\.com|alibaba\.com|alipay\.com|taobao\.com|tmall\.com)$/i
const isInApp = (url) => {
  try { return IN_APP_HOSTS.test(new URL(url).hostname) } catch { return false }
}

// Only web/mail links are ever handed to the OS (xdg-open). Notably file://,
// smb:// and custom app schemes are ignored: shell.openExternal must never
// receive an arbitrary page-controlled URL.
const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])
function openExternalSafely(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (!SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) return
    shell.openExternal(url.href)
  } catch { /* not a URL */ }
}

// Native Wayland on Hyprland + working fcitx5 IME (Chinese input).
app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
app.commandLine.appendSwitch('enable-wayland-ime')

const buildUA = () =>
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${process.versions.chrome} Safari/537.36`

// ---------------------------------------------------------------------------
// Omarchy theme colors (used to style the titlebar)
// ---------------------------------------------------------------------------

const FALLBACK_COLORS = {
  mode: 'dark', bg: '#1e1e2e', fg: '#cdd6f4', border: '#171723',
  hover: '#353543', close: '#353543', closeFg: '#cdd6f4', muted: '#9aa1b7',
}

function rgbOf(hex) {
  const v = hex.replace('#', '')
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v
  const n = Number.parseInt(full, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function luminance(hex) {
  const { r, g, b } = rgbOf(hex)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

function isColored(hex) {
  const { r, g, b } = rgbOf(hex)
  return Math.max(r, g, b) - Math.min(r, g, b) > 40
}

function readThemeColors() {
  let text = ''
  try {
    text = fs.readFileSync(THEME_FILE, 'utf8')
  } catch {
    return { ...FALLBACK_COLORS }
  }

  const get = (key) => {
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'))
    return m ? m[1] : null
  }

  const mode = (get('mode') || get('theme_type') || 'dark') === 'light' ? 'light' : 'dark'
  const bg = get('background') || FALLBACK_COLORS.bg
  const fg = get('foreground') || FALLBACK_COLORS.fg
  const border = get('darker_background') || (mode === 'light' ? '#e8e8e8' : '#171723')
  const hover = mode === 'light'
    ? (get('dark_background') || '#f5f5f5')
    : (get('lighter_background') || '#353543')
  const muted = get('dark_foreground') || (mode === 'light' ? '#808080' : '#9aa1b7')

  // The close button uses the theme "red" only when that color has a hue
  // (monochrome themes like "White" get a neutral hover instead).
  const red = get('red')
  let close = hover
  let closeFg = fg
  if (red && isColored(red)) {
    close = red
    closeFg = luminance(red) > 0.6 ? '#1e1e2e' : '#ffffff'
  }

  return { mode, bg, fg, border, hover, close, closeFg, muted }
}

// ---------------------------------------------------------------------------
// Persistent settings (window size, first-hide notification)
// ---------------------------------------------------------------------------

const settings = { firstHideDone: false, width: 1280, height: 820, x: null, y: null, downloadDir: null }
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsPath(), 'utf8')))
  } catch { /* first run */ }
}

let saveTimer = null
function saveSettingsSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveSettings, 500)
}

function saveSettings() {
  try {
    if (win && !win.isMaximized() && !win.isMinimized()) {
      const [w, h] = win.getSize()
      settings.width = w
      settings.height = h
      const [x, y] = win.getPosition()
      settings.x = x
      settings.y = y
    }
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true })
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
  } catch { /* not critical */ }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let win = null
let view = null
let tray = null
let quitting = false
let colors = { ...FALLBACK_COLORS }
let activeDownload = null // { controller, name, done, total, totalBytes }
let blockedDialogOpen = false

const send = (channel, payload) => {
  try { win.webContents.send(channel, payload) } catch { /* window closed */ }
}

function layout() {
  if (!win || !view) return
  const [w, h] = win.getContentSize()
  view.setBounds({
    x: 0,
    y: TITLEBAR_HEIGHT,
    width: Math.max(1, w),
    height: Math.max(1, h - TITLEBAR_HEIGHT),
  })
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const bounds = {}
  if (Number.isFinite(settings.width)) bounds.width = settings.width
  if (Number.isFinite(settings.height)) bounds.height = settings.height
  if (Number.isInteger(settings.x)) bounds.x = settings.x
  if (Number.isInteger(settings.y)) bounds.y = settings.y

  win = new BrowserWindow({
    ...bounds,
    minWidth: 480,
    minHeight: 320,
    show: false,
    frame: false,
    backgroundColor: colors.bg,
    title: APP_NAME,
    icon: ICON_256,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.setMenuBarVisibility(false)

  win.loadFile(path.join(__dirname, 'titlebar', 'index.html'))

  // The titlebar is a local page whose preload is the privileged IPC bridge:
  // it must never navigate away or open windows (defense in depth).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!String(url).startsWith('file://')) event.preventDefault()
  })

  // The actual web app (pan.quark.cn) lives in a WebContentsView under the bar.
  view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'view-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  try { view.setBackgroundColor(colors.bg) } catch { /* optional */ }
  win.contentView.addChildView(view)
  layout()

  const wc = view.webContents
  wc.loadURL(APP_URL)

  const pushNavState = () => send('page:nav-state', {
    loading: wc.isLoading(),
    canBack: wc.navigationHistory.canGoBack(),
    canForward: wc.navigationHistory.canGoForward(),
  })

  wc.on('page-title-updated', (event, title) => {
    event.preventDefault()
    send('page:title', title)
  })
  wc.on('did-start-loading', pushNavState)
  wc.on('did-stop-loading', pushNavState)
  wc.on('did-navigate', pushNavState)
  wc.on('did-navigate-in-page', pushNavState)

  // Quick keys inside the page (in addition to the invisible menu shortcuts).
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F5') {
      event.preventDefault()
      wc.reload()
    } else if (input.alt && input.key === 'Left') {
      event.preventDefault()
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    } else if (input.alt && input.key === 'Right') {
      event.preventDefault()
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    }
  })

  // External links -> system browser (http/https/mailto only).
  wc.setWindowOpenHandler(({ url }) => {
    if (isInApp(url)) return { action: 'allow' }
    openExternalSafely(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (event, url) => {
    if (!isInApp(url)) {
      event.preventDefault()
      openExternalSafely(url)
    }
  })

  win.on('resize', () => { layout(); saveSettingsSoon() })
  win.on('moved', saveSettingsSoon)
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      hideToTray()
    }
  })
  win.webContents.on('did-finish-load', () => send('theme:colors', colors))
  win.once('ready-to-show', showWindow)
}

function showWindow() {
  if (!win) return
  win.show()
  win.focus()
  try { view.webContents.focus() } catch { /* still loading */ }
}

function hideToTray() {
  if (!win) return
  win.hide()
  if (!settings.firstHideDone) {
    settings.firstHideDone = true
    saveSettings()
    try {
      new Notification({
        title: APP_NAME,
        body: 'Still running in the system tray. Click its icon to reopen.',
        icon: ICON_256,
      }).show()
    } catch { /* no notification daemon */ }
  }
}

function toggleWindow() {
  if (!win) return
  if (win.isVisible() && !win.isMinimized()) {
    hideToTray()
  } else {
    showWindow()
  }
}

function quitApp() {
  quitting = true
  saveSettings()
  try { tray?.destroy() } catch { /* already gone */ }
  tray = null
  try { win?.destroy() } catch { /* already gone */ }
  app.quit()
}

// ---------------------------------------------------------------------------
// Folder downloads
//
// The web app cannot download folders; the client talks to Quark's private
// drive API instead. src/quark-download.js does the same with the app's own
// session. Triggered by the titlebar button, Ctrl+Shift+D, the tray menu, or
// automatically when view-preload.js spots the site's "install the client"
// notice.
// ---------------------------------------------------------------------------

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function notify(title, body) {
  try {
    new Notification({ title, body, icon: ICON_256 }).show()
  } catch { /* no notification daemon */ }
}

function currentFolder() {
  try {
    return parseFolderFromUrl(view?.webContents.getURL() || '')
  } catch {
    return null
  }
}

let lastProgressSent = 0
function sendDownloadProgress(state, force) {
  const now = Date.now()
  if (!force && now - lastProgressSent < 150) return
  lastProgressSent = now
  if (activeDownload && state.phase === 'downloading') {
    activeDownload.done = state.done
    activeDownload.total = state.total
    activeDownload.totalBytes = state.totalBytes
  }
  if (tray) {
    if (state.phase === 'idle') tray.setToolTip(APP_NAME)
    else if (state.phase === 'listing') tray.setToolTip(`${APP_NAME} — listing folder…`)
    else tray.setToolTip(`${APP_NAME} — downloading ${state.done}/${state.total} (${formatBytes(state.bytes)})`)
  }
  send('dl:progress', state)
}

let lastOpenFolderPrompt = 0

// Shown when the button/notice fires but no folder can be identified (root or
// non-folder views). `force` for manual clicks (always), throttled for the
// automatic notice so it cannot nag.
async function promptOpenFolder(force) {
  if (!win) return
  const now = Date.now()
  if (!force && now - lastOpenFolderPrompt < 60_000) return
  lastOpenFolderPrompt = now
  blockedDialogOpen = true
  try {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Open the folder you want to download first',
      detail:
        'The web version cannot download folders — this app can. Open the folder ' +
        'inside the app, then press the ⬇ button in the bar (or Ctrl+Shift+D).',
    })
  } finally {
    blockedDialogOpen = false
  }
}

async function startFolderDownload({ auto = false } = {}) {
  if (!win || !view) return

  if (activeDownload) {
    if (auto) return
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Cancel download', 'Keep downloading'],
      defaultId: 1,
      cancelId: 1,
      message: 'A folder download is already running',
      detail: `“${activeDownload.name}” — ${activeDownload.done}/${activeDownload.total} files. Cancel it?`,
    })
    if (response === 0) activeDownload.controller.abort()
    return
  }

  const folder = currentFolder()
  if (!folder || folder.fid === '0') {
    console.log('[folder] no folder identified in the current view — prompting')
    await promptOpenFolder(!auto)
    return
  }

  if (auto) {
    if (blockedDialogOpen) return
    blockedDialogOpen = true
    try {
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Download with Kuafu', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        message: 'The web version cannot download folders',
        detail: `Download the folder you are viewing, “${folder.name || folder.fid}”, with the app instead? The folder structure is kept.`,
      })
      if (response !== 0) return
    } finally {
      blockedDialogOpen = false
    }
  }

  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: `Save “${folder.name || folder.fid}” to…`,
    buttonLabel: 'Download here',
    defaultPath: settings.downloadDir || app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (canceled || !filePaths?.length) return

  settings.downloadDir = filePaths[0]
  saveSettings()
  runFolderDownload(folder, filePaths[0])
}

function runFolderDownload(folder, destDir) {
  const controller = new AbortController()
  const name = folder.name || folder.fid
  activeDownload = { controller, name, done: 0, total: 0, totalBytes: 0 }
  console.log(`[folder] downloading “${name}” → ${destDir}`)
  refreshTrayMenu()
  sendDownloadProgress({ phase: 'listing', files: 0, dirs: 0, bytes: 0, totalBytes: 0 }, true)

  let startedNotified = false
  downloadFolder({
    fid: folder.fid,
    name: folder.name,
    destDir,
    signal: controller.signal,
    onProgress: (state) => {
      if (!startedNotified && state.phase === 'downloading' && state.total > 0) {
        startedNotified = true
        notify(
          `${APP_NAME} — downloading “${name}”`,
          `${state.total} file${state.total === 1 ? '' : 's'}` +
            `${state.totalBytes ? ' · ' + formatBytes(state.totalBytes) : ''} → ${destDir}`
        )
      }
      sendDownloadProgress(state)
    },
  })
    .then((result) => {
      console.log(
        `[folder] finished: ${result.downloaded}/${result.total} files · ${formatBytes(result.bytes)} → ${result.targetRoot}` +
          (result.failed.length ? ` (${result.failed.length} failed)` : '')
      )
      if (result.cancelled) {
        notify(`${APP_NAME} — download cancelled`, `${result.downloaded} of ${result.total} files saved to ${result.targetRoot}`)
      } else if (result.failed.length) {
        notify(
          `${APP_NAME} — download finished with errors`,
          `${result.downloaded}/${result.total} files · ${formatBytes(result.bytes)} saved to ${result.targetRoot}\n` +
            `Failed: ${result.failed[0].name} (${result.failed[0].error})`
        )
      } else {
        notify(
          `${APP_NAME} — download complete`,
          `${result.total} file${result.total === 1 ? '' : 's'} · ${formatBytes(result.bytes)} saved to ${result.targetRoot}`
        )
      }
    })
    .catch((err) => {
      if (controller.signal.aborted) {
        notify(`${APP_NAME} — download cancelled`, '')
        return
      }
      console.error(`[folder] failed: ${err?.message || err}`)
      if (win) {
        dialog
          .showMessageBox(win, {
            type: 'error',
            message: 'Folder download failed',
            detail: `${name}: ${err?.message || err}`,
          })
          .catch(() => {})
      }
    })
    .finally(() => {
      activeDownload = null
      refreshTrayMenu()
      sendDownloadProgress({ phase: 'idle' }, true)
    })
}

// ---------------------------------------------------------------------------
// System tray and menus (accelerators)
// ---------------------------------------------------------------------------

function refreshTrayMenu() {
  if (!tray) return
  const template = [
    { label: 'Show Kuafu', click: toggleWindow },
    { type: 'separator' },
    { label: 'Reload', click: () => view?.webContents.reload() },
    { label: 'Download this folder…', click: () => startFolderDownload({ auto: false }) },
    { label: 'Open pan.quark.cn in browser', click: () => openExternalSafely(APP_URL) },
  ]
  if (activeDownload) {
    template.push(
      { type: 'separator' },
      { label: 'Cancel download', click: () => activeDownload?.controller.abort() }
    )
  }
  template.push({ type: 'separator' }, { label: 'Quit', click: quitApp })
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function createTray() {
  const icon = fs.existsSync(ICON_TRAY) ? ICON_TRAY : ICON_256
  tray = new Tray(nativeImage.createFromPath(icon))
  tray.setToolTip(APP_NAME)
  refreshTrayMenu()
  tray.on('click', toggleWindow)
}

function createAppMenu() {
  // The menu is invisible (frameless window) but its shortcuts still work.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Hide to tray', accelerator: 'CmdOrCtrl+W', click: hideToTray },
        { label: 'Download this folder', accelerator: 'CmdOrCtrl+Shift+D', click: () => startFolderDownload({ auto: false }) },
        { type: 'separator' },
        { label: 'Quit Kuafu', accelerator: 'CmdOrCtrl+Q', click: quitApp },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => view?.webContents.reload() },
        { label: 'Force reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => view?.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Developer tools', accelerator: 'F12', click: () => view?.webContents.toggleDevTools() },
      ],
    },
  ]))
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('before-quit', () => { quitting = true })
  app.on('window-all-closed', () => { if (quitting) app.quit() })

  app.whenReady().then(async () => {
    loadSettings()
    colors = readThemeColors()

    // Regular Chrome UA (so the site does not detect Electron).
    session.defaultSession.setUserAgent(buildUA())

    // Minimal permissions, only for Quark hosts. Camera/microphone (media) and
    // silent clipboard reads are intentionally NOT auto-granted: no feature of
    // the web app needs them, and both are privacy-sensitive.
    const ALLOWED = new Set(['clipboard-sanitized-write', 'notifications', 'fullscreen'])
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      let url = ''
      try { url = wc?.getURL?.() || '' } catch { /* already destroyed */ }
      callback(ALLOWED.has(permission) && isInApp(url))
    })
    session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) =>
      ALLOWED.has(permission) && isInApp(origin || ''))

    // Notify when a download finishes.
    session.defaultSession.on('will-download', (_event, item) => {
      item.once('done', (_e, state) => {
        if (state !== 'completed') return
        try {
          new Notification({
            title: `${APP_NAME} — download complete`,
            body: item.getFilename(),
            icon: ICON_256,
          }).show()
        } catch { /* no notification daemon */ }
      })
    })

    createWindow()
    createTray()
    createAppMenu()

    // Keep the titlebar in sync when the Omarchy theme changes at runtime.
    setInterval(() => {
      const next = readThemeColors()
      if (JSON.stringify(next) !== JSON.stringify(colors)) {
        colors = next
        send('theme:colors', colors)
        try { win?.setBackgroundColor(colors.bg) } catch { /* optional */ }
        try { view?.setBackgroundColor(colors.bg) } catch { /* optional */ }
      }
    }, 20000)
  })
}

// IPC is bound to specific webContents (defense in depth): UI messages must
// come from the local titlebar, the site notice from the pan.quark.cn view.
const fromTitlebar = (event) => Boolean(win) && event.sender === win.webContents
const fromSiteView = (event) => Boolean(view) && event.sender === view.webContents

// Titlebar IPC
ipcMain.on('win:hide', (event) => { if (fromTitlebar(event)) hideToTray() })
ipcMain.on('win:toggle-max', (event) => {
  if (!fromTitlebar(event)) return
  win.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.on('app:quit', (event) => { if (fromTitlebar(event)) quitApp() })
ipcMain.on('nav:reload', (event) => { if (fromTitlebar(event)) view?.webContents.reload() })
ipcMain.on('nav:back', (event) => {
  if (!fromTitlebar(event)) return
  const wc = view?.webContents
  if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
})
ipcMain.on('nav:forward', (event) => {
  if (!fromTitlebar(event)) return
  const wc = view?.webContents
  if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
})

// Folder download IPC (titlebar button + site notice detector)
ipcMain.on('folder:download', (event) => {
  if (fromTitlebar(event)) startFolderDownload({ auto: false })
})
ipcMain.on('folder:blocked', (event) => {
  if (!fromSiteView(event)) return
  if (activeDownload || blockedDialogOpen) return
  console.log('[folder] the site refused a folder download')
  startFolderDownload({ auto: true })
})
