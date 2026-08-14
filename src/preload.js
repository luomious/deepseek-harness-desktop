const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  installPlugin: (name) => ipcRenderer.invoke('plugin:install', name),
  uninstallPlugin: (name) => ipcRenderer.invoke('plugin:uninstall', name),
  installLocalPlugin: (path) => ipcRenderer.invoke('plugin:installLocal', path),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
});
