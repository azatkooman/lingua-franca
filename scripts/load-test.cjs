const { io } = require('socket.io-client');

const baseUrl = process.env.LINGUA_FRANCA_URL || 'https://localhost:4173';
const clients = Number(process.env.LINGUA_FRANCA_CLIENTS || 25);
const sockets = [];
let connected = 0;

for (let index = 0; index < clients; index += 1) {
    const socket = io(baseUrl, { transports: ['websocket'], rejectUnauthorized: false });
    sockets.push(socket);
    socket.on('connect', () => {
        connected += 1;
        if (connected === clients) {
            console.log(`${clients} signaling clients connected successfully.`);
            sockets.forEach((item) => item.close());
        }
    });
    socket.on('connect_error', (error) => {
        console.error(`Client ${index + 1} failed: ${error.message}`);
        sockets.forEach((item) => item.close());
        process.exitCode = 1;
    });
}

setTimeout(() => {
    if (connected !== clients) {
        console.error(`Timed out: ${connected}/${clients} clients connected.`);
        sockets.forEach((item) => item.close());
        process.exitCode = 1;
    }
}, 15000);
