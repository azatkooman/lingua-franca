const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLiveInstructions, languageName, liveSession } = require('./ai-instructions.cjs');
const { DocumentError, documentText } = require('./document-text.cjs');
const { adminSettings, DEFAULT_SETTINGS, MAX_AI_NOTES, dropRetiredSettings } = require('./settings.cjs');
const { zip } = require('../scripts/test-zip.cjs');


const slide = (...lines) => `<p:sld><p:cSld><p:spTree>${lines.map((line) => `<a:p><a:pPr algn="l"/><a:r><a:t>${line}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`;

test('slides are read in presentation order, with their speaker notes', () => {
    const pptx = zip({
        'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
        'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
        'ppt/slides/slide1.xml': slide('Second &amp; last'),
        'ppt/slides/slide2.xml': slide('Грace upon grace', 'John 1:16'),
        'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide7.xml"/></Relationships>',
        'ppt/notesSlides/notesSlide7.xml': slide('Mention Pastor Ivanov', '2'),
        'ppt/media/image1.png': 'not text',
    });
    assert.equal(documentText(pptx, 'Sermon.PPTX'),
        'Slide 1:\nГрace upon grace\nJohn 1:16\nSpeaker notes: Mention Pastor Ivanov\n\nSlide 2:\nSecond & last');
});

test('a Word document keeps its paragraphs, with tabs and breaks as spaces', () => {
    const docx = zip({
        'word/document.xml': '<w:document><w:body><w:p><w:pPr/><w:r><w:t xml:space="preserve">Point one:</w:t><w:tab/><w:t>grace</w:t></w:r></w:p><w:p><w:r><w:t>Пастор Иванов</w:t></w:r></w:p><w:p></w:p></w:body></w:document>',
    });
    assert.equal(documentText(docx, 'notes.docx'), 'Point one: grace\nПастор Иванов');
});

test('plain text is kept as it is, and unreadable files say what to do', () => {
    assert.equal(documentText(Buffer.from('﻿  Names: Ivanov \n'), 'names.txt'), 'Names: Ivanov');
    assert.throws(() => documentText(Buffer.from('%PDF'), 'a.pdf'), (error) => error instanceof DocumentError && /paste/.test(error.message));
    assert.throws(() => documentText(Buffer.from('x'), 'old.ppt'), /\.pptx/);
    assert.throws(() => documentText(Buffer.from('not a zip at all'), 'fake.pptx'), DocumentError);
    assert.throws(() => documentText(Buffer.from('x'), 'photo.jpg'), DocumentError);
});

test('GPT-Live is told to interpret continuously, never to answer, pause or back-channel', () => {
    const text = buildLiveInstructions({ sourceCode: 'ru', targetCode: 'kk', instructions: 'Pastor Ivanov.', notes: 'Slide 1' });
    assert.match(text, /^KAZAKH ONLY\. NEVER GENERATE <\|SpawnThinking\|>/);
    assert.match(text, /Translate the speaker's Russian speech into Kazakh/);
    assert.match(text, /Translate phrases as they arrive/);
    assert.match(text, /Backchannel policy: Never use backchannels/);
    assert.match(text, /Interruption policy: [^\n]*never stop to listen/);
    assert.match(text, /Delegation policy:\nBackend tools:\n- None\./);
    assert.match(text, /organisers:\n"""\nPastor Ivanov\.\n"""/);
    assert.match(text, /Notes for this service[^\n]*\n"""\nSlide 1\n"""/);
});

test('the GPT-Live session keeps one chosen voice, uses no backend, and clips long notes', () => {
    assert.equal(languageName('ru'), 'Russian');
    assert.equal(languageName('kk'), 'Kazakh');
    const session = liveSession({ sourceCode: 'ru', targetCode: 'en', voice: 'gleam', notes: 'x'.repeat(MAX_AI_NOTES + 500) });
    assert.equal(session.model, 'gpt-live-1');
    assert.deepEqual(session.audio, { output: { voice: 'gleam' } });
    assert.equal('delegation' in session, false, 'no backend model: client delegation, never used');
    assert.ok(session.instructions.length < MAX_AI_NOTES + 4000, 'notes are clipped');
    assert.equal(liveSession({ voice: 'robot' }).audio.output.voice, 'marin');
    assert.doesNotMatch(buildLiveInstructions({ sourceCode: 'ru', targetCode: 'en' }), /Notes for this service|organisers/);
});

test('the translator settings are normalised for Admin, and the old model choice is dropped on load', () => {
    const view = adminSettings({ ...DEFAULT_SETTINGS, aiVoice: 'cedar', aiNotes: '  Slide 1  ' });
    assert.deepEqual([view.aiVoice, view.aiNotes, view.aiInstructions], ['cedar', 'Slide 1', '']);
    assert.equal(adminSettings({ ...DEFAULT_SETTINGS, aiVoice: 'robot' }).aiVoice, 'marin');
    assert.equal('aiEngine' in view, false);
    const loaded = dropRetiredSettings({ aiEngine: 'steady', aiPace: 'smoother', aiVoice: 'cedar' });
    assert.deepEqual(loaded, { aiVoice: 'cedar' });
});
