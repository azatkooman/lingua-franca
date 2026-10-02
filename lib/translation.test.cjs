const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTranslationPrompt, languageCodeFor } = require('./settings.cjs');

const languages = [
    { id: 'english', name: 'English', code: 'en', description: '' },
    { id: 'ukrainian', name: 'Українська', code: 'uk', description: '' },
];

test('languageCodeFor uses the configured code for a channel name', () => {
    assert.equal(languageCodeFor(languages, 'Українська'), 'uk');
});

test('languageCodeFor accepts a channel id or a code', () => {
    assert.equal(languageCodeFor(languages, 'ukrainian'), 'uk');
    assert.equal(languageCodeFor(languages, 'en'), 'en');
});

test('languageCodeFor falls back to inference for an unknown value', () => {
    assert.equal(languageCodeFor(languages, 'Russian'), 'ru');
    assert.equal(languageCodeFor([], ''), 'en');
});

test('the translation prompt carries the glossary', () => {
    const prompt = buildTranslationPrompt({
        text: 'Привет', sourceLang: 'Русский', targetLang: 'English', glossary: 'Pastor Ivanov; Holy Spirit',
    });
    assert.match(prompt, /from Русский to English/);
    assert.match(prompt, /Pastor Ivanov; Holy Spirit/);
    assert.ok(prompt.endsWith('\nПривет'));
});

test('the translation prompt omits the glossary line when it is empty', () => {
    const prompt = buildTranslationPrompt({ text: 'Hi', sourceLang: 'English', targetLang: 'Русский', glossary: '   ' });
    assert.doesNotMatch(prompt, /names and terms/);
    assert.equal(prompt.split('\n').length, 3);
});
