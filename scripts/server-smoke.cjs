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
 * itself worth asserting -- the API must stay up when the media engine cannot start.
 */

const Module = require('module');
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lingua-franca-smoke-'));
let markReady;
const ready = new Promise((resolve) => { markReady = resolve; });

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

// Silence the expected "no mediasoup worker" restart noise; the SFU state is asserted below.
const realError = console.error;
console.error = (...args) => {
    if (String(args[0] ?? '').includes('SFU initialization failed')) return;
    realError(...args);
};

require(path.join(__dirname, '..', 'main.cjs'));
markReady();

const BASE = 'http://127.0.0.1:4174';
const results = [];
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

    await check('the API stays up when the media engine cannot start', async () => {
        const { status, body } = await json('/api/health');
        assert.equal(status, 200);
        assert.equal(body.sfu, 'unavailable');
        return 'health served with sfu=unavailable';
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
        assert.ok('glossary' in body);
        assert.equal('adminPinHash' in body, false);
        assert.equal('openaiApiKeyEncrypted' in body, false);
        assert.equal('duckDnsTokenEncrypted' in body, false);
        return 'secrets absent';
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

    await check('an interpreter link works once and only once', async () => {
        const { body: settings } = await json('/api/admin/settings', { headers: authed(token) });
        const { body: link } = await json('/api/admin/interpreter-link', {
            method: 'POST', headers: authed(token), body: JSON.stringify({ channelId: settings.languages[0].id }),
        });
        assert.match(link.code, /^\d{6}$/);
        const first = await json('/api/interpreter/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: link.code }),
        });
        assert.equal(first.status, 200);
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

    await check('an unknown API route returns JSON, not the SPA shell', async () => {
        const { status, contentType } = await json('/api/does-not-exist');
        assert.equal(status, 404);
        assert.match(contentType, /json/);
        return '404 JSON';
    });

    console.log(`\nServer smoke test (${results.length - failures}/${results.length} passed)\n`);
    console.log(results.join('\n'));
    fs.rmSync(userData, { recursive: true, force: true });
    process.exit(failures ? 1 : 0);
}

// Give the HTTPS listener time to generate its self-signed certificate and bind.
setTimeout(() => { void run(); }, 3500);
