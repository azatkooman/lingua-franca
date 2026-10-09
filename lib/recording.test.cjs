const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { OggOpusWriter, SILENCE_PACKET, oggCrc, opusPacketSamples } = require('./ogg-opus.cjs');
const { RtpToOgg } = require('./recorder.cjs');
const { RecordingStore, TranscriptLog } = require('./recordings.cjs');

// Reads Ogg pages back, checking each page's checksum, so the tests verify real file structure.
function parsePages(buffer) {
    const pages = [];
    let offset = 0;
    while (offset < buffer.length) {
        assert.equal(buffer.toString('ascii', offset, offset + 4), 'OggS', `page at ${offset}`);
        const count = buffer[offset + 26];
        const segments = [...buffer.subarray(offset + 27, offset + 27 + count)];
        const size = 27 + count + segments.reduce((total, value) => total + value, 0);
        const page = Buffer.from(buffer.subarray(offset, offset + size));
        const stored = page.readUInt32LE(22);
        page.writeUInt32LE(0, 22);
        assert.equal(oggCrc(page), stored, 'page checksum');
        const packets = [];
        let start = 27 + count;
        let length = 0;
        for (const value of segments) {
            length += value;
            if (value < 255) { packets.push(page.subarray(start, start + length)); start += length; length = 0; }
        }
        pages.push({
            flags: buffer[offset + 5], granule: Number(buffer.readBigUInt64LE(offset + 6)),
            sequence: buffer.readUInt32LE(offset + 18), packets,
        });
        offset += size;
    }
    return pages;
}

const collect = () => {
    const chunks = [];
    return { write: (chunk) => chunks.push(chunk), bytes: () => Buffer.concat(chunks) };
};

const rtp = (timestamp, payload, { payloadType = 111, sequence = 1, extension = false } = {}) => {
    const header = Buffer.alloc(12);
    header[0] = 0x80 | (extension ? 0x10 : 0);
    header[1] = payloadType;
    header.writeUInt16BE(sequence & 0xffff, 2);
    header.writeUInt32BE(timestamp >>> 0, 4);
    header.writeUInt32BE(1234, 8);
    // One-byte header extension (RFC 8285) carrying one 4-byte word, as browsers send.
    const ext = extension ? Buffer.from([0xbe, 0xde, 0x00, 0x01, 0x10, 0xff, 0x00, 0x00]) : Buffer.alloc(0);
    return Buffer.concat([header, ext, payload]);
};

test('the Ogg checksum matches the standard check value', () => {
    // CRC-32 with polynomial 0x04c11db7, zero start, no reflection and no final xor.
    assert.equal(oggCrc(Buffer.from('123456789')), 0x89a1897f);
});

test('Opus packet durations are read from the TOC byte', () => {
    assert.equal(opusPacketSamples(SILENCE_PACKET), 960, 'CELT 20 ms');
    assert.equal(opusPacketSamples(Buffer.from([0x08])), 960, 'SILK 20 ms');
    assert.equal(opusPacketSamples(Buffer.from([0x18])), 2880, 'SILK 60 ms');
    assert.equal(opusPacketSamples(Buffer.from([0xf9])), 1920, 'two 20 ms frames');
    assert.equal(opusPacketSamples(Buffer.from([0xfb, 0x03])), 2880, 'code 3, three frames');
    assert.equal(opusPacketSamples(Buffer.alloc(0)), 0);
});

test('the writer produces head, tags and audio pages with running granule positions', () => {
    const sink = collect();
    const writer = new OggOpusWriter(sink.write, { channels: 2, serial: 7, tags: { title: 'English' } });
    for (let index = 0; index < 120; index += 1) writer.writePacket(SILENCE_PACKET);
    writer.close();
    const pages = parsePages(sink.bytes());
    assert.equal(pages[0].flags, 0x02, 'first page begins the stream');
    assert.equal(pages[0].packets[0].toString('ascii', 0, 8), 'OpusHead');
    assert.equal(pages[0].packets[0][9], 2, 'channel count');
    assert.equal(pages[1].packets[0].toString('ascii', 0, 8), 'OpusTags');
    assert.match(pages[1].packets[0].toString('utf8'), /TITLE=English/);
    const last = pages.at(-1);
    assert.equal(last.flags, 0x04, 'last page ends the stream');
    assert.equal(last.granule, 120 * 960);
    assert.deepEqual(pages.map((page) => page.sequence), pages.map((_, index) => index));
    const audioPackets = pages.slice(2).flatMap((page) => page.packets);
    assert.equal(audioPackets.length, 120);
    assert.equal(writer.durationMs, 2400);
});

test('a packet over 255 bytes is laced across segments and read back whole', () => {
    const sink = collect();
    const writer = new OggOpusWriter(sink.write, { serial: 1 });
    const big = Buffer.alloc(600, 7);
    big[0] = 0xfc; // CELT 20 ms, code 0
    writer.writePacket(big);
    writer.close();
    const audio = parsePages(sink.bytes()).slice(2).flatMap((page) => page.packets);
    assert.equal(audio.length, 1);
    assert.equal(audio[0].length, 600);
});

test('RTP is unpacked in time order, gaps become silence, late packets are dropped', () => {
    const sink = collect();
    const writer = new OggOpusWriter(sink.write, { serial: 2 });
    const converter = new RtpToOgg(writer, 111);
    const voice = Buffer.from([0xfc, 1, 2, 3]);
    assert.equal(converter.push(rtp(1000, voice, { extension: true })), true);
    assert.equal(converter.push(rtp(1960, voice)), true);
    // 1 second missing (a mute), then audio again.
    assert.equal(converter.push(rtp(1960 + 960 + 48000, voice)), true);
    assert.equal(converter.push(rtp(1960, voice)), false, 'a repeat is dropped');
    assert.equal(converter.push(rtp(5000, voice, { payloadType: 96 })), false, 'another payload type is ignored');
    assert.equal(converter.push(Buffer.from([0x80, 200, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])), false, 'RTCP is ignored');
    writer.close();
    assert.equal(converter.packets, 3);
    assert.equal(writer.durationMs, 20 + 20 + 1000 + 20);
    const audio = parsePages(sink.bytes()).slice(2).flatMap((page) => page.packets);
    assert.equal(audio.filter((packet) => packet.equals(SILENCE_PACKET)).length, 50);
    assert.deepEqual([...audio[0]], [...voice], 'the header extension is skipped');
});

test('RTP timestamps that wrap past 2^32 keep counting forward', () => {
    const writer = new OggOpusWriter(() => undefined, { serial: 3 });
    const converter = new RtpToOgg(writer, 111);
    converter.push(rtp(0xffffffff - 959, SILENCE_PACKET));
    assert.equal(converter.push(rtp(0, SILENCE_PACKET)), true);
    assert.equal(writer.durationMs, 40);
});

test('non-Latin channel ids keep separate transcript files and can be downloaded', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-recordings-'));
    try {
        const store = new RecordingStore(directory);
        const log = new TranscriptLog(store);
        const at = new Date(2026, 9, 9, 10, 0, 0);
        const russian = log.append('русский', 'Русский', { id: 'r', text: 'Привет.', originalText: '' }, { at });
        const french = log.append('французский', 'Французский', { id: 'f', text: 'Bonjour.', originalText: '' }, { at });
        const kazakh = log.append('қазақша', 'Қазақша', { id: 'k', text: 'Сәлем.', originalText: '' }, { at });
        assert.equal(new Set([russian, french, kazakh]).size, 3, 'three separate files');
        assert.equal(russian, '2026-10-09_русский_transcript.txt');
        for (const name of [russian, french, kazakh]) assert.ok(store.resolve(name), `${name} can be downloaded`);
        const audio = store.newAudioFile('русский', 'interpreter', at);
        assert.equal(audio.name, '2026-10-09_10-00-00_русский_interpreter.opus');
        assert.equal(store.list([]).filter((item) => item.type === 'transcript').length, 3);
        assert.equal(store.resolve('../русский.txt'), null);
        assert.equal(store.resolve('русский .txt'), null);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('the store lists recordings and transcripts and refuses names it did not create', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-recordings-'));
    try {
        const store = new RecordingStore(directory);
        const { name, filePath } = store.newAudioFile('English', 'translation', new Date(2026, 9, 9, 14, 5, 33));
        assert.equal(name, '2026-10-09_14-05-33_english_translation.opus');
        fs.writeFileSync(filePath, 'audio');
        assert.equal(store.newAudioFile('English', 'translation', new Date(2026, 9, 9, 14, 5, 33)).name,
            '2026-10-09_14-05-33_english_translation-2.opus', 'never overwrites');
        store.writeMeta(name, { channelId: 'english', channelName: 'English', role: 'translation', durationMs: 61000 });
        const log = new TranscriptLog(store);
        const at = new Date(2026, 9, 9, 14, 6, 0);
        assert.ok(log.append('english', 'English', { id: 'a', text: 'Good morning.', originalText: 'Доброе утро.' }, { eventName: 'Forum', at }));
        assert.equal(log.append('english', 'English', { id: 'a', text: 'Good morning.', originalText: '' }, { at }), null, 'a sentence is written once');
        log.append('english', 'English', { id: 'b', text: 'Welcome.', originalText: 'Welcome.' }, { at });

        const text = fs.readFileSync(path.join(directory, '2026-10-09_english_transcript.txt'), 'utf8');
        assert.equal(text, '﻿Forum\nEnglish · 2026-10-09\n\n[14:06:00] Good morning.\n           Доброе утро.\n[14:06:00] Welcome.\n');

        const items = store.list([{ id: 'english', name: 'English (main)' }]);
        const audio = items.find((item) => item.type === 'audio');
        const transcript = items.find((item) => item.type === 'transcript');
        assert.equal(audio.channelName, 'English');
        assert.equal(audio.role, 'translation');
        assert.equal(audio.durationMs, 61000);
        assert.equal(transcript.channelName, 'English (main)');
        assert.equal(transcript.lines, 2);

        for (const bad of ['../secret.txt', '..\\secret.txt', 'lingua-franca-settings.json', '', 'a/b.opus', 'x.opus.json']) {
            assert.equal(store.resolve(bad), null, bad);
        }
        assert.equal(store.remove(name), true);
        assert.equal(fs.existsSync(store.metaPath(name)), false, 'the description goes with the audio');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
