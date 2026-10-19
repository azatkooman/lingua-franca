const { app, BrowserWindow, Notification, desktopCapturer, dialog, ipcMain, safeStorage, shell, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const https = require('https');
const http = require('http');
const forge = require('node-forge');

const {
    DEFAULT_SETTINGS, INTERFACE_LANGUAGES, adminSettings, budgetLevel, dropRetiredSettings, findLanguage, isValidDuckDnsDomain,
    isVirtualAdapter, normalizeBudget, normalizeSilencePause,
    MAX_AI_INSTRUCTIONS, MAX_AI_NOTES, normalizeAiEngine, normalizeAiPace, normalizeAiVoice, normalizeLongText,
    isValidEmail, normalizeContact, normalizeDuckDnsDomain, normalizeEvent, normalizeLanguages, publicSettings,
    selectLocalAddress,
} = require('./lib/settings.cjs');
const { CAPTION_IDLE_MS, TranscriptStore } = require('./lib/transcript.cjs');
const { readSettingsFile, writeSettingsFile } = require('./lib/settings-file.cjs');
const { TRANSCRIPTION_PER_SECOND, responseCostUsd, steadySession } = require('./lib/ai-instructions.cjs');
const { DocumentError, documentText } = require('./lib/document-text.cjs');
const { ListenerReports } = require('./lib/listener-reports.cjs');
const { certificateCoversHost, certificateDetails: readCertificateDetails } = require('./lib/certificates.cjs');
const { RecordingStore, ROLES, TranscriptLog } = require('./lib/recordings.cjs');
const { startChannelRecording } = require('./lib/recorder.cjs');
const { ExpiringMap, LoginThrottle, isValidPin, newAccessCode, newToken, refreshSession, setPin, verifyPin } = require('./lib/security.cjs');

const HTTPS_PORT = 4173;
const LOCAL_PORT = 4174;
// Plain-HTTP port for listener phones only. A LAN address cannot get a publicly trusted
// certificate, so every phone hit a certificate warning before it could listen. Listening
// needs no secure context (only microphone capture does), so phones can use plain HTTP here,
// while signing in and broadcasting stay on HTTPS. The audio itself is still encrypted by
// WebRTC (DTLS-SRTP).
const LISTENER_PORT = 4175;
// The only API calls a listener page makes.
const LISTENER_API = new Set(['/api/settings', '/api/health']);
// One multiplexed ICE port for every transport (see createMedia). The wider range is only
// used by the fallback path when the shared port cannot be bound.
const RTC_PORT = 10000;
const RTC_MIN_PORT = 10000;
const RTC_MAX_PORT = 10100;
// An operator session ends after 12 hours unused, and in any case after a week. It used to
// end exactly 12 hours after sign-in, even mid-event: captions silently stopped reaching phones
// and the next AI reconnect failed. Every use extends it, and a live broadcast keeps it alive.
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const ADMIN_SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const INTERPRETER_SESSION_MS = 8 * 60 * 60 * 1000;
const INTERPRETER_CODE_MS = 8 * 60 * 60 * 1000;
const CERTIFICATE_RENEWAL_DAYS = 30;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const DYNAMIC_DNS_INTERVAL_MS = 5 * 60 * 1000;
const WORKER_RESTART_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];
// How often expired interpreter sessions are looked for. Overridable so tests need not wait.
const SESSION_SWEEP_MS = Number(process.env.LINGUA_FRANCA_SESSION_SWEEP_MS) || 30_000;
// OpenAI's prices per minute of audio, per target language (2026): gpt-realtime-translate
// ($0.034) plus gpt-realtime-whisper ($0.017), which transcribes the original speech for its
// captions. Only used for the rough cost shown on the operator's dashboard.
const AI_PRICE_PER_MINUTE = 0.034 + 0.017;
// Captions go only to phones watching that channel, not to every connected phone.
const CAPTION_ROOM = 'captions:';
// Bounds what one device can hold open. A listener needs one transport (two briefly while
// switching channel); at the limit its oldest one is closed rather than refusing it, so a phone
// can never lock itself out. Broadcasters are signed in and refused instead.
const LISTENER_TRANSPORT_LIMIT = 4;
const PUBLISHER_TRANSPORT_LIMIT = 24;
// A handover the current interpreter approved stays open this long for the next one to start.
const HANDOVER_MS = 60 * 1000;
// "Extend" on the dashboard gives a phone interpreter this much more time, up to a full session.
const INTERPRETER_EXTEND_MS = 2 * 60 * 60 * 1000;

let mainWindow;
let httpsServer;
let httpServer;
let listenerServer;
let listenerPortError = '';
let maintenanceTimer;
let sessionSweepTimer;
let dynamicDnsTimer;
let media = { worker: null, router: null, webRtcServer: null, error: '', portMode: 'unknown' };
let certificateState = { type: 'self-signed', hostname: '', expiresAt: '', error: '' };
let secureStorageAvailable = true;
// How the settings were loaded: null normally, 'backup' or 'defaults' after a damaged file.
// Admin and the pre-service check say so, since 'defaults' means the PIN is 1234 again.
let settingsRecovery = null;
// True while the operator PIN is still the factory 1234. Admin asks for a new one first.
let pinIsDefault = false;
const DEFAULT_PIN = '1234';
let addressDrift = '';
// Set once the server runs, so quitting can finish every open recording file properly.
let stopAllRecordings = () => undefined;

const settingsPath = () => path.join(app.getPath('userData'), 'lingua-franca-settings.json');
const certificateDirectory = () => path.join(app.getPath('userData'), 'certificate');

/* ---------------------------------------------------------------- secrets */

function protectSecret(value) {
    if (!value) return '';
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this computer.');
    return safeStorage.encryptString(value).toString('base64');
}

function revealSecret(value) {
    if (!value) return '';
    try { return safeStorage.decryptString(Buffer.from(value, 'base64')); }
    catch (error) { console.error('Could not decrypt a credential:', error.message); return ''; }
}

/* --------------------------------------------------------------- settings */

// Migrate a plaintext key written by an older build. If the OS keychain is unavailable we
// drop the key rather than leave it readable on disk, and flag it so Admin can say so.
function migrateSecret(settings, plainKey, encryptedKey) {
    if (!settings[plainKey]) return;
    try {
        if (!settings[encryptedKey]) settings[encryptedKey] = protectSecret(settings[plainKey]);
    } catch (error) {
        secureStorageAvailable = false;
        console.error(`Dropping ${plainKey}: ${error.message}`);
    }
    delete settings[plainKey];
}

function loadSettings() {
    const { loaded, recovery, corruptCopy } = readSettingsFile(settingsPath());
    settingsRecovery = recovery;
    if (recovery) console.error(`Settings file was damaged (kept as ${corruptCopy}); loaded ${recovery === 'backup' ? 'the backup' : 'defaults'}.`);
    const settings = { ...DEFAULT_SETTINGS, ...loaded };
    settings.languages = normalizeLanguages(loaded.languages);
    if (!settings.languages.length) settings.languages = normalizeLanguages(DEFAULT_SETTINGS.languages);
    migrateSecret(settings, 'openaiApiKey', 'openaiApiKeyEncrypted');
    // Translation is OpenAI only; forget the old text-fallback settings and any Gemini key.
    dropRetiredSettings(settings);
    if (!settings.adminPinHash || !settings.adminPinSalt) setPin(settings, settings.adminPin || DEFAULT_PIN);
    delete settings.adminPin;
    pinIsDefault = verifyPin(settings, DEFAULT_PIN);
    settings.languages.forEach((language) => delete language.activePeerId);
    return settings;
}

function saveSettings(settings) {
    writeSettingsFile(settingsPath(), settings);
}

/* ---------------------------------------------------------------- network */

function networkAddresses() {
    const results = [];
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
        for (const address of addresses || []) {
            if (address.family === 'IPv4' && !address.internal) results.push({ name, address: address.address });
        }
    }
    return results;
}

// Host allowlist for the Express app and the Socket.IO handshake. Without it any web page a
// phone happens to open can point a hostname at this LAN address and talk to the API
// (DNS rebinding). Every address the machine actually holds stays allowed so an operator is
// never locked out by reaching the app through an unexpected adapter.
function isAllowedHost(hostHeader, settings) {
    const raw = String(hostHeader || '').trim().toLowerCase();
    if (!raw) return false;
    const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) return true;
    if (networkAddresses().some((entry) => entry.address === host)) return true;
    const duckDns = normalizeDuckDnsDomain(settings.certificateHostname);
    return Boolean(duckDns) && host === `${duckDns}.duckdns.org`;
}

function isAllowedOriginHeader(origin, settings) {
    if (!origin) return true; // Non-browser clients (the load test) send no Origin header.
    try { return isAllowedHost(new URL(origin).host, settings); }
    catch { return false; }
}

// Every outbound call goes through here. Without a deadline a stalled DuckDNS, ACME,
// OpenAI or MyMemory connection hangs its request forever: certificate setup never returns,
// and the operator is left staring at a spinner minutes before a service starts.
const OUTBOUND_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = OUTBOUND_TIMEOUT_MS) {
    try {
        return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s contacting ${new URL(url).host}.`);
        }
        throw error;
    }
}

/* ------------------------------------------------------------ certificate */

const certificateDetails = (certPem) => readCertificateDetails(certPem, CERTIFICATE_RENEWAL_DAYS);

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
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
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

async function updateDuckDns(domain, token, parameters) {
    if (!domain || !token) throw new Error('DuckDNS subdomain and token are required.');
    const query = new URLSearchParams({ domains: domain, token, ...parameters });
    const response = await fetchWithTimeout(`https://www.duckdns.org/update?${query}`);
    const body = (await response.text()).trim();
    if (!response.ok || !body.startsWith('OK')) throw new Error(`DuckDNS update failed (${body || response.status}).`);
}

function trustedCertificatePaths() {
    return {
        accountKeyPath: path.join(certificateDirectory(), 'acme-account-key.pem'),
        keyPath: path.join(certificateDirectory(), 'trusted-key.pem'),
        certPath: path.join(certificateDirectory(), 'trusted-cert.pem'),
    };
}

function readTrustedCertificate() {
    const { keyPath, certPath } = trustedCertificatePaths();
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return null;
    try {
        const cert = fs.readFileSync(certPath);
        return { key: fs.readFileSync(keyPath), cert, details: certificateDetails(cert) };
    } catch (error) {
        console.warn('Stored trusted certificate is unreadable:', error.message);
        return null;
    }
}

async function issueTrustedCertificate(settings, localAddress) {
    const domain = normalizeDuckDnsDomain(settings.certificateHostname);
    const email = String(settings.certificateEmail || '').trim();
    const token = revealSecret(settings.duckDnsTokenEncrypted);
    if (!isValidDuckDnsDomain(domain)) throw new Error('Enter a valid DuckDNS subdomain.');
    if (!isValidEmail(email)) throw new Error('Enter a valid certificate contact email.');
    if (!token) throw new Error('Enter your DuckDNS token.');

    const acme = require('acme-client');
    const { accountKeyPath, keyPath, certPath } = trustedCertificatePaths();
    fs.mkdirSync(certificateDirectory(), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(accountKeyPath)) {
        fs.writeFileSync(accountKeyPath, await acme.crypto.createPrivateKey(), { mode: 0o600 });
    }
    await updateDuckDns(domain, token, { ip: localAddress });
    const [certificateKey, certificateCsr] = await acme.crypto.createCsr({
        commonName: `${domain}.duckdns.org`, altNames: [`${domain}.duckdns.org`],
    });
    // Let's Encrypt allows only five identical certificates per week. Operators testing their
    // DuckDNS token can burn that in an afternoon, so LINGUA_FRANCA_ACME_STAGING points at the
    // staging CA, which has no such limit, for setup rehearsals.
    const useStaging = process.env.LINGUA_FRANCA_ACME_STAGING === '1';
    const client = new acme.Client({
        directoryUrl: useStaging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
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
            // DuckDNS serves the new TXT almost immediately, but give resolvers a moment
            // before acme-client starts polling for it.
            await new Promise((resolve) => setTimeout(resolve, 5000));
        },
        challengeRemoveFn: async () => {
            await updateDuckDns(domain, token, { txt: '', clear: 'true' }).catch((error) => console.warn(error.message));
        },
    });
    const writeAtomic = (target, contents) => {
        fs.writeFileSync(`${target}.tmp`, contents, { mode: 0o600 });
        fs.renameSync(`${target}.tmp`, target);
    };
    writeAtomic(keyPath, certificateKey);
    writeAtomic(certPath, certificate);
    const details = certificateDetails(certificate);
    certificateState = {
        type: 'trusted', hostname: `${domain}.duckdns.org`, expiresAt: details.expiresAt,
        error: useStaging ? 'Issued by the Let’s Encrypt staging CA; phones will still warn.' : '',
    };
    return { key: certificateKey, cert: certificate };
}

async function ensureServerCertificate(settings, localAddress, { forceRenewal = false } = {}) {
    if (settings.certificateMode === 'duckdns') {
        const domain = normalizeDuckDnsDomain(settings.certificateHostname);
        // Only a certificate issued for this host is any use: after the DuckDNS name changes,
        // the old one would be served and rejected by every browser.
        const found = readTrustedCertificate();
        const stored = found && certificateCoversHost(found.details, `${domain}.duckdns.org`) ? found : null;
        try {
            // Reuse a certificate that is still comfortably valid instead of asking the CA
            // for another one on every launch.
            if (stored && !stored.details.expiresSoon && !forceRenewal) {
                certificateState = { type: 'trusted', hostname: `${domain}.duckdns.org`, expiresAt: stored.details.expiresAt, error: '' };
                return { key: stored.key, cert: stored.cert };
            }
            return await issueTrustedCertificate(settings, localAddress);
        } catch (error) {
            console.error('Trusted certificate setup failed:', error.message);
            if (stored && !stored.details.expired) {
                certificateState = {
                    type: 'trusted', hostname: `${domain}.duckdns.org`, expiresAt: stored.details.expiresAt,
                    error: `Renewal failed, still using the stored certificate: ${error.message}`,
                };
                return { key: stored.key, cert: stored.cert };
            }
            certificateState.error = `Trusted certificate unavailable: ${error.message}`;
        }
    }
    const fallback = ensureSelfSignedCertificate(localAddress);
    certificateState = {
        type: 'self-signed', hostname: localAddress,
        expiresAt: certificateDetails(fallback.cert).expiresAt, error: certificateState.error || '',
    };
    return fallback;
}

/* -------------------------------------------------------------- mediasoup */

function findWorkerBinary(isDev) {
    if (isDev) return undefined;
    const binary = process.platform === 'win32' ? 'mediasoup-worker.exe' : 'mediasoup-worker';
    // process.resourcesPath only exists inside a packaged Electron process. Guard it so a
    // missing worker reports the diagnostic below instead of a bare path.join TypeError.
    const resources = process.resourcesPath;
    const candidates = [
        process.env.LINGUA_FRANCA_WORKER_BIN,
        resources && path.join(resources, 'bin', binary),
        resources && path.join(resources, 'app.asar.unpacked', 'node_modules', 'mediasoup', 'worker', 'out', 'Release', binary),
    ].filter(Boolean);
    if (!candidates.length) throw new Error('Cannot locate the mediasoup worker: no resources path is available.');
    const found = candidates.find(fs.existsSync);
    if (!found) throw new Error(`mediasoup worker not found. Checked: ${candidates.join(', ')}`);
    if (process.platform === 'win32' && fs.readFileSync(found).subarray(0, 2).toString('ascii') !== 'MZ') {
        throw new Error(`Invalid Windows mediasoup worker at ${found}. Reinstall dependencies on Windows.`);
    }
    if (process.platform !== 'win32') fs.chmodSync(found, 0o755);
    return found;
}

// A WebRtcServer multiplexes every transport onto one ICE port. Allocating a port per
// transport instead caps the room at (range / 2) listeners, which is roughly 49 phones on the
// old 10000-10100 range -- right where a full event audience lands.
async function createMedia(isDev, localAddress) {
    const mediasoup = require('mediasoup');
    const worker = await mediasoup.createWorker({
        logLevel: isDev ? 'warn' : 'error',
        rtcMinPort: RTC_MIN_PORT,
        rtcMaxPort: RTC_MAX_PORT,
        workerBin: findWorkerBinary(isDev),
    });
    let webRtcServer = null;
    let portMode = 'range';
    try {
        webRtcServer = await worker.createWebRtcServer({
            listenInfos: [
                { protocol: 'udp', ip: '0.0.0.0', announcedAddress: localAddress, port: RTC_PORT },
                { protocol: 'tcp', ip: '0.0.0.0', announcedAddress: localAddress, port: RTC_PORT },
            ],
        });
        portMode = 'multiplexed';
    } catch (error) {
        console.warn(`Falling back to per-transport ICE ports (listener capacity is limited): ${error.message}`);
    }
    const router = await worker.createRouter({
        mediaCodecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
    });
    return { worker, router, webRtcServer, error: '', portMode };
}

// announcedAddress is only consulted on the fallback path; a WebRtcServer already carries the
// address it was created with. Named distinctly so it does not shadow the outer localAddress.
function transportOptions(announcedAddress) {
    const shared = { enableUdp: true, enableTcp: true, preferUdp: true };
    if (media.webRtcServer) return { ...shared, webRtcServer: media.webRtcServer };
    return {
        ...shared,
        listenInfos: [
            { protocol: 'udp', ip: '0.0.0.0', announcedAddress },
            { protocol: 'tcp', ip: '0.0.0.0', announcedAddress },
        ],
    };
}

/* -------------------------------------------------------------- lifecycle */

function appUrl(isDev) {
    return isDev ? 'https://localhost:5173' : `http://localhost:${LOCAL_PORT}/`;
}

// A name Windows accepts: no path characters, not empty, ending in .pdf.
function pdfFileName(value) {
    const printable = [...String(value || '')].filter((character) => character.charCodeAt(0) >= 32).join('');
    const cleaned = printable.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    const base = cleaned.replace(/\.pdf$/i, '').replace(/[. ]+$/, '') || 'Lingua Franca';
    return `${base}.pdf`;
}

// "Save as PDF" for the QR poster. The Windows print dialog's Microsoft Print to PDF opens its
// save box with an empty file name; this prints the page itself and suggests a real name.
function registerDesktopActions(isDev) {
    const appOrigin = isDev ? 'https://localhost:5173' : `http://localhost:${LOCAL_PORT}`;
    const fromApp = (event) => {
        let origin = '';
        try { origin = new URL(event.senderFrame?.url || '').origin; } catch { /* not a page of ours */ }
        return origin === appOrigin && Boolean(mainWindow) && event.sender === mainWindow.webContents;
    };
    // Something the operator must see now (the AI gave up, an input died, phones cannot hear).
    // Silent on purpose: this computer's sound may feed the PA, or be the broadcast itself when
    // the input is "System output". The taskbar button flashes until the window is looked at.
    ipcMain.handle('notify-operator', (event, payload) => {
        if (!fromApp(event)) return { error: 'Not available here.' };
        const title = String(payload?.title || 'Lingua Franca').slice(0, 120);
        const body = String(payload?.body || '').slice(0, 400);
        try { if (Notification.isSupported()) new Notification({ title, body, silent: true }).show(); }
        catch (error) { console.warn('Could not show a notification:', error.message); }
        if (mainWindow && !mainWindow.isFocused()) {
            mainWindow.flashFrame(true);
            mainWindow.once('focus', () => mainWindow?.flashFrame(false));
        }
        return { ok: true };
    });
    ipcMain.handle('save-page-as-pdf', async (event, requestedName) => {
        if (!fromApp(event)) return { error: 'Not available here.' };
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
            defaultPath: path.join(app.getPath('documents'), pdfFileName(requestedName)),
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (canceled || !filePath) return { canceled: true };
        try {
            const data = await event.sender.printToPDF({ printBackground: true, preferCSSPageSize: true });
            fs.writeFileSync(filePath, data);
            shell.showItemInFolder(filePath);
            return { saved: filePath };
        } catch (error) { return { error: error.message }; }
    });
}

function createWindow(isDev) {
    mainWindow = new BrowserWindow({
        width: 1200, height: 800, show: false,
        webPreferences: {
            nodeIntegration: false, contextIsolation: true, sandbox: true,
            preload: path.join(__dirname, 'desktop', 'preload.cjs'),
            // This window runs the broadcast. Chromium otherwise slows its timers once it is
            // minimised (to once a minute after a while), which delays caption lines, OpenAI
            // reconnects and the silence pause's wake-up by that much.
            backgroundThrottling: false,
        },
    });
    // Only the origin this mode actually serves: the packaged app has no reason to trust the
    // Vite dev server, and vice versa.
    const allowedOrigins = new Set([isDev ? 'https://localhost:5173' : `http://localhost:${LOCAL_PORT}`]);
    const isAllowedOrigin = (value) => {
        try { return allowedOrigins.has(new URL(value).origin); }
        catch { return false; }
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
    // Compare parsed origins: a startsWith() prefix test also accepts hosts that merely begin
    // with the allowed string.
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!isAllowedOrigin(url)) event.preventDefault();
    });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('closed', () => { mainWindow = null; });
    return mainWindow;
}

function showStartupFailure(error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('Startup failed:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
        void mainWindow.loadFile(path.join(__dirname, 'desktop', 'startup.html'), { search: `?error=${encodeURIComponent(detail)}` });
        mainWindow.show();
    }
    dialog.showErrorBox('Lingua Franca could not start', detail);
}

/* ----------------------------------------------------------------- server */

async function startServers(isDev) {
    const settings = loadSettings();
    saveSettings(settings);
    let localAddress = selectLocalAddress(networkAddresses(), process.env.LINGUA_FRANCA_HOST_IP || settings.preferredAddress);

    const expressApp = express();
    expressApp.disable('x-powered-by');
    // Routes matched case-insensitively by default, so /API/admin/login reached the real login
    // handler while the listener-port check below looked only for lowercase /api/. Routing is
    // case-sensitive now, and that check compares a lowercased path anyway. Set before the
    // first use(), which is when Express builds its router.
    expressApp.set('case sensitive routing', true);
    expressApp.use((request, response, next) => {
        if (!isAllowedHost(request.headers.host, settings)) {
            return response.status(403).json({ error: 'Unrecognized host name.' });
        }
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Permissions-Policy', 'microphone=(self)');
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        next();
    });
    // The plain listener port serves listening and nothing else. It refuses every API that
    // signs in or changes anything, so a PIN or interpreter code is never accepted over plain
    // HTTP, and it sends the sign-in pages to the HTTPS address before anything is typed.
    expressApp.use((request, response, next) => {
        if (request.socket.localPort !== LISTENER_PORT) return next();
        const requestPath = request.path.toLowerCase();
        if (requestPath.startsWith('/api/') || requestPath === '/api') {
            if (request.method === 'GET' && LISTENER_API.has(request.path)) return next();
            return response.status(403).json({ error: 'This address is for listening only. Use the secure address to sign in or broadcast.' });
        }
        if (/^\/(admin|interpreter)(\/|$)/.test(requestPath)) {
            return response.redirect(302, `https://${request.hostname}:${HTTPS_PORT}${request.originalUrl}`);
        }
        next();
    });
    expressApp.use(express.json({ limit: '256kb' }));
    expressApp.use((error, _request, response, next) => {
        if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
            return response.status(400).json({ error: 'Malformed request body.' });
        }
        return next(error);
    });

    httpsServer = https.createServer(await ensureServerCertificate(settings, localAddress), expressApp);
    httpServer = http.createServer(expressApp);
    listenerServer = http.createServer(expressApp);

    const { Server: SocketServer } = require('socket.io');
    const io = new SocketServer(httpsServer, {
        transports: ['websocket'],
        maxHttpBufferSize: 64 * 1024,
        allowRequest: (request, callback) =>
            callback(null, isAllowedOriginHeader(request.headers.origin, settings)),
    });
    const forwardUpgrade = (request, socket, head) => {
        if (!String(request.url || '').startsWith('/socket.io/')) return socket.destroy();
        io.engine.handleUpgrade(request, socket, head);
    };
    httpServer.on('upgrade', forwardUpgrade);
    listenerServer.on('upgrade', forwardUpgrade);

    const liveChannels = new Map();
    const transports = new Map();
    const producers = new Map();
    const listenerChannels = new Map();
    // channelId -> { socketId, token } of whoever is publishing it, so one broadcaster cannot
    // silently cut off, mute or end another's live channel.
    const producerOwners = new Map();

    // Recent captions per channel, handed to phones that join or reconnect mid-talk.
    const transcripts = new TranscriptStore();

    // Audio recordings and caption transcripts, kept on this computer for after the event.
    const recordingStore = new RecordingStore(path.join(app.getPath('userData'), 'recordings'));
    const transcriptLog = new TranscriptLog(recordingStore);
    // producer id -> { channelId, name, handle, stopRequested } for each recording in progress.
    const activeRecordings = new Map();
    // channelId -> { role, since } for each live broadcast: what the dashboard shows.
    const broadcastInfo = new Map();
    // producer id -> { producer, channelId, socketId }: the original speech in AI mode when it
    // is recorded but not broadcast. Never consumable, never shown as live.
    const recordOnlyProducers = new Map();
    const peakListeners = new Map();
    // AI time and cost since the app started or the dashboard was reset. The translation model
    // is billed by the minute (aiSeconds); Steady voice by the token, which its broadcaster
    // reports after each sentence (tokenUsd), so its time (steadySeconds) is only shown.
    const usage = { aiSeconds: 0, steadySeconds: 0, tokenUsd: 0, since: Date.now() };
    // "I can't hear" taps from phones, per channel, for the dashboard and the operator alert.
    const listenerReports = new ListenerReports();
    // channelId -> { socketId, approved, at }: the broadcaster waiting to take a channel over
    // from the interpreter on it (two interpreters taking turns).
    const handovers = new Map();
    // Highest budget warning already sent (0, 80, 100), so each is sent once.
    let budgetAlerted = 0;

    const adminSessions = new ExpiringMap();
    const interpreterSessions = new ExpiringMap();
    const interpreterCodes = new ExpiringMap();
    const adminThrottle = new LoginThrottle({ maxAttempts: 5, baseDelayMs: 30_000, maxDelayMs: 30 * 60_000 });
    const interpreterThrottle = new LoginThrottle({ maxAttempts: 5, baseDelayMs: 30_000, maxDelayMs: 30 * 60_000 });

    // Every successful use pushes the deadline out again, up to the session's hard limit.
    const keepAdminSession = (token) => refreshSession(adminSessions, token, ADMIN_SESSION_MS);
    const isAdminToken = (token) => keepAdminSession(token);
    const publisherSession = (token) => {
        if (isAdminToken(token)) return { role: 'admin' };
        const session = token ? interpreterSessions.get(token) : undefined;
        return session ? { role: 'interpreter', channelId: session.channelId } : null;
    };
    const requestToken = (request) => String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const requireAdmin = (request, response, next) => {
        if (!isAdminToken(requestToken(request))) return response.status(401).json({ error: 'Administrator login required.' });
        next();
    };
    const requirePublisher = (request, response, next) => {
        const session = publisherSession(requestToken(request));
        if (!session) return response.status(401).json({ error: 'Broadcaster login required.' });
        request.publisher = session;
        next();
    };

    // The operator's view of the settings, with what only this run knows: whether the PIN is
    // still the factory one and whether the settings file had to be recovered.
    const adminView = () => ({ ...adminSettings(settings, liveChannels), pinIsDefault, settingsRecovery });
    const emitSettings = () => io.emit('settingsChanged', publicSettings(settings, liveChannels));
    const setChannelState = (channelId, mode, role) => {
        if (mode) liveChannels.set(channelId, { mode, role, updatedAt: Date.now() });
        else liveChannels.delete(channelId);
        emitSettings();
    };
    // socket id -> { channelId, transportId } of what that phone is listening to right now.
    const countListeners = (channelId) => [...listenerChannels.values()].filter((entry) => entry.channelId === channelId).length;
    // Only the channel's broadcaster and the operators show this number. Sending it to every
    // socket meant each phone that joined pushed a message to every other phone in the room.
    const emitListenerCount = (channelId, count = countListeners(channelId)) => {
        const owner = producerOwners.get(channelId)?.socketId;
        for (const target of io.of('/').sockets.values()) {
            const operator = Boolean(target.data.token && adminSessions.has(target.data.token));
            if (operator || target.id === owner) target.emit('listenerCount', { channelId, count });
        }
    };
    // Seconds of OpenAI time one broadcast has run up so far: from when it last started
    // billing (it stops while paused for silence) or the dashboard's last reset, whichever is later.
    const billedSeconds = (info, now = Date.now()) => (info?.role === 'translation' && info.billedSince
        ? Math.max(0, now - Math.max(info.billedSince, usage.since)) / 1000 : 0);
    const aiTime = (now = Date.now()) => {
        let billed = usage.aiSeconds;
        let steady = usage.steadySeconds;
        for (const info of broadcastInfo.values()) {
            if (info.tokenMetered) steady += billedSeconds(info, now);
            else billed += billedSeconds(info, now);
        }
        return { billed, steady };
    };
    const aiCostUsd = (now = Date.now()) => aiTime(now).billed / 60 * AI_PRICE_PER_MINUTE + usage.tokenUsd;
    // Adds a finished AI broadcast's time to the running total before forgetting it.
    const endBroadcast = (channelId) => {
        const info = broadcastInfo.get(channelId);
        if (info?.tokenMetered) usage.steadySeconds += billedSeconds(info);
        else usage.aiSeconds += billedSeconds(info);
        broadcastInfo.delete(channelId);
    };
    // Only operator sessions; a socket on the plain listener port never holds a token.
    const emitToOperators = (event, payload) => {
        for (const operatorSocket of io.of('/').sockets.values()) {
            if (operatorSocket.data.token && adminSessions.has(operatorSocket.data.token)) operatorSocket.emit(event, payload);
        }
    };

    const startRecording = (channelId, producer, role) => {
        if (role === 'test') return;
        if (!settings.recordingEnabled || !media.router || producer.closed || activeRecordings.has(producer.id)) return;
        const startedAt = new Date();
        let file;
        try { file = recordingStore.newAudioFile(channelId, role, startedAt); }
        catch (error) { console.error('Could not create the recordings folder:', error.message); return; }
        const entry = { channelId, name: file.name, handle: null, stopRequested: false };
        activeRecordings.set(producer.id, entry);
        const channelName = findLanguage(settings.languages, channelId)?.name || channelId;
        const meta = { channelId, channelName, role, eventName: settings.event?.name || '', startedAt: startedAt.toISOString() };
        recordingStore.writeMeta(file.name, meta);
        startChannelRecording({
            router: media.router, producer, filePath: file.filePath,
            tags: { title: `${channelName} (${role})`, album: meta.eventName, date: startedAt.toISOString().slice(0, 10) },
            onEnded: ({ durationMs, packets }) => {
                activeRecordings.delete(producer.id);
                // Nothing was ever received (switched on and off at once): leave no empty file.
                if (!packets) { recordingStore.remove(file.name); return; }
                recordingStore.writeMeta(file.name, { ...meta, endedAt: new Date().toISOString(), durationMs });
            },
        }).then((handle) => {
            entry.handle = handle;
            if (entry.stopRequested || producer.closed) handle.stop();
        }).catch((error) => {
            activeRecordings.delete(producer.id);
            fs.rmSync(recordingStore.metaPath(file.name), { force: true });
            console.error(`Could not record ${channelId}:`, error.message);
        });
    };
    const stopRecording = (producerId) => {
        const entry = activeRecordings.get(producerId);
        if (!entry) return;
        entry.stopRequested = true;
        entry.handle?.stop();
    };
    // Follows the Admin switch: starts recording everything already live, or stops it all.
    const syncRecordings = () => {
        if (!settings.recordingEnabled) {
            for (const producerId of [...activeRecordings.keys()]) stopRecording(producerId);
            return;
        }
        for (const [channelId, producer] of producers) startRecording(channelId, producer, broadcastInfo.get(channelId)?.role || 'interpreter');
        for (const { channelId, producer } of recordOnlyProducers.values()) startRecording(channelId, producer, 'original');
    };
    stopAllRecordings = () => { for (const producerId of [...activeRecordings.keys()]) stopRecording(producerId); };

    const closeProducerFor = (channelId) => {
        const producer = producers.get(channelId);
        if (!producer) return false;
        producers.delete(channelId);
        producerOwners.delete(channelId);
        endBroadcast(channelId);
        stopRecording(producer.id);
        try { producer.close(); } catch { /* already closed */ }
        setChannelState(channelId);
        io.emit('producerClosed', { channelId });
        // Someone was waiting to take this channel over and it is now free: let them start.
        const waiting = handovers.get(channelId);
        if (waiting) {
            handovers.delete(channelId);
            io.to(waiting.socketId).emit('handoverApproved', { channelId, free: true });
        }
        return true;
    };

    // Ends sessions server-side and drops every socket still using one, so a revoked phone
    // stops broadcasting at once rather than whenever its socket next reconnects.
    // An interpreter's broadcast ends with its session: when the eight hours are up, or when
    // the operator ends interpreter access. Expired sessions are already gone from the store, so
    // the broadcasts are found through their owners rather than through the tokens.
    const endInterpreterBroadcasts = ({ includeValid = false } = {}) => {
        let ended = 0;
        for (const [channelId, owner] of [...producerOwners]) {
            if (owner.role !== 'interpreter') continue;
            if (!includeValid && publisherSession(owner.token)) continue;
            closeProducerFor(channelId);
            ended += 1;
            const owning = io.of('/').sockets.get(owner.socketId);
            if (!owning) continue;
            owning.emit('sessionRevoked');
            setTimeout(() => owning.disconnect(true), 200).unref?.();
        }
        return ended;
    };

    const revokeSessions = (store, keepToken = '') => {
        const revoked = new Set(store.keys().filter((token) => token !== keepToken));
        for (const token of revoked) store.delete(token);
        for (const socket of io.of('/').sockets.values()) {
            if (!revoked.has(socket.data.token)) continue;
            socket.emit('sessionRevoked');
            // A short pause lets the notice reach the client before the socket closes.
            setTimeout(() => socket.disconnect(true), 200).unref?.();
        }
        return revoked.size;
    };

    const persist = (response, value = settings) => {
        try { saveSettings(value); return true; }
        catch (error) {
            console.error('Failed to save settings:', error);
            response.status(500).json({ error: `Could not save settings: ${error.message}` });
            return false;
        }
    };

    /* ------------------------------------------------------- media worker */

    let restartAttempt = 0;
    const startMedia = async () => {
        try {
            media = await createMedia(isDev, localAddress);
            restartAttempt = 0;
            console.log(`SFU ready (${media.portMode === 'multiplexed' ? `single ICE port ${RTC_PORT}` : `port range ${RTC_MIN_PORT}-${RTC_MAX_PORT}`}).`);
            media.worker.on('died', () => {
                console.error('The mediasoup worker died; restarting it.');
                media = { worker: null, router: null, webRtcServer: null, error: 'The media worker stopped and is restarting.', portMode: media.portMode };
                // Recordings end on their own as the router closes; the AI time still counts.
                for (const channelId of [...broadcastInfo.keys()]) endBroadcast(channelId);
                recordOnlyProducers.clear();
                producers.clear(); producerOwners.clear(); liveChannels.clear(); listenerChannels.clear(); handovers.clear();
                // Empty each socket's transport list but keep the entry. Those sockets stay
                // connected and renegotiate on 'sfuReady'; deleting the entries left every
                // transport they created afterwards untracked, so connectTransport and consume
                // failed with "Transport not found" until the page was reloaded.
                for (const owned of transports.values()) owned.clear();
                io.emit('sfuRestarting');
                scheduleMediaRestart();
            });
            io.emit('sfuReady');
            emitSettings();
        } catch (error) {
            media = { worker: null, router: null, webRtcServer: null, error: error.message || String(error), portMode: 'unknown' };
            console.error('SFU initialization failed:', error);
            scheduleMediaRestart();
        }
    };
    const scheduleMediaRestart = () => {
        const delay = WORKER_RESTART_DELAYS_MS[Math.min(restartAttempt, WORKER_RESTART_DELAYS_MS.length - 1)];
        restartAttempt += 1;
        setTimeout(() => { void startMedia(); }, delay).unref?.();
    };
    await startMedia();

    /* --------------------------------------------------------- signalling */

    io.on('connection', (socket) => {
        transports.set(socket.id, new Map());
        // A socket that came in on the plain listener port is never treated as signed in, even
        // if it presents a token: it may only listen.
        const listenOnly = socket.request.socket?.localPort === LISTENER_PORT;
        // Starts as the handshake token and changes with 'setToken'.
        socket.data.token = listenOnly ? '' : String(socket.handshake.auth?.token || '').slice(0, 256);
        const socketToken = () => socket.data.token;
        const socketIsAdmin = () => isAdminToken(socketToken());
        const socketPublisher = () => publisherSession(socketToken());
        // A reconnecting phone gets a new socket id but keeps its session token, so either one
        // proves ownership. A channel with no live producer belongs to nobody.
        // transport id -> its consumer, for this socket.
        const consumers = new Map();
        const ownsChannel = (channelId) => {
            const owner = producerOwners.get(channelId);
            return !owner || owner.socketId === socket.id || (Boolean(owner.token) && owner.token === socketToken());
        };
        const trackTransport = (transport) => {
            const owned = transports.get(socket.id);
            owned?.set(transport.id, transport);
            // However a transport ends, forget it, and stop counting its phone as a listener.
            transport.observer.once('close', () => {
                owned?.delete(transport.id);
                const listening = listenerChannels.get(socket.id);
                if (listening?.transportId !== transport.id) return;
                listenerChannels.delete(socket.id);
                emitListenerCount(listening.channelId);
            });
            const close = () => { try { transport.close(); } catch { /* already closed */ } };
            // 'failed' matters as much as 'closed': a phone that walks out of range never
            // sends a clean shutdown, and its ICE port would otherwise stay held.
            transport.on('dtlsstatechange', (state) => { if (state === 'closed' || state === 'failed') close(); });
            transport.on('routerclose', close);
        };

        // Every handler goes through this. Any phone, signed in or not, can send any event with
        // any payload and with or without an acknowledgement; none of that may throw inside the
        // server (a missing callback used to raise an uncaught TypeError).
        const on = (event, handler) => socket.on(event, (...args) => {
            const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
            const payload = args[0] !== null && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {};
            let answered = false;
            const callback = (value) => {
                if (answered || !ack) return;
                answered = true;
                ack(value);
            };
            const fail = (error) => {
                console.error(`Signalling "${event}" failed:`, error?.message || error);
                callback({ error: 'The server could not handle that request.' });
            };
            try {
                const result = handler(payload, callback);
                if (result && typeof result.catch === 'function') result.catch(fail);
            } catch (error) { fail(error); }
        });

        on('getRouterRtpCapabilities', (_payload, callback) =>
            callback(media.router ? media.router.rtpCapabilities : { error: `SFU unavailable: ${media.error}` }));

        // Signing in, or back in after a session lapsed, swaps the token on the live connection.
        // The client used to reconnect instead, and the server treated that as the device leaving:
        // every broadcast and listener on it was torn down, while the client, seeing its own
        // disconnect, did not republish. Ownership follows the socket, so its channels move to
        // the new token.
        on('setToken', ({ token } = {}, callback) => {
            if (listenOnly) return callback({ ok: true, ignored: true });
            socket.data.token = String(token || '').slice(0, 256);
            for (const owner of producerOwners.values()) if (owner.socketId === socket.id) owner.token = socket.data.token;
            callback({ ok: true });
        });

        // Which channel's captions this phone wants. Captions used to go to every phone, which
        // threw away all but its own channel: several times the traffic on a busy Wi-Fi.
        on('watchCaptions', ({ channelId } = {}, callback) => {
            const id = String(channelId || '').slice(0, 80);
            for (const room of [...socket.rooms]) if (room.startsWith(CAPTION_ROOM)) socket.leave(room);
            if (id) socket.join(`${CAPTION_ROOM}${id}`);
            callback({ ok: true });
        });

        // A listener tapped "I can't hear". Counted per phone over two minutes and pushed to the
        // operator, who otherwise only learns about a dead channel when someone walks over.
        on('listenerReport', ({ channelId } = {}, callback) => {
            const language = findLanguage(settings.languages, String(channelId || '').slice(0, 80));
            if (!language) return callback({ error: 'Unknown channel.' });
            const { accepted, count } = listenerReports.record(language.id, socket.id);
            if (accepted) emitToOperators('listenerReports', { channelId: language.id, channelName: language.name, count });
            callback({ ok: true, accepted, count });
        });

        // Two interpreters taking turns: the next one asks, the one on air approves, and the
        // next one's broadcast then replaces the current one (see 'produce').
        on('requestHandover', ({ channelId } = {}, callback) => {
            const publisher = socketPublisher();
            if (!publisher) return callback({ error: 'Broadcaster login required.', code: 'login_required' });
            const id = String(channelId || '').slice(0, 80);
            if (!findLanguage(settings.languages, id)) return callback({ error: 'Unknown channel.' });
            if (publisher.role === 'interpreter' && publisher.channelId !== id) {
                return callback({ error: 'This interpreter link is authorized for a different channel.', code: 'wrong_channel' });
            }
            const owner = producerOwners.get(id);
            if (!producers.has(id) || !owner) return callback({ ok: true, free: true });
            if (ownsChannel(id)) return callback({ ok: true, own: true });
            handovers.set(id, { socketId: socket.id, approved: false, at: Date.now() });
            io.to(owner.socketId).emit('handoverRequested', { channelId: id });
            callback({ ok: true, requested: true });
        });

        on('acceptHandover', ({ channelId } = {}, callback) => {
            const id = String(channelId || '').slice(0, 80);
            const pending = handovers.get(id);
            if (!pending) return callback({ error: 'Nobody is waiting to take this channel over.' });
            if (producerOwners.get(id)?.socketId !== socket.id) return callback({ error: 'Only the broadcaster on this channel can hand it over.' });
            pending.approved = true;
            pending.at = Date.now();
            io.to(pending.socketId).emit('handoverApproved', { channelId: id });
            callback({ ok: true });
        });

        on('cancelHandover', ({ channelId } = {}, callback) => {
            const id = String(channelId || '').slice(0, 80);
            const pending = handovers.get(id);
            if (pending?.socketId === socket.id) {
                handovers.delete(id);
                const owner = producerOwners.get(id);
                if (owner) io.to(owner.socketId).emit('handoverCancelled', { channelId: id });
            }
            callback({ ok: true });
        });

        // The AI legs were closed for silence (or reopened): stop (or restart) counting their
        // time, so the dashboard's cost and the budget warning reflect what OpenAI bills.
        on('setAiPaused', ({ channelIds, paused } = {}, callback) => {
            if (!socketIsAdmin()) return callback({ error: 'Administrator login required.' });
            const ids = Array.isArray(channelIds) ? channelIds.slice(0, 32).map((value) => String(value).slice(0, 80)) : [];
            for (const id of ids) {
                const info = broadcastInfo.get(id);
                if (info?.role !== 'translation' || info.tokenMetered || !ownsChannel(id)) continue;
                if (paused && info.billedSince) { usage.aiSeconds += billedSeconds(info); info.billedSince = null; }
                if (!paused && !info.billedSince) info.billedSince = Date.now();
            }
            callback({ ok: true });
        });

        // What one Steady voice sentence cost, from OpenAI's own usage report: the tokens of a
        // finished response, or the seconds of speech transcribed. Priced here, not on the
        // broadcasting screen, and capped, so a bad report cannot run the total up.
        on('aiUsage', ({ channelId, usage: tokens, transcribedSeconds } = {}, callback) => {
            if (!socketIsAdmin()) return callback?.({ error: 'Administrator login required.' });
            const info = broadcastInfo.get(String(channelId || '').slice(0, 80));
            if (!info?.tokenMetered || !ownsChannel(String(channelId))) return callback?.({ ok: true, ignored: true });
            const seconds = Number(transcribedSeconds);
            const cost = (tokens && typeof tokens === 'object' ? responseCostUsd(tokens) : 0)
                + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 600) * TRANSCRIPTION_PER_SECOND : 0);
            usage.tokenUsd += Math.min(cost, 5);
            callback?.({ ok: true });
        });

        // A transport this phone no longer needs (it stopped listening, switched channel, or its
        // channel had no broadcast yet). Without this, each attempt left one open on the server.
        on('closeTransport', ({ transportId } = {}, callback) => {
            const transport = transports.get(socket.id)?.get(String(transportId || ''));
            if (transport) { try { transport.close(); } catch { /* already closed */ } }
            callback({ ok: true });
        });

        on('createWebRtcTransport', async ({ type } = {}, callback) => {
            if (!media.router) return callback({ error: `SFU unavailable: ${media.error}` });
            const publisher = socketPublisher();
            if (type === 'producer' && !publisher) return callback({ error: 'Broadcaster login required.', code: 'login_required' });
            const owned = transports.get(socket.id);
            if (owned && publisher && owned.size >= PUBLISHER_TRANSPORT_LIMIT) {
                return callback({ error: 'Too many open connections from this device. Stop and start the broadcast again.' });
            }
            if (owned && !publisher) {
                // Oldest first: Map keeps insertion order.
                for (const stale of [...owned.values()].slice(0, Math.max(0, owned.size - LISTENER_TRANSPORT_LIMIT + 1))) {
                    try { stale.close(); } catch { /* already closed */ }
                }
            }
            try {
                const transport = await media.router.createWebRtcTransport(transportOptions(localAddress));
                trackTransport(transport);
                callback({
                    id: transport.id, iceParameters: transport.iceParameters,
                    iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters,
                });
            } catch (error) { callback({ error: error.message }); }
        });

        on('connectTransport', async ({ transportId, dtlsParameters } = {}, callback) => {
            try {
                const transport = transports.get(socket.id)?.get(transportId);
                if (!transport) throw new Error('Transport not found.');
                await transport.connect({ dtlsParameters });
                callback();
            } catch (error) { callback({ error: error.message }); }
        });

        on('produce', async ({ transportId, kind, rtpParameters, appData } = {}, callback) => {
            const publisher = socketPublisher();
            if (!publisher) return callback({ error: 'Broadcaster login required.', code: 'login_required' });
            // A code lets a phone show the reason in its own language.
            const coded = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });
            try {
                const transport = transports.get(socket.id)?.get(transportId);
                if (!transport) throw new Error('Producer transport not found.');
                const channelId = String(appData?.channelId || '').slice(0, 80);
                const language = findLanguage(settings.languages, channelId);
                if (!language) throw new Error('Unknown channel.');
                if (publisher.role === 'interpreter' && publisher.channelId !== channelId) {
                    throw coded('This interpreter link is authorized for a different channel.', 'wrong_channel');
                }
                // The original speech in AI mode, recorded without being broadcast. It goes
                // nowhere but the recording, so it never touches the channel's live state.
                if (appData?.recordOnly) {
                    if (publisher.role !== 'admin') throw new Error('Only the operator can record without broadcasting.');
                    const producer = await transport.produce({ kind, rtpParameters, appData: { channelId, recordOnly: true } });
                    recordOnlyProducers.set(producer.id, { producer, channelId, socketId: socket.id });
                    producer.observer.once('close', () => {
                        recordOnlyProducers.delete(producer.id);
                        stopRecording(producer.id);
                    });
                    startRecording(channelId, producer, 'original');
                    return callback({ id: producer.id });
                }
                // Starting a second broadcast on a live channel used to cut the first one off
                // without a word. Only the operator may take a channel over, and the broadcaster
                // being replaced is told, instead of carrying on into a producer nobody hears.
                const isTest = appData?.role === 'test';
                if (isTest && publisher.role !== 'admin') throw new Error('Only the operator can play a test tone.');
                // Asked before and again after the new producer exists: the old broadcast is
                // only ended once its replacement is ready, and whatever changed meanwhile (the
                // channel taken by someone else, access revoked) is caught before the swap.
                const takeover = (who) => {
                    // A handover the current interpreter approved for this device lets it take over.
                    const handover = handovers.get(channelId);
                    const handedOver = Boolean(handover?.approved && handover.socketId === socket.id && Date.now() - handover.at < HANDOVER_MS);
                    if (producers.has(channelId) && !ownsChannel(channelId) && who.role !== 'admin' && !handedOver) {
                        throw coded(`${language.name} is already being broadcast. Ask the operator to stop it first.`, 'channel_taken', { channel: language.name });
                    }
                    return handedOver;
                };
                takeover(publisher);
                const producer = await transport.produce({ kind, rtpParameters, appData: { channelId } });
                let handedOver;
                try {
                    const still = socketPublisher();
                    if (!still) throw coded('Broadcaster login required.', 'login_required');
                    if (!findLanguage(settings.languages, channelId)) throw new Error('Unknown channel.');
                    if (producer.closed) throw new Error('The connection closed before the broadcast started.');
                    handedOver = takeover(still);
                } catch (error) {
                    try { producer.close(); } catch { /* already closed */ }
                    throw error;
                }
                const previousOwner = producerOwners.get(channelId);
                if (producers.has(channelId) && previousOwner && !ownsChannel(channelId)) {
                    io.to(previousOwner.socketId).emit('producerReplaced', { channelId, reason: handedOver ? 'handover' : 'takeover' });
                }
                // Settled either way: whoever goes on air now ends any pending request.
                handovers.delete(channelId);
                closeProducerFor(channelId);
                // A new broadcast after a long quiet spell is a new service, not a continuation.
                if (!isTest) transcripts.clearIfIdle(channelId, CAPTION_IDLE_MS);
                producers.set(channelId, producer);
                producerOwners.set(channelId, { socketId: socket.id, token: socketToken() || '', role: publisher.role });
                // Phones already waiting on the channel count from the first second.
                emitListenerCount(channelId);
                const role = isTest ? 'test' : ROLES.includes(appData?.role) ? appData.role : appData?.mode === 'ai' ? 'translation' : 'interpreter';
                setChannelState(channelId, appData?.mode === 'ai' && !isTest ? 'ai-active' : 'sfu-active', role);
                broadcastInfo.set(channelId, {
                    role, since: Date.now(), billedSince: role === 'translation' ? Date.now() : null,
                    // Steady voice is billed by the token, reported by its broadcaster.
                    tokenMetered: role === 'translation' && appData?.engine === 'steady',
                });
                startRecording(channelId, producer, role);
                producer.on('transportclose', () => {
                    if (producers.get(channelId)?.id === producer.id) closeProducerFor(channelId);
                });
                callback({ id: producer.id });
                socket.broadcast.emit('producerAvailable', { channelId });
            } catch (error) { callback({ error: error.message, code: error.code, channel: error.channel }); }
        });

        // Explicit teardown. Without it the server only learns a broadcast ended when DTLS
        // times out, and a listener joining in that window consumes a dead producer and hears
        // silence while the UI claims it is connected.
        on('closeProducer', ({ channelId } = {}, callback) => {
            const publisher = socketPublisher();
            if (!publisher) return callback?.({ error: 'Broadcaster login required.' });
            const id = String(channelId || '').slice(0, 80);
            if (publisher.role === 'interpreter' && publisher.channelId !== id) {
                return callback?.({ error: 'This interpreter link is authorized for a different channel.' });
            }
            // A broadcaster that was taken over still sends this when it presses Stop. Ending
            // the channel then would cut off whoever took it over, so only the owner may.
            if (!ownsChannel(id)) return callback?.({ ok: true, ignored: true });
            closeProducerFor(id);
            callback?.({ ok: true });
        });

        on('closeRecordOnly', ({ producerId } = {}, callback) => {
            const entry = recordOnlyProducers.get(String(producerId || ''));
            if (!entry || entry.socketId !== socket.id) return callback?.({ ok: true, ignored: true });
            try { entry.producer.close(); } catch { /* already closed */ }
            callback?.({ ok: true });
        });

        // mediasoup-client's producer.pause() is local only, so the mute has to be relayed
        // for the server to pause the real producer and notify every consumer.
        on('setProducerPaused', ({ channelId, paused } = {}, callback) => {
            const publisher = socketPublisher();
            if (!publisher) return callback?.({ error: 'Broadcaster login required.' });
            const id = String(channelId || '').slice(0, 80);
            if (publisher.role === 'interpreter' && publisher.channelId !== id) {
                return callback?.({ error: 'This interpreter link is authorized for a different channel.' });
            }
            const producer = producers.get(id);
            if (!producer) return callback?.({ error: 'That channel is not broadcasting.' });
            if (!ownsChannel(id)) return callback?.({ error: 'Another broadcaster now has this channel.' });
            void (paused ? producer.pause() : producer.resume())
                .then(() => callback?.({ ok: true }))
                .catch((error) => callback?.({ error: error.message }));
        });

        on('consume', async ({ transportId, rtpCapabilities, channelId } = {}, callback) => {
            try {
                const producer = producers.get(channelId);
                if (!producer) {
                    // Nothing to receive yet. Close the transport made for it rather than leave
                    // one behind for every attempt; the phone makes a fresh one when it retries.
                    const unused = transports.get(socket.id)?.get(transportId);
                    if (unused) { try { unused.close(); } catch { /* already closed */ } }
                    return callback({ error: 'Waiting for broadcaster.', transportClosed: true });
                }
                if (!media.router?.canConsume({ producerId: producer.id, rtpCapabilities })) {
                    throw new Error('This device cannot consume the stream.');
                }
                const transport = transports.get(socket.id)?.get(transportId);
                if (!transport) throw new Error('Consumer transport not found.');
                // One stream per transport: the client never asks for more, and each repeated
                // consume would otherwise send another copy of the audio to the same phone.
                const previousConsumer = consumers.get(transport.id);
                if (previousConsumer) { try { previousConsumer.close(); } catch { /* already closed */ } }
                const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities, paused: false });
                consumers.set(transport.id, consumer);
                consumer.observer.once('close', () => { if (consumers.get(transport.id) === consumer) consumers.delete(transport.id); });
                // A phone switching channels leaves its old one: tell that broadcaster too, or
                // its count stayed one too high until something else changed it.
                const previousChannel = listenerChannels.get(socket.id)?.channelId;
                listenerChannels.set(socket.id, { channelId, transportId: transport.id });
                if (previousChannel && previousChannel !== channelId) emitListenerCount(previousChannel);
                const count = countListeners(channelId);
                peakListeners.set(channelId, Math.max(peakListeners.get(channelId) || 0, count));
                emitListenerCount(channelId, count);
                consumer.on('transportclose', () => consumer.close());
                consumer.on('producerclose', () => consumer.close());
                // Lets a listener distinguish "the interpreter muted themselves" from "the
                // audio died", which are very different things to see mid-service.
                consumer.on('producerpause', () => socket.emit('channelMuted', { channelId, muted: true }));
                consumer.on('producerresume', () => socket.emit('channelMuted', { channelId, muted: false }));
                callback({
                    id: consumer.id, producerId: producer.id, kind: consumer.kind,
                    rtpParameters: consumer.rtpParameters, producerPaused: producer.paused,
                });
            } catch (error) { callback({ error: error.message }); }
        });

        // Captions arrive as segments: one id per sentence, sent repeatedly while it grows and
        // once more with `final` set. Each is kept for late joiners and relayed to everyone.
        on('sendTranslationText', ({ channelId, segmentId, text, originalText, final } = {}, callback) => {
            if (!socketIsAdmin()) return callback?.({ error: 'Administrator login required.' });
            const id = String(channelId || '').slice(0, 80);
            const language = findLanguage(settings.languages, id);
            if (!language) return callback?.({ error: 'Unknown channel.' });
            const segment = transcripts.update(id, { segmentId, text, originalText, final });
            if (!segment) return callback?.({ error: 'A caption needs a segment id.' });
            io.to(`${CAPTION_ROOM}${id}`).emit('translationText', { channelId: id, ...segment });
            if (segment.final && settings.transcriptsEnabled !== false) {
                try { transcriptLog.append(id, language.name, segment, { eventName: settings.event?.name || '' }); }
                catch (error) { console.error('Could not save the transcript:', error.message); }
            }
            callback?.({ ok: true });
        });

        // What was said recently on a channel. Captions are public to every listener anyway,
        // so this needs no session, and it works on the plain listener port.
        on('getTranscript', ({ channelId } = {}, callback) => {
            const id = String(channelId || '').slice(0, 80);
            // Off air and quiet for a while: last service's words are not "what was just said".
            if (!producers.has(id)) transcripts.clearIfIdle(id, CAPTION_IDLE_MS);
            callback?.({ segments: transcripts.recent(id) });
        });

        socket.on('disconnect', () => {
            for (const transport of transports.get(socket.id)?.values() || []) {
                try { transport.close(); } catch { /* already closed */ }
            }
            transports.delete(socket.id);
            const listening = listenerChannels.get(socket.id);
            listenerChannels.delete(socket.id);
            if (listening) emitListenerCount(listening.channelId);
            listenerReports.forget(socket.id);
            // A device that asked to take a channel over and left: tell the one on air.
            for (const [channelId, pending] of [...handovers]) {
                if (pending.socketId !== socket.id) continue;
                handovers.delete(channelId);
                const owner = producerOwners.get(channelId);
                if (owner) io.to(owner.socketId).emit('handoverCancelled', { channelId });
            }
        });
    });

    /* --------------------------------------------------------------- API */

    expressApp.get('/api/settings', (_request, response) => response.json(publicSettings(settings, liveChannels)));
    expressApp.get('/api/local-ip', (_request, response) => response.json({ ip: localAddress, port: HTTPS_PORT }));

    // Public liveness only. Adapter inventory, file paths (which embed the Windows user name)
    // and SFU internals moved to the operator-only endpoint below.
    expressApp.get('/api/health', (_request, response) => response.json({
        ok: Boolean(media.router),
        sfu: media.router ? 'ready' : 'unavailable',
        publicHost: certificateState.type === 'trusted' ? certificateState.hostname : localAddress,
        certificateType: certificateState.type,
        ports: { https: HTTPS_PORT, listener: listenerPortError ? null : LISTENER_PORT },
    }));

    // Anything holding a broadcaster session may read the microphone permission state, which
    // the Interpreter screen needs to explain a denied input.
    expressApp.get('/api/diagnostics', requirePublisher, (_request, response) => response.json({
        sfu: media.router ? 'ready' : 'unavailable',
        sfuError: media.error,
        microphoneAccess: ['win32', 'darwin'].includes(process.platform)
            ? systemPreferences.getMediaAccessStatus('microphone') : 'unknown',
    }));

    expressApp.get('/api/admin/health', requireAdmin, (_request, response) => response.json({
        ok: Boolean(media.router),
        localAddress,
        addresses: networkAddresses(),
        sfu: media.router ? 'ready' : 'unavailable',
        sfuError: media.error,
        portMode: media.portMode,
        addressDrift,
        openaiConfigured: Boolean(settings.openaiApiKeyEncrypted),
        secureStorageAvailable: secureStorageAvailable && safeStorage.isEncryptionAvailable(),
        publicHost: certificateState.type === 'trusted' ? certificateState.hostname : localAddress,
        certificate: certificateState,
        certificatePath: path.join(certificateDirectory(), certificateState.type === 'trusted' ? 'trusted-cert.pem' : 'server-cert.pem'),
        microphoneAccess: ['win32', 'darwin'].includes(process.platform)
            ? systemPreferences.getMediaAccessStatus('microphone') : 'unknown',
        ports: {
            https: HTTPS_PORT, local: LOCAL_PORT, listener: listenerPortError ? null : LISTENER_PORT,
            rtc: media.portMode === 'multiplexed' ? `${RTC_PORT}/udp+tcp` : `${RTC_MIN_PORT}-${RTC_MAX_PORT}/udp+tcp`,
        },
        listenerPortError,
    }));

    expressApp.post('/api/admin/login', (request, response) => {
        const address = request.ip || 'unknown';
        const blocked = adminThrottle.status(address);
        if (blocked.blocked) {
            response.setHeader('Retry-After', Math.ceil(blocked.retryAfterMs / 1000));
            return response.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(blocked.retryAfterMs / 1000)} seconds.` });
        }
        if (!verifyPin(settings, request.body?.pin || '')) {
            const next = adminThrottle.fail(address);
            return response.status(401).json({
                error: next.blocked
                    ? `Incorrect PIN. Locked for ${Math.ceil(next.retryAfterMs / 1000)} seconds.`
                    : 'Incorrect PIN.',
            });
        }
        adminThrottle.succeed(address);
        const token = newToken();
        adminSessions.set(token, { role: 'admin', capAt: Date.now() + ADMIN_SESSION_MAX_MS }, Date.now() + ADMIN_SESSION_MS);
        response.json({ token, expiresIn: ADMIN_SESSION_MS / 1000 });
    });

    expressApp.post('/api/admin/logout', requireAdmin, (request, response) => {
        adminSessions.delete(requestToken(request));
        response.json({ ok: true });
    });

    expressApp.post('/api/admin/interpreter-link', requireAdmin, (request, response) => {
        const channelId = String(request.body?.channelId || '').slice(0, 80);
        const language = findLanguage(settings.languages, channelId);
        if (!language) return response.status(400).json({ error: 'Choose a configured language channel.' });
        let code;
        do { code = newAccessCode(); } while (interpreterCodes.has(code));
        const expiresAt = Date.now() + INTERPRETER_CODE_MS;
        interpreterCodes.set(code, { channelId, expiresAt }, expiresAt);
        response.json({ code, channelId, channelName: language.name, expiresAt });
    });

    // Ends every interpreter session and unused code at once: a lost phone, a link shared
    // further than intended, or simply the end of a service. Interpreter sessions otherwise
    // lasted their full eight hours with no way to cut them short.
    expressApp.post('/api/admin/interpreter-sessions/revoke', requireAdmin, (_request, response) => {
        const codes = interpreterCodes.keys().length;
        interpreterCodes.clear();
        const sessions = revokeSessions(interpreterSessions);
        const broadcasts = endInterpreterBroadcasts({ includeValid: true });
        response.json({ ok: true, sessions, codes, broadcasts });
    });

    // Same escalating lockout as the admin PIN. A six-digit code with unlimited attempts is
    // reachable by brute force from anywhere on the Wi-Fi, and the prize is a live microphone.
    expressApp.post('/api/interpreter/login', (request, response) => {
        const address = request.ip || 'unknown';
        const blocked = interpreterThrottle.status(address);
        if (blocked.blocked) {
            response.setHeader('Retry-After', Math.ceil(blocked.retryAfterMs / 1000));
            return response.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(blocked.retryAfterMs / 1000)} seconds.` });
        }
        const code = String(request.body?.code || '').replace(/\D/g, '').slice(0, 6);
        const access = code.length === 6 ? interpreterCodes.take(code) : undefined;
        if (!access) {
            const next = interpreterThrottle.fail(address);
            return response.status(401).json({
                error: next.blocked
                    ? `This code is invalid or expired. Locked for ${Math.ceil(next.retryAfterMs / 1000)} seconds.`
                    : 'This interpreter code is invalid or expired.',
            });
        }
        interpreterThrottle.succeed(address);
        const language = findLanguage(settings.languages, access.channelId);
        const token = newToken();
        interpreterSessions.set(token, { channelId: access.channelId }, Date.now() + INTERPRETER_SESSION_MS);
        response.json({
            token, channelId: access.channelId,
            channelName: language?.name || access.channelId,
            expiresAt: Date.now() + INTERPRETER_SESSION_MS,
        });
    });

    expressApp.post('/api/admin/certificate', requireAdmin, async (request, response) => {
        const domain = normalizeDuckDnsDomain(request.body?.domain);
        const email = String(request.body?.email || '').trim();
        const token = String(request.body?.token || '').trim();
        if (!isValidDuckDnsDomain(domain)) return response.status(400).json({ error: 'Enter a valid DuckDNS subdomain.' });
        if (!isValidEmail(email)) return response.status(400).json({ error: 'Enter a valid contact email.' });
        if (!token && !settings.duckDnsTokenEncrypted) return response.status(400).json({ error: 'Enter your DuckDNS token.' });
        const previous = { mode: settings.certificateMode, hostname: settings.certificateHostname, email: settings.certificateEmail };
        settings.certificateMode = 'duckdns';
        settings.certificateHostname = domain;
        settings.certificateEmail = email;
        if (token) {
            try { settings.duckDnsTokenEncrypted = protectSecret(token); }
            catch (error) {
                Object.assign(settings, { certificateMode: previous.mode, certificateHostname: previous.hostname, certificateEmail: previous.email });
                return response.status(503).json({ error: error.message });
            }
        }
        if (!persist(response)) return;
        try {
            const secureContext = await ensureServerCertificate(settings, localAddress, { forceRenewal: false });
            httpsServer.setSecureContext(secureContext);
            // ensureServerCertificate falls back to the local certificate when issuing fails, so
            // success has to be judged by what is now installed, not by the absence of a throw.
            if (certificateState.type !== 'trusted') {
                return response.status(502).json({
                    error: `Certificate setup failed: ${certificateState.error || 'no trusted certificate was issued.'} Phones still see a warning.`,
                    certificate: certificateState,
                });
            }
            response.json({ ok: true, certificate: certificateState, publicHost: certificateState.hostname });
        } catch (error) {
            certificateState.error = error.message;
            response.status(502).json({ error: `Certificate setup failed: ${error.message}` });
        }
    });

    expressApp.get('/api/admin/settings', requireAdmin, (_request, response) => response.json(adminView()));

    expressApp.patch('/api/admin/settings', requireAdmin, (request, response) => {
        const patch = request.body || {};
        // Everything that can be refused is checked before anything changes, so a refused
        // request never leaves channels removed or the event edited with the PIN unchanged.
        let languages = null;
        if (Array.isArray(patch.languages)) {
            languages = normalizeLanguages(patch.languages);
            if (!languages.length) return response.status(400).json({ error: 'Keep at least one language channel.' });
        }
        const pinChanged = patch.adminPin !== undefined;
        if (pinChanged) {
            if (!isValidPin(patch.adminPin)) return response.status(400).json({ error: 'The PIN must be 4 to 12 digits.' });
            // A session left open on a shared computer must not be enough to take the PIN over.
            // Wrong guesses count toward the same lockout as the sign-in screen.
            const address = request.ip || 'unknown';
            const blocked = adminThrottle.status(address);
            if (blocked.blocked) return response.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(blocked.retryAfterMs / 1000)} seconds.` });
            if (!verifyPin(settings, patch.currentPin || '')) {
                adminThrottle.fail(address);
                return response.status(403).json({ error: 'The current PIN is not correct.' });
            }
            if (String(patch.adminPin) === DEFAULT_PIN) return response.status(400).json({ error: 'Choose a PIN other than 1234.' });
        }
        let openaiApiKeyEncrypted = '';
        try {
            if (typeof patch.openaiApiKey === 'string' && patch.openaiApiKey.trim()) openaiApiKeyEncrypted = protectSecret(patch.openaiApiKey.trim());
        } catch (error) { return response.status(503).json({ error: error.message }); }

        // Applied to a copy and saved; the live settings change only once the file has.
        const next = structuredClone(settings);
        if (languages) next.languages = languages;
        if (patch.event && typeof patch.event === 'object') next.event = normalizeEvent(patch.event);
        if (patch.contact && typeof patch.contact === 'object') next.contact = normalizeContact(patch.contact);
        if (pinChanged) setPin(next, String(patch.adminPin));
        if (INTERFACE_LANGUAGES.includes(patch.interfaceLanguage)) next.interfaceLanguage = patch.interfaceLanguage;
        // Lets an operator go back to the local certificate. The trusted key and cert are
        // left on disk so re-enabling does not need a fresh issuance from the CA.
        if (patch.certificateMode === 'self-signed') next.certificateMode = 'self-signed';
        if (typeof patch.preferredAddress === 'string') next.preferredAddress = patch.preferredAddress.slice(0, 64);
        if (typeof patch.recordingEnabled === 'boolean') next.recordingEnabled = patch.recordingEnabled;
        if (typeof patch.transcriptsEnabled === 'boolean') next.transcriptsEnabled = patch.transcriptsEnabled;
        if (patch.aiBudgetUsd !== undefined) next.aiBudgetUsd = normalizeBudget(patch.aiBudgetUsd);
        if (patch.aiSilencePauseMinutes !== undefined) next.aiSilencePauseMinutes = normalizeSilencePause(patch.aiSilencePauseMinutes);
        if (patch.aiEngine !== undefined) next.aiEngine = normalizeAiEngine(patch.aiEngine);
        if (patch.aiVoice !== undefined) next.aiVoice = normalizeAiVoice(patch.aiVoice);
        if (patch.aiPace !== undefined) next.aiPace = normalizeAiPace(patch.aiPace);
        if (patch.aiInstructions !== undefined) next.aiInstructions = normalizeLongText(patch.aiInstructions, MAX_AI_INSTRUCTIONS);
        if (patch.aiNotes !== undefined) next.aiNotes = normalizeLongText(patch.aiNotes, MAX_AI_NOTES);
        if (openaiApiKeyEncrypted) next.openaiApiKeyEncrypted = openaiApiKeyEncrypted;
        if (patch.clearOpenaiApiKey === true) next.openaiApiKeyEncrypted = '';
        if (!persist(response, next)) return;
        for (const key of Object.keys(settings)) delete settings[key];
        Object.assign(settings, next);

        if (languages) {
            // A channel that disappears must stop broadcasting; ids survive renames, so this
            // only fires on a genuine removal.
            const keptIds = new Set(languages.map((language) => language.id));
            for (const channelId of [...producers.keys()]) if (!keptIds.has(channelId)) closeProducerFor(channelId);
            for (const channelId of [...liveChannels.keys()]) if (!keptIds.has(channelId)) liveChannels.delete(channelId);
            transcripts.retain(keptIds);
        }
        if (patch.aiBudgetUsd !== undefined) budgetAlerted = 0;
        if (pinChanged) {
            pinIsDefault = false;
            adminThrottle.succeed(request.ip || 'unknown');
            // A PIN change is usually a response to the old PIN leaking, so every other operator
            // session opened with it ends here. The session making the change stays signed in.
            revokeSessions(adminSessions, requestToken(request));
        }
        if (typeof patch.recordingEnabled === 'boolean') syncRecordings();
        emitSettings();
        response.json(adminView());
    });

    // What the operator's dashboard shows: each channel's state and audience, recordings in
    // progress, and AI time with a rough cost.
    expressApp.get('/api/admin/live', requireAdmin, (_request, response) => {
        const now = Date.now();
        const recordingChannels = new Set([...activeRecordings.values()].map((entry) => entry.channelId));
        const time = aiTime(now);
        response.json({
            channels: settings.languages.map((language) => {
                const producer = producers.get(language.id);
                const info = broadcastInfo.get(language.id);
                const owner = producerOwners.get(language.id);
                return {
                    id: language.id, name: language.name, live: Boolean(producer), role: info?.role || null,
                    since: info?.since || null, paused: Boolean(producer?.paused),
                    listeners: countListeners(language.id), peakListeners: peakListeners.get(language.id) || 0,
                    recording: recordingChannels.has(language.id),
                    // Phones on this channel that tapped "I can't hear" in the last two minutes.
                    reports: listenerReports.count(language.id),
                    // A phone interpreter's access ends at a fixed time; the operator can extend it.
                    accessEndsAt: owner?.role === 'interpreter' ? interpreterSessions.expiresAt(owner.token) || null : null,
                    aiPaused: info?.role === 'translation' && !info.tokenMetered && !info.billedSince,
                    steady: Boolean(info?.tokenMetered),
                };
            }),
            totalListeners: listenerChannels.size,
            aiSeconds: Math.round(time.billed + time.steady),
            aiCostUsd: Math.round(aiCostUsd(now) * 1000) / 1000,
            aiPricePerMinute: AI_PRICE_PER_MINUTE,
            budgetUsd: normalizeBudget(settings.aiBudgetUsd),
            since: usage.since,
            // The server's clock, so "on air" times are right on a phone whose clock differs.
            now,
        });
    });

    // Starts the dashboard's listener peaks and AI time afresh, for an app left running between
    // events. Before, both only reset when the app restarted, so they added up across services.
    expressApp.post('/api/admin/live/reset', requireAdmin, (_request, response) => {
        Object.assign(usage, { aiSeconds: 0, steadySeconds: 0, tokenUsd: 0, since: Date.now() });
        budgetAlerted = 0;
        listenerReports.clear();
        peakListeners.clear();
        for (const language of settings.languages) {
            const count = countListeners(language.id);
            if (count) peakListeners.set(language.id, count);
        }
        response.json({ ok: true, since: usage.since });
    });

    // Gives the phone interpreter on a channel more time, so the eight-hour limit does not cut
    // them off mid-sentence. Never beyond a full session from now.
    expressApp.post('/api/admin/interpreter-sessions/extend', requireAdmin, (request, response) => {
        const channelId = String(request.body?.channelId || '').slice(0, 80);
        const owner = producerOwners.get(channelId);
        const current = owner?.role === 'interpreter' ? interpreterSessions.expiresAt(owner.token) : 0;
        if (!current) return response.status(404).json({ error: 'No phone interpreter is broadcasting on that channel.' });
        const expiresAt = Math.min(current + INTERPRETER_EXTEND_MS, Date.now() + INTERPRETER_SESSION_MS);
        interpreterSessions.touch(owner.token, expiresAt);
        io.to(owner.socketId).emit('sessionExtended', { expiresAt });
        response.json({ ok: true, expiresAt });
    });

    // The pre-service check: everything that can be tested from this computer, in one list.
    // Whether phones can reach it is tested with a phone (the test tone in Admin).
    expressApp.get('/api/admin/preflight', requireAdmin, async (_request, response) => {
        const checks = [];
        const add = (id, status, detail = '') => checks.push({ id, status, detail: String(detail || '') });
        // Anyone in the room could guess 1234, and a recovered settings file may have lost the
        // OpenAI key or other choices, so both come first.
        add('admin_pin', pinIsDefault ? 'fail' : 'ok');
        if (settingsRecovery) add('settings_file', settingsRecovery === 'backup' ? 'warn' : 'fail', settingsRecovery);
        add('media', !media.router ? 'fail' : media.portMode === 'multiplexed' ? 'ok' : 'warn', media.router ? media.portMode : media.error);
        add('listener_port', listenerPortError ? 'warn' : 'ok', listenerPortError || String(LISTENER_PORT));
        const adapter = networkAddresses().find((entry) => entry.address === localAddress);
        add('network', addressDrift || !adapter ? 'fail' : isVirtualAdapter(adapter.name) ? 'warn' : 'ok',
            addressDrift || (adapter ? `${adapter.name} · ${localAddress}` : localAddress));
        const daysLeft = certificateState.expiresAt ? Math.floor((Date.parse(certificateState.expiresAt) - Date.now()) / 86_400_000) : null;
        add('certificate', certificateState.error || (daysLeft !== null && daysLeft < 14) ? 'warn' : 'ok',
            certificateState.error || `${certificateState.type}${daysLeft !== null ? ` · ${daysLeft}` : ''}`);
        const microphone = ['win32', 'darwin'].includes(process.platform) ? systemPreferences.getMediaAccessStatus('microphone') : 'unknown';
        // 'not-determined' is not a refusal: the system asks the first time a broadcast starts.
        add('microphone', ['granted', 'unknown'].includes(microphone) ? 'ok' : microphone === 'not-determined' ? 'warn' : 'fail', microphone);
        add('secure_storage', secureStorageAvailable && safeStorage.isEncryptionAvailable() ? 'ok' : 'warn');
        if (settings.recordingEnabled) {
            try {
                const disk = fs.statfsSync(recordingStore.ensure());
                const free = disk.bavail * disk.bsize;
                add('disk', free < 200 * 1024 ** 2 ? 'fail' : free < 2 * 1024 ** 3 ? 'warn' : 'ok', String(free));
            } catch (error) { add('disk', 'warn', error.message); }
        }
        // Creating a client secret checks the key without opening a session, so it costs nothing.
        const apiKey = revealSecret(settings.openaiApiKeyEncrypted);
        if (!apiKey) add('openai', 'warn', 'not_configured');
        else {
            try {
                const upstream = await fetchWithTimeout('https://api.openai.com/v1/realtime/translations/client_secrets', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session: { model: 'gpt-realtime-translate', audio: { output: { language: 'en' } } } }),
                }, 10_000);
                add('openai', upstream.ok ? 'ok' : 'fail', upstream.ok ? '' : `HTTP ${upstream.status}`);
            } catch (error) { add('openai', 'fail', error.message); }
        }
        response.json({ checks, at: Date.now() });
    });

    expressApp.get('/api/admin/recordings', requireAdmin, (_request, response) => {
        const active = new Set([...activeRecordings.values()].map((entry) => entry.name));
        response.json({
            folder: recordingStore.directory,
            items: recordingStore.list(settings.languages).map((item) => ({ ...item, active: active.has(item.name) })),
        });
    });

    // A recording still in progress can be downloaded too: the file is valid up to the last
    // second written.
    expressApp.get('/api/admin/recordings/file/:name', requireAdmin, (request, response) => {
        const filePath = recordingStore.resolve(request.params.name);
        if (!filePath) return response.status(404).json({ error: 'That recording no longer exists.' });
        response.download(filePath, request.params.name);
    });

    expressApp.delete('/api/admin/recordings/file/:name', requireAdmin, (request, response) => {
        const name = String(request.params.name || '');
        if ([...activeRecordings.values()].some((entry) => entry.name === name)) {
            return response.status(409).json({ error: 'This recording is still running. Stop the broadcast or turn recording off first.' });
        }
        if (!recordingStore.remove(name)) return response.status(404).json({ error: 'That recording no longer exists.' });
        response.json({ ok: true });
    });

    // Opens the folder on this computer, for copying everything at once after the event.
    expressApp.post('/api/admin/recordings/open-folder', requireAdmin, async (_request, response) => {
        try {
            const error = await shell.openPath(recordingStore.ensure());
            if (error) throw new Error(error);
            response.json({ ok: true });
        } catch (error) { response.status(500).json({ error: `Could not open the folder: ${error.message}` }); }
    });

    // A short-lived key for one OpenAI connection, made here so the API key never leaves this
    // computer. The broadcasting screen says which engine it is running, so a change in Admin
    // mid-service does not switch a reconnecting channel to the other one.
    expressApp.post('/api/realtime/session', requireAdmin, async (request, response) => {
        const apiKey = revealSecret(settings.openaiApiKeyEncrypted);
        if (!apiKey) return response.status(409).json({ error: 'Add an OpenAI API key in Admin settings first.' });
        const engine = normalizeAiEngine(request.body?.engine);
        const sourceCode = String(request.body?.sourceLanguage || '').slice(0, 16);
        const targetCode = String(request.body?.targetLanguage || 'en').slice(0, 16);
        const session = engine === 'steady'
            ? steadySession({
                sourceCode, targetCode, voice: settings.aiVoice, pace: settings.aiPace,
                instructions: settings.aiInstructions, notes: settings.aiNotes,
            })
            : { model: 'gpt-realtime-translate', audio: { output: { language: targetCode } } };
        try {
            const upstream = await fetchWithTimeout(`https://api.openai.com/v1/realtime/${engine === 'steady' ? '' : 'translations/'}client_secrets`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
                    'OpenAI-Safety-Identifier': crypto.createHash('sha256').update(requestToken(request)).digest('hex'),
                },
                body: JSON.stringify({ session }),
            });
            const body = await upstream.json().catch(() => ({}));
            response.status(upstream.status).json({ ...body, engine });
        } catch (error) { response.status(502).json({ error: `OpenAI connection failed: ${error.message}` }); }
    });

    // The text of a slide deck, Word document or text file, for the Steady voice notes. It is
    // only returned to the screen, where the operator reads and edits it before saving.
    expressApp.post('/api/admin/ai-notes/extract', requireAdmin, express.raw({ type: '*/*', limit: '200mb' }), (request, response) => {
        const filename = String(request.query.name || '').slice(0, 200);
        if (!Buffer.isBuffer(request.body) || !request.body.length) return response.status(400).json({ error: 'The file is empty.' });
        try {
            const text = normalizeLongText(documentText(request.body, filename), MAX_AI_NOTES * 2);
            if (!text) return response.status(422).json({ error: 'No text was found in this file.' });
            response.json({ text });
        } catch (error) {
            if (error instanceof DocumentError) return response.status(422).json({ error: error.message });
            console.error('Could not read the notes file:', error);
            response.status(422).json({ error: 'This file could not be read.' });
        }
    });

    // Admin used to say "Restart the app to apply it" and leave the operator to find and close
    // the window. This relaunches the desktop app instead. Every broadcast stops for the few
    // seconds it takes to start again, so the Admin screen asks before calling it.
    expressApp.post('/api/admin/restart', requireAdmin, (_request, response) => {
        response.json({ ok: true });
        setTimeout(() => { app.relaunch(); app.quit(); }, 300);
    });

    // Any letter case: routing is case-sensitive, and /API/... must not fall through to the page.
    expressApp.use((request, response, next) => (/^\/api(\/|$)/i.test(request.path) ? response.status(404).json({ error: 'Not found.' }) : next()));

    if (!isDev) {
        expressApp.use(express.static(path.join(__dirname, 'dist')));
        expressApp.use((_request, response) => response.sendFile(path.join(__dirname, 'dist', 'index.html')));
    }

    // Last resort, so an unexpected throw in a handler returns JSON the client can show
    // instead of an Express HTML stack trace.
    expressApp.use((error, request, response, _next) => {
        if (error?.type === 'entity.too.large') return response.status(413).json({ error: 'This file is too large.' });
        console.error(`Unhandled error on ${request.method} ${request.path}:`, error);
        if (response.headersSent) return;
        response.status(500).json({ error: 'The server hit an unexpected error.' });
    });

    const listen = (server, port, host) => new Promise((resolve, reject) => {
        const onError = (error) => {
            server.removeListener('listening', onListening);
            reject(error.code === 'EADDRINUSE'
                ? new Error(`Port ${port} is already in use. Close the other copy of Lingua Franca (or whatever is using the port) and start again.`)
                : error);
        };
        const onListening = () => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
    await listen(httpServer, LOCAL_PORT, '127.0.0.1');
    await listen(httpsServer, HTTPS_PORT, '0.0.0.0');
    // The plain listener port is a convenience, not a requirement: if something else holds
    // it, start anyway and let Admin fall back to the HTTPS link and say why.
    try { await listen(listenerServer, LISTENER_PORT, '0.0.0.0'); }
    catch (error) {
        listenerPortError = error.message;
        console.warn(`Plain listener port unavailable: ${error.message}`);
    }
    // Keep serving after startup even if a socket errors later.
    httpServer.on('error', (error) => console.error('Local HTTP server error:', error.message));
    httpsServer.on('error', (error) => console.error('HTTPS server error:', error.message));
    listenerServer.on('error', (error) => console.error('Listener HTTP server error:', error.message));

    // Interpreter sessions last eight hours; a broadcast must not outlive its session.
    sessionSweepTimer = setInterval(() => {
        // A Human-mode broadcast sends nothing that would refresh its operator session, so the
        // session that owns a live channel is kept alive here instead of lapsing under it.
        for (const owner of producerOwners.values()) if (owner.role === 'admin') keepAdminSession(owner.token);
        endInterpreterBroadcasts();
        listenerReports.prune();
        // Warn the operator once at 80% of the AI budget and once when it is spent. Nothing is
        // stopped: cutting the translation mid-sermon would be worse than going over.
        const budgetUsd = normalizeBudget(settings.aiBudgetUsd);
        const spentUsd = aiCostUsd();
        const level = budgetLevel(spentUsd, budgetUsd);
        if (level > budgetAlerted) emitToOperators('aiBudget', { level, spentUsd, budgetUsd });
        budgetAlerted = level;
    }, SESSION_SWEEP_MS);
    sessionSweepTimer.unref?.();

    // A stored certificate is reused at startup without contacting DuckDNS, and the periodic
    // check below only reacts to a change while running. If DHCP gave this computer a new
    // address before launch, DuckDNS kept pointing at the old one, so tell it now.
    if (settings.certificateMode === 'duckdns' && settings.duckDnsTokenEncrypted) {
        void updateDuckDns(normalizeDuckDnsDomain(settings.certificateHostname), revealSecret(settings.duckDnsTokenEncrypted), { ip: localAddress })
            .catch((error) => console.warn('DuckDNS address refresh at startup failed:', error.message));
    }

    maintenanceTimer = setInterval(() => {
        adminSessions.prune(); interpreterSessions.prune(); interpreterCodes.prune();
        adminThrottle.prune(); interpreterThrottle.prune();
        if (settings.certificateMode !== 'duckdns') return;
        const stored = readTrustedCertificate();
        const host = `${normalizeDuckDnsDomain(settings.certificateHostname)}.duckdns.org`;
        if (stored && !stored.details.expiresSoon && certificateCoversHost(stored.details, host)) return;
        void ensureServerCertificate(settings, localAddress, { forceRenewal: true })
            .then((context) => httpsServer.setSecureContext(context))
            .catch((error) => console.error('Scheduled certificate renewal failed:', error.message));
    }, MAINTENANCE_INTERVAL_MS);
    maintenanceTimer.unref?.();

    // Re-point DuckDNS if DHCP moves this machine mid-service, otherwise phones that scan the
    // hostname QR resolve to an address nobody is listening on.
    //
    // This cannot fully repair itself: the shared ICE port announces the address it was
    // created with, so media for *new* listeners still advertises the old one. Rebuilding the
    // WebRtcServer would drop every listener already connected, which is worse mid-event, so
    // the operator is told to restart at a moment of their choosing instead.
    dynamicDnsTimer = setInterval(() => {
        const current = selectLocalAddress(networkAddresses(), process.env.LINGUA_FRANCA_HOST_IP || settings.preferredAddress);
        if (current === localAddress) return;
        console.warn(`LAN address changed from ${localAddress} to ${current}. Restart to restore media for new listeners.`);
        addressDrift = `The network address changed from ${localAddress} to ${current}. Restart Lingua Franca so new listeners can connect.`;
        localAddress = current;
        if (settings.certificateMode !== 'duckdns') return;
        void updateDuckDns(normalizeDuckDnsDomain(settings.certificateHostname), revealSecret(settings.duckDnsTokenEncrypted), { ip: current })
            .catch((error) => console.warn('DuckDNS address update failed:', error.message));
    }, DYNAMIC_DNS_INTERVAL_MS);
    dynamicDnsTimer.unref?.();

    console.log(listenerPortError
        ? `Lingua Franca listener: https://${certificateState.hostname || localAddress}:${HTTPS_PORT}/listener`
        : `Lingua Franca listener: http://${localAddress}:${LISTENER_PORT}/listener`);
}

/* ------------------------------------------------------------- bootstrap */

if (!app.requestSingleInstanceLock()) {
    // A second launch would collide on port 4173 and leave the operator with two windows,
    // one of them dead. Focus the running copy instead.
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });

    app.whenReady().then(async () => {
        const isDev = process.env.NODE_ENV === 'development';
        registerDesktopActions(isDev);
        // The window comes up first and shows a splash, so a failure below is visible rather
        // than leaving the operator staring at a dock icon that never opens a window.
        createWindow(isDev);
        await mainWindow.loadFile(path.join(__dirname, 'desktop', 'startup.html'));
        mainWindow.show();
        try {
            await startServers(isDev);
            await mainWindow.loadURL(appUrl(isDev));
        } catch (error) {
            showStartupFailure(error);
        }
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow(isDev);
                void mainWindow.loadURL(appUrl(isDev));
            }
        });
    }).catch(showStartupFailure);
}

app.on('before-quit', () => {
    try { stopAllRecordings(); } catch (error) { console.error('Could not finish recordings:', error.message); }
    clearInterval(maintenanceTimer);
    clearInterval(sessionSweepTimer);
    clearInterval(dynamicDnsTimer);
    try { media.worker?.close(); } catch { /* already closed */ }
    try { httpsServer?.close(); } catch { /* already closed */ }
    try { httpServer?.close(); } catch { /* already closed */ }
    try { listenerServer?.close(); } catch { /* already closed */ }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
// A stray exception in a socket or timer callback would otherwise end the whole app mid-service,
// taking every channel off air. Logging it and carrying on is the lesser harm for a live event.
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));
