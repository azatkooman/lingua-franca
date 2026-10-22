const test = require('node:test');
const assert = require('node:assert/strict');
const { AudioQuality } = require('./audio-quality.cjs');

const setup = () => {
    let clock = 0;
    const quality = new AudioQuality({ now: () => clock });
    return { quality, advance: (ms) => { clock += ms; } };
};

test('phones on a channel are averaged, and those losing 5% or more count as poor', () => {
    const { quality } = setup();
    assert.equal(quality.reportPhone('a', 'english', 0), true);
    assert.equal(quality.reportPhone('b', 'english', 0.02), true);
    assert.equal(quality.reportPhone('c', 'english', 0.1), true);
    assert.equal(quality.reportPhone('d', 'russian', 0.5), true);
    assert.deepEqual(quality.summary('english'), { phones: 3, loss: 0.04, poor: 1, link: null });
    assert.deepEqual(quality.summary('kazakh'), { phones: 0, loss: 0, poor: 0, link: null });
});

test('a phone reporting too often is ignored, unless it changed channel', () => {
    const { quality, advance } = setup();
    quality.reportPhone('a', 'english', 0.2);
    advance(1000);
    assert.equal(quality.reportPhone('a', 'english', 0), false);
    assert.equal(quality.summary('english').loss, 0.2);
    assert.equal(quality.reportPhone('a', 'russian', 0), true, 'a channel switch counts at once');
    assert.equal(quality.summary('english').phones, 0);
});

test('bad values are refused and shares above one are capped', () => {
    const { quality } = setup();
    for (const value of [-0.1, Number.NaN, 'lots', undefined, Infinity]) assert.equal(quality.reportPhone('a', 'english', value), false);
    assert.equal(quality.reportPhone('', 'english', 0), false);
    assert.equal(quality.reportPhone('a', 'english', 3), true);
    assert.equal(quality.summary('english').loss, 1);
});

test('the AI link is shown per channel until it goes stale or the broadcast ends', () => {
    const { quality, advance } = setup();
    assert.equal(quality.reportLink('english', {}), false);
    assert.equal(quality.reportLink('english', { received: 0.012, sent: 0 }), true);
    assert.deepEqual(quality.summary('english').link, { received: 0.012, sent: 0 });
    advance(31_000);
    assert.equal(quality.summary('english').link, null);
    quality.reportLink('english', { received: 0 });
    quality.forgetLink('english');
    assert.equal(quality.summary('english').link, null);
});

test('phones that leave or go quiet stop counting', () => {
    const { quality, advance } = setup();
    quality.reportPhone('a', 'english', 0.1);
    quality.reportPhone('b', 'english', 0.1);
    quality.forgetPhone('a');
    assert.equal(quality.summary('english').phones, 1);
    advance(31_000);
    assert.equal(quality.summary('english').phones, 0);
    quality.prune();
    assert.equal(quality.phones.size, 0);
});
