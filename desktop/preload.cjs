const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tcw', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  importWorkspace: scope => ipcRenderer.invoke('workspace:import', scope),
  list: (scope, id, relative) => ipcRenderer.invoke('workspace:list', scope, id, relative),
  status: (scope, id) => ipcRenderer.invoke('workspace:status', scope, id),
  saveNote: (scope, id, relative, text) => ipcRenderer.invoke('note:save', scope, id, relative, text),
  saveSettings: serverUrl => ipcRenderer.invoke('settings:save', serverUrl),
  collaborate: (operation, input) => ipcRenderer.invoke('collaboration', operation, input)
}));
