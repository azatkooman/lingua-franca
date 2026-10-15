const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backupPath, readSettingsFile, writeSettingsFile } = require('./settings-file.cjs');

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lf-settings-')), 'settings.json');

test('a first run loads nothing and reports no recovery', () => {
    assert.deepEqual(readSettingsFile(tempFile()), { loaded: {}, recovery: null, corruptCopy: '' });
});

test('every save keeps the previous good file as the backup', () => {
    const file = tempFile();
    writeSettingsFile(file, { adminPinHash: 'first' });
    assert.equal(fs.existsSync(backupPath(file)), false, 'nothing to back up on the first save');
    writeSettingsFile(file, { adminPinHash: 'second' });
    assert.deepEqual(JSON.parse(fs.readFileSync(backupPath(file), 'utf8')), { adminPinHash: 'first' });
    assert.deepEqual(readSettingsFile(file).loaded, { adminPinHash: 'second' });
});

test('a damaged file is set aside and the backup is loaded', () => {
    const file = tempFile();
    writeSettingsFile(file, { adminPinHash: 'good' });
    writeSettingsFile(file, { adminPinHash: 'newer' });
    fs.writeFileSync(file, '{"adminPinHash": "newer", "langu');
    const result = readSettingsFile(file, 42);
    assert.equal(result.recovery, 'backup');
    assert.deepEqual(result.loaded, { adminPinHash: 'good' });
    assert.equal(result.corruptCopy, `${file}.corrupt-42`);
    assert.equal(fs.readFileSync(result.corruptCopy, 'utf8'), '{"adminPinHash": "newer", "langu', 'the damaged file is kept as it was');
});

test('saving over a damaged file never replaces a good backup with it', () => {
    const file = tempFile();
    writeSettingsFile(file, { adminPinHash: 'good' });
    writeSettingsFile(file, { adminPinHash: 'good' });
    fs.writeFileSync(file, 'not json');
    writeSettingsFile(file, { adminPinHash: 'recovered' });
    assert.deepEqual(JSON.parse(fs.readFileSync(backupPath(file), 'utf8')), { adminPinHash: 'good' });
});

test('with no readable backup either, defaults are used and the caller is told', () => {
    const file = tempFile();
    fs.writeFileSync(file, '[1, 2, 3]');
    const result = readSettingsFile(file, 7);
    assert.deepEqual([result.loaded, result.recovery], [{}, 'defaults']);
    assert.ok(fs.existsSync(result.corruptCopy));
});
