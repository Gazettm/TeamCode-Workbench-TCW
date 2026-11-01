const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tcw', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  importWorkspace: () => ipcRenderer.invoke('workspace:import'),
  list: (id, relative) => ipcRenderer.invoke('workspace:list', id, relative),
  status: id => ipcRenderer.invoke('workspace:status', id),
  saveNote: (id, relative, text) => ipcRenderer.invoke('note:save', id, relative, text),
  saveSettings: serverUrl => ipcRenderer.invoke('settings:save', serverUrl)
}));
