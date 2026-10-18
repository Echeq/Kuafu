'use strict'

// Recursive folder download (Kuafu — unofficial Quark Cloud client).
//
// The web app refuses to download folders ("网页端不支持文件夹下载, 请使用客户端")
// and asks for the desktop client. The client's trick is to call Quark's own
// private drive API: list the folder recursively, ask for each file's signed
// download URL, and save the files keeping the tree. This module does the
// same from the main process, reusing the app's logged-in session (net.fetch
// uses the default session, so cookies are sent automatically).
//
// Hard-earned details (also noted in AGENTS.md):
//   - The drive API (drive-pc.quark.cn, pr=ucpro&fr=pc) answers code 23018
//     when it dislikes the caller; sending the PC client's user agent (the
//     "quark-cloud-drive/..." Electron string below) avoids it.
//   - download_url links are signed and expire, so links are requested in
//     batches right before downloading, and refreshed once on failure.
//   - Personal drive URLs look like
//     https://pan.quark.cn/list#/list/all/<fid>-<name>/<subfid>-<subname>;
//     the last segment is the folder currently open.

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const { net } = require('electron')

const PAN_ORIGIN = 'https://pan.quark.cn'
const DRIVE_BASE = 'https://drive-pc.quark.cn'
const PAGE_SIZE = 100
const LINK_BATCH = 50
const CONCURRENCY = 3
const MAX_PAGES_PER_DIR = 500

const CLIENT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'quark-cloud-drive/2.5.56 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 ' +
  'Safari/537.36 Channel/pckk_other_ch'

const FID_RE = /^([a-fA-F0-9]{32})(?:-(.*))?$/

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

// Returns { fid, name } for the folder currently open in the drive, or null
// when the page is not a personal-drive folder listing. The drive root has
// fid '0'.
function parseFolderFromUrl(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl || ''))
  } catch {
    return null
  }
  if (!/(^|\.)(pan|drive)\.quark\.cn$/i.test(url.hostname)) return null

  const hash = url.hash.replace(/^#/, '').split('?')[0]
  const match = hash.match(/^\/?list\/all(?:\/(.*))?$/i)
  if (!match) return null

  const rest = (match[1] || '').replace(/^\/+|\/+$/g, '')
  if (!rest) return { fid: '0', name: '' }

  let segment = rest.split('/').filter(Boolean).pop() || ''
  try {
    segment = decodeURIComponent(segment)
  } catch { /* keep raw */ }
  segment = segment.split('*')[0] // Quark appends extra params after '*'

  const fidMatch = segment.match(FID_RE)
  if (!fidMatch) return null
  return { fid: fidMatch[1], name: (fidMatch[2] || '').trim() }
}

// ---------------------------------------------------------------------------
// Drive API helpers
// ---------------------------------------------------------------------------

function apiHeaders(withBody) {
  const headers = {
    'User-Agent': CLIENT_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN',
    Origin: PAN_ORIGIN,
    Referer: `${PAN_ORIGIN}/`,
  }
  if (withBody) headers['Content-Type'] = 'application/json;charset=UTF-8'
  return headers
}

function describeApiError(body) {
  const code = body?.code
  if (code === 31001 || code === 40001 || code === 10000) {
    return 'Session expired — log in again in the app.'
  }
  if (code === 23018) return 'Quark risk control blocked the download — wait a few minutes and retry.'
  return body?.message || `Drive API error (${code ?? 'unknown'})`
}

async function apiJson(url, { method = 'GET', body, signal } = {}) {
  let res
  try {
    res = await net.fetch(url, {
      method,
      headers: apiHeaders(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      // Without this, net.fetch (same-origin default) sends NO session
      // cookies to drive-pc.quark.cn and the API answers 31001 "guest".
      credentials: 'include',
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw new Error('cancelled')
    throw new Error(`Network error: ${err?.message || err}`)
  }
  let json = null
  try {
    json = await res.json()
  } catch { /* not JSON */ }
  if (!json || typeof json.code !== 'number') {
    throw new Error(`Drive API returned HTTP ${res.status} (unexpected body)`)
  }
  if (json.code !== 0) throw new Error(describeApiError(json))
  return json.data
}

function apiListPage(pdirFid, page, signal) {
  const url =
    `${DRIVE_BASE}/1/clouddrive/file/sort?pr=ucpro&fr=pc` +
    `&pdir_fid=${encodeURIComponent(pdirFid || '0')}` +
    `&_page=${page}&_size=${PAGE_SIZE}` +
    `&_sort=file_type:asc,file_name:asc`
  return apiJson(url, { signal }).then((data) => data?.list || [])
}

async function apiDownloadLinks(fids, signal) {
  const url = `${DRIVE_BASE}/1/clouddrive/file/download?pr=ucpro&fr=pc`
  const data = await apiJson(url, { method: 'POST', body: { fids }, signal })
  const list = Array.isArray(data) ? data : data?.list || []
  const links = new Map()
  for (const entry of list) {
    if (entry?.fid && entry.download_url) links.set(entry.fid, entry.download_url)
  }
  return links
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function safeName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/\u0000]/g, '_')
    .trim()
  if (!cleaned || /^\.+$/.test(cleaned)) return 'unnamed'
  return cleaned
}

async function downloadFile(url, target, signal, onBytes) {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const res = await net.fetch(url, {
    credentials: 'include',
    signal,
    headers: {
      'User-Agent': CLIENT_UA,
      Accept: '*/*',
      Origin: PAN_ORIGIN,
      Referer: `${PAN_ORIGIN}/`,
    },
  })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

  // O_NOFOLLOW: refuse to write through a symlink that happens to sit at the
  // target path (a pre-existing symlink could redirect the write elsewhere).
  let fd
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      0o644
    )
  } catch (err) {
    if (err?.code === 'ELOOP') throw new Error('destination is a symlink — not writing through it')
    throw err
  }

  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      if (onBytes) onBytes(chunk.length)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(target, { fd }))
  } catch (err) {
    await fsp.rm(target, { force: true }).catch(() => {})
    throw err
  }
}

// ---------------------------------------------------------------------------
// Folder walk
// ---------------------------------------------------------------------------

async function listFolder(rootFid, { signal, onProgress } = {}) {
  const dirs = []
  const files = []
  const queue = [{ fid: rootFid || '0', rel: '' }]

  while (queue.length) {
    if (signal?.aborted) throw new Error('cancelled')
    const { fid, rel } = queue.shift()
    let page = 1
    for (;;) {
      const list = await apiListPage(fid, page, signal)
      for (const item of list) {
        const name = safeName(item.file_name)
        if (item.dir === true || item.file_type === 0) {
          const childRel = rel ? `${rel}/${name}` : name
          dirs.push(childRel)
          queue.push({ fid: item.fid, rel: childRel })
        } else {
          files.push({ fid: item.fid, name, rel, size: Number(item.size) || 0 })
        }
      }
      if (list.length < PAGE_SIZE || page >= MAX_PAGES_PER_DIR) break
      page += 1
    }
    if (onProgress) onProgress({ files: files.length, dirs: dirs.length, current: rel })
  }
  return { dirs, files }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// Downloads every file under the drive folder `fid` into
// `<destDir>/<name>/`, keeping the tree. Progress callback receives
// { phase: 'listing' | 'downloading', files, dirs, done, total, bytes,
//   totalBytes, current }.
async function downloadFolder({ fid, name, destDir, signal, onProgress } = {}) {
  const report = onProgress || (() => {})
  const folderName = name ? safeName(name) : `quark-${String(fid || '0').slice(0, 8)}`
  const targetRoot = path.join(destDir, folderName)

  report({ phase: 'listing', files: 0, dirs: 0, bytes: 0, totalBytes: 0 })
  const { dirs, files } = await listFolder(fid, {
    signal,
    onProgress: ({ files: f, dirs: d, current }) =>
      report({ phase: 'listing', files: f, dirs: d, bytes: 0, totalBytes: 0, current }),
  })

  await fsp.mkdir(targetRoot, { recursive: true })
  for (const rel of dirs) await fsp.mkdir(path.join(targetRoot, rel), { recursive: true })

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  let done = 0
  let bytes = 0
  const failed = []

  const tick = (current) =>
    report({ phase: 'downloading', done, total: files.length, bytes, totalBytes, current })

  for (let i = 0; i < files.length; i += LINK_BATCH) {
    if (signal?.aborted) break
    const batch = files.slice(i, i + LINK_BATCH)
    let links = await apiDownloadLinks(batch.map((file) => file.fid), signal)
    const queue = batch.slice()

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, queue.length) },
      async () => {
        while (queue.length) {
          if (signal?.aborted) return
          const file = queue.shift()
          const target = path.join(targetRoot, file.rel || '', file.name)
          try {
            let url = links.get(file.fid)
            if (!url) throw new Error('no download link returned')
            try {
              await downloadFile(url, target, signal, (n) => {
                bytes += n
                tick(file.name)
              })
            } catch (err) {
              if (signal?.aborted) throw err
              // Signed links can expire mid-run: refresh this file once.
              links = await apiDownloadLinks([file.fid], signal)
              url = links.get(file.fid)
              if (!url) throw err
              await downloadFile(url, target, signal, (n) => {
                bytes += n
                tick(file.name)
              })
            }
          } catch (err) {
            if (signal?.aborted) return
            failed.push({
              name: path.join(file.rel || '', file.name),
              error: err?.message || String(err),
            })
          }
          done += 1
          tick(file.name)
        }
      }
    )
    await Promise.all(workers)
  }

  return {
    total: files.length,
    downloaded: done - failed.length,
    failed,
    bytes,
    totalBytes,
    targetRoot,
    cancelled: Boolean(signal?.aborted),
  }
}

module.exports = {
  parseFolderFromUrl,
  downloadFolder,
  // Exposed for debugging scripts run against a logged-in profile.
  _internal: { listFolder, apiDownloadLinks, downloadFile },
}
