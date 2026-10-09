// The few desktop-only actions the page may ask for. Runs sandboxed; exposes nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('linguaFrancaDesktop', {
    /** Saves the current page as a PDF, asking where with `fileName` filled in. */
    savePageAsPdf: (fileName) => ipcRenderer.invoke('save-page-as-pdf', String(fileName || '')),
});
