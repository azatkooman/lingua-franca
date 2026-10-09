const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_TEXT, TranscriptStore } = require('./transcript.cjs');

test('a growing segment is updated in place, not appended again', () => {
    const store = new TranscriptStore({ now: () => 1 });
    store.update('english', { segmentId: 's1', text: 'Good', originalText: 'Доброе' });
    store.update('english', { segmentId: 's1', text: 'Good morning', originalText: 'Доброе утро', final: true });
    assert.deepEqual(store.recent('english'), [{ id: 's1', text: 'Good morning', originalText: 'Доброе утро', final: true, at: 1 }]);
});

test('only the most recent segments are kept', () => {
    const store = new TranscriptStore({ maxSegments: 3 });
    for (let index = 1; index <= 5; index += 1) store.update('english', { segmentId: `s${index}`, text: String(index) });
    assert.deepEqual(store.recent('english').map((segment) => segment.id), ['s3', 's4', 's5']);
});

test('channels are kept apart', () => {
    const store = new TranscriptStore();
    store.update('english', { segmentId: 'a', text: 'Hello' });
    store.update('kazakh', { segmentId: 'a', text: 'Сәлем' });
    assert.equal(store.recent('english')[0].text, 'Hello');
    assert.equal(store.recent('kazakh')[0].text, 'Сәлем');
});

test('a segment without a channel or id is ignored', () => {
    const store = new TranscriptStore();
    assert.equal(store.update('english', { text: 'no id' }), null);
    assert.equal(store.update('', { segmentId: 'a', text: 'no channel' }), null);
    assert.deepEqual(store.recent('english'), []);
});

test('very long text is clipped', () => {
    const store = new TranscriptStore();
    const segment = store.update('english', { segmentId: 'a', text: 'x'.repeat(MAX_TEXT + 500) });
    assert.equal(segment.text.length, MAX_TEXT);
});

test('retain drops history for removed channels', () => {
    const store = new TranscriptStore();
    store.update('english', { segmentId: 'a', text: 'Hello' });
    store.update('spanish', { segmentId: 'a', text: 'Hola' });
    store.retain(new Set(['english']));
    assert.equal(store.recent('english').length, 1);
    assert.deepEqual(store.recent('spanish'), []);
});

test('recent returns copies the caller cannot use to change the store', () => {
    const store = new TranscriptStore();
    store.update('english', { segmentId: 'a', text: 'Hello' });
    store.recent('english')[0].text = 'changed';
    assert.equal(store.recent('english')[0].text, 'Hello');
});
