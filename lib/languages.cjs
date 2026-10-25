// Language codes for channels. The AI translator is told which language to speak from the
// channel's code, so a wrong code used to go through silently: "ch" is Chamorro, not Chinese,
// and a made-up code like "cn" left the translator guessing. Codes are now checked against
// the languages the system knows, common mix-ups with country codes are corrected, and a code
// that disagrees with the channel's name is flagged. Pure, so it is unit tested.

const LANGUAGE_CODES = require('./language-codes.json');

const englishNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

// Country codes people type for a language. Only ones that are not themselves language codes
// are corrected; "kr" (Kanuri) or "se" (Northern Sami) are real languages and are flagged
// instead when the channel's name says otherwise.
const COUNTRY_CODE_MISTAKES = {
    cn: 'zh', jp: 'ja', ua: 'uk', cz: 'cs', dk: 'da', gr: 'el', il: 'he', kz: 'kk', vn: 'vi',
    gb: 'en', us: 'en', rs: 'sr', ir: 'fa',
};

// Names typed for a channel that the system's own names do not cover.
const NAME_ALIASES = { 'қазақша': 'kk', 'mandarin': 'zh', 'chinese mandarin': 'zh', 'putonghua': 'zh', 'farsi': 'fa' };

/** The code in its standard form ("zh-hant" -> "zh-hant"), or '' when it is not a code at all. */
function canonicalCode(code) {
    const value = String(code ?? '').trim();
    if (!value) return '';
    try { return Intl.getCanonicalLocales(value)[0].toLowerCase(); } catch { return ''; }
}

/** The English name of a language code, or '' when the code means nothing. */
function languageNameOf(code) {
    const value = canonicalCode(code);
    if (!value) return '';
    try { return englishNames.of(value) || ''; } catch { return ''; }
}

const isKnownLanguageCode = (code) => Boolean(languageNameOf(code));

let nameIndex = null;
/** Channel name -> code, from each listed language's name in English, Russian, Kazakh and itself. */
function codeFromName(name) {
    if (!nameIndex) {
        nameIndex = new Map(Object.entries(NAME_ALIASES));
        for (const code of LANGUAGE_CODES) {
            for (const locale of ['en', 'ru', 'kk', code]) {
                try {
                    const label = new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(code);
                    if (label && !nameIndex.has(label.toLowerCase())) nameIndex.set(label.toLowerCase(), code);
                } catch { /* a locale this system lacks */ }
            }
        }
    }
    return nameIndex.get(String(name ?? '').trim().toLowerCase()) || '';
}

/**
 * The code to store for a channel: the code given in standard form, a country code turned
 * into its language, or with no usable code, the language the name points to. An unknown code
 * is kept as typed (the operator is told), so nothing saved is ever silently replaced.
 */
function resolveLanguageCode(code, name) {
    const value = canonicalCode(code);
    if (!value) return codeFromName(name);
    if (!isKnownLanguageCode(value) && COUNTRY_CODE_MISTAKES[value]) return COUNTRY_CODE_MISTAKES[value];
    return value;
}

const base = (code) => code.split('-')[0];

/**
 * What Admin says about a channel's language: the language its code means, and a problem
 * when the code means nothing ('unknown') or a different language from the name ('mismatch'),
 * with the code the name points to when there is one.
 */
function checkLanguage({ code, name } = {}) {
    const meaning = languageNameOf(code);
    const fromName = codeFromName(name);
    if (!meaning) return { meaning: '', problem: 'unknown', suggestion: fromName || null };
    if (fromName && base(fromName) !== base(canonicalCode(code))) return { meaning, problem: 'mismatch', suggestion: fromName };
    return { meaning, problem: null, suggestion: null };
}

/**
 * The language to tell the AI translator for a channel. When the code and the name disagree,
 * the name wins: it is what the operator chose and reads, while codes are easy to get wrong.
 * With neither recognised, the channel's own name is the best description there is.
 */
function aiLanguageName(language) {
    const check = checkLanguage(language);
    if (check.suggestion) return languageNameOf(check.suggestion);
    return check.meaning || String(language?.name || '').trim() || 'English';
}

module.exports = {
    COUNTRY_CODE_MISTAKES,
    LANGUAGE_CODES,
    aiLanguageName,
    canonicalCode,
    checkLanguage,
    codeFromName,
    isKnownLanguageCode,
    languageNameOf,
    resolveLanguageCode,
};
