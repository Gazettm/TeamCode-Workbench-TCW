const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tcw', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  importWorkspace: scope => ipcRenderer.invoke('workspace:import', scope),
  list: (scope, id, relative) => ipcRenderer.invoke('workspace:list', scope, id, relative),
  status: (scope, id) => ipcRenderer.invoke('workspace:status', scope, id),
  git: (scope, id, operation, input = {}) => ipcRenderer.invoke('workspace:git', scope, id, operation, input),
  bindGit: (scope, project, workspace, task = null, branch = null) => ipcRenderer.invoke('workspace:bind', scope, project, workspace, task, branch),
  cloneWorkspace: (scope, address) => ipcRenderer.invoke('workspace:clone', scope, address),
  cancelClone: () => ipcRenderer.invoke('workspace:cancel-clone'),
  onCloneProgress: callback => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('workspace:clone-progress', listener);
    return () => ipcRenderer.removeListener('workspace:clone-progress', listener);
  },
  saveNote: (scope, id, relative, text) => ipcRenderer.invoke('note:save', scope, id, relative, text),
  saveSettings: serverUrl => ipcRenderer.invoke('settings:save', serverUrl),
  collaborate: (operation, input) => ipcRenderer.invoke('collaboration', operation, input)
}));
