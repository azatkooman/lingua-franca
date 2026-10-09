const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, INTERFACE_LANGUAGES, normalizeContact, normalizeEvent, publicSettings } = require('./settings.cjs');

test('normalizeEvent trims the name and keeps valid dates', () => {
    assert.deepEqual(normalizeEvent({ name: '  Congress 2026 ', startDate: '2026-10-05', endDate: '2026-10-06' }),
        { name: 'Congress 2026', startDate: '2026-10-05', endDate: '2026-10-06' });
});

test('normalizeEvent swaps dates entered in the wrong order', () => {
    assert.deepEqual(normalizeEvent({ startDate: '2026-10-06', endDate: '2026-10-05' }),
        { name: '', startDate: '2026-10-05', endDate: '2026-10-06' });
});

test('normalizeEvent rejects days that do not exist and stray characters', () => {
    assert.equal(normalizeEvent({ startDate: '2026-02-30' }).startDate, '');
    assert.equal(normalizeEvent({ startDate: '2026-10-05x' }).startDate, '');
    assert.equal(normalizeEvent({ startDate: '05.10.2026' }).startDate, '');
});

test('normalizeEvent treats a lone end date as a one-day event, and drops an equal end', () => {
    assert.deepEqual(normalizeEvent({ endDate: '2026-10-05' }), { name: '', startDate: '2026-10-05', endDate: '' });
    assert.deepEqual(normalizeEvent({ startDate: '2026-10-05', endDate: '2026-10-05' }), { name: '', startDate: '2026-10-05', endDate: '' });
});

test('normalizeContact keeps only safe characters for links it builds itself', () => {
    assert.deepEqual(normalizeContact({
        name: ' Support ', phone: '+7 (701) 000-00-00<script>', whatsapp: 'javascript:alert(1)',
        telegram: 'https://t.me/event_help', email: 'help@example.com',
    }), { name: 'Support', phone: '+7 (701) 000-00-00', whatsapp: '', telegram: 'event_help', email: 'help@example.com' });
});

test('normalizeContact drops a phone with too few digits to be one', () => {
    assert.equal(normalizeContact({ phone: '(1)' }).phone, '');
    assert.equal(normalizeContact({ phone: '+7 701 000 00 00' }).phone, '+7 701 000 00 00');
});

test('normalizeContact drops an invalid email', () => {
    assert.equal(normalizeContact({ email: 'not an email' }).email, '');
});

test('listeners receive the event and contact, cleaned', () => {
    const payload = publicSettings({
        ...DEFAULT_SETTINGS,
        event: { name: 'Congress', startDate: '2026-10-05' },
        contact: { name: 'Help desk', email: 'bad' },
    }, new Map());
    assert.equal(payload.event.name, 'Congress');
    assert.equal(payload.contact.name, 'Help desk');
    assert.equal(payload.contact.email, '');
});

test('Kazakh is an interface language', () => {
    assert.deepEqual(INTERFACE_LANGUAGES, ['en', 'ru', 'kk']);
});
