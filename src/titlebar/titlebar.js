'use strict'

// Titlebar logic: theme, page title and buttons.

const $ = (id) => document.getElementById(id)
const api = window.qc

// --- Omarchy theme ---------------------------------------------------------
api.onColors((c) => {
  const root = document.documentElement.style
  root.setProperty('--bg', c.bg)
  root.setProperty('--fg', c.fg)
  root.setProperty('--border', c.border)
  root.setProperty('--hover', c.hover)
  root.setProperty('--close', c.close)
  root.setProperty('--close-fg', c.closeFg)
  root.setProperty('--muted', c.muted)
})

// --- Page title and folder-download progress -------------------------------
let pageTitle = ''
let dlState = null

function fmtBytes(n) {
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

function renderTitle() {
  const el = $('ptitle')
  $('dl').classList.toggle('busy', Boolean(dlState))
  if (dlState && dlState.phase === 'listing') {
    el.textContent = dlState.files ? `Listing folder… (${dlState.files} files)` : 'Listing folder…'
  } else if (dlState && dlState.phase === 'downloading') {
    const count = dlState.total ? `${dlState.done} / ${dlState.total}` : `${dlState.done}`
    const size = dlState.totalBytes
      ? `${fmtBytes(dlState.bytes)} / ${fmtBytes(dlState.totalBytes)}`
      : fmtBytes(dlState.bytes)
    el.textContent = `Downloading ${count} · ${size}`
  } else {
    el.textContent = pageTitle || 'Kuafu'
  }
}

api.onTitle((title) => {
  pageTitle = title
  document.title = title ? `${title} — Kuafu` : 'Kuafu'
  renderTitle()
})

api.onDlProgress((state) => {
  dlState = state && state.phase !== 'idle' ? state : null
  renderTitle()
})

// --- Navigation state ------------------------------------------------------
api.onNavState((state) => {
  $('back').disabled = !state.canBack
  $('forward').disabled = !state.canForward
  $('reload').classList.toggle('spin', Boolean(state.loading))
})

// --- Buttons ---------------------------------------------------------------
$('back').addEventListener('click', () => api.back())
$('forward').addEventListener('click', () => api.forward())
$('reload').addEventListener('click', () => api.reload())
$('dl').addEventListener('click', () => api.downloadFolder())
$('min').addEventListener('click', () => api.minimize())
$('close').addEventListener('click', () => api.hide())

// Double click on the bar (outside the buttons) maximizes/restores.
$('bar').addEventListener('dblclick', (event) => {
  if (event.target.closest('button')) return
  api.toggleMax()
})
