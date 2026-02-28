const { app, BrowserWindow } = require('electron');
const path = require('path');
const { PeerServer } = require('peer');
const express = require('express');
const https = require('https');
const http = require('http');
const forge = require('node-forge');
const os = require('os');

let mainWindow;

// Helper to get local IP
function getLocalIp() {
    console.log('Detecting local IP address...');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    app.commandLine.appendSwitch('ignore-certificate-errors');

    const isDev = process.env.NODE_ENV === 'development';

    if (isDev) {
        mainWindow.loadURL('https://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        // In production, we load from the internal plain HTTP listener bypass
        mainWindow.loadURL('http://localhost:4174/');
    }

    // Handle session permissions (specifically for microphone)
    mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
        if (permission === 'media') return true;
        return false;
    });

    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media') return callback(true);
        callback(false);
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

async function startServers() {
    const isDev = process.env.NODE_ENV === 'development';
    const localIp = getLocalIp();

    console.log('--- Startup Diagnostic ---');
    console.log('Electron app object exists:', !!app);
    console.log('Process versions:', JSON.stringify(process.versions, null, 2));
    console.log('--------------------------');

    // Generate self-signed SSL certificates synchronously using node-forge
    console.log('Generating self-signed SSL certificates...');
    const pki = forge.pki;
    console.log('Starting RSA key generation (2048-bit)...');
    const keys = pki.rsa.generateKeyPair(2048);
    console.log('RSA key generation complete.');
    const cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    const certAttrs = [{ name: 'commonName', value: localIp }];
    cert.setSubject(certAttrs);
    cert.setIssuer(certAttrs);
    cert.sign(keys.privateKey);
    const pems = {
        private: pki.privateKeyToPem(keys.privateKey),
        cert: pki.certificateToPem(cert)
    };
    console.log('SSL certificates generated successfully.');

    // SSL certificate data for servers
    const sslOptions = {
        key: pems.private,
        cert: pems.cert
    };

    // 1. Initialize Express and PeerJS
    const expressApp = express();
    const { ExpressPeerServer } = require('peer');

    // Create a temporary server for PeerJS to attach to (will be overridden by our main listen calls)
    const tempServer = http.createServer(expressApp);
    const peerServer = ExpressPeerServer(tempServer, {
        debug: true,
        path: '/'
    });

    expressApp.use('/peerjs', peerServer);
    expressApp.use(express.json());

    console.log('PeerJS signaling server attached to Express at /peerjs');

    // PeerJS events
    peerServer.on('connection', (client) => console.log('Peer connected:', client.getId()));
    peerServer.on('disconnect', (client) => console.log('Peer disconnected:', client.getId()));

    // Settings persistence
    const settingsPath = path.join(app.getPath('userData'), 'lingua-franca-settings.json');
    let settings = {
        languages: [
            { id: 'english', name: 'English', description: 'Main translation channel' },
            { id: 'spanish', name: 'Español', description: 'Canal de traducción al español' },
            { id: 'french', name: 'Français', description: 'Canal de traduction française' },
            { id: 'german', name: 'Deutsch', description: 'Deutscher Übersetzungскanal' },
            { id: 'russian', name: 'Русский', description: 'Русский канал перевода' }
        ],
        adminPin: '1234'
    };

    try {
        if (require('fs').existsSync(settingsPath)) {
            settings = JSON.parse(require('fs').readFileSync(settingsPath, 'utf8'));
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }

    const saveSettings = () => {
        try {
            require('fs').writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        } catch (e) {
            console.error('Failed to save settings:', e);
        }
    };

    // API endpoints
    expressApp.get('/api/local-ip', (req, res) => {
        res.json({ ip: localIp });
    });

    expressApp.get('/api/settings', (req, res) => {
        res.json(settings);
    });

    expressApp.post('/api/settings', (req, res) => {
        settings = { ...settings, ...req.body };
        saveSettings();
        res.json({ success: true, settings });
    });

    if (!isDev) {
        console.log('Production mode detected. Initializing Static serving...');
        // Serve the React static build folder
        expressApp.use(express.static(path.join(__dirname, 'dist')));

        // Redirect all 404s to index.html for React Router
        expressApp.use((req, res) => {
            if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
            res.sendFile(path.join(__dirname, 'dist/index.html'));
        });
    }

    // HTTPS server on port 4173 for external devices (phones)
    const httpsServer = https.createServer(sslOptions, expressApp);

    // HTTP server on port 4174 for the local Electron window (no SSL issues)
    http.createServer(expressApp).listen(4174, 'localhost');

    httpsServer.listen(4173, '0.0.0.0', () => {
        console.log('====================================================');
        console.log('🌐 Web UI and API are now live!');
        console.log(`📱 Connect devices at: https://${localIp}:4173`);
        console.log('====================================================');
    });
}

app.whenReady().then(async () => {
    app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
        event.preventDefault();
        callback(true); // Trust self-signed certs
    });

    console.log('App is ready. Initializing servers...');
    await startServers();
    console.log('Servers initialized. Creating window...');
    createWindow();
    console.log('Window creation call complete.');

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
