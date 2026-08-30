const test = require('node:test');
const assert = require('node:assert');
const {
    adminSettings, findLanguage, inferLanguageCode, isValidDuckDnsDomain, isValidEmail,
    normalizeDuckDnsDomain, normalizeLanguage, normalizeLanguages, publicSettings,
    selectLocalAddress, slugify,
} = require('./settings.cjs');

test('inferLanguageCode maps known names and falls back to a two-letter prefix', () => {
    assert.equal(inferLanguageCode('English'), 'en');
    assert.equal(inferLanguageCode('Русский'), 'ru');
    assert.equal(inferLanguageCode('Portuguese'), 'po');
    assert.equal(inferLanguageCode(''), 'en');
});

test('slugify strips punctuation and edge dashes but keeps Cyrillic', () => {
    assert.equal(slugify('  Sign Language! '), 'sign-language');
    assert.equal(slugify('Русский'), 'русский');
    assert.equal(slugify('---'), '');
});

test('normalizeLanguage trims and derives missing fields', () => {
    assert.deepEqual(normalizeLanguage({ name: '  Deutsch  ' }), {
        id: 'deutsch', name: 'Deutsch', code: 'de', description: '',
    });
});

test('normalizeLanguages drops nameless entries and de-duplicates ids', () => {
    const result = normalizeLanguages([
        { name: 'English' }, { name: '' }, { name: 'English' }, { name: 'English' },
    ]);
    assert.deepEqual(result.map((language) => language.id), ['english', 'english-2', 'english-3']);
});

test('normalizeLanguages preserves an existing id across a rename', () => {
    const [renamed] = normalizeLanguages([{ id: 'english', name: 'English (US)' }]);
    assert.equal(renamed.id, 'english');
    assert.equal(renamed.name, 'English (US)');
});

test('normalizeLanguages assigns a fallback id when the name has no slug characters', () => {
    const [language] = normalizeLanguages([{ name: '!!!' }]);
    assert.equal(language.id, 'channel-1');
});

test('publicSettings withholds the glossary and preferred address from listeners', () => {
    const payload = publicSettings(
        { languages: [{ id: 'english', name: 'English' }], interfaceLanguage: 'en', glossary: 'Private Name', preferredAddress: '192.168.1.5' },
        new Map(),
    );
    assert.equal('glossary' in payload, false);
    assert.equal('preferredAddress' in payload, false);
    assert.deepEqual(Object.keys(payload).sort(), ['interfaceLanguage', 'languages']);
});

test('publicSettings reports live channel mode keyed by id, not name', () => {
    const live = new Map([['english', { mode: 'ai-active' }]]);
    const payload = publicSettings({ languages: [{ id: 'english', name: 'Renamed' }] }, live);
    assert.equal(payload.languages[0].activePeerId, 'ai-active');
});

test('adminSettings exposes configuration flags but never the secrets themselves', () => {
    const payload = adminSettings({
        languages: [], glossary: 'names', openaiApiKeyEncrypted: 'cipher',
        duckDnsTokenEncrypted: 'cipher', adminPinHash: 'hash', adminPinSalt: 'salt',
    }, new Map());
    assert.equal(payload.openaiConfigured, true);
    assert.equal(payload.duckDnsConfigured, true);
    assert.equal(payload.glossary, 'names');
    assert.equal('openaiApiKeyEncrypted' in payload, false);
    assert.equal('adminPinHash' in payload, false);
});

test('selectLocalAddress honours a preferred address only when it still exists', () => {
    const addresses = [{ name: 'vEthernet', address: '172.16.0.1' }, { name: 'Wi-Fi', address: '192.168.1.5' }];
    assert.equal(selectLocalAddress(addresses, '172.16.0.1'), '172.16.0.1');
    assert.equal(selectLocalAddress(addresses, '10.0.0.9'), '192.168.1.5');
});

test('selectLocalAddress skips virtual adapters and degrades to loopback', () => {
    assert.equal(selectLocalAddress([{ name: 'VMware Network Adapter', address: '172.16.0.1' }], ''), '172.16.0.1');
    assert.equal(selectLocalAddress([], ''), '127.0.0.1');
});

test('findLanguage resolves by id', () => {
    const languages = [{ id: 'english', name: 'English' }];
    assert.equal(findLanguage(languages, 'english').name, 'English');
    assert.equal(findLanguage(languages, 'missing'), null);
});

test('normalizeDuckDnsDomain strips the suffix and validates the label', () => {
    assert.equal(normalizeDuckDnsDomain('  My-Church.duckdns.org '), 'my-church');
    assert.ok(isValidDuckDnsDomain('my-church'));
    assert.ok(!isValidDuckDnsDomain('-bad'));
    assert.ok(!isValidDuckDnsDomain('has space'));
});

test('isValidEmail accepts a contact address and rejects blanks', () => {
    assert.ok(isValidEmail('admin@example.com'));
    assert.ok(!isValidEmail('admin@example'));
    assert.ok(!isValidEmail(''));
});

test('selectLocalAddress rejects the vEthernet name Hyper-V and WSL actually use', () => {
    const addresses = [
        { name: 'vEthernet (Default Switch)', address: '172.16.0.1' },
        { name: 'Wi-Fi', address: '192.168.1.5' },
    ];
    assert.equal(selectLocalAddress(addresses, ''), '192.168.1.5');
});
