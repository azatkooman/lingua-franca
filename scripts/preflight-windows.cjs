const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`Windows x64 build required; current platform is ${process.platform}-${process.arch}.`);
}

const worker = path.join(__dirname, '..', 'node_modules', 'mediasoup', 'worker', 'out', 'Release', 'mediasoup-worker.exe');
if (!fs.existsSync(worker)) throw new Error(`Missing Windows mediasoup worker: ${worker}. Run npm ci on Windows.`);
if (fs.readFileSync(worker).subarray(0, 2).toString('ascii') !== 'MZ') {
    throw new Error('The mediasoup worker is not a Windows executable. Remove node_modules and run npm ci on Windows.');
}
console.log(`Windows x64 preflight passed: ${worker}`);
