// Pure settings helpers. Kept free of Electron imports so they can be unit tested
// with `node --test`.

const DEFAULT_LANGUAGES = [
    { id: 'english', name: 'English', code: 'en', description: 'Main English translation channel' },
    { id: 'russian', name: 'Русский', code: 'ru', description: 'Русский канал' },
];

const DEFAULT_SETTINGS = {
    languages: DEFAULT_LANGUAGES,
    adminPin: '1234',
    interfaceLanguage: 'en',
    aiProvider: 'openai',
    glossary: 'Jesus Christ; Holy Spirit; Gospel; Bible; church; pastor',
    preferredAddress: '',
    recordingEnabled: false,
    certificateMode: 'self-signed',
    certificateHostname: '',
    certificateEmail: '',
};

const KNOWN_LANGUAGE_CODES = {
    english: 'en', russian: 'ru', 'русский': 'ru', spanish: 'es', 'español': 'es',
    french: 'fr', 'français': 'fr', german: 'de', deutsch: 'de', kazakh: 'kk', 'қазақша': 'kk',
};

function inferLanguageCode(name) {
    const value = String(name || '').toLowerCase();
    return KNOWN_LANGUAGE_CODES[value] || value.slice(0, 2) || 'en';
}

// The operator already typed an ISO code for every channel, so use it. Guessing from the
// display name only knows a dozen names and turns anything else, such as "Українська",
// into a code no translation service accepts.
function languageCodeFor(languages, value) {
    const key = String(value || '').trim();
    const match = (languages || []).find((language) =>
        language.id === key || language.name === key || language.code === key);
    return match?.code || inferLanguageCode(key);
}

// Prompt for the Gemini text fallback. The glossary is the operator's list of names and
// church terms; it used to be saved and then sent nowhere. The OpenAI realtime translation
// model does not accept custom instructions, so this is the only place it can take effect.
function buildTranslationPrompt({ text, sourceLang, targetLang, glossary }) {
    const terms = String(glossary || '').trim();
    const lines = [`Translate the text below from ${sourceLang} to ${targetLang}. Return only the translation.`];
    if (terms) lines.push(`Keep these names and terms accurate and spelled consistently: ${terms}`);
    lines.push('', String(text || ''));
    return lines.join('\n');
}

function slugify(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '');
}

function normalizeLanguage(language) {
    const name = String(language?.name || '').trim();
    return {
        id: slugify(language?.id) || slugify(name),
        name,
        code: String(language?.code || inferLanguageCode(name)).toLowerCase().slice(0, 8),
        description: String(language?.description || ''),
    };
}

// Channel identity is the wire key for producers, consumers and captions, so ids must be
// stable across renames and unique within the list. Renaming a channel keeps its id, which
// is what stops a live broadcast from being orphaned mid-service.
function normalizeLanguages(languages) {
    const used = new Set();
    const result = [];
    for (const entry of Array.isArray(languages) ? languages : []) {
        const language = normalizeLanguage(entry);
        if (!language.name) continue;
        let id = language.id || `channel-${result.length + 1}`;
        if (used.has(id)) {
            let suffix = 2;
            while (used.has(`${id}-${suffix}`)) suffix += 1;
            id = `${id}-${suffix}`;
        }
        used.add(id);
        result.push({ ...language, id });
    }
    return result;
}

function findLanguage(languages, channelId) {
    return (languages || []).find((language) => language.id === channelId) || null;
}

// Listener payload. Deliberately excludes the glossary (it holds congregant names) and the
// preferred adapter address, which no listener needs.
function publicSettings(settings, liveChannels) {
    return {
        languages: settings.languages.map((language) => ({
            ...language,
            activePeerId: liveChannels?.get(language.id)?.mode,
        })),
        interfaceLanguage: settings.interfaceLanguage,
    };
}

// Operator payload: everything the Admin screen needs, secrets excluded.
function adminSettings(settings, liveChannels) {
    return {
        ...publicSettings(settings, liveChannels),
        aiProvider: settings.aiProvider,
        openaiConfigured: Boolean(settings.openaiApiKeyEncrypted),
        geminiConfigured: Boolean(settings.geminiApiKeyEncrypted),
        glossary: settings.glossary || '',
        preferredAddress: settings.preferredAddress || '',
        recordingEnabled: Boolean(settings.recordingEnabled),
        duckDnsConfigured: Boolean(settings.duckDnsTokenEncrypted),
        certificateHostname: settings.certificateHostname || '',
        certificateEmail: settings.certificateEmail || '',
    };
}

// Adapter names that are never the church Wi-Fi. "vEthernet (...)" is what Hyper-V and WSL
// actually call themselves on Windows, so matching only "hyper-v" misses the common case.
const VIRTUAL_ADAPTER = /virtual|vmware|vbox|hyper-?v|vethernet|wsl|docker|bluetooth|loopback|tailscale|zerotier|vpn|utun|tap\b|tun\d/i;

function selectLocalAddress(addresses, preferred) {
    if (preferred && addresses.some((entry) => entry.address === preferred)) return preferred;
    return addresses.find((entry) => !VIRTUAL_ADAPTER.test(entry.name))?.address
        || addresses[0]?.address || '127.0.0.1';
}

function normalizeDuckDnsDomain(value) {
    return String(value || '').trim().toLowerCase().replace(/\.duckdns\.org$/, '');
}

function isValidDuckDnsDomain(domain) {
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain);
}

function isValidEmail(email) {
    return /^\S+@\S+\.\S+$/.test(String(email || '').trim());
}

module.exports = {
    DEFAULT_SETTINGS,
    adminSettings,
    buildTranslationPrompt,
    findLanguage,
    inferLanguageCode,
    isValidDuckDnsDomain,
    isValidEmail,
    languageCodeFor,
    normalizeDuckDnsDomain,
    normalizeLanguage,
    normalizeLanguages,
    publicSettings,
    selectLocalAddress,
    slugify,
};
