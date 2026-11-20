// Bridge for the chat bubble window.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubble', {
  onOpen: cb => ipcRenderer.on('open', (_e, p) => cb(p)),           // { title, focus }
  onMessage: cb => ipcRenderer.on('message', (_e, m) => cb(m)),     // { role, text, files, open, actions, kind, tag }
  onLoading: cb => ipcRenderer.on('loading', (_e, t) => cb(t)),     // text or null
  onReset: cb => ipcRenderer.on('reset', () => cb()),
  setHeight: h => ipcRenderer.send('bubble-height', h),
  close: () => ipcRenderer.send('bubble-close'),
  send: text => ipcRenderer.send('chat-send', text),
  action: value => ipcRenderer.send('chat-action', value),
  reset: () => ipcRenderer.send('chat-reset'),
  openFile: (file, line) => ipcRenderer.send('open-file', { file, line }),
});
