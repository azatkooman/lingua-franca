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
    preferredAddress: '',
    recordingEnabled: false,
    transcriptsEnabled: true,
    certificateMode: 'self-signed',
    certificateHostname: '',
    certificateEmail: '',
    event: { name: '', startDate: '', endDate: '' },
    contact: { name: '', phone: '', whatsapp: '', telegram: '', email: '' },
};

// Interface languages every screen offers. Kazakh joined English and Russian in 1.4.
const INTERFACE_LANGUAGES = ['en', 'ru', 'kk'];

const clip = (value, length) => String(value ?? '').trim().slice(0, length);
// A real calendar day. Date.parse alone accepts 2026-02-30 and silently rolls it into March.
const isIsoDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const isoDateOrEmpty = (value) => {
    const raw = String(value ?? '').trim();
    return isIsoDate(raw) ? raw : '';
};

// The event listeners see on the lobby and listening screens. Dates are optional calendar
// days (YYYY-MM-DD); an end before the start is swapped rather than rejected, since that is
// what an operator who picked them in the wrong order meant.
function normalizeEvent(event) {
    const name = clip(event?.name, 120);
    let startDate = isoDateOrEmpty(event?.startDate);
    let endDate = isoDateOrEmpty(event?.endDate);
    if (!startDate && endDate) { startDate = endDate; endDate = ''; }
    if (startDate && endDate && endDate < startDate) [startDate, endDate] = [endDate, startDate];
    if (endDate === startDate) endDate = '';
    return { name, startDate, endDate };
}

// Who a listener can reach when there is no sound. Shown publicly on every phone, so only
// what the organiser chose to publish. Stored cleaned; the app builds the tel:, wa.me,
// t.me and mailto: links itself, so nothing here is ever used as a raw URL.
function normalizeContact(contact) {
    const phone = (value) => {
        const cleaned = clip(value, 32).replace(/[^\d+()\- ]/g, '').trim();
        return cleaned.replace(/\D/g, '').length >= 5 ? cleaned : '';
    };
    const telegram = clip(contact?.telegram, 64).replace(/^https?:\/\/t\.me\//i, '').replace(/[^\w@+]/g, '');
    const email = clip(contact?.email, 120);
    return {
        name: clip(contact?.name, 80),
        phone: phone(contact?.phone),
        whatsapp: phone(contact?.whatsapp),
        telegram,
        email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    };
}

const KNOWN_LANGUAGE_CODES = {
    english: 'en', russian: 'ru', 'русский': 'ru', spanish: 'es', 'español': 'es',
    french: 'fr', 'français': 'fr', german: 'de', deutsch: 'de', kazakh: 'kk', 'қазақша': 'kk',
};

function inferLanguageCode(name) {
    const value = String(name || '').toLowerCase();
    return KNOWN_LANGUAGE_CODES[value] || value.slice(0, 2) || 'en';
}

// Settings from the retired text fallback (browser speech recognition plus Gemini or
// MyMemory). Translation is OpenAI only now, so these are dropped from the settings file on
// load, including a stored Gemini key, rather than kept on disk doing nothing. The glossary
// only ever reached Gemini; OpenAI's realtime translation model accepts no custom terms.
const RETIRED_SETTINGS = ['aiProvider', 'glossary', 'geminiApiKey', 'geminiApiKeyEncrypted'];

function dropRetiredSettings(settings) {
    for (const key of RETIRED_SETTINGS) delete settings[key];
    return settings;
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

// Listener payload. Deliberately excludes the preferred adapter address and everything else
// operator-only, which no listener needs.
function publicSettings(settings, liveChannels) {
    return {
        languages: settings.languages.map((language) => ({
            ...language,
            activePeerId: liveChannels?.get(language.id)?.mode,
            // 'original' when the channel carries the speaker's own voice and captions, so a
            // phone can say so instead of calling it a translation.
            liveRole: liveChannels?.get(language.id)?.role,
        })),
        interfaceLanguage: settings.interfaceLanguage,
        event: normalizeEvent(settings.event),
        contact: normalizeContact(settings.contact),
    };
}

// Operator payload: everything the Admin screen needs, secrets excluded.
function adminSettings(settings, liveChannels) {
    return {
        ...publicSettings(settings, liveChannels),
        openaiConfigured: Boolean(settings.openaiApiKeyEncrypted),
        preferredAddress: settings.preferredAddress || '',
        recordingEnabled: Boolean(settings.recordingEnabled),
        transcriptsEnabled: settings.transcriptsEnabled !== false,
        duckDnsConfigured: Boolean(settings.duckDnsTokenEncrypted),
        certificateHostname: settings.certificateHostname || '',
        certificateEmail: settings.certificateEmail || '',
    };
}

// Adapter names that are never the venue Wi-Fi. "vEthernet (...)" is what Hyper-V and WSL
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
    INTERFACE_LANGUAGES,
    normalizeContact,
    normalizeEvent,
    RETIRED_SETTINGS,
    adminSettings,
    dropRetiredSettings,
    findLanguage,
    inferLanguageCode,
    isValidDuckDnsDomain,
    isValidEmail,
    normalizeDuckDnsDomain,
    normalizeLanguage,
    normalizeLanguages,
    publicSettings,
    selectLocalAddress,
    slugify,
};
