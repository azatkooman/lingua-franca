const test = require('node:test');
const assert = require('node:assert/strict');
const { COUNTRY_CODE_MISTAKES, LANGUAGE_CODES, aiLanguageName, checkLanguage, codeFromName, isKnownLanguageCode, languageNameOf, resolveLanguageCode } = require('./languages.cjs');
const { normalizeLanguages } = require('./settings.cjs');

test('every listed language is a real code with a name', () => {
    for (const code of LANGUAGE_CODES) assert.ok(languageNameOf(code), code);
    assert.equal(languageNameOf('zh-hant'), 'Traditional Chinese');
});

test('codes are checked: real ones pass, made-up ones do not', () => {
    for (const code of ['zh', 'ZH', 'ru', 'kk', 'yue', 'zh-hant', 'ch']) assert.equal(isKnownLanguageCode(code), true, code);
    for (const code of ['xx', 'cn', 'po', '', 'not a code', '中文']) assert.equal(isKnownLanguageCode(code), false, code);
});

test('country codes typed for a language are corrected, and only those that are no language', () => {
    for (const [mistake, code] of Object.entries(COUNTRY_CODE_MISTAKES)) {
        assert.equal(isKnownLanguageCode(mistake), false, `${mistake} must not be a language itself`);
        assert.equal(resolveLanguageCode(mistake, ''), code);
    }
    assert.equal(resolveLanguageCode('ch', 'Chinese'), 'ch', 'Chamorro is real: flagged, not replaced');
    assert.equal(resolveLanguageCode('', 'Китайский'), 'zh', 'no code: the name decides');
    assert.equal(resolveLanguageCode('xx', 'Chinese'), 'xx', 'an unknown code is kept for the operator to see');
});

test('channel names are recognised in English, Russian, Kazakh and the language itself', () => {
    for (const name of ['Chinese', 'chinese', '中文', 'Китайский', 'Mandarin']) assert.equal(codeFromName(name), 'zh', name);
    assert.equal(codeFromName('Қазақша'), 'kk');
    assert.equal(codeFromName('Portuguese'), 'pt');
    assert.equal(codeFromName('Main channel'), '');
});

test('Admin is told when a code means nothing, or a different language from the name', () => {
    assert.deepEqual(checkLanguage({ code: 'zh', name: 'Chinese' }), { meaning: 'Chinese', problem: null, suggestion: null });
    assert.deepEqual(checkLanguage({ code: 'ch', name: 'Chinese' }), { meaning: 'Chamorro', problem: 'mismatch', suggestion: 'zh' });
    assert.deepEqual(checkLanguage({ code: 'xx', name: 'Main' }), { meaning: '', problem: 'unknown', suggestion: null });
    assert.equal(checkLanguage({ code: 'zh-hant', name: 'Chinese' }).problem, null, 'a variant of the named language is fine');
    assert.equal(checkLanguage({ code: 'en', name: 'Main channel' }).problem, null, 'a name that is no language says nothing');
});

test('the AI is told the language the name points to when the code disagrees', () => {
    assert.equal(aiLanguageName({ code: 'ch', name: 'Chinese' }), 'Chinese');
    assert.equal(aiLanguageName({ code: 'kr', name: 'Korean' }), 'Korean');
    assert.equal(aiLanguageName({ code: 'zh-hant', name: '繁體中文' }), 'Traditional Chinese');
    assert.equal(aiLanguageName({ code: 'xx', name: 'Tok Pisin service' }), 'Tok Pisin service', 'nothing recognised: the name itself');
});

test('saved channels get a corrected or inferred code, and never a made-up two-letter one', () => {
    const [chinese, portuguese, main] = normalizeLanguages([
        { id: 'chinese', name: 'Chinese', code: 'cn' }, { name: 'Portuguese' }, { name: 'Main', code: '' },
    ]);
    assert.equal(chinese.code, 'zh');
    assert.equal(portuguese.code, 'pt');
    assert.equal(main.code, '');
});
