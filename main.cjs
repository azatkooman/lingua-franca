const { app, BrowserWindow, desktopCapturer, safeStorage, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const https = require('https');
const http = require('http');
const forge = require('node-forge');

const HTTPS_PORT = 4173;
const LOCAL_PORT = 4174;
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const INTERPRETER_SESSION_MS = 8 * 60 * 60 * 1000;
const CERTIFICATE_RENEWAL_DAYS = 30;
const DEFAULT_SETTINGS = {
    languages: [
        { id: 'english', name: 'English', code: 'en', description: 'Main English translation channel' },
        { id: 'russian', name: 'Русский', code: 'ru', description: 'Русский канал' },
    ],
    adminPin: '1234',
    interfaceLanguage: 'en',
    aiProvider: 'openai',
    glossary: 'Jesus Christ; Holy Spirit; Gospel; Bible; church; pastor',
    preferredAddress: '',
    recordingEnabled: false,
    certificateMode: 'self-signed',
    certificateHostname: '',
    certificateEmail: '',
};

let mainWindow;
let mediaWorker;
let httpsServer;
let httpServer;
let certificateState = { type: 'self-signed', hostname: '', expiresAt: '', error: '' };

const settingsPath = () => path.join(app.getPath('userData'), 'lingua-franca-settings.json');

function protectSecret(value) {
    if (!value) return '';
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
    return safeStorage.encryptString(value).toString('base64');
}

function revealSecret(value) {
    if (!value) return '';
    try { return safeStorage.decryptString(Buffer.from(value, 'base64')); }
    catch (error) { console.error('Could not decrypt a credential:', error.message); return ''; }
}

function setPin(settings, pin) {
    const salt = crypto.randomBytes(16);
    settings.adminPinSalt = salt.toString('base64');
    settings.adminPinHash = crypto.scryptSync(String(pin), salt, 32).toString('base64');
    delete settings.adminPin;
}

function verifyPin(settings, pin) {
    if (!settings.adminPinSalt || !settings.adminPinHash) return false;
    const actual = crypto.scryptSync(String(pin), Buffer.from(settings.adminPinSalt, 'base64'), 32);
    const expected = Buffer.from(settings.adminPinHash, 'base64');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function inferLanguageCode(name) {
    const value = String(name || '').toLowerCase();
    const known = {
        english: 'en', russian: 'ru', 'русский': 'ru', spanish: 'es', 'español': 'es',
        french: 'fr', 'français': 'fr', german: 'de', deutsch: 'de', kazakh: 'kk', 'қазақша': 'kk',
    };
    return known[value] || value.slice(0, 2) || 'en';
}

function normalizeLanguage(language) {
    const name = String(language.name || '').trim();
    const id = String(language.id || name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-')).replace(/^-|-$/g, '');
    return { id, name, code: String(language.code || inferLanguageCode(name)), description: String(language.description || '') };
}

function loadSettings() {
    let loaded = {};
    try { if (fs.existsSync(settingsPath())) loaded = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
    catch (error) { console.error('Failed to load settings:', error); }
    const settings = { ...DEFAULT_SETTINGS, ...loaded };
    settings.languages = Array.isArray(loaded.languages) && loaded.languages.length
        ? loaded.languages.map(normalizeLanguage) : DEFAULT_SETTINGS.languages;
    if (settings.openaiApiKey && !settings.openaiApiKeyEncrypted) {
        settings.openaiApiKeyEncrypted = protectSecret(settings.openaiApiKey); delete settings.openaiApiKey;
    }
    if (settings.geminiApiKey && !settings.geminiApiKeyEncrypted) {
        settings.geminiApiKeyEncrypted = protectSecret(settings.geminiApiKey); delete settings.geminiApiKey;
    }
    if (!settings.adminPinHash || !settings.adminPinSalt) setPin(settings, settings.adminPin || '1234');
    delete settings.adminPin;
    settings.languages.forEach((language) => delete language.activePeerId);
    return settings;
}

function saveSettings(settings) {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    const temporary = `${settingsPath()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, settingsPath());
}

function publicSettings(settings, liveChannels) {
    return {
        languages: settings.languages.map((language) => ({ ...language, activePeerId: liveChannels.get(language.name)?.mode })),
        interfaceLanguage: settings.interfaceLanguage,
        aiProvider: settings.aiProvider,
        openaiConfigured: Boolean(settings.openaiApiKeyEncrypted),
        geminiConfigured: Boolean(settings.geminiApiKeyEncrypted),
        glossary: settings.glossary || '',
        preferredAddress: settings.preferredAddress || '',
        recordingEnabled: Boolean(settings.recordingEnabled),
    };
}

function networkAddresses() {
    const results = [];
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (address.family === 'IPv4' && !address.internal) results.push({ name, address: address.address });
        }
    }
    return results;
}

function selectLocalAddress(preferred) {
    const addresses = networkAddresses();
    if (preferred && addresses.some((entry) => entry.address === preferred)) return preferred;
    return addresses.find((entry) => !/virtual|vmware|hyper-v|wsl|bluetooth/i.test(entry.name))?.address
        || addresses[0]?.address || '127.0.0.1';
}

function certificateDirectory() {
    return path.join(app.getPath('userData'), 'certificate');
}

function certificateDetails(certPem) {
    const certificate = forge.pki.certificateFromPem(String(certPem));
    return {
        expiresAt: certificate.validity.notAfter.toISOString(),
        expiresSoon: certificate.validity.notAfter.getTime() <= Date.now() + CERTIFICATE_RENEWAL_DAYS * 24 * 60 * 60 * 1000,
    };
}

function ensureSelfSignedCertificate(localAddress) {
    const directory = certificateDirectory();
    const keyPath = path.join(directory, 'server-key.pem');
    const certPath = path.join(directory, 'server-cert.pem');
    const addressPath = path.join(directory, 'address.txt');
    if (fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(addressPath)
        && fs.readFileSync(addressPath, 'utf8').trim() === localAddress) {
        try {
            const cert = fs.readFileSync(certPath);
            if (!certificateDetails(cert).expiresSoon) return { key: fs.readFileSync(keyPath), cert };
        } catch (error) { console.warn('Replacing invalid local certificate:', error.message); }
    }
    fs.mkdirSync(directory, { recursive: true });
    const pki = forge.pki;
    const keys = pki.rsa.generateKeyPair(2048);
    const cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = crypto.randomBytes(16).toString('hex');
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);
    const attrs = [{ name: 'commonName', value: localAddress }];
    cert.setSubject(attrs); cert.setIssuer(attrs);
    cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, { type: 7, ip: localAddress }] },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    fs.writeFileSync(keyPath, pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
    fs.writeFileSync(certPath, pki.certificateToPem(cert), { mode: 0o600 });
    fs.writeFileSync(addressPath, localAddress, { mode: 0o600 });
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

function normalizeDuckDnsDomain(value) {
    return String(value || '').trim().toLowerCase().replace(/\.duckdns\.org$/, '');
}

async function updateDuckDns(domain, token, parameters) {
    const query = new URLSearchParams({ domains: domain, token, ...parameters });
    const response = await fetch(`https://www.duckdns.org/update?${query}`);
    const body = (await response.text()).trim();
    if (!response.ok || !body.startsWith('OK')) throw new Error(`DuckDNS update failed (${body || response.status}).`);
}

async function renewTrustedCertificate(settings, localAddress) {
    const domain = normalizeDuckDnsDomain(settings.certificateHostname);
    const email = String(settings.certificateEmail || '').trim();
    const token = revealSecret(settings.duckDnsTokenEncrypted);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) throw new Error('Enter a valid DuckDNS subdomain.');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid certificate contact email.');
    if (!token) throw new Error('Enter your DuckDNS token.');

    const acme = require('acme-client');
    const directory = certificateDirectory();
    const accountKeyPath = path.join(directory, 'acme-account-key.pem');
    const trustedKeyPath = path.join(directory, 'trusted-key.pem');
    const trustedCertPath = path.join(directory, 'trusted-cert.pem');
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(accountKeyPath)) {
        fs.writeFileSync(accountKeyPath, await acme.crypto.createPrivateKey(), { mode: 0o600 });
    }
    await updateDuckDns(domain, token, { ip: localAddress });
    const [certificateKey, certificateCsr] = await acme.crypto.createCsr({
        commonName: `${domain}.duckdns.org`, altNames: [`${domain}.duckdns.org`],
    });
    const client = new acme.Client({
        directoryUrl: acme.directory.letsencrypt.production,
        accountKey: fs.readFileSync(accountKeyPath),
    });
    const certificate = await client.auto({
        csr: certificateCsr,
        email,
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        challengeCreateFn: async (_authorization, challenge, keyAuthorization) => {
            if (challenge.type !== 'dns-01') throw new Error(`Unsupported ACME challenge: ${challenge.type}`);
            await updateDuckDns(domain, token, { txt: keyAuthorization });
        },
        challengeRemoveFn: async () => {
            await updateDuckDns(domain, token, { txt: '', clear: 'true' }).catch((error) => console.warn(error.message));
        },
    });
    const temporaryKey = `${trustedKeyPath}.tmp`;
    const temporaryCert = `${trustedCertPath}.tmp`;
    fs.writeFileSync(temporaryKey, certificateKey, { mode: 0o600 });
    fs.writeFileSync(temporaryCert, certificate, { mode: 0o600 });
    fs.renameSync(temporaryKey, trustedKeyPath);
    fs.renameSync(temporaryCert, trustedCertPath);
    const details = certificateDetails(certificate);
    certificateState = { type: 'trusted', hostname: `${domain}.duckdns.org`, expiresAt: details.expiresAt, error: '' };
    return { key: certificateKey, cert: certificate };
}

async function ensureServerCertificate(settings, localAddress) {
    const trustedKeyPath = path.join(certificateDirectory(), 'trusted-key.pem');
    const trustedCertPath = path.join(certificateDirectory(), 'trusted-cert.pem');
    if (settings.certificateMode === 'duckdns') {
        try {
            if (fs.existsSync(trustedKeyPath) && fs.existsSync(trustedCertPath)) {
                const cert = fs.readFileSync(trustedCertPath);
                const details = certificateDetails(cert);
                if (!details.expiresSoon) {
                    certificateState = { type: 'trusted', hostname: `${normalizeDuckDnsDomain(settings.certificateHostname)}.duckdns.org`, expiresAt: details.expiresAt, error: '' };
                    void updateDuckDns(normalizeDuckDnsDomain(settings.certificateHostname), revealSecret(settings.duckDnsTokenEncrypted), { ip: localAddress })
                        .catch((error) => console.warn('DuckDNS address update failed:', error.message));
                    return { key: fs.readFileSync(trustedKeyPath), cert };
                }
            }
            return await renewTrustedCertificate(settings, localAddress);
        } catch (error) {
            console.error('Trusted certificate setup failed:', error);
            if (fs.existsSync(trustedKeyPath) && fs.existsSync(trustedCertPath)) {
                try {
                    const cert = fs.readFileSync(trustedCertPath);
                    const details = certificateDetails(cert);
                    if (new Date(details.expiresAt).getTime() > Date.now()) {
                        certificateState = { type: 'trusted', hostname: `${normalizeDuckDnsDomain(settings.certificateHostname)}.duckdns.org`, expiresAt: details.expiresAt, error: `Renewal failed: ${error.message}` };
                        return { key: fs.readFileSync(trustedKeyPath), cert };
                    }
                } catch (_ignored) { /* use the local fallback below */ }
            }
            certificateState.error = `Trusted certificate unavailable: ${error.message}`;
        }
    }
    const fallback = ensureSelfSignedCertificate(localAddress);
    certificateState = { type: 'self-signed', hostname: localAddress, expiresAt: certificateDetails(fallback.cert).expiresAt, error: certificateState.error || '' };
    return fallback;
}

function findWorkerBinary(isDev) {
    if (isDev) return undefined;
    const binary = process.platform === 'win32' ? 'mediasoup-worker.exe' : 'mediasoup-worker';
    const candidates = [
        process.env.LINGUA_FRANCA_WORKER_BIN,
        path.join(process.resourcesPath, 'bin', binary),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'mediasoup', 'worker', 'out', 'Release', binary),
    ].filter(Boolean);
    const found = candidates.find(fs.existsSync);
    if (!found) throw new Error(`mediasoup worker not found. Checked: ${candidates.join(', ')}`);
    if (process.platform === 'win32' && fs.readFileSync(found).subarray(0, 2).toString('ascii') !== 'MZ') {
        throw new Error(`Invalid Windows mediasoup worker at ${found}. Reinstall dependencies on Windows.`);
    }
    if (process.platform !== 'win32') fs.chmodSync(found, 0o755);
    return found;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200, height: 800, show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const isDev = process.env.NODE_ENV === 'development';
    const isAllowedOrigin = (value) => {
        try {
            const url = new URL(value);
            return ['localhost', '127.0.0.1'].includes(url.hostname)
                && ['http:', 'https:'].includes(url.protocol);
        } catch (_error) { return false; }
    };
    const appSession = mainWindow.webContents.session;
    appSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
        permission === 'media' && isAllowedOrigin(details?.securityOrigin || requestingOrigin));
    appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
        const origin = details?.securityOrigin || details?.requestingUrl || contents?.getURL() || '';
        callback(isAllowedOrigin(origin) && ['media', 'display-capture'].includes(permission));
    });
    appSession.setDisplayMediaRequestHandler(async (_request, callback) => {
        try {
            const [screen] = await desktopCapturer.getSources({ types: ['screen'] });
            if (!screen) throw new Error('No screen source is available for system-audio capture.');
            callback({ video: screen, audio: 'loopback' });
        } catch (error) {
            console.error('System audio capture failed:', error);
            callback({});
        }
    }, { useSystemPicker: false });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
        const allowed = isDev ? 'https://localhost:5173' : `http://localhost:${LOCAL_PORT}`;
        if (!url.startsWith(allowed)) event.preventDefault();
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.loadURL(isDev ? 'https://localhost:5173' : `http://localhost:${LOCAL_PORT}/`);
}

async function startServers() {
    const isDev = process.env.NODE_ENV === 'development';
    const settings = loadSettings();
    saveSettings(settings);
    const addresses = networkAddresses();
    const localAddress = selectLocalAddress(process.env.LINGUA_FRANCA_HOST_IP || settings.preferredAddress);
    const expressApp = express();
    expressApp.disable('x-powered-by');
    expressApp.use(express.json({ limit: '256kb' }));
    expressApp.use((_request, response, next) => {
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Permissions-Policy', 'microphone=(self)');
        next();
    });
    httpsServer = https.createServer(await ensureServerCertificate(settings, localAddress), expressApp);
    httpServer = http.createServer(expressApp);
    const { Server: SocketServer } = require('socket.io');
    const io = new SocketServer(httpsServer, { transports: ['websocket'], maxHttpBufferSize: 64 * 1024 });
    httpServer.on('upgrade', (request, socket, head) => io.engine.handleUpgrade(request, socket, head));

    const mediasoup = require('mediasoup');
    const liveChannels = new Map();
    const transports = new Map();
    const producers = new Map();
    const listenerChannels = new Map();
    let router;
    let sfuError = '';
    try {
        mediaWorker = await mediasoup.createWorker({
            logLevel: isDev ? 'warn' : 'error', rtcMinPort: 10000, rtcMaxPort: 10100,
            workerBin: findWorkerBinary(isDev),
        });
        mediaWorker.on('died', () => { sfuError = 'The media worker stopped unexpectedly.'; });
        router = await mediaWorker.createRouter({
            mediaCodecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
        });
    } catch (error) { sfuError = error.message || String(error); console.error('SFU initialization failed:', error); }

    const adminSessions = new Map();
    const interpreterCodes = new Map();
    const interpreterSessions = new Map();
    const loginAttempts = new Map();
    const issueToken = () => {
        const token = crypto.randomBytes(32).toString('base64url'); adminSessions.set(token, Date.now() + ADMIN_SESSION_MS); return token;
    };
    const isAdminToken = (token) => {
        const expiry = adminSessions.get(token);
        if (!expiry || expiry < Date.now()) { if (token) adminSessions.delete(token); return false; }
        return true;
    };
    const publisherSession = (token) => {
        if (isAdminToken(token)) return { role: 'admin' };
        const session = interpreterSessions.get(token);
        if (!session || session.expiresAt < Date.now()) {
            if (token) interpreterSessions.delete(token);
            return null;
        }
        return { role: 'interpreter', channelName: session.channelName };
    };
    const requestToken = (request) => String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const requireAdmin = (request, response, next) => {
        if (!isAdminToken(requestToken(request))) return response.status(401).json({ error: 'Administrator login required.' });
        next();
    };
    const emitSettings = () => io.emit('settingsChanged', publicSettings(settings, liveChannels));
    const setChannelState = (channelName, mode) => {
        if (mode) liveChannels.set(channelName, { mode, updatedAt: Date.now() }); else liveChannels.delete(channelName);
        emitSettings();
    };

    io.on('connection', (socket) => {
        transports.set(socket.id, new Map());
        const socketIsAdmin = () => isAdminToken(socket.handshake.auth?.token);
        const socketPublisher = () => publisherSession(socket.handshake.auth?.token);
        const reject = (callback) => { callback?.({ error: 'Administrator login required.' }); return false; };
        const rejectPublisher = (callback) => { callback?.({ error: 'Broadcaster login required.' }); return false; };
        socket.on('getRouterRtpCapabilities', (callback) => callback(router ? router.rtpCapabilities : { error: `SFU unavailable: ${sfuError}` }));
        socket.on('createWebRtcTransport', async ({ type } = {}, callback) => {
            if (!router) return callback({ error: `SFU unavailable: ${sfuError}` });
            if (type === 'producer' && !socketPublisher()) return rejectPublisher(callback);
            try {
                const transport = await router.createWebRtcTransport({
                    listenIps: [{ ip: '0.0.0.0', announcedIp: localAddress }], enableUdp: true, enableTcp: true, preferUdp: true,
                });
                transports.get(socket.id).set(transport.id, transport);
                transport.on('dtlsstatechange', (state) => { if (state === 'closed') transport.close(); });
                callback({ id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters });
            } catch (error) { callback({ error: error.message }); }
        });
        socket.on('connectTransport', async ({ transportId, dtlsParameters } = {}, callback) => {
            try {
                const transport = transports.get(socket.id)?.get(transportId);
                if (!transport) throw new Error('Transport not found.');
                await transport.connect({ dtlsParameters }); callback();
            } catch (error) { callback({ error: error.message }); }
        });
        socket.on('produce', async ({ transportId, kind, rtpParameters, appData } = {}, callback) => {
            const publisher = socketPublisher();
            if (!publisher) return rejectPublisher(callback);
            try {
                const transport = transports.get(socket.id)?.get(transportId);
                if (!transport) throw new Error('Producer transport not found.');
                const channelName = String(appData?.channelName || '').slice(0, 80);
                if (!channelName) throw new Error('Channel name is required.');
                if (publisher.role === 'interpreter' && publisher.channelName !== channelName) {
                    throw new Error(`This interpreter link is authorized only for ${publisher.channelName}.`);
                }
                producers.get(channelName)?.close();
                const producer = await transport.produce({ kind, rtpParameters, appData: { channelName } });
                producers.set(channelName, producer);
                setChannelState(channelName, appData?.mode === 'ai' ? 'ai-active' : 'sfu-active');
                const close = () => {
                    if (producers.get(channelName)?.id !== producer.id) return;
                    producers.delete(channelName); setChannelState(channelName); io.emit('producerClosed', { channelName });
                };
                producer.on('transportclose', close); producer.on('close', close);
                callback({ id: producer.id }); socket.broadcast.emit('producerAvailable', { channelName });
            } catch (error) { callback({ error: error.message }); }
        });
        socket.on('consume', async ({ transportId, rtpCapabilities, channelName } = {}, callback) => {
            try {
                const producer = producers.get(channelName);
                if (!producer) return callback({ error: 'Waiting for broadcaster.' });
                if (!router?.canConsume({ producerId: producer.id, rtpCapabilities })) throw new Error('This device cannot consume the stream.');
                const transport = transports.get(socket.id)?.get(transportId);
                if (!transport) throw new Error('Consumer transport not found.');
                const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities, paused: false });
                listenerChannels.set(socket.id, channelName);
                io.emit('listenerCount', { channelName, count: [...listenerChannels.values()].filter((name) => name === channelName).length });
                consumer.on('transportclose', () => consumer.close()); consumer.on('producerclose', () => consumer.close());
                callback({ id: consumer.id, producerId: producer.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
            } catch (error) { callback({ error: error.message }); }
        });
        socket.on('sendTranslationText', ({ channelName, text, originalText } = {}, callback) => {
            if (!socketIsAdmin()) return reject(callback);
            io.emit('translationText', {
                channelName: String(channelName || '').slice(0, 80), text: String(text || '').slice(0, 8000),
                originalText: String(originalText || '').slice(0, 8000),
            });
            callback?.({ ok: true });
        });
        socket.on('setTextChannel', ({ channelName, active } = {}, callback) => {
            if (!socketIsAdmin()) return reject(callback);
            const name = String(channelName || '').slice(0, 80);
            if (!name) return callback?.({ error: 'Channel name is required.' });
            setChannelState(name, active ? 'ai-active' : undefined);
            callback?.({ ok: true });
        });
        socket.on('disconnect', () => {
            for (const transport of transports.get(socket.id)?.values() || []) transport.close();
            transports.delete(socket.id);
            const channelName = listenerChannels.get(socket.id); listenerChannels.delete(socket.id);
            if (channelName) io.emit('listenerCount', { channelName, count: [...listenerChannels.values()].filter((name) => name === channelName).length });
        });
    });

    expressApp.get('/api/settings', (_request, response) => response.json(publicSettings(settings, liveChannels)));
    expressApp.get('/api/local-ip', (_request, response) => response.json({ ip: localAddress, port: HTTPS_PORT }));
    expressApp.get('/api/health', (_request, response) => response.json({
        ok: Boolean(router), localAddress, addresses, sfu: router ? 'ready' : 'unavailable', sfuError,
        openaiConfigured: Boolean(settings.openaiApiKeyEncrypted),
        publicHost: certificateState.type === 'trusted' ? certificateState.hostname : localAddress,
        certificate: certificateState,
        certificatePath: path.join(certificateDirectory(), certificateState.type === 'trusted' ? 'trusted-cert.pem' : 'server-cert.pem'),
        microphoneAccess: ['win32', 'darwin'].includes(process.platform)
            ? systemPreferences.getMediaAccessStatus('microphone') : 'unknown',
        ports: { https: HTTPS_PORT, local: LOCAL_PORT, rtc: '10000-10100/udp' },
    }));
    expressApp.post('/api/admin/login', (request, response) => {
        const address = request.ip || 'unknown';
        const attempt = loginAttempts.get(address) || { count: 0, blockedUntil: 0 };
        if (attempt.blockedUntil > Date.now()) return response.status(429).json({ error: 'Too many attempts. Try again shortly.' });
        const valid = verifyPin(settings, request.body?.pin || '');
        if (!valid) {
            attempt.count += 1;
            if (attempt.count >= 5) { attempt.count = 0; attempt.blockedUntil = Date.now() + 60_000; }
            loginAttempts.set(address, attempt); return response.status(401).json({ error: 'Incorrect PIN.' });
        }
        loginAttempts.delete(address); response.json({ token: issueToken(), expiresIn: ADMIN_SESSION_MS / 1000 });
    });
    expressApp.post('/api/admin/logout', requireAdmin, (request, response) => { adminSessions.delete(requestToken(request)); response.json({ ok: true }); });
    expressApp.post('/api/admin/interpreter-link', requireAdmin, (request, response) => {
        const channelName = String(request.body?.channelName || '').slice(0, 80);
        if (!settings.languages.some((language) => language.name === channelName)) {
            return response.status(400).json({ error: 'Choose a configured language channel.' });
        }
        let code;
        do { code = crypto.randomInt(100000, 1000000).toString(); } while (interpreterCodes.has(code));
        const expiresAt = Date.now() + INTERPRETER_SESSION_MS;
        interpreterCodes.set(code, { channelName, expiresAt });
        response.json({ code, channelName, expiresAt });
    });
    expressApp.post('/api/interpreter/login', (request, response) => {
        const code = String(request.body?.code || '').replace(/\D/g, '').slice(0, 6);
        const access = interpreterCodes.get(code);
        if (!access || access.expiresAt < Date.now()) {
            if (access) interpreterCodes.delete(code);
            return response.status(401).json({ error: 'This interpreter code is invalid or expired.' });
        }
        interpreterCodes.delete(code);
        const token = crypto.randomBytes(32).toString('base64url');
        interpreterSessions.set(token, access);
        response.json({ token, channelName: access.channelName, expiresAt: access.expiresAt });
    });
    expressApp.post('/api/admin/certificate', requireAdmin, async (request, response) => {
        const domain = normalizeDuckDnsDomain(request.body?.domain);
        const email = String(request.body?.email || '').trim();
        const token = String(request.body?.token || '').trim();
        if (!domain || !email || (!token && !settings.duckDnsTokenEncrypted)) {
            return response.status(400).json({ error: 'DuckDNS subdomain, token, and contact email are required.' });
        }
        settings.certificateMode = 'duckdns';
        settings.certificateHostname = domain;
        settings.certificateEmail = email;
        if (token) settings.duckDnsTokenEncrypted = protectSecret(token);
        saveSettings(settings);
        try {
            const secureContext = await renewTrustedCertificate(settings, localAddress);
            httpsServer.setSecureContext(secureContext);
            response.json({ ok: true, certificate: certificateState, publicHost: certificateState.hostname });
        } catch (error) {
            certificateState.error = error.message;
            response.status(502).json({ error: `Certificate setup failed: ${error.message}` });
        }
    });
    expressApp.get('/api/admin/settings', requireAdmin, (_request, response) => response.json(publicSettings(settings, liveChannels)));
    expressApp.patch('/api/admin/settings', requireAdmin, (request, response) => {
        const patch = request.body || {};
        if (Array.isArray(patch.languages)) settings.languages = patch.languages.map(normalizeLanguage).filter((language) => language.name);
        if (/^\d{4,12}$/.test(String(patch.adminPin || ''))) setPin(settings, String(patch.adminPin));
        if (['en', 'ru'].includes(patch.interfaceLanguage)) settings.interfaceLanguage = patch.interfaceLanguage;
        if (['openai', 'gemini', 'browser'].includes(patch.aiProvider)) settings.aiProvider = patch.aiProvider;
        if (typeof patch.glossary === 'string') settings.glossary = patch.glossary.slice(0, 8000);
        if (typeof patch.preferredAddress === 'string') settings.preferredAddress = patch.preferredAddress.slice(0, 64);
        if (typeof patch.recordingEnabled === 'boolean') settings.recordingEnabled = patch.recordingEnabled;
        if (typeof patch.openaiApiKey === 'string' && patch.openaiApiKey.trim()) settings.openaiApiKeyEncrypted = protectSecret(patch.openaiApiKey.trim());
        if (patch.clearOpenaiApiKey === true) settings.openaiApiKeyEncrypted = '';
        if (typeof patch.geminiApiKey === 'string' && patch.geminiApiKey.trim()) settings.geminiApiKeyEncrypted = protectSecret(patch.geminiApiKey.trim());
        if (patch.clearGeminiApiKey === true) settings.geminiApiKeyEncrypted = '';
        saveSettings(settings); emitSettings(); response.json(publicSettings(settings, liveChannels));
    });
    expressApp.post('/api/realtime/session', requireAdmin, async (request, response) => {
        const apiKey = revealSecret(settings.openaiApiKeyEncrypted);
        if (!apiKey) return response.status(409).json({ error: 'Add an OpenAI API key in Admin settings first.' });
        try {
            const upstream = await fetch('https://api.openai.com/v1/realtime/translations/client_secrets', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                    'OpenAI-Safety-Identifier': crypto.createHash('sha256').update(requestToken(request)).digest('hex'),
                },
                body: JSON.stringify({ session: {
                    model: 'gpt-realtime-translate',
                    audio: {
                        output: { language: String(request.body?.targetLanguage || 'en').slice(0, 16) },
                    },
                } }),
            });
            response.status(upstream.status).json(await upstream.json());
        } catch (error) { response.status(502).json({ error: `OpenAI connection failed: ${error.message}` }); }
    });
    expressApp.post('/api/translate', requireAdmin, async (request, response) => {
        const { text, sourceLang, targetLang } = request.body || {};
        if (!text) return response.status(400).json({ error: 'Text is required.' });
        const geminiKey = revealSecret(settings.geminiApiKeyEncrypted);
        if (settings.aiProvider === 'gemini' && geminiKey) {
            try {
                const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiKey)}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contents: [{ parts: [{ text: `Translate from ${sourceLang} to ${targetLang}. Return only the translation.\n${text}` }] }] }),
                });
                const data = await upstream.json();
                const translatedText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (upstream.ok && translatedText) return response.json({ translatedText, provider: 'gemini' });
            } catch (error) { console.warn('Gemini translation failed:', error.message); }
        }
        try {
            const upstream = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${inferLanguageCode(sourceLang)}|${inferLanguageCode(targetLang)}`);
            const data = await upstream.json();
            if (upstream.ok && data.responseData?.translatedText) return response.json({ translatedText: data.responseData.translatedText, provider: 'mymemory' });
        } catch (error) { console.warn('Fallback translation failed:', error.message); }
        response.status(502).json({ error: 'Translation service unavailable.' });
    });

    if (!isDev) {
        expressApp.use(express.static(path.join(__dirname, 'dist')));
        expressApp.use((request, response) => {
            if (request.path.startsWith('/api/')) return response.status(404).json({ error: 'Not found.' });
            response.sendFile(path.join(__dirname, 'dist', 'index.html'));
        });
    }
    await Promise.all([
        new Promise((resolve) => httpServer.listen(LOCAL_PORT, '127.0.0.1', resolve)),
        new Promise((resolve) => httpsServer.listen(HTTPS_PORT, '0.0.0.0', resolve)),
    ]);
    console.log(`Lingua Franca listener: https://${localAddress}:${HTTPS_PORT}/listener`);
}

app.whenReady().then(async () => {
    await startServers(); createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => {
    try { mediaWorker?.close(); } catch (_error) { /* already closed */ }
    try { httpsServer?.close(); } catch (_error) { /* already closed */ }
    try { httpServer?.close(); } catch (_error) { /* already closed */ }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
