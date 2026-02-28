const { app, BrowserWindow } = require('electron');
console.log('--- Startup Diagnostic ---');
console.log('Electron app object exists:', !!app);
console.log('Process versions:', JSON.stringify(process.versions, null, 2));
console.log('--------------------------');
const path = require('path');
const { PeerServer } = require('peer');
const express = require('express');
const https = require('https');
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

    const isDev = process.env.NODE_ENV === 'development';

    if (isDev) {
        app.commandLine.appendSwitch('ignore-certificate-errors');
        mainWindow.loadURL('https://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        // In production, we load from the internal plain HTTP listener bypass
        mainWindow.loadURL('http://localhost:4174/');
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

async function startServers() {
    const isDev = process.env.NODE_ENV === 'development';
    const localIp = getLocalIp();

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

    // 1. Start PeerJS Signaling Server (Secure WSS)
    console.log('Starting internal PeerJS signaling server securely on port 9000...');
    const peerServer = PeerServer({
        port: 9000,
        path: '/',
        ssl: {
            key: pems.private,
            cert: pems.cert
        }
    });

    console.log('PeerJS server object created. Setting up listeners...');
    peerServer.on('connection', (client) => console.log('Client connected:', client.getId()));
    peerServer.on('disconnect', (client) => console.log('Client disconnected:', client.getId()));

    console.log('PeerJS event listeners attached.');

    // 2. Start Express Web Server (Production Only)
    if (!isDev) {
        console.log('Production mode detected. Initializing Express...');
        const expressApp = express();

        // Return the local IP to the frontend Admin Dashboard
        expressApp.get('/api/local-ip', (req, res) => {
            res.json({ ip: localIp });
        });

        // Serve the React static build folder
        expressApp.use(express.static(path.join(__dirname, '../dist')));

        // Redirect all 404s to index.html for React Router
        expressApp.use((req, res) => {
            res.sendFile(path.join(__dirname, '../dist/index.html'));
        });

        // HTTPS server on port 4173 for external devices (phones)
        const httpsServer = https.createServer({
            key: pems.private,
            cert: pems.cert
        }, expressApp);

        // HTTP server on port 4174 for the local Electron window (no SSL issues)
        const http = require('http');
        http.createServer(expressApp).listen(4174, 'localhost');

        httpsServer.listen(4173, '0.0.0.0', () => {
            console.log('====================================================');
            console.log('🌐 Web UI is now locally hosted over secure HTTPS!');
            console.log(`📱 Tell smartphones to visit: https://${localIp}:4173`);
            console.log('====================================================');
        });
    }
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
