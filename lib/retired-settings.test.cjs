const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, RETIRED_SETTINGS, adminSettings, dropRetiredSettings } = require('./settings.cjs');

test('dropRetiredSettings removes the text-fallback settings, including a stored Gemini key', () => {
    const settings = dropRetiredSettings({
        languages: [], aiProvider: 'gemini', glossary: 'names',
        geminiApiKey: 'plain', geminiApiKeyEncrypted: 'cipher', openaiApiKeyEncrypted: 'keep',
    });
    for (const key of RETIRED_SETTINGS) assert.equal(key in settings, false, `${key} should be gone`);
    assert.equal(settings.openaiApiKeyEncrypted, 'keep');
});

test('new installs carry no retired settings', () => {
    for (const key of RETIRED_SETTINGS) assert.equal(key in DEFAULT_SETTINGS, false, `${key} in defaults`);
});

test('the operator payload no longer offers a provider, a Gemini key or a glossary', () => {
    const payload = adminSettings({ languages: [], glossary: 'names', aiProvider: 'gemini', geminiApiKeyEncrypted: 'x' }, new Map());
    for (const key of ['aiProvider', 'geminiConfigured', 'glossary']) assert.equal(key in payload, false, key);
});
