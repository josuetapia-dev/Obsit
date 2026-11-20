// Bridge between the robot page and the main process. Only these few calls are exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('obsi', {
  setIgnore: ignore => ipcRenderer.send('set-ignore', ignore),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  click: () => ipcRenderer.send('robot-click'),
  menu: () => ipcRenderer.send('menu'),
  onCursor: cb => ipcRenderer.on('cursor', (_e, p) => cb(p)),
  onState: cb => ipcRenderer.on('state', (_e, s) => cb(s)),   // { name, revert, ms }
});
