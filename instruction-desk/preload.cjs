const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  run: (instruction, settings, targetTabId, attachments) => ipcRenderer.invoke('run', instruction, settings, targetTabId, attachments),
  stop: () => ipcRenderer.send('stop'),
  answer: (promptId, answer) => ipcRenderer.send('answer', promptId, answer),
  newChat: () => ipcRenderer.invoke('new-chat'),
  launchBrowser: (profileId) => ipcRenderer.invoke('launch-browser', profileId),
  getChromeProfiles: () => ipcRenderer.invoke('get-chrome-profiles'),
  getActiveChromeProfile: () => ipcRenderer.invoke('get-active-chrome-profile'),
  syncSettings: (settings) => ipcRenderer.invoke('sync-settings', settings),
  getStorage: (key) => ipcRenderer.invoke('get-storage', key),
  setStorage: (key, val) => ipcRenderer.invoke('set-storage', key, val),
  transcribeAudio: (payload) => ipcRenderer.invoke('transcribe-audio', payload),
  onEvent: (cb) => ipcRenderer.on('agent-event', (_e, ev) => cb(ev))
});
