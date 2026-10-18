'use strict'

// Preload for the site view (pan.quark.cn), isolated world, sandboxed.
//
// Watches the page for Quark's "the web cannot download folders" notice
// (网页端不支持文件夹下载) and tells the main process, which offers to
// download the current folder with src/quark-download.js instead.
// The page itself is untouched: only DOM reads happen here.

const { ipcRenderer } = require('electron')

const MARK = '网页端不支持文件夹下载'
const SCAN_EVERY_MS = 2000

let reported = false
let lastScan = 0
let timer = null

function schedule(delay) {
  if (timer) return
  timer = setTimeout(check, delay)
}

// The notice is a small dialog; require the element holding the text to be
// actually rendered (getClientRects covers position:fixed dialogs too).
function noticeVisible() {
  for (const el of document.querySelectorAll('body *')) {
    if (el.childElementCount > 4) continue
    const text = el.textContent
    if (!text || !text.includes(MARK)) continue
    if (el.getClientRects().length) return true
  }
  return false
}

function check() {
  timer = null
  if (!document.body) return
  if (!document.body.textContent.includes(MARK)) {
    reported = false
    return
  }
  if (reported) return

  const now = Date.now()
  const wait = SCAN_EVERY_MS - (now - lastScan)
  if (wait > 0) {
    schedule(wait)
    return
  }
  lastScan = now

  if (noticeVisible()) {
    reported = true
    ipcRenderer.send('folder:blocked')
    return
  }
  // Layout may not be computed yet (hidden or not-yet-painted window):
  // keep watching cheaply while the notice text stays in the DOM.
  schedule(SCAN_EVERY_MS)
}

new MutationObserver(() => schedule(500)).observe(document, {
  childList: true,
  subtree: true,
  characterData: true,
})

window.addEventListener('DOMContentLoaded', () => schedule(1200))
