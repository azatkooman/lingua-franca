// Records one live channel to an .opus file on this computer.
//
// The media server hands a copy of the channel's audio to a local UDP socket (a mediasoup
// PlainTransport, loopback only), and the Opus packets are written straight into an Ogg file
// as they arrive. This records every kind of broadcast the same way: the operator's
// microphone, a phone interpreter, the AI translation and the original speech.

const dgram = require('dgram');
const fs = require('fs');
const { OggOpusWriter, SILENCE_SAMPLES, opusPacketSamples } = require('./ogg-opus.cjs');

// A gap longer than this is not filled with silence. Six hours of silence is about 3 MB, so
// this only guards against a nonsense timestamp jump.
const MAX_GAP_SAMPLES = 6 * 60 * 60 * 48000;

/**
 * Parses RTP packets and writes their Opus payloads in time order. Missing time (a paused
 * producer, lost packets) becomes silence; late or repeated packets are dropped.
 */
class RtpToOgg {
    constructor(writer, payloadType) {
        this.writer = writer;
        this.payloadType = payloadType;
        this.expected = null;
        this.packets = 0;
    }

    push(buffer) {
        if (buffer.length < 12 || buffer[0] >> 6 !== 2) return false;
        // RTCP shares the socket (rtcp-mux); its packet types 192-223 sit where RTP has the
        // marker bit and payload type (RFC 5761).
        if (buffer[1] >= 192 && buffer[1] <= 223) return false;
        if ((buffer[1] & 0x7f) !== this.payloadType) return false;
        let offset = 12 + (buffer[0] & 0x0f) * 4;
        if (buffer[0] & 0x10) {
            if (buffer.length < offset + 4) return false;
            offset += 4 + buffer.readUInt16BE(offset + 2) * 4;
        }
        let end = buffer.length;
        if (buffer[0] & 0x20) end -= buffer[end - 1];
        if (end <= offset) return false;
        const payload = Buffer.from(buffer.subarray(offset, end));
        const timestamp = buffer.readUInt32BE(4);

        if (this.expected !== null) {
            // Signed 32-bit difference, so the timestamp wrapping around still compares right.
            const gap = (timestamp - this.expected) | 0;
            if (gap < 0) return false;
            if (gap >= SILENCE_SAMPLES && gap <= MAX_GAP_SAMPLES) this.writer.writeSilence(gap);
        }
        const samples = opusPacketSamples(payload) || SILENCE_SAMPLES;
        this.writer.writePacket(payload, samples);
        this.expected = (timestamp + samples) >>> 0;
        this.packets += 1;
        return true;
    }
}

/**
 * Starts recording a producer. Resolves to a handle whose stop() finishes the file and
 * resolves to { durationMs, packets }. `onEnded` fires once when the recording ends for any
 * reason (stop(), the producer closing, the media engine restarting).
 */
async function startChannelRecording({ router, producer, filePath, tags = {}, onEnded = () => undefined }) {
    const socket = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(0, '127.0.0.1', () => { socket.off('error', reject); resolve(); });
    });

    let transport;
    let consumer;
    let fd;
    try {
        transport = await router.createPlainTransport({
            listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
            rtcpMux: true,
            comedia: false,
        });
        await transport.connect({ ip: '127.0.0.1', port: socket.address().port });
        consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities, paused: false });
        fd = fs.openSync(filePath, 'wx');
    } catch (error) {
        try { transport?.close(); } catch { /* already closed */ }
        socket.close();
        throw error;
    }

    const codec = consumer.rtpParameters.codecs[0];
    const writer = new OggOpusWriter((chunk) => fs.writeSync(fd, chunk), { channels: codec.channels || 2, tags });
    const converter = new RtpToOgg(writer, codec.payloadType);
    socket.on('message', (message) => {
        try { converter.push(message); }
        catch (error) { console.error('Recording write failed:', error.message); finish(); }
    });
    socket.on('error', (error) => console.error('Recording socket error:', error.message));

    let ended = null;
    const finish = () => {
        if (ended) return ended;
        try { writer.close(); } catch (error) { console.error('Could not finish recording:', error.message); }
        try { fs.closeSync(fd); } catch { /* already closed */ }
        try { socket.close(); } catch { /* already closed */ }
        try { transport.close(); } catch { /* already closed */ }
        ended = { durationMs: writer.durationMs, packets: converter.packets };
        onEnded(ended);
        return ended;
    };
    consumer.on('producerclose', finish);
    consumer.on('transportclose', finish);
    transport.on('routerclose', finish);

    return {
        consumerId: consumer.id,
        get durationMs() { return writer.durationMs; },
        stop: finish,
    };
}

module.exports = { MAX_GAP_SAMPLES, RtpToOgg, startChannelRecording };
