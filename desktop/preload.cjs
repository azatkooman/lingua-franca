// The few desktop-only actions the page may ask for. Runs sandboxed; exposes nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('linguaFrancaDesktop', {
    /** Saves the current page as a PDF, asking where with `fileName` filled in. */
    savePageAsPdf: (fileName) => ipcRenderer.invoke('save-page-as-pdf', String(fileName || '')),
    /** A silent system notification and a flashing taskbar button, for something urgent. */
    notify: (title, body) => ipcRenderer.invoke('notify-operator', { title: String(title || ''), body: String(body || '') }),
    /** Opens OpenAI's billing page in the system browser, to add credit. */
    openOpenAiBilling: () => ipcRenderer.invoke('open-openai-billing'),
});
