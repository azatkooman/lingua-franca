const test = require('node:test');
const assert = require('node:assert');
const { ExpiringMap, LoginThrottle, isValidPin, newAccessCode, newToken, setPin, verifyPin } = require('./security.cjs');

test('setPin stores a salted hash and never the PIN itself', () => {
    const settings = { adminPin: '1234' };
    setPin(settings, '1234');
    assert.equal('adminPin' in settings, false);
    assert.ok(settings.adminPinHash && settings.adminPinSalt);
    assert.ok(!JSON.stringify(settings).includes('"1234"'));
});

test('verifyPin accepts the correct PIN and rejects near misses', () => {
    const settings = setPin({}, '4821');
    assert.ok(verifyPin(settings, '4821'));
    assert.ok(!verifyPin(settings, '4822'));
    assert.ok(!verifyPin(settings, '482'));
    assert.ok(!verifyPin(settings, ''));
});

test('verifyPin salts distinctly, so identical PINs hash differently', () => {
    assert.notEqual(setPin({}, '1234').adminPinHash, setPin({}, '1234').adminPinHash);
});

test('verifyPin fails closed on missing or corrupt stored credentials', () => {
    assert.ok(!verifyPin({}, '1234'));
    assert.ok(!verifyPin(null, '1234'));
    assert.ok(!verifyPin({ adminPinSalt: 'AAAA', adminPinHash: 'short' }, '1234'));
});

test('isValidPin enforces four to twelve digits', () => {
    assert.ok(isValidPin('1234'));
    assert.ok(isValidPin('123456'));
    assert.ok(!isValidPin('123'));
    assert.ok(!isValidPin('1234567890123'));
    assert.ok(!isValidPin('12a4'));
});

test('newAccessCode is always six digits, including leading zeros', () => {
    for (let index = 0; index < 500; index += 1) {
        assert.match(newAccessCode(), /^\d{6}$/);
    }
});

test('newToken returns distinct high-entropy values', () => {
    const tokens = new Set(Array.from({ length: 200 }, newToken));
    assert.equal(tokens.size, 200);
    assert.ok(tokens.values().next().value.length >= 40);
});

test('LoginThrottle blocks only after the attempt budget is spent', () => {
    let clock = 1000;
    const throttle = new LoginThrottle({ maxAttempts: 5, baseDelayMs: 30_000, now: () => clock });
    for (let attempt = 0; attempt < 4; attempt += 1) {
        assert.equal(throttle.fail('phone').blocked, false);
    }
    assert.equal(throttle.fail('phone').blocked, true);
    assert.equal(throttle.status('phone').blocked, true);
});

test('LoginThrottle doubles the penalty for each further strike', () => {
    let clock = 0;
    const throttle = new LoginThrottle({ maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 8000, now: () => clock });
    const strike = () => { throttle.fail('a'); return throttle.fail('a').retryAfterMs; };
    assert.equal(strike(), 1000);
    clock += 1000;
    assert.equal(strike(), 2000);
    clock += 2000;
    assert.equal(strike(), 4000);
    clock += 4000;
    assert.equal(strike(), 8000);
    clock += 8000;
    assert.equal(strike(), 8000, 'penalty is capped at maxDelayMs');
});

test('LoginThrottle unblocks once the penalty elapses', () => {
    let clock = 0;
    const throttle = new LoginThrottle({ maxAttempts: 1, baseDelayMs: 1000, now: () => clock });
    assert.equal(throttle.fail('a').blocked, true);
    clock += 999;
    assert.equal(throttle.status('a').blocked, true);
    clock += 2;
    assert.equal(throttle.status('a').blocked, false);
});

test('LoginThrottle tracks callers independently and resets them on success', () => {
    let clock = 0;
    const throttle = new LoginThrottle({ maxAttempts: 1, baseDelayMs: 1000, now: () => clock });
    throttle.fail('attacker');
    assert.equal(throttle.status('attacker').blocked, true);
    assert.equal(throttle.status('operator').blocked, false);
    clock += 1001;
    throttle.succeed('attacker');
    assert.equal(throttle.status('attacker').blocked, false);
});

test('LoginThrottle prunes stale entries but keeps active blocks', () => {
    let clock = 0;
    const throttle = new LoginThrottle({ maxAttempts: 1, baseDelayMs: 1000, entryTtlMs: 5000, now: () => clock });
    throttle.fail('old');
    clock += 60_000;
    throttle.fail('fresh');
    throttle.prune();
    assert.equal(throttle.entries.has('old'), false);
    assert.equal(throttle.entries.has('fresh'), true);
});

test('ExpiringMap hides and removes entries once they expire', () => {
    let clock = 0;
    const map = new ExpiringMap({ now: () => clock });
    map.set('token', { role: 'admin' }, 1000);
    assert.deepEqual(map.get('token'), { role: 'admin' });
    clock = 1000;
    assert.equal(map.get('token'), undefined);
    assert.equal(map.size, 0, 'reading an expired key drops it');
});

test('ExpiringMap take() consumes a valid entry exactly once', () => {
    const map = new ExpiringMap({ now: () => 0 });
    map.set('123456', { channelId: 'english' }, 1000);
    assert.deepEqual(map.take('123456'), { channelId: 'english' });
    assert.equal(map.take('123456'), undefined);
});

test('ExpiringMap take() returns nothing for an expired code and leaves no residue', () => {
    let clock = 0;
    const map = new ExpiringMap({ now: () => clock });
    map.set('123456', { channelId: 'english' }, 1000);
    clock = 2000;
    assert.equal(map.take('123456'), undefined);
    assert.equal(map.size, 0);
});

test('ExpiringMap prune() clears every lapsed entry', () => {
    let clock = 0;
    const map = new ExpiringMap({ now: () => clock });
    map.set('a', 1, 1000);
    map.set('b', 2, 5000);
    clock = 2000;
    map.prune();
    assert.equal(map.size, 1);
    assert.equal(map.get('b'), 2);
});
