const { contextBridge, ipcRenderer } = require('electron');

const api = {
  addTask: (url, suggestedName) => ipcRenderer.invoke('api/add-task', url, suggestedName),
  tasks: () => ipcRenderer.invoke('api/tasks'),
  taskStatus: (taskId) => ipcRenderer.invoke('api/task-status', taskId),
  startTask: (taskId) => ipcRenderer.invoke('api/start-task', taskId),
  pauseTask: (taskId) => ipcRenderer.invoke('api/pause-task', taskId),
  stopTask: (taskId) => ipcRenderer.invoke('api/stop-task', taskId),
  removeTask: (taskId, deleteFile) => ipcRenderer.invoke('api/remove-task', taskId, deleteFile),
  downloadsDir: () => ipcRenderer.invoke('api/downloads-dir'),
  openFolder: () => ipcRenderer.invoke('api/open-folder'),
  openUrl: (url) => ipcRenderer.invoke('api/open-url', url),
  openPath: (target) => ipcRenderer.invoke('api/open-path', target),
  revealPath: (target) => ipcRenderer.invoke('api/reveal-path', target),
};

contextBridge.exposeInMainWorld('api', api);
