// Writes Opus packets into an Ogg Opus file (RFC 7845), the format of .opus files, which
// Windows Media Player, VLC, browsers and phones all play. Pure JavaScript, so recording needs
// no ffmpeg or other program shipped with the app.

const SAMPLE_RATE = 48000;
// 20 ms of silence as a complete Opus packet (CELT, fullband, mono). Used to fill gaps such
// as a muted microphone, so the file keeps real time instead of jumping over the pause.
const SILENCE_PACKET = Buffer.from([0xf8, 0xff, 0xfe]);
const SILENCE_SAMPLES = 960;
// Pages are flushed about once a second, so a crash loses at most that much.
const PACKETS_PER_PAGE = 50;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index << 24;
        for (let bit = 0; bit < 8; bit += 1) value = (value & 0x80000000) ? ((value << 1) ^ 0x04c11db7) : (value << 1);
        table[index] = value >>> 0;
    }
    return table;
})();

// Ogg's CRC-32: polynomial 0x04c11db7, no reflection, zero start, no final xor.
function oggCrc(buffer) {
    let crc = 0;
    for (const byte of buffer) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
    return crc;
}

/** Samples (at 48 kHz) in one Opus packet, read from its TOC byte (RFC 6716 section 3.1). */
function opusPacketSamples(packet) {
    if (!packet?.length) return 0;
    const toc = packet[0];
    const config = toc >> 3;
    let frameMs;
    if (config < 12) frameMs = [10, 20, 40, 60][config % 4];
    else if (config < 16) frameMs = config % 2 ? 20 : 10;
    else frameMs = [2.5, 5, 10, 20][config % 4];
    const code = toc & 0x03;
    const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
    return Math.round(frameMs * 48) * frames;
}

function oggPage({ data, segments, granule, serial, sequence, flags }) {
    const header = Buffer.alloc(27 + segments.length);
    header.write('OggS', 0, 'ascii');
    header[4] = 0;
    header[5] = flags;
    header.writeBigUInt64LE(BigInt(granule), 6);
    header.writeUInt32LE(serial, 14);
    header.writeUInt32LE(sequence, 18);
    header.writeUInt32LE(0, 22);
    header[26] = segments.length;
    segments.forEach((size, index) => { header[27 + index] = size; });
    const page = Buffer.concat([header, data]);
    page.writeUInt32LE(oggCrc(page), 22);
    return page;
}

// An Ogg packet's length is stored as 255-byte runs plus a remainder (0 when it divides evenly).
function lacing(length) {
    const values = new Array(Math.floor(length / 255)).fill(255);
    values.push(length % 255);
    return values;
}

class OggOpusWriter {
    /**
     * @param {(chunk: Buffer) => void} write  receives whole pages, in order
     * @param {{ channels?: number, serial?: number, tags?: Record<string, string> }} options
     */
    constructor(write, { channels = 2, serial = (Math.random() * 0xffffffff) >>> 0, tags = {} } = {}) {
        this.write = write;
        this.serial = serial;
        this.sequence = 0;
        this.granule = 0;
        this.pending = [];
        this.closed = false;

        const head = Buffer.alloc(19);
        head.write('OpusHead', 0, 'ascii');
        head[8] = 1;
        head[9] = channels;
        head.writeUInt16LE(0, 10);
        head.writeUInt32LE(SAMPLE_RATE, 12);
        head.writeInt16LE(0, 16);
        head[18] = 0;
        this.emitPage([head], 0, 0x02);

        const vendor = Buffer.from('Lingua Franca', 'utf8');
        const comments = Object.entries(tags)
            .filter(([, value]) => value)
            .map(([key, value]) => Buffer.from(`${key.toUpperCase()}=${value}`, 'utf8'));
        const parts = [Buffer.from('OpusTags', 'ascii'), Buffer.alloc(4), vendor, Buffer.alloc(4)];
        parts[1].writeUInt32LE(vendor.length, 0);
        parts[3].writeUInt32LE(comments.length, 0);
        for (const comment of comments) {
            const size = Buffer.alloc(4);
            size.writeUInt32LE(comment.length, 0);
            parts.push(size, comment);
        }
        this.emitPage([Buffer.concat(parts)], 0, 0);
    }

    get durationMs() { return Math.round(this.granule / (SAMPLE_RATE / 1000)); }

    emitPage(packets, granule, flags) {
        const segments = packets.flatMap((packet) => lacing(packet.length));
        this.write(oggPage({ data: Buffer.concat(packets), segments, granule, serial: this.serial, sequence: this.sequence, flags }));
        this.sequence += 1;
    }

    flush(flags = 0) {
        if (!this.pending.length && !flags) return;
        this.emitPage(this.pending, this.granule, flags);
        this.pending = [];
    }

    writePacket(packet, samples = opusPacketSamples(packet)) {
        if (this.closed || !packet.length) return;
        const segmentsNow = this.pending.reduce((total, entry) => total + lacing(entry.length).length, 0);
        if (segmentsNow + lacing(packet.length).length > 255) this.flush();
        this.pending.push(packet);
        this.granule += samples;
        if (this.pending.length >= PACKETS_PER_PAGE) this.flush();
    }

    writeSilence(samples) {
        for (let left = samples; left >= SILENCE_SAMPLES; left -= SILENCE_SAMPLES) this.writePacket(SILENCE_PACKET, SILENCE_SAMPLES);
    }

    /** Writes the last page, marked end-of-stream. */
    close() {
        if (this.closed) return;
        this.flush(0x04);
        this.closed = true;
    }
}

module.exports = { OggOpusWriter, SAMPLE_RATE, SILENCE_PACKET, SILENCE_SAMPLES, oggCrc, opusPacketSamples };
