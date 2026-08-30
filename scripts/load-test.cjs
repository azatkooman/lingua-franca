// Signalling and transport-capacity check.
//
// Connecting sockets alone never exercised the limit that actually bites: every WebRTC
// transport needs an ICE port, so this also asks each client for a transport. Against a build
// that allocates a port per transport this starts failing at roughly 49 clients; against the
// shared WebRtcServer port it should reach whatever number you ask for.
//
//   LINGUA_FRANCA_URL='https://127.0.0.1:4173' LINGUA_FRANCA_CLIENTS=60 npm run test:load

const { io } = require('socket.io-client');

const baseUrl = process.env.LINGUA_FRANCA_URL || 'https://localhost:4173';
const clients = Number(process.env.LINGUA_FRANCA_CLIENTS || 25);
const timeoutMs = Number(process.env.LINGUA_FRANCA_TIMEOUT_MS || 30_000);

const sockets = [];
let connected = 0;
let transports = 0;
const failures = [];

const finish = (code) => {
    sockets.forEach((socket) => socket.close());
    process.exitCode = code;
};

const summarise = () => {
    console.log(`Connected: ${connected}/${clients}`);
    console.log(`Transports allocated: ${transports}/${clients}`);
    if (failures.length) {
        console.error(`Failures (${failures.length}):`);
        for (const failure of failures.slice(0, 5)) console.error(`  - ${failure}`);
        if (failures.length > 5) console.error(`  …and ${failures.length - 5} more.`);
    }
    if (transports === clients) {
        console.log(`OK: ${clients} concurrent listener transports.`);
        return finish(0);
    }
    console.error('Capacity check failed. If transports stop well short of the client count, the');
    console.error('SFU is allocating one ICE port per transport instead of sharing one.');
    return finish(1);
};

let settled = 0;
const settle = () => { if ((settled += 1) === clients) summarise(); };

for (let index = 0; index < clients; index += 1) {
    const socket = io(baseUrl, { transports: ['websocket'], rejectUnauthorized: false });
    sockets.push(socket);
    socket.on('connect', () => {
        connected += 1;
        socket.emit('createWebRtcTransport', { type: 'consumer' }, (result) => {
            if (result && result.error) failures.push(`client ${index + 1}: ${result.error}`);
            else if (!result || !result.id) failures.push(`client ${index + 1}: no transport returned`);
            else transports += 1;
            settle();
        });
    });
    socket.on('connect_error', (error) => {
        failures.push(`client ${index + 1}: ${error.message}`);
        settle();
    });
}

setTimeout(() => {
    if (settled !== clients) {
        failures.push(`timed out with ${settled}/${clients} clients settled`);
        summarise();
    }
}, timeoutMs).unref();
