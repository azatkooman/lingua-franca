const test = require('node:test');
const assert = require('node:assert');
const { ListenerReports } = require('./listener-reports.cjs');
const { budgetLevel, isVirtualAdapter, normalizeBudget, normalizeSilencePause, adminSettings } = require('./settings.cjs');
const { ExpiringMap } = require('./security.cjs');

test('listener reports count distinct phones per channel within the window', () => {
    let clock = 0;
    const reports = new ListenerReports({ windowMs: 1000, repeatMs: 500, now: () => clock });
    assert.deepEqual(reports.record('english', 'a'), { accepted: true, count: 1 });
    assert.deepEqual(reports.record('english', 'b'), { accepted: true, count: 2 });
    assert.deepEqual(reports.record('russian', 'a'), { accepted: true, count: 1 });
    clock = 1001;
    assert.equal(reports.count('english'), 0, 'old reports drop out');
});

test('a phone repeating its report within a minute counts once', () => {
    let clock = 0;
    const reports = new ListenerReports({ windowMs: 10_000, repeatMs: 500, now: () => clock });
    reports.record('english', 'a');
    assert.deepEqual(reports.record('english', 'a'), { accepted: false, count: 1 });
    clock = 600;
    assert.equal(reports.record('english', 'a').accepted, true, 'counts again after the repeat window');
    assert.equal(reports.count('english'), 1, 'still one phone');
});

test('listener reports forget a phone that left and refuse anonymous ones', () => {
    const reports = new ListenerReports({ now: () => 0 });
    reports.record('english', 'a');
    reports.forget('a');
    assert.equal(reports.count('english'), 0);
    assert.equal(reports.record('', 'a').accepted, false);
    assert.equal(reports.record('english', '').accepted, false);
});

test('listener reports prune empty channels', () => {
    let clock = 0;
    const reports = new ListenerReports({ windowMs: 100, now: () => clock });
    reports.record('english', 'a');
    clock = 200;
    reports.prune();
    assert.equal(reports.channels.size, 0);
});

test('budget levels warn at 80% and at 100%, and never without a budget', () => {
    assert.equal(budgetLevel(5, 10), 0);
    assert.equal(budgetLevel(8, 10), 80);
    assert.equal(budgetLevel(9.99, 10), 80);
    assert.equal(budgetLevel(10, 10), 100);
    assert.equal(budgetLevel(50, 0), 0);
});

test('a budget is rounded to cents and capped; anything unusable is no budget', () => {
    assert.equal(normalizeBudget('12.345'), 12.35);
    assert.equal(normalizeBudget(-5), 0);
    assert.equal(normalizeBudget('abc'), 0);
    assert.equal(normalizeBudget(1e9), 10_000);
});

test('the silence pause only takes an offered delay', () => {
    assert.equal(normalizeSilencePause(5), 5);
    assert.equal(normalizeSilencePause('10'), 10);
    assert.equal(normalizeSilencePause(3), 0);
    assert.equal(normalizeSilencePause(undefined), 0);
});

test('the operator payload carries the budget and silence pause', () => {
    const payload = adminSettings({ languages: [], aiBudgetUsd: 20, aiSilencePauseMinutes: 5 }, new Map());
    assert.equal(payload.aiBudgetUsd, 20);
    assert.equal(payload.aiSilencePauseMinutes, 5);
});

test('virtual adapters are recognised by name', () => {
    assert.ok(isVirtualAdapter('vEthernet (Default Switch)'));
    assert.ok(isVirtualAdapter('Tailscale'));
    assert.ok(!isVirtualAdapter('Wi-Fi'));
});

test('ExpiringMap reports when a live entry ends', () => {
    let clock = 0;
    const map = new ExpiringMap({ now: () => clock });
    map.set('token', {}, 1000);
    assert.equal(map.expiresAt('token'), 1000);
    clock = 1000;
    assert.equal(map.expiresAt('token'), 0);
    assert.equal(map.expiresAt('missing'), 0);
});
