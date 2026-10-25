const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 1.8.2's first build left lib/language-codes.json out of the app, because the packaging
// rules only took lib's .cjs files, and the packaged app could not start. Every file the
// server code loads from lib must be one the packaging rules include.
test('every file main.cjs and lib load is packaged into the app', () => {
    const root = path.join(__dirname, '..');
    const files = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.files;
    const included = (file) => files.includes(file)
        || files.some((pattern) => pattern.startsWith('lib/**/*.') && file.startsWith('lib/') && file.endsWith(pattern.slice('lib/**/*'.length)));
    const sources = ['main.cjs', ...fs.readdirSync(__dirname).filter((name) => name.endsWith('.cjs') && !name.endsWith('.test.cjs')).map((name) => `lib/${name}`)];
    const loaded = new Set();
    for (const source of sources) {
        const text = fs.readFileSync(path.join(root, source), 'utf8');
        for (const [, target] of text.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
            loaded.add(path.relative(root, path.resolve(path.dirname(path.join(root, source)), target)).split(path.sep).join('/'));
        }
    }
    assert.ok(loaded.has('lib/language-codes.json'), 'the check sees JSON files too');
    for (const file of loaded) {
        assert.ok(fs.existsSync(path.join(root, file)), `${file} exists`);
        assert.ok(included(file), `${file} is left out by package.json build.files`);
    }
});
