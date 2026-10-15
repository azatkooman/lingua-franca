// Reading and writing settings.json with a backup. Kept free of Electron imports so it can be
// unit tested with `node --test`.
//
// The file holds the admin PIN hash and the encrypted keys. A damaged file used to be
// replaced by defaults on the next save, which quietly reset the PIN to 1234 and threw the
// keys away. Now every save keeps the previous good copy as settings.json.bak, a damaged file
// is set aside rather than overwritten, and the caller learns which copy it got.

const fs = require('node:fs');
const path = require('node:path');

const backupPath = (file) => `${file}.bak`;

/** The parsed settings object, or null when the file is missing, unreadable or not an object. */
function readJsonObject(file) {
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Loads the settings file.
 *
 * Returns `{ loaded, recovery, corruptCopy }`. `recovery` is null for a normal load or a first
 * run, 'backup' when the main file was damaged and the backup was used, and 'defaults' when
 * neither could be read. A damaged main file is copied aside to `corruptCopy` first, so
 * nothing in it is lost when the next save replaces it.
 */
function readSettingsFile(file, now = Date.now()) {
    if (!fs.existsSync(file)) return { loaded: {}, recovery: null, corruptCopy: '' };
    const main = readJsonObject(file);
    if (main) return { loaded: main, recovery: null, corruptCopy: '' };
    const corruptCopy = `${file}.corrupt-${now}`;
    try { fs.copyFileSync(file, corruptCopy); } catch { /* best effort; the backup is what matters */ }
    const backup = readJsonObject(backupPath(file));
    if (backup) return { loaded: backup, recovery: 'backup', corruptCopy };
    return { loaded: {}, recovery: 'defaults', corruptCopy };
}

/** Writes the settings atomically, keeping the previous good file as the backup. */
function writeSettingsFile(file, settings) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
    // Only a file that still reads back becomes the backup, so a damaged main file never
    // replaces a good backup.
    if (readJsonObject(file)) fs.copyFileSync(file, backupPath(file));
    fs.renameSync(temporary, file);
}

module.exports = { backupPath, readSettingsFile, writeSettingsFile };
