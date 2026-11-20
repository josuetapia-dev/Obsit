// Bridge for the hidden "ear" window (speech recognition).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ear', {
  onMode: cb => ipcRenderer.on('ear-mode', (_e, m) => cb(m)),        // 'off' | 'wake' | 'command' | 'dictate'
  onMute: cb => ipcRenderer.on('ear-mute', (_e, on) => cb(on)),      // true while Obsi-boty is speaking
  onTest: cb => ipcRenderer.on('ear-test', (_e, p) => cb(p)),        // debug: recognize a wav file instead of the mic
  send: (type, data) => ipcRenderer.send('ear', { type, data }),
});
