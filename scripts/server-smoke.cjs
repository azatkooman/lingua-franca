/**
 * End-to-end check of the HTTP surface in main.cjs.
 *
 * Electron is stubbed, so this runs headless with no window and no packaged build. It binds
 * the real ports (4173/4174) and generates an RSA key, so it is kept out of `npm test` and
 * run on demand:
 *
 *   npm run test:server
 *
 * The mediasoup worker is not required; the SFU simply reports itself unavailable, which is
 * itself worth asserting -- the API must stay up when the media engine cannot start. Point
 * LINGUA_FRANCA_WORKER_BIN at the worker binary to also run the media checks (CI does).
 */

const Module = require('module');
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const dgram = require('dgram');
const mediasoup = require('mediasoup');
const { io } = require('socket.io-client');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lingua-franca-smoke-'));
// A settings file from an older build that still has the retired text-fallback settings.
const settingsFile = path.join(userData, 'lingua-franca-settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({
    aiProvider: 'gemini', glossary: 'Pastor Ivanov', geminiApiKey: 'plain-gemini-key',
}));
let markReady;
const ready = new Promise((resolve) => { markReady = resolve; });

// main.cjs resolves the same mediasoup module, so its workers show up here and a test can
// kill one to exercise the restart path.
const workers = [];
const routers = [];
mediasoup.observer.on('newworker', (worker) => {
    workers.push(worker);
    worker.observer.on('newrouter', (router) => routers.push(router));
});

class FakeWindow {
    constructor() {
        this.webContents = {
            session: { setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDisplayMediaRequestHandler() {} },
            setWindowOpenHandler() {}, on() {},
        };
    }
    static getAllWindows() { return []; }
    once() {} on() {} show() {} focus() {} restore() {}
    isMinimized() { return false; }
    isDestroyed() { return false; }
    loadFile() { return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
}

const electronStub = {
    app: {
        getPath: () => userData,
        requestSingleInstanceLock: () => true,
        whenReady: () => ready,
        on() {}, quit() {}, exit() {},
    },
    BrowserWindow: FakeWindow,
    desktopCapturer: { getSources: async () => [] },
    dialog: { showErrorBox: (title, detail) => console.error(`[dialog] ${title}: ${detail}`) },
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(`enc:${value}`),
        decryptString: (buffer) => buffer.toString().replace(/^enc:/, ''),
    },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
    shell: { openPath: async () => '', showItemInFolder() {} },
    ipcMain: { handle() {} },
};

const stubPath = path.join(__dirname, '__electron_stub__');
require.cache[stubPath] = new Module(stubPath, null);
require.cache[stubPath].filename = stubPath;
require.cache[stubPath].loaded = true;
require.cache[stubPath].exports = electronStub;

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'electron') return stubPath;
    return resolveFilename.call(this, request, ...rest);
};

// Silence the expected "no mediasoup worker" restart noise and the deliberate worker kill;
// the SFU state is asserted below.
const realError = console.error;
console.error = (...args) => {
    const text = String(args[0] ?? '');
    if (text.includes('SFU initialization failed') || text.includes('mediasoup worker died')) return;
    realError(...args);
};

// The checks sign in with the default PIN and change settings (PIN, channel names, event,
// contact). If a real copy of Lingua Franca holds the ports, this server cannot start and every
// check would land on that app instead and change its settings. Refuse to run at all then.
const portFree = (port, host) => new Promise((resolve) => {
    const probe = require('net').createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
});
const started = (async () => {
    for (const [port, host] of [[4174, '127.0.0.1'], [4173, '0.0.0.0'], [4175, '0.0.0.0']]) {
        if (await portFree(port, host)) continue;
        console.error(`Port ${port} is already in use, probably by a running copy of Lingua Franca. Close it and run the smoke test again: it changes settings and must never run against a real app.`);
        process.exit(1);
    }
    require(path.join(__dirname, '..', 'main.cjs'));
    markReady();
})();

const BASE = 'http://127.0.0.1:4174';
// The plain-HTTP, listening-only port that phones use without a certificate warning.
const LISTENER_BASE = 'http://127.0.0.1:4175';
const results = [];
const sockets = [];
let failures = 0;

const check = async (name, fn) => {
    try {
        const detail = await fn();
        results.push(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
        failures += 1;
        results.push(`  FAIL  ${name} — ${error.message}`);
    }
};

const rawGet = (hostHeader, requestPath = '/api/settings') => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: 4174, path: requestPath, headers: { Host: hostHeader } },
        (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end();
});

const json = async (requestPath, init) => {
    const response = await fetch(`${BASE}${requestPath}`, init);
    return { status: response.status, contentType: response.headers.get('content-type') || '', body: await response.json().catch(() => ({})) };
};
const authed = (token, extra = {}) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra });
const login = async (pin = '1234') => (await json('/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
})).body.token;

/* ------------------------------------------------------------- signalling */

const connect = (token = '', base = BASE) => new Promise((resolve, reject) => {
    const socket = io(base, { transports: ['websocket'], auth: { token }, reconnection: false });
    sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
});
const ask = (socket, event, payload) => new Promise((resolve) => {
    socket.timeout(5000).emit(event, payload, (error, response) => resolve(error ? { error: error.message } : (response ?? {})));
});
const waitFor = (socket, event, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no '${event}' within ${timeoutMs} ms`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
});
// Enough for the router to accept a producer without a real browser on the other end.
const opusRtp = (ssrc) => ({
    codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }],
    headerExtensions: [], encodings: [{ ssrc }], rtcp: { cname: `smoke-${ssrc}`, reducedSize: true },
});
const FAKE_DTLS = {
    role: 'client',
    fingerprints: [{ algorithm: 'sha-256', value: '82:5A:68:3D:36:C3:0A:DE:AF:E7:32:43:D2:88:83:57:AC:2D:65:E5:80:C4:B6:FB:AF:1A:A0:21:9F:6D:0C:AD' }],
};
const produce = async (socket, channelId, ssrc) => {
    const transport = await ask(socket, 'createWebRtcTransport', { type: 'producer' });
    if (transport.error) return transport;
    return ask(socket, 'produce', { transportId: transport.id, kind: 'audio', rtpParameters: opusRtp(ssrc), appData: { channelId, mode: 'human' } });
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rtpPacket = (sequence, timestamp, ssrc, payload) => {
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = 111;
    header.writeUInt16BE(sequence & 0xffff, 2);
    header.writeUInt32BE(timestamp >>> 0, 4);
    header.writeUInt32BE(ssrc, 8);
    return Buffer.concat([header, payload]);
};
const channelMode = async (channelId) =>
    (await json('/api/settings')).body.languages.find((language) => language.id === channelId)?.activePeerId;

async function run() {
    await check('listener settings carry channels but no operator data', async () => {
        const { status, body } = await json('/api/settings');
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.languages) && body.languages.length);
        assert.equal('glossary' in body, false, 'the glossary must not reach listeners');
        assert.equal('preferredAddress' in body, false);
        return `${body.languages.length} channels`;
    });

    await check('public health omits file paths and adapter inventory', async () => {
        const { body } = await json('/api/health');
        assert.equal('certificatePath' in body, false);
        assert.equal('addresses' in body, false);
        return `keys=[${Object.keys(body).join(',')}]`;
    });

    // Passes either way on purpose: with LINGUA_FRANCA_WORKER_BIN set this confirms the SFU
    // really starts, and without it that the API stays up when the media engine cannot.
    let sfuReady = false;
    await check('the API serves health whatever state the media engine is in', async () => {
        const { status, body } = await json('/api/health');
        assert.equal(status, 200);
        assert.ok(['ready', 'unavailable'].includes(body.sfu), `unexpected sfu state: ${body.sfu}`);
        assert.equal(body.ok, body.sfu === 'ready');
        sfuReady = body.sfu === 'ready';
        return `sfu=${body.sfu}`;
    });

    await check('operator health requires a session', async () => {
        assert.equal((await json('/api/admin/health')).status, 401);
        return '401';
    });

    await check('diagnostics require a broadcaster session', async () => {
        assert.equal((await json('/api/diagnostics')).status, 401);
        return '401';
    });

    await check('a foreign Host header is refused (DNS rebinding)', async () => {
        assert.equal(await rawGet('evil.example.com'), 403);
        return '403';
    });

    await check('the machine’s own LAN address is accepted', async () => {
        const lan = Object.values(os.networkInterfaces()).flat()
            .find((entry) => entry && entry.family === 'IPv4' && !entry.internal);
        if (!lan) return 'skipped (no LAN adapter)';
        assert.equal(await rawGet(`${lan.address}:4173`), 200);
        return `200 for ${lan.address}`;
    });

    await check('localhost is accepted', async () => {
        assert.equal(await rawGet('localhost:4174'), 200);
        return '200';
    });

    await check('a malformed body returns JSON rather than an HTML error page', async () => {
        const { status, contentType } = await json('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops',
        });
        assert.equal(status, 400);
        assert.match(contentType, /json/);
        return '400 JSON';
    });

    let token;
    await check('the default PIN issues an operator token', async () => {
        const { status, body } = await json('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '1234' }),
        });
        assert.equal(status, 200);
        assert.ok(body.token);
        token = body.token;
        return 'token issued';
    });

    await check('operator settings expose configuration but never secrets', async () => {
        const { body } = await json('/api/admin/settings', { headers: authed(token) });
        assert.ok('openaiConfigured' in body);
        assert.equal('adminPinHash' in body, false);
        assert.equal('openaiApiKeyEncrypted' in body, false);
        assert.equal('duckDnsTokenEncrypted' in body, false);
        return 'secrets absent';
    });

    await check('the plain listener port serves the channel list and health', async () => {
        const settings = await fetch(`${LISTENER_BASE}/api/settings`);
        assert.equal(settings.status, 200);
        assert.ok(Array.isArray((await settings.json()).languages));
        const health = await (await fetch(`${BASE}/api/health`)).json();
        assert.equal(health.ports.listener, 4175, 'public health advertises the listener port');
        assert.equal((await fetch(`${LISTENER_BASE}/api/health`)).status, 200);
        return 'settings 200, health 200';
    });

    await check('the plain listener port refuses sign-in, codes and every operator call', async () => {
        const refused = [
            ['POST', '/api/admin/login', { pin: '1234' }],
            ['POST', '/api/interpreter/login', { code: '123456' }],
            ['GET', '/api/admin/settings'],
            ['GET', '/api/admin/health'],
            ['GET', '/api/diagnostics'],
            ['POST', '/api/admin/restart'],
            ['POST', '/api/realtime/session', {}],
            ['POST', '/api/settings', {}],
        ];
        for (const [method, route, body] of refused) {
            const response = await fetch(`${LISTENER_BASE}${route}`, {
                method, headers: authed(token), body: body ? JSON.stringify(body) : undefined,
            });
            assert.equal(response.status, 403, `${method} ${route} returned ${response.status}`);
        }
        return `${refused.length} routes refused with a valid operator token`;
    });

    await check('the plain listener port sends sign-in pages to HTTPS before anything is typed', async () => {
        for (const page of ['/admin', '/interpreter?code=123456']) {
            const response = await fetch(`${LISTENER_BASE}${page}`, { redirect: 'manual' });
            assert.equal(response.status, 302, `${page} returned ${response.status}`);
            assert.equal(response.headers.get('location'), `https://127.0.0.1:4173${page}`);
        }
        return '302 to https://…:4173';
    });

    await check('a socket on the plain listener port can listen but never broadcast, even with a token', async () => {
        const socket = await connect(token, LISTENER_BASE);
        const producer = await ask(socket, 'createWebRtcTransport', { type: 'producer' });
        if (!sfuReady) {
            assert.ok(producer.error, 'expected a refusal');
            return 'skipped media half (no media worker)';
        }
        assert.match(producer.error || '', /Broadcaster login required/);
        const consumer = await ask(socket, 'createWebRtcTransport', { type: 'consumer' });
        assert.ok(consumer.id, consumer.error || 'no consumer transport');
        return 'producer refused, consumer allowed';
    });

    await check('the event, contact and Kazakh phone language reach listeners', async () => {
        const { status } = await json('/api/admin/settings', {
            method: 'PATCH', headers: authed(token), body: JSON.stringify({
                interfaceLanguage: 'kk',
                event: { name: 'Smoke Congress', startDate: '2026-10-06', endDate: '2026-10-05' },
                contact: { name: 'Help desk', phone: '+7 701 000 00 00', email: 'help@example.com', telegram: 'https://t.me/help_desk' },
            }),
        });
        assert.equal(status, 200);
        const listener = await (await fetch(`${LISTENER_BASE}/api/settings`)).json();
        assert.equal(listener.interfaceLanguage, 'kk');
        assert.deepEqual(listener.event, { name: 'Smoke Congress', startDate: '2026-10-05', endDate: '2026-10-06' });
        assert.equal(listener.contact.telegram, 'help_desk');
        assert.equal(listener.contact.phone, '+7 701 000 00 00');
        return 'event, contact and kk on the plain listener link';
    });

    await check('captions are relayed live and kept for phones that join late', async () => {
        const { body: settings } = await json('/api/settings');
        const english = settings.languages[0].id;
        const operator = await connect(token);
        const early = await connect('', LISTENER_BASE);
        const relayed = waitFor(early, 'translationText', 5000);
        assert.equal((await ask(operator, 'sendTranslationText', { channelId: english, segmentId: 'smoke-1', text: 'Good', originalText: 'Доброе' })).ok, true);
        assert.equal((await relayed).text, 'Good');
        await ask(operator, 'sendTranslationText', { channelId: english, segmentId: 'smoke-1', text: 'Good morning', originalText: 'Доброе утро', final: true });
        await ask(operator, 'sendTranslationText', { channelId: english, segmentId: 'smoke-2', text: 'Welcome', originalText: 'Добро пожаловать' });
        const late = await connect('', LISTENER_BASE);
        const { segments } = await ask(late, 'getTranscript', { channelId: english });
        assert.deepEqual(segments.map((segment) => [segment.id, segment.text, segment.final]),
            [['smoke-1', 'Good morning', true], ['smoke-2', 'Welcome', false]]);
        return `${segments.length} segments for a late joiner`;
    });

    await check('only an operator can send captions, and never from the plain listener port', async () => {
        const { body: settings } = await json('/api/settings');
        const english = settings.languages[0].id;
        const anonymous = await connect('', LISTENER_BASE);
        assert.match((await ask(anonymous, 'sendTranslationText', { channelId: english, segmentId: 'x', text: 'spoof' })).error || '', /Administrator/);
        const tokenOnPlainPort = await connect(token, LISTENER_BASE);
        assert.match((await ask(tokenOnPlainPort, 'sendTranslationText', { channelId: english, segmentId: 'x', text: 'spoof' })).error || '', /Administrator/);
        const operator = await connect(token);
        assert.match((await ask(operator, 'sendTranslationText', { channelId: 'no-such-channel', segmentId: 'x', text: 'lost' })).error || '', /Unknown channel/);
        return 'refused, refused, unknown channel';
    });

    await check('the dashboard and recordings require an operator session', async () => {
        for (const route of ['/api/admin/live', '/api/admin/recordings', '/api/admin/recordings/file/x.txt']) {
            assert.equal((await json(route)).status, 401, route);
        }
        assert.equal((await json('/api/admin/recordings/open-folder', { method: 'POST' })).status, 401);
        const plain = await fetch(`${LISTENER_BASE}/api/admin/live`, { headers: authed(token) });
        assert.equal(plain.status, 403, 'never on the plain listener port');
        return '401 x4, 403 on the plain port';
    });

    await check('finished caption sentences are saved as a transcript to download', async () => {
        const { body } = await json('/api/admin/recordings', { headers: authed(token) });
        const transcript = body.items.find((item) => item.type === 'transcript');
        assert.ok(transcript, 'transcript listed');
        assert.equal(transcript.lines, 1, 'only the finished sentence');
        const response = await fetch(`${BASE}/api/admin/recordings/file/${transcript.name}`, { headers: authed(token) });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-disposition') || '', /attachment/);
        assert.match(await response.text(), /\] Good morning\n {11}Доброе утро\n/);
        return transcript.name;
    });

    await check('recording files cannot be read or deleted outside the recordings folder', async () => {
        for (const name of ['..%2Flingua-franca-settings.json', '..%5Clingua-franca-settings.json', 'lingua-franca-settings.json']) {
            assert.equal((await json(`/api/admin/recordings/file/${name}`, { headers: authed(token) })).status, 404, name);
            assert.equal((await json(`/api/admin/recordings/file/${name}`, { method: 'DELETE', headers: authed(token) })).status, 404, name);
        }
        assert.ok(fs.existsSync(settingsFile), 'the settings file is untouched');
        return 'refused';
    });

    await check('renaming a channel preserves its id, so a live broadcast survives', async () => {
        const { body: before } = await json('/api/admin/settings', { headers: authed(token) });
        const target = before.languages[0];
        const { body: after } = await json('/api/admin/settings', {
            method: 'PATCH', headers: authed(token),
            body: JSON.stringify({ languages: before.languages.map((language) => language.id === target.id ? { ...language, name: 'Renamed Channel' } : language) }),
        });
        const renamed = after.languages.find((language) => language.id === target.id);
        assert.ok(renamed, 'the id survived the rename');
        assert.equal(renamed.name, 'Renamed Channel');
        return `${target.id} kept`;
    });

    await check('the last channel cannot be deleted', async () => {
        const { status } = await json('/api/admin/settings', {
            method: 'PATCH', headers: authed(token), body: JSON.stringify({ languages: [] }),
        });
        assert.equal(status, 400);
        return '400';
    });

    await check('a PIN shorter than four digits is refused', async () => {
        const { status } = await json('/api/admin/settings', {
            method: 'PATCH', headers: authed(token), body: JSON.stringify({ adminPin: '12' }),
        });
        assert.equal(status, 400);
        return '400';
    });

    let interpreterToken;
    let channelId;
    await check('an interpreter link works once and only once', async () => {
        const { body: settings } = await json('/api/admin/settings', { headers: authed(token) });
        channelId = settings.languages[0].id;
        const { body: link } = await json('/api/admin/interpreter-link', {
            method: 'POST', headers: authed(token), body: JSON.stringify({ channelId }),
        });
        assert.match(link.code, /^\d{6}$/);
        const first = await json('/api/interpreter/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: link.code }),
        });
        assert.equal(first.status, 200);
        interpreterToken = first.body.token;
        const replay = await json('/api/interpreter/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: link.code }),
        });
        assert.equal(replay.status, 401, 'a used code must not be exchangeable again');
        return 'first 200, replay 401';
    });

    await check('interpreter codes cannot be brute forced', async () => {
        let lockedOut = false;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const { status } = await json('/api/interpreter/login', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: String(100000 + attempt) }),
            });
            if (status === 429) { lockedOut = true; break; }
        }
        assert.ok(lockedOut, 'expected a 429 lockout');
        return 'locked out';
    });

    await check('phones are told which live channel carries the original speech', async () => {
        if (!sfuReady) return 'skipped (no media worker)';
        const { body: settings } = await json('/api/settings');
        const channel = settings.languages[1].id;
        const operator = await connect(token);
        const transport = await ask(operator, 'createWebRtcTransport', { type: 'producer' });
        const produced = await ask(operator, 'produce', {
            transportId: transport.id, kind: 'audio', rtpParameters: opusRtp(9999), appData: { channelId: channel, mode: 'ai', role: 'original' },
        });
        assert.ok(produced.id, produced.error);
        const live = (await json('/api/settings')).body.languages.find((language) => language.id === channel);
        assert.deepEqual([live.activePeerId, live.liveRole], ['ai-active', 'original']);
        await ask(operator, 'closeProducer', { channelId: channel });
        const after = (await json('/api/settings')).body.languages.find((language) => language.id === channel);
        assert.equal(after.liveRole, undefined, 'cleared when the broadcast ends');
        return 'liveRole original, then cleared';
    });

    await check('a phone switching channels lowers the old channel listener count at once', async () => {
        if (!sfuReady) return 'skipped (no media worker)';
        const { body: settings } = await json('/api/settings');
        const [first, second] = settings.languages.map((language) => language.id);
        const operator = await connect(token);
        assert.ok((await produce(operator, first, 1212)).id);
        assert.ok((await produce(operator, second, 1313)).id);
        const phone = await connect('', LISTENER_BASE);
        const capabilities = await new Promise((resolve) => phone.emit('getRouterRtpCapabilities', resolve));
        const consume = async (channelId) => {
            const transport = await ask(phone, 'createWebRtcTransport', { type: 'consumer' });
            return ask(phone, 'consume', { transportId: transport.id, rtpCapabilities: capabilities, channelId });
        };
        // The latest count per channel: counts reach the broadcaster in no fixed order relative
        // to the phone's own replies.
        const latest = new Map();
        operator.on('listenerCount', ({ channelId, count }) => latest.set(channelId, count));
        // Other checks' listeners come and go in the background, so check what matters: after the
        // switch both channels are told, and what they are told matches the server's count.
        const listeners = async () => Object.fromEntries((await json('/api/admin/live', { headers: authed(token) })).body.channels.map((entry) => [entry.id, entry.listeners]));
        try {
            assert.ok((await consume(first)).id);
            await sleep(300);
            latest.clear();
            assert.ok((await consume(second)).id);
            await sleep(300);
            const now = await listeners();
            assert.ok(latest.has(first), 'the old channel was told');
            assert.equal(latest.get(first), now[first]);
            assert.equal(latest.get(second), now[second]);
        } finally {
            phone.close();
            await ask(operator, 'closeProducer', { channelId: first });
            await ask(operator, 'closeProducer', { channelId: second });
        }
        return 'both channels told their current count';
    });

    await check('the dashboard shows each live channel with its listeners and peak', async () => {
        if (!sfuReady) return 'skipped (no media worker)';
        const { body: settings } = await json('/api/settings');
        const channel = settings.languages[1].id;
        const operator = await connect(token);
        assert.ok((await produce(operator, channel, 5555)).id);
        const listener = await connect('', LISTENER_BASE);
        const capabilities = await new Promise((resolve) => listener.emit('getRouterRtpCapabilities', resolve));
        const transport = await ask(listener, 'createWebRtcTransport', { type: 'consumer' });
        const consumed = await ask(listener, 'consume', { transportId: transport.id, rtpCapabilities: capabilities, channelId: channel });
        assert.ok(consumed.id, consumed.error);
        const { body } = await json('/api/admin/live', { headers: authed(token) });
        const row = body.channels.find((entry) => entry.id === channel);
        assert.deepEqual([row.live, row.role, row.listeners, row.peakListeners], [true, 'interpreter', 1, 1]);
        assert.ok(row.since <= Date.now());
        assert.equal(typeof body.aiPricePerMinute, 'number');
        listener.close();
        await sleep(300);
        await ask(operator, 'closeProducer', { channelId: channel });
        const after = (await json('/api/admin/live', { headers: authed(token) })).body.channels.find((entry) => entry.id === channel);
        assert.deepEqual([after.live, after.listeners, after.peakListeners], [false, 0, 1], 'the peak is kept');
        return '1 listener, peak kept';
    });

    await check('with recording on, every broadcast and the unbroadcast original are recorded', async () => {
        if (!sfuReady) return 'skipped (no media worker)';
        const patch = (body) => json('/api/admin/settings', { method: 'PATCH', headers: authed(token), body: JSON.stringify(body) });
        const { body: settings } = await json('/api/settings');
        const channel = settings.languages[1].id;
        const source = settings.languages[0].id;
        const operator = await connect(token);
        assert.ok((await produce(operator, channel, 6666)).id, 'broadcast started before recording was switched on');
        assert.equal((await patch({ recordingEnabled: true })).body.recordingEnabled, true);
        const transport = await ask(operator, 'createWebRtcTransport', { type: 'producer' });
        const original = await ask(operator, 'produce', {
            transportId: transport.id, kind: 'audio', rtpParameters: opusRtp(7777), appData: { channelId: source, recordOnly: true },
        });
        assert.ok(original.id, original.error);
        assert.equal(await channelMode(source), undefined, 'the original is recorded, not broadcast');
        const phone = await connect(interpreterToken);
        const phoneTransport = await ask(phone, 'createWebRtcTransport', { type: 'producer' });
        const refused = await ask(phone, 'produce', {
            transportId: phoneTransport.id, kind: 'audio', rtpParameters: opusRtp(7778), appData: { channelId: source, recordOnly: true },
        });
        assert.match(refused.error || '', /Only the operator/);
        await sleep(500);
        const active = (await json('/api/admin/recordings', { headers: authed(token) })).body.items.filter((item) => item.active);
        assert.deepEqual(active.map((item) => item.role).sort(), ['interpreter', 'original']);
        assert.equal((await json('/api/admin/live', { headers: authed(token) })).body.channels.find((entry) => entry.id === channel).recording, true);
        assert.equal((await patch({ recordingEnabled: false })).status, 200);
        await sleep(300);
        const items = (await json('/api/admin/recordings', { headers: authed(token) })).body.items;
        assert.equal(items.filter((item) => item.active).length, 0, 'switching off stops every recording');
        assert.equal(items.filter((item) => item.type === 'audio').length, 0, 'recordings that never got audio leave no file');
        assert.equal((await ask(operator, 'closeRecordOnly', { producerId: original.id })).ok, true);
        await ask(operator, 'closeProducer', { channelId: channel });
        return 'interpreter + original recorded, both stopped';
    });

    await check('a recording captures real Opus audio, with pauses kept as silence', async () => {
        if (!sfuReady || !routers.length) return 'skipped (no media worker)';
        const { startChannelRecording } = require('../lib/recorder.cjs');
        const router = routers.at(-1);
        const input = await router.createPlainTransport({ listenInfo: { protocol: 'udp', ip: '127.0.0.1' }, rtcpMux: true, comedia: true });
        const producer = await input.produce({ kind: 'audio', rtpParameters: opusRtp(8888) });
        const filePath = path.join(userData, 'smoke-recording.opus');
        const handle = await startChannelRecording({ router, producer, filePath, tags: { title: 'smoke' } });
        const sender = dgram.createSocket('udp4');
        const send = (packet) => new Promise((resolve) => sender.send(packet, input.tuple.localPort, '127.0.0.1', resolve));
        const voice = Buffer.from([0xfc, 0x10, 0x20, 0x30, 0x40]);
        let sequence = 0;
        // 2 s of audio, a 1 s pause (as when the speaker mutes), then 1 s more.
        for (let index = 0; index < 150; index += 1) {
            const frame = index < 100 ? index : index + 50;
            await send(rtpPacket(sequence++, 5000 + frame * 960, 8888, voice));
            if (index % 10 === 9) await sleep(15);
        }
        await sleep(500);
        const result = handle.stop();
        sender.close();
        producer.close();
        input.close();
        const bytes = fs.readFileSync(filePath);
        assert.equal(bytes.toString('ascii', 0, 4), 'OggS');
        assert.equal(bytes.toString('ascii', 28, 36), 'OpusHead');
        assert.equal(result.packets, 150, 'every packet arrived through the media server');
        assert.equal(result.durationMs, 4000, '2 s + 1 s of silence + 1 s');
        return `${result.packets} packets, ${result.durationMs} ms, ${bytes.length} bytes`;
    });

    await check('an interpreter cannot cut off, mute or end a live broadcast it does not own', async () => {
        if (!sfuReady) return 'skipped (no media worker)';
        const operator = await connect(token);
        assert.ok((await produce(operator, channelId, 1111)).id, 'operator broadcast started');
        const phone = await connect(interpreterToken);
        const attempt = await produce(phone, channelId, 2222);
        assert.match(attempt.error || '', /already being broadcast/);
        assert.match((await ask(phone, 'setProducerPaused', { channelId, paused: true })).error || '', /Another broadcaster/);
        assert.equal((await ask(phone, 'closeProducer', { channelId })).ignored, true);
        assert.equal(await channelMode(channelId), 'sfu-active', 'the operator broadcast is still live');
        return 'refused, refused, ignored';
    });

    await check('the operator can take a channel over, and the previous broadcaster is told', async () => {
        if (!sfuReady) return 'skipped (no media worker)';
        const first = await connect(token);
        assert.ok((await produce(first, channelId, 3333)).id);
        const second = await connect(await login());
        const replaced = waitFor(first, 'producerReplaced', 5000);
        assert.ok((await produce(second, channelId, 4444)).id, 'takeover accepted');
        assert.equal((await replaced).channelId, channelId);
        // The replaced broadcaster pressing Stop must not end the new broadcast.
        assert.equal((await ask(first, 'closeProducer', { channelId })).ignored, true);
        assert.equal(await channelMode(channelId), 'sfu-active');
        return 'producerReplaced received';
    });

    await check('a connected socket can still negotiate after the media worker restarts', async () => {
        if (!sfuReady || !workers.length) return 'skipped (no media worker)';
        const listener = await connect();
        const restarted = waitFor(listener, 'sfuReady', 15_000);
        process.kill(workers.at(-1).pid);
        await restarted;
        const transport = await ask(listener, 'createWebRtcTransport', { type: 'consumer' });
        assert.ok(transport.id, transport.error || 'no transport');
        const connected = await ask(listener, 'connectTransport', { transportId: transport.id, dtlsParameters: FAKE_DTLS });
        assert.equal(connected.error, undefined, `connectTransport failed: ${connected.error}`);
        return 'transport tracked after restart';
    });

    await check('ending interpreter access disconnects the phone and kills its session', async () => {
        const phone = await connect(interpreterToken);
        const notified = waitFor(phone, 'sessionRevoked', 5000);
        const disconnected = waitFor(phone, 'disconnect', 5000);
        const { status, body } = await json('/api/admin/interpreter-sessions/revoke', { method: 'POST', headers: authed(token) });
        assert.equal(status, 200);
        assert.ok(body.sessions >= 1, `revoked ${body.sessions}`);
        await notified;
        await disconnected;
        assert.equal((await json('/api/diagnostics', { headers: authed(interpreterToken) })).status, 401);
        return `${body.sessions} session(s) ended`;
    });

    await check('ending interpreter access requires an operator session', async () => {
        assert.equal((await json('/api/admin/interpreter-sessions/revoke', { method: 'POST' })).status, 401);
        return '401';
    });

    await check('changing the PIN signs out every other operator session', async () => {
        const other = await login();
        assert.ok(other);
        const { status } = await json('/api/admin/settings', {
            method: 'PATCH', headers: authed(token), body: JSON.stringify({ adminPin: '246810' }),
        });
        assert.equal(status, 200);
        assert.equal((await json('/api/admin/settings', { headers: authed(other) })).status, 401, 'the other session ended');
        assert.equal((await json('/api/admin/settings', { headers: authed(token) })).status, 200, 'the changing session stays');
        return 'other 401, self 200';
    });

    await check('certificate mode can be reverted to self-signed', async () => {
        const { body } = await json('/api/admin/settings', {
            method: 'PATCH', headers: authed(token), body: JSON.stringify({ certificateMode: 'self-signed' }),
        });
        assert.ok(body, 'patch accepted');
        const health = await json('/api/admin/health', { headers: authed(token) });
        assert.equal(health.body.certificate.type, 'self-signed');
        return 'reverted';
    });

    await check('retired text-fallback settings and a stored Gemini key are dropped on load', async () => {
        const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        for (const key of ['aiProvider', 'glossary', 'geminiApiKey', 'geminiApiKeyEncrypted']) {
            assert.equal(key in saved, false, `${key} is still in the settings file`);
        }
        return 'removed from disk';
    });

    await check('the retired text-translation endpoint is gone', async () => {
        assert.equal((await json('/api/translate', { method: 'POST', headers: authed(token), body: '{}' })).status, 404);
        return '404';
    });

    // Only the refusal is checked: a successful call would relaunch the process under test.
    await check('restarting the app requires an operator session', async () => {
        assert.equal((await json('/api/admin/restart', { method: 'POST' })).status, 401);
        return '401';
    });

    await check('an unknown API route returns JSON, not the SPA shell', async () => {
        const { status, contentType } = await json('/api/does-not-exist');
        assert.equal(status, 404);
        assert.match(contentType, /json/);
        return '404 JSON';
    });

    console.log(`\nServer smoke test (${results.length - failures}/${results.length} passed)\n`);
    console.log(results.join('\n'));
    sockets.forEach((socket) => socket.close());
    fs.rmSync(userData, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
}

// Give the HTTPS listener time to generate its self-signed certificate and bind.
void started.then(() => setTimeout(() => { void run(); }, 3500));
