// Credential and session primitives. No Electron imports, so this is unit testable.

const crypto = require('crypto');

const SCRYPT_KEY_BYTES = 32;
const SALT_BYTES = 16;

function isValidPin(pin) {
    return /^\d{4,12}$/.test(String(pin ?? ''));
}

function setPin(settings, pin) {
    const salt = crypto.randomBytes(SALT_BYTES);
    settings.adminPinSalt = salt.toString('base64');
    settings.adminPinHash = crypto.scryptSync(String(pin), salt, SCRYPT_KEY_BYTES).toString('base64');
    delete settings.adminPin;
    return settings;
}

function verifyPin(settings, pin) {
    if (!settings?.adminPinSalt || !settings?.adminPinHash) return false;
    let expected;
    try { expected = Buffer.from(settings.adminPinHash, 'base64'); }
    catch { return false; }
    if (expected.length !== SCRYPT_KEY_BYTES) return false;
    const actual = crypto.scryptSync(String(pin ?? ''), Buffer.from(settings.adminPinSalt, 'base64'), SCRYPT_KEY_BYTES);
    return crypto.timingSafeEqual(actual, expected);
}

function newToken() {
    return crypto.randomBytes(32).toString('base64url');
}

// Six digits with a leading zero preserved, drawn from a CSPRNG.
function newAccessCode() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// Escalating lockout. A flat "5 tries per minute" still exhausts a 4-digit PIN in about a
// day of unattended grinding; doubling the penalty per strike pushes that past any realistic
// window while staying invisible to an operator who simply mistypes once.
class LoginThrottle {
    constructor({ maxAttempts = 5, baseDelayMs = 30_000, maxDelayMs = 30 * 60_000, entryTtlMs = 24 * 60 * 60_000, now = Date.now } = {}) {
        this.maxAttempts = maxAttempts;
        this.baseDelayMs = baseDelayMs;
        this.maxDelayMs = maxDelayMs;
        this.entryTtlMs = entryTtlMs;
        this.now = now;
        this.entries = new Map();
    }

    status(key) {
        const entry = this.entries.get(key);
        if (!entry) return { blocked: false, retryAfterMs: 0 };
        const remaining = entry.blockedUntil - this.now();
        return remaining > 0 ? { blocked: true, retryAfterMs: remaining } : { blocked: false, retryAfterMs: 0 };
    }

    fail(key) {
        const entry = this.entries.get(key) || { failures: 0, strikes: 0, blockedUntil: 0, seenAt: 0 };
        entry.failures += 1;
        entry.seenAt = this.now();
        if (entry.failures >= this.maxAttempts) {
            entry.failures = 0;
            entry.strikes += 1;
            const delay = Math.min(this.baseDelayMs * 2 ** (entry.strikes - 1), this.maxDelayMs);
            entry.blockedUntil = this.now() + delay;
        }
        this.entries.set(key, entry);
        return this.status(key);
    }

    succeed(key) {
        this.entries.delete(key);
    }

    prune() {
        const cutoff = this.now() - this.entryTtlMs;
        for (const [key, entry] of this.entries) {
            if (entry.seenAt < cutoff && entry.blockedUntil < this.now()) this.entries.delete(key);
        }
    }
}

// Map whose entries disappear at their own deadline, so sessions and one-time codes cannot
// accumulate for the lifetime of the process.
class ExpiringMap {
    constructor({ now = Date.now } = {}) {
        this.now = now;
        this.entries = new Map();
    }

    set(key, value, expiresAt) {
        this.entries.set(key, { value, expiresAt });
        return this;
    }

    get(key) {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= this.now()) { this.entries.delete(key); return undefined; }
        return entry.value;
    }

    has(key) {
        return this.get(key) !== undefined;
    }

    // Single-use retrieval for interpreter codes: a valid code is consumed by reading it.
    take(key) {
        const value = this.get(key);
        if (value !== undefined) this.entries.delete(key);
        return value;
    }

    delete(key) {
        return this.entries.delete(key);
    }

    // Live keys only, as a snapshot, so callers can delete while they walk the result. Used to
    // revoke sessions, where an already-expired entry needs no revoking.
    keys() {
        const now = this.now();
        return [...this.entries].filter(([, entry]) => entry.expiresAt > now).map(([key]) => key);
    }

    clear() {
        this.entries.clear();
    }

    prune() {
        const now = this.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) this.entries.delete(key);
        }
    }

    get size() {
        return this.entries.size;
    }
}

module.exports = { ExpiringMap, LoginThrottle, isValidPin, newAccessCode, newToken, setPin, verifyPin };
