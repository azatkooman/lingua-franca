const test = require('node:test');
const assert = require('node:assert/strict');
const { ExpiringMap } = require('./security.cjs');

test('ExpiringMap.keys lists only live entries', () => {
    let now = 1000;
    const map = new ExpiringMap({ now: () => now });
    map.set('live', 1, 5000);
    map.set('stale', 2, 1500);
    now = 2000;
    assert.deepEqual(map.keys(), ['live']);
});

test('ExpiringMap.keys is a snapshot that survives deletes during iteration', () => {
    const map = new ExpiringMap({ now: () => 0 });
    map.set('a', 1, 10).set('b', 2, 10).set('c', 3, 10);
    for (const key of map.keys()) map.delete(key);
    assert.equal(map.size, 0);
});

test('ExpiringMap.clear removes everything', () => {
    const map = new ExpiringMap({ now: () => 0 });
    map.set('a', 1, 10).set('b', 2, 10);
    map.clear();
    assert.equal(map.has('a'), false);
    assert.equal(map.size, 0);
});
