import LANGUAGE_CODES from '../../lib/language-codes.json';

// The languages offered when adding a channel, named in the operator's own interface language
// so nobody has to know the codes. The server checks codes the same way (lib/languages.cjs).

export interface LanguageOption {
    code: string;
    /** In the interface language, such as "Chinese" or "Китайский". */
    name: string;
    /** In the language itself, such as "中文". */
    native: string;
}

const displayName = (code: string, locale: string) => {
    try { return new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(code) || ''; }
    catch { return ''; }
};

/** Every listed language, sorted by its name in the interface language. */
export function languageOptions(locale: string): LanguageOption[] {
    return (LANGUAGE_CODES as string[])
        .map((code) => ({ code, name: displayName(code, locale) || code, native: displayName(code, code) }))
        .sort((left, right) => left.name.localeCompare(right.name, locale));
}

/** What a code means in the interface language, or '' when it is not a language code. */
export function describeLanguageCode(code: string, locale: string) {
    const value = code.trim();
    if (!value) return '';
    try { return displayName(Intl.getCanonicalLocales(value)[0], locale); } catch { return ''; }
}

const NAME_ALIASES: Record<string, string> = { 'қазақша': 'kk', mandarin: 'zh', farsi: 'fa' };

/** The listed language a channel name means, in any of the interface languages or its own. */
export function codeFromName(name: string, locales: readonly string[]) {
    const value = name.trim().toLowerCase();
    if (!value) return '';
    if (NAME_ALIASES[value]) return NAME_ALIASES[value];
    for (const code of LANGUAGE_CODES as string[]) {
        for (const locale of [...locales, code]) if (displayName(code, locale).toLowerCase() === value) return code;
    }
    return '';
}

/** True when the code is one of the listed languages (anything else goes in "Other code"). */
export const isListedLanguage = (code: string) => (LANGUAGE_CODES as string[]).includes(code.trim().toLowerCase());
