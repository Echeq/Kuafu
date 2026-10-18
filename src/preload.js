'use strict'

// Safe bridge between the local titlebar UI and the main process.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('qc', {
  hide: () => ipcRenderer.send('win:hide'),
  minimize: () => ipcRenderer.send('win:hide'),
  quit: () => ipcRenderer.send('app:quit'),
  toggleMax: () => ipcRenderer.send('win:toggle-max'),
  reload: () => ipcRenderer.send('nav:reload'),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  downloadFolder: () => ipcRenderer.send('folder:download'),
  onTitle: (cb) => ipcRenderer.on('page:title', (_e, title) => cb(title)),
  onNavState: (cb) => ipcRenderer.on('page:nav-state', (_e, state) => cb(state)),
  onColors: (cb) => ipcRenderer.on('theme:colors', (_e, colors) => cb(colors)),
  onDlProgress: (cb) => ipcRenderer.on('dl:progress', (_e, state) => cb(state)),
})
