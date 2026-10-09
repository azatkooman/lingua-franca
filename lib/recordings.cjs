// The recordings folder: audio (.opus with a .json description beside it) and caption
// transcripts (.txt, one per channel per day). Kept free of Electron so it can be unit tested.

const fs = require('fs');
const path = require('path');

const AUDIO_EXTENSION = '.opus';
const TRANSCRIPT_EXTENSION = '.txt';
// Only names this module creates. Anything else in a request is refused, so a download or
// delete can never reach outside the folder.
// Letters of any script are allowed (channel ids can be Cyrillic or Kazakh); dots, slashes and
// spaces are not, so a name can never point outside the folder.
const SAFE_NAME = /^[\p{L}\p{N}_-]+\.(opus|txt)$/u;
const ROLES = ['original', 'translation', 'interpreter'];

const pad = (value) => String(value).padStart(2, '0');
const localDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localTime = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
const fileStamp = (date) => `${localDate(date)}_${localTime(date).replace(/:/g, '-')}`;
// Keeps letters of every script: Latin-only slugs turned "русский" and "французский" alike
// into "channel", so their transcripts were written into one file.
const slug = (value) => String(value || 'channel').toLowerCase().normalize('NFC')
    .replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'channel';

class RecordingStore {
    constructor(directory) {
        this.directory = directory;
    }

    ensure() {
        fs.mkdirSync(this.directory, { recursive: true });
        return this.directory;
    }

    /** A new, unused audio file name for a channel starting now. */
    newAudioFile(channelId, role, startedAt = new Date()) {
        this.ensure();
        const base = `${fileStamp(startedAt)}_${slug(channelId)}_${ROLES.includes(role) ? role : 'interpreter'}`;
        let name = `${base}${AUDIO_EXTENSION}`;
        for (let index = 2; fs.existsSync(path.join(this.directory, name)); index += 1) name = `${base}-${index}${AUDIO_EXTENSION}`;
        return { name, filePath: path.join(this.directory, name) };
    }

    metaPath(name) { return path.join(this.directory, name.replace(/\.opus$/, '.json')); }

    writeMeta(name, meta) {
        try { fs.writeFileSync(this.metaPath(name), JSON.stringify(meta, null, 2)); }
        catch (error) { console.error('Could not save recording details:', error.message); }
    }

    readMeta(name) {
        try { return JSON.parse(fs.readFileSync(this.metaPath(name), 'utf8')); }
        catch { return {}; }
    }

    /** Absolute path of a stored file, or null for any name this folder did not create. */
    resolve(name) {
        const value = String(name || '');
        if (!SAFE_NAME.test(value)) return null;
        const filePath = path.join(this.directory, value);
        return fs.existsSync(filePath) ? filePath : null;
    }

    remove(name) {
        const filePath = this.resolve(name);
        if (!filePath) return false;
        fs.rmSync(filePath, { force: true });
        if (name.endsWith(AUDIO_EXTENSION)) fs.rmSync(this.metaPath(name), { force: true });
        return true;
    }

    /** Every stored recording and transcript, newest first. */
    list(languages = []) {
        let names;
        try { names = fs.readdirSync(this.directory); } catch { return []; }
        const nameFor = (channelId) => languages.find((language) => language.id === channelId)?.name;
        const items = [];
        for (const name of names) {
            if (!SAFE_NAME.test(name)) continue;
            let stat;
            try { stat = fs.statSync(path.join(this.directory, name)); } catch { continue; }
            if (name.endsWith(AUDIO_EXTENSION)) {
                const meta = this.readMeta(name);
                items.push({
                    name, type: 'audio', size: stat.size,
                    channelId: meta.channelId || '', channelName: meta.channelName || nameFor(meta.channelId) || meta.channelId || name,
                    role: ROLES.includes(meta.role) ? meta.role : 'interpreter',
                    startedAt: meta.startedAt || stat.birthtime.toISOString(),
                    endedAt: meta.endedAt || '',
                    durationMs: Number(meta.durationMs) || 0,
                });
            } else {
                const [date, channelId] = name.replace(/_transcript\.txt$/, '').split('_');
                let lines = 0;
                try { lines = (fs.readFileSync(path.join(this.directory, name), 'utf8').match(/^\[\d\d:\d\d:\d\d\]/gm) || []).length; } catch { /* unreadable */ }
                items.push({
                    name, type: 'transcript', size: stat.size, channelId: channelId || '',
                    channelName: nameFor(channelId) || channelId || name, date: date || '',
                    startedAt: stat.birthtime.toISOString(), endedAt: stat.mtime.toISOString(), lines,
                });
            }
        }
        return items.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
    }
}

/**
 * Appends each finished caption sentence to a text file per channel per day:
 *
 *   [14:05:33] Good morning, everyone.
 *              Доброе утро всем.
 *
 * The indented line is what the speaker said, when it differs from the caption.
 */
class TranscriptLog {
    constructor(store) {
        this.store = store;
        this.written = new Set();
    }

    append(channelId, channelName, { id, text, originalText }, { eventName = '', at = new Date() } = {}) {
        const line = String(text || '').trim();
        if (!line || this.written.has(id)) return null;
        this.written.add(id);
        if (this.written.size > 5000) this.written = new Set([...this.written].slice(-2500));
        this.store.ensure();
        const name = `${localDate(at)}_${slug(channelId)}_transcript${TRANSCRIPT_EXTENSION}`;
        const filePath = path.join(this.store.directory, name);
        let output = '';
        if (!fs.existsSync(filePath)) {
            // A byte-order mark, so Notepad and Word open Cyrillic and Kazakh text correctly.
            output += '\ufeff';
            if (eventName) output += `${eventName}\n`;
            output += `${channelName} · ${localDate(at)}\n\n`;
        }
        output += `[${localTime(at)}] ${line}\n`;
        const original = String(originalText || '').trim();
        if (original && original !== line) output += `           ${original}\n`;
        fs.appendFileSync(filePath, output, 'utf8');
        return name;
    }
}

module.exports = { ROLES, RecordingStore, SAFE_NAME, TranscriptLog };
