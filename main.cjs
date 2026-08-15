const { app, BrowserWindow, session, systemPreferences } = require('electron');
const path = require('path');

// Initialize command line flags BEFORE anything else
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost');
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer'); // For some linux systems if relevant

const express = require('express');
const https = require('https');
const http = require('http');
const forge = require('node-forge');
const os = require('os');
const fs = require('fs');

// Diagnostic helper
function getDiagnosticInfo(workerPath) {
    let diag = `Diagnostics for: ${workerPath}\n`;
    try {
        diag += `Exists: ${fs.existsSync(workerPath)}\n`;
        if (fs.existsSync(workerPath)) {
            const stats = fs.statSync(workerPath);
            diag += `Is File: ${stats.isFile()}, Is Dir: ${stats.isDirectory()}\n`;
        }

        // Check parent segments
        let current = workerPath;
        for (let i = 0; i < 5; i++) {
            current = path.dirname(current);
            const exists = fs.existsSync(current);
            const isDir = exists ? fs.statSync(current).isDirectory() : false;
            diag += `Parent ${current}: exists=${exists}, isDir=${isDir}\n`;
            if (current === '/' || current === '.') break;
        }
    } catch (err) {
        diag += `Diag error: ${err.message}\n`;
    }
    return diag;
}

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
        mainWindow.loadURL('https://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        // In production, we load from the internal plain HTTP listener bypass
        mainWindow.loadURL('http://localhost:4174/');
    }

    // Handle session permissions (specifically for microphone)
    mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
        if (permission === 'media' || permission === 'audioCapture') return true;
        return false;
    });

    mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media' || permission === 'audioCapture') return callback(true);
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

    // 1. Initialize Express & Socket.io
    const expressApp = express();
    const { Server: SocketServer } = require('socket.io');
    const mediasoup = require('mediasoup');
    expressApp.use(express.json());

    // 2. Create the actual servers
    const httpsServer = https.createServer(sslOptions, expressApp);
    const httpServer = http.createServer(expressApp);

    // 3. Initialize Socket.io on HTTPS (for phones) and handle HTTP upgrade
    const io = new SocketServer(httpsServer, {
        cors: { origin: "*" }
    });

    httpServer.on('upgrade', (req, socket, head) => {
        io.engine.handleUpgrade(req, socket, head);
    });

    // 4. Mediasoup Configuration & State
    let worker;
    let router;
    let sfuInitError = null; // Store the actual initialization error
    const transports = new Map(); // socket.id -> transport
    const producers = new Map();  // channelName -> producer
    const consumers = new Map();  // socket.id -> consumer

    const createWorker = async () => {
        // Explicitly handle worker path for packaged Electron apps
        let workerPath = undefined;
        if (!isDev) {
            const isWin = process.platform === 'win32';
            const binName = isWin ? 'mediasoup-worker.exe' : 'mediasoup-worker';
            const altBinName = isWin ? 'mediasoup-worker' : 'mediasoup-worker.exe'; // Try both on Windows ARM

            // Potential locations for the worker binary
            const candidatePaths = [];

            const dirs = [
                path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'mediasoup', 'worker', 'out', 'Release'),
                path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'mediasoup', 'worker', 'out', 'Debug'),
                path.join(process.resourcesPath, 'bin'),
                path.join(process.cwd(), 'bin')
            ];

            for (const dir of dirs) {
                candidatePaths.push(path.join(dir, binName));
                if (isWin) candidatePaths.push(path.join(dir, altBinName));
            }

            let scanResults = [];
            console.log('--- Mediasoup Path Diagnostics ---');
            for (const p of candidatePaths) {
                const exists = fs.existsSync(p);
                console.log(`Checking path: ${p} (Exists: ${exists})`);
                if (exists) {
                    workerPath = p;
                    break;
                }
            }

            if (!workerPath) {
                console.error('CRITICAL: mediasoup-worker binary not found in primary candidate paths.');

                // Deep scan of resourcesPath for debugging
                try {
                    console.log('--- Deep Resources Scan ---');
                    const scanDir = (dir, depth = 0) => {
                        if (depth > 3) return;
                        const files = fs.readdirSync(dir);
                        for (const f of files) {
                            const full = path.join(dir, f);
                            let isDir = false;
                            try { isDir = fs.statSync(full).isDirectory(); } catch (e) { }

                            if (f.includes('mediasoup-worker')) {
                                // Check if it's a Windows or Mac binary by reading first 4 bytes
                                let type = "unknown";
                                try {
                                    const buffer = Buffer.alloc(4);
                                    const fd = fs.openSync(full, 'r');
                                    fs.readSync(fd, buffer, 0, 4, 0);
                                    fs.closeSync(fd);
                                    if (buffer[0] === 0x4d && buffer[1] === 0x5a) type = "Windows (MZ)";
                                    else if (buffer[0] === 0xcf && buffer[1] === 0xfa && buffer[2] === 0xed && buffer[3] === 0xfe) type = "Mac (64-bit)";
                                    else type = `Other (${buffer.toString('hex')})`;
                                } catch (e) { }

                                console.log(`[FOUND]: ${full} [Type: ${type}]`);
                                scanResults.push(`FOUND: ${f} (${type}) at ${full}`);
                            }
                            if (isDir) scanDir(full, depth + 1);
                        }
                    };
                    scanDir(process.resourcesPath);
                } catch (e) {
                    console.log('Scan failed:', e.message);
                }

                const helpMsg = isWin
                    ? `\n\n[DIAGNOSTICS]\nInventory: ${scanResults.length > 0 ? scanResults.join(', ') : 'No worker found in ' + process.resourcesPath}\n\nTIP: Windows binaries must be "Windows (MZ)" type. If you see "Mac" type, please delete node_modules on the VM and run "npm install" locally in the VM (not on a shared Parallels folder).`
                    : "";
                throw new Error(`mediasoup-worker binary not found.${helpMsg}`);
            }

            // Ensure executable permission (mostly for Mac/Linux)
            if (fs.existsSync(workerPath) && !isWin) {
                try {
                    fs.chmodSync(workerPath, 0o755);
                    console.log('Successfully set 755 permissions on workerPath');
                } catch (chmodErr) {
                    console.warn('Failed to chmod workerPath:', chmodErr.message);
                }
            }
            console.log('Using workerPath:', workerPath);
            console.log('----------------------------------');
        }

        // Change working directory out of 'app.asar' boundaries to prevent OS spawn ENOTDIR issues
        const originalCwd = process.cwd();
        if (!isDev && originalCwd.includes('app.asar')) {
            try {
                process.chdir(process.resourcesPath);
                console.log('Temporarily changed CWD to:', process.cwd());
            } catch (ignoreOut) { }
        }

        try {
            // Spawn the worker. ExtraResources location avoids ASAR issues.
            worker = await mediasoup.createWorker({
                logLevel: 'debug',
                logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
                rtcMinPort: 10000,
                rtcMaxPort: 10100,
                workerBin: workerPath // CRITICAL: It is `workerBin` in Mediasoup v3, NOT `executablePath`
            });
        } catch (spawnErr) {
            console.error('Worker Spawn Error:', spawnErr);
            throw new Error(`${spawnErr.message}\n\nPath: ${workerPath}\nCWD: ${process.cwd()}\n${getDiagnosticInfo(workerPath)}`);
        } finally {
            if (!isDev && originalCwd.includes('app.asar')) {
                try {
                    process.chdir(originalCwd);
                } catch (ignoreBack) { }
            }
        }

        worker.on('died', () => {
            console.error('mediasoup worker died, exiting in 2 seconds...');
            setTimeout(() => process.exit(1), 2000);
        });
        return worker;
    };

    try {
        worker = await createWorker();
        router = await worker.createRouter({
            mediaCodecs: [
                {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2,
                }
            ]
        });
        console.log('Mediasoup worker and router initialized successfully.');
    } catch (err) {
        sfuInitError = err.message || String(err);
        console.error('CRITICAL: Failed to initialize Mediasoup worker:', err);
        console.error('Detailed Error Stack:', err.stack);
        console.error('SFU will not be available. The app will still open.');
    }

    // 5. SFU Signaling Layer (Socket.io)
    io.on('connection', (socket) => {
        console.log('Client connected:', socket.id);

        socket.on('getRouterRtpCapabilities', (callback) => {
            if (!router) {
                console.error('getRouterRtpCapabilities: Router not initialized. Error:', sfuInitError);
                return callback({ error: `SFU Router not initialized: ${sfuInitError || 'Unknown startup failure'}` });
            }
            callback(router.rtpCapabilities);
        });

        socket.on('createWebRtcTransport', async ({ type }, callback) => {
            if (!router) {
                return callback({ error: `SFU Router not initialized: ${sfuInitError || 'Unknown startup failure'}` });
            }
            try {
                const transport = await router.createWebRtcTransport({
                    listenIps: [{ ip: '0.0.0.0', announcedIp: localIp }],
                    enableUdp: true,
                    enableTcp: true,
                    preferUdp: true,
                });

                transport.on('dtlsstatechange', (dtlsState) => {
                    if (dtlsState === 'closed') transport.close();
                });

                transports.set(socket.id, transport);

                callback({
                    id: transport.id,
                    iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates,
                    dtlsParameters: transport.dtlsParameters,
                });
            } catch (error) {
                console.error('Error creating transport:', error);
                callback({ error: error.message });
            }
        });

        socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
            const transport = transports.get(socket.id);
            if (transport && transport.id === transportId) {
                await transport.connect({ dtlsParameters });
                callback();
            }
        });

        socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
            const transport = transports.get(socket.id);
            if (transport && transport.id === transportId) {
                const producer = await transport.produce({ kind, rtpParameters, appData });
                const channelName = appData.channelName;
                producers.set(channelName, producer);

                producer.on('transportclose', () => {
                    producer.close();
                    producers.delete(channelName);
                    io.emit('producerClosed', { channelName });
                });

                producer.on('close', () => {
                    producers.delete(channelName);
                    io.emit('producerClosed', { channelName });
                });

                callback({ id: producer.id });
                // Notify all listeners on this channel that a producer is live
                socket.broadcast.emit('producerAvailable', { channelName });
            }
        });

        socket.on('consume', async ({ transportId, rtpCapabilities, channelName }, callback) => {
            try {
                const producer = producers.get(channelName);
                if (!producer) {
                    return callback({ error: 'No producer for this channel' });
                }

                if (!router || !router.canConsume({ producerId: producer.id, rtpCapabilities })) {
                    const reason = !router ? `Router not ready: ${sfuInitError}` : 'Device cannot consume this stream';
                    return callback({ error: reason });
                }

                const transport = transports.get(socket.id);
                if (transport && transport.id === transportId) {
                    const consumer = await transport.consume({
                        producerId: producer.id,
                        rtpCapabilities,
                        paused: false, // Start unpaused
                    });

                    consumer.on('transportclose', () => consumer.close());
                    consumer.on('producerclose', () => consumer.close());

                    callback({
                        id: consumer.id,
                        producerId: producer.id,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                    });
                }
            } catch (error) {
                console.error('Consume error:', error);
                callback({ error: error.message });
            }
        });

        socket.on('disconnect', () => {
            console.log('Client disconnected:', socket.id);
            const transport = transports.get(socket.id);
            if (transport) {
                transport.close();
                transports.delete(socket.id);
            }
        });

        socket.on('sendTranslationText', ({ channelName, text, originalText }) => {
            io.emit('translationText', { channelName, text, originalText });
        });
    });

    console.log('Mediasoup SFU with Socket.io signaling initialized on port 4173/4174');

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

    expressApp.post('/api/translate', async (req, res) => {
        const { text, sourceLang, targetLang } = req.body;
        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        const apiKey = settings.geminiApiKey;

        // Language code mapping (ISO 639-1) for MyMemory
        const languageIsoMap = {
            'english': 'en',
            'spanish': 'es',
            'español': 'es',
            'french': 'fr',
            'français': 'fr',
            'german': 'de',
            'deutsch': 'de',
            'russian': 'ru',
            'русский': 'ru'
        };

        const getIsoCode = (langName) => {
            if (!langName) return 'en';
            const normalized = langName.toLowerCase();
            return languageIsoMap[normalized] || normalized.substring(0, 2);
        };

        const sourceIso = getIsoCode(sourceLang);
        const targetIso = getIsoCode(targetLang);

        if (apiKey) {
            console.log(`Translating using Gemini: "${text}" from ${sourceLang} to ${targetLang}`);
            try {
                // Call Gemini REST API
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{
                                text: `Translate the following text from ${sourceLang} to ${targetLang}. Return ONLY the direct translation. Do not add quotes, explanations, or introductory text. Text: "${text}"`
                            }]
                        }]
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
                        let translated = data.candidates[0].content.parts[0].text.trim();
                        // Clean up any outer quotes added by LLM
                        if (translated.startsWith('"') && translated.endsWith('"')) {
                            translated = translated.substring(1, translated.length - 1);
                        }
                        if (translated.startsWith("'") && translated.endsWith("'")) {
                            translated = translated.substring(1, translated.length - 1);
                        }
                        return res.json({ translatedText: translated });
                    }
                }
                const errorText = await response.text();
                console.warn('Gemini API call failed, falling back to MyMemory API. Status:', response.status, errorText);
            } catch (err) {
                console.warn('Gemini translation error, falling back to MyMemory API:', err);
            }
        }

        // Fallback or default: MyMemory API
        console.log(`Translating using MyMemory: "${text}" (${sourceIso} -> ${targetIso})`);
        try {
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${sourceIso}|${targetIso}`;
            const response = await fetch(url);
            if (response.ok) {
                const data = await response.json();
                if (data.responseData && data.responseData.translatedText) {
                    return res.json({ translatedText: data.responseData.translatedText });
                }
            }
            throw new Error(`MyMemory API responded with status ${response.status}`);
        } catch (err) {
            console.error('MyMemory translation failed:', err);
            // Last fallback: return the original text so the app doesn't crash
            return res.json({ translatedText: text, error: 'Translation service unavailable' });
        }
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

    // Listen
    httpServer.listen(4174, 'localhost', () => {
        console.log('Local HTTP server listening on port 4174 (for Electron window)');
    });

    httpsServer.listen(4173, '0.0.0.0', () => {
        console.log('====================================================');
        console.log('🌐 Lingua Franca Web UI and API are now live!');
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

    // macOS: Request microphone access explicitly
    if (process.platform === 'darwin') {
        try {
            const status = systemPreferences.getMediaAccessStatus('microphone');
            console.log(`Current microphone access status: ${status}`);

            if (status !== 'granted') {
                console.log('Requesting microphone access...');
                const granted = await systemPreferences.askForMediaAccess('microphone');
                console.log(`Microphone access granted: ${granted}`);
            }
        } catch (err) {
            console.error('Error requesting microphone access:', err);
        }
    }

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
