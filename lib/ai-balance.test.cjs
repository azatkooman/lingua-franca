const test = require('node:test');
const assert = require('node:assert/strict');
const { balanceLevel, isOutOfCredit, normalizeAmount, normalizeBalance, remainingUsd } = require('./ai-balance.cjs');

test('an entered balance is kept in cents, and nothing usable means no balance', () => {
    assert.deepEqual(normalizeBalance({ amountUsd: '49.999', setAt: 5, spentUsd: 1.5 }), { amountUsd: 50, setAt: 5, spentUsd: 1.5 });
    for (const amountUsd of [0, -3, 'lots', undefined]) assert.equal(normalizeBalance({ amountUsd }), null);
    assert.equal(normalizeBalance({ amountUsd: 10, spentUsd: -2 }).spentUsd, 0);
    assert.equal(normalizeAmount(2e9), 100_000);
});

test('what is left subtracts what was spent and what is running now', () => {
    const balance = { amountUsd: 50, setAt: 1, spentUsd: 12.345 };
    assert.equal(remainingUsd(balance), 37.66);
    assert.equal(remainingUsd(balance, 2.5), 35.16);
    assert.equal(remainingUsd(balance, -4), 37.66, 'a negative running cost is ignored');
    assert.equal(remainingUsd(null, 3), null);
});

test('the operator is warned below the chosen amount, and told when it is used up', () => {
    assert.equal(balanceLevel(20, 5), null);
    assert.equal(balanceLevel(4.99, 5), 'low');
    assert.equal(balanceLevel(0, 5), 'empty');
    assert.equal(balanceLevel(-1, 0), 'empty');
    assert.equal(balanceLevel(3, 0), null, 'no warning amount: only "used up"');
    assert.equal(balanceLevel(null, 5), null);
});

test('OpenAI errors meaning "no credit left" are recognised', () => {
    assert.equal(isOutOfCredit({ error: { code: 'insufficient_quota' } }), true);
    assert.equal(isOutOfCredit({ error: { code: 'credit_balance_exhausted' } }), true);
    assert.equal(isOutOfCredit({ error: { type: 'insufficient_quota' } }), true);
    assert.equal(isOutOfCredit({ error: { code: 'invalid_api_key' } }), false);
    assert.equal(isOutOfCredit({}), false);
});
