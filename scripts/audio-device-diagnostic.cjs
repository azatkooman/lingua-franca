const { app, BrowserWindow } = require('electron');
const fs = require('fs');

app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    const appSession = window.webContents.session;
    appSession.setPermissionCheckHandler((_contents, permission, origin) =>
        permission === 'media' && ['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
    appSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'media'));
    await window.loadURL('http://localhost:4174/');
    const result = await window.webContents.executeJavaScript(`(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((track) => track.stop());
            await new Promise((resolve) => setTimeout(resolve, 200));
            const devices = await navigator.mediaDevices.enumerateDevices();
            return { devices: devices.filter((device) => device.kind === 'audioinput').map((device) => device.label), error: '' };
        } catch (error) {
            return { devices: [], error: String(error && (error.name + ': ' + error.message)) };
        }
    })()`);
    const output = JSON.stringify(result);
    console.log(output);
    if (process.env.LINGUA_FRANCA_DIAGNOSTIC_FILE) fs.writeFileSync(process.env.LINGUA_FRANCA_DIAGNOSTIC_FILE, output);
    window.destroy();
    app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
