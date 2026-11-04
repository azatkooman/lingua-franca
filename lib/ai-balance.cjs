// An estimate of the OpenAI credit left. OpenAI has no way for an app to read the balance, so
// the operator enters it after topping up and the app subtracts the AI time it runs. It only
// knows this app's use: the operator re-enters the real figure now and then. Pure, so it is
// unit tested.

const MAX_BALANCE_USD = 100_000;
// The default amount below which the operator is warned to top up.
const DEFAULT_WARN_USD = 5;

/** Dollars rounded to cents, or 0 for anything unusable. */
function normalizeAmount(value, max = MAX_BALANCE_USD) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.round(Math.min(number, max) * 100) / 100;
}

/**
 * The stored balance: the amount entered, when, and what the app has spent since. Null when
 * no balance has been entered (or it was cleared).
 */
function normalizeBalance(balance) {
    const amountUsd = normalizeAmount(balance?.amountUsd);
    if (!amountUsd) return null;
    const setAt = Number(balance?.setAt);
    const spentUsd = Number(balance?.spentUsd);
    return {
        amountUsd,
        setAt: Number.isFinite(setAt) && setAt > 0 ? setAt : Date.now(),
        spentUsd: Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0,
    };
}

/** What is left: the amount entered, less what was spent and what is running now. */
function remainingUsd(balance, runningUsd = 0) {
    if (!balance) return null;
    return Math.round((balance.amountUsd - balance.spentUsd - Math.max(0, runningUsd)) * 100) / 100;
}

/** 'empty' at or below zero, 'low' below the warning amount, otherwise null. */
function balanceLevel(remaining, warnUsd) {
    if (remaining === null || remaining === undefined) return null;
    if (remaining <= 0) return 'empty';
    if (warnUsd > 0 && remaining < warnUsd) return 'low';
    return null;
}

// OpenAI's error codes when the account has no credit left to start a session.
const OUT_OF_CREDIT_CODES = new Set(['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached', 'billing_not_active']);

/** True when an OpenAI error body says the account is out of credit. */
const isOutOfCredit = (body) => OUT_OF_CREDIT_CODES.has(String(body?.error?.code || body?.error?.type || ''));

module.exports = { DEFAULT_WARN_USD, balanceLevel, isOutOfCredit, normalizeAmount, normalizeBalance, remainingUsd };
