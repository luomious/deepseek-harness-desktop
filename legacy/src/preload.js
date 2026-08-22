const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  installPlugin: (name) => ipcRenderer.invoke('plugin:install', name),
  uninstallPlugin: (name) => ipcRenderer.invoke('plugin:uninstall', name),
  installLocalPlugin: (path) => ipcRenderer.invoke('plugin:installLocal', path),
  listPlugins: () => ipcRenderer.invoke('plugin:list'),
  listCatalog: (query, sort) => ipcRenderer.invoke('plugin:catalog', query, sort),
  recommendPlugins: (query) => ipcRenderer.invoke('plugin:recommend', query),
  setPluginEnabled: (name, enabled) => ipcRenderer.invoke('plugin:setEnabled', name, enabled),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
});
