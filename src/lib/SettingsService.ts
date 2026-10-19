import { realtimeSocket } from './realtimeSocket';

export interface Language {
    id: string;
    name: string;
    code: string;
    description: string;
    activePeerId?: 'sfu-active' | 'ai-active';
    /** What a live channel carries; 'original' is the speaker's own voice with captions. */
    liveRole?: 'original' | 'translation' | 'interpreter';
}

export type InterfaceLanguage = 'en' | 'ru' | 'kk';

/** Shown on every listener screen. Dates are calendar days, YYYY-MM-DD, or empty. */
export interface EventInfo {
    name: string;
    startDate: string;
    endDate: string;
}

/** Who listeners can reach behind the header's help button. Empty fields are hidden. */
export interface ContactInfo {
    name: string;
    phone: string;
    whatsapp: string;
    telegram: string;
    email: string;
}

/** What every listener device is allowed to see. Deliberately small. */
export interface AppSettings {
    languages: Language[];
    interfaceLanguage?: InterfaceLanguage;
    event?: EventInfo;
    contact?: ContactInfo;
}

// The listener-visible part of the operator payload. Rebuilding it by hand dropped any field
// added later, so it is picked in one place.
const publicPart = (settings: AppSettings): AppSettings => ({
    languages: settings.languages,
    interfaceLanguage: settings.interfaceLanguage,
    event: settings.event,
    contact: settings.contact,
});

/** Operator-only configuration, fetched separately once an admin session exists. */
export type AiEngine = 'translate' | 'steady';
/** OpenAI's voices for Steady voice; it recommends the first two. */
export const AI_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] as const;
/** Matches the server's limits, so the screen can say when notes will be cut. */
export const MAX_AI_INSTRUCTIONS = 4000;
export const MAX_AI_NOTES = 20_000;

export interface AdminSettings extends AppSettings {
    openaiConfigured: boolean;
    preferredAddress: string;
    recordingEnabled: boolean;
    transcriptsEnabled: boolean;
    duckDnsConfigured: boolean;
    certificateHostname: string;
    certificateEmail: string;
    /** Dollars; 0 = no budget. Warns at 80% and 100%, never stops anything. */
    aiBudgetUsd: number;
    /** Minutes without speech before the OpenAI legs close; 0 = never. */
    aiSilencePauseMinutes: number;
    /** 'translate': the interpreting model (fastest). 'steady': the conversational model, one voice, reads the notes. */
    aiEngine: AiEngine;
    aiVoice: string;
    aiPace: 'faster' | 'balanced' | 'smoother';
    /** Steady voice only: names, terms and style. */
    aiInstructions: string;
    /** Steady voice only: the sermon outline, slide text or other notes for this service. */
    aiNotes: string;
    /** The operator PIN is still the factory 1234; Admin asks for a new one before anything else. */
    pinIsDefault?: boolean;
    /** Set when the settings file was damaged: 'backup' was loaded, or 'defaults'. */
    settingsRecovery?: 'backup' | 'defaults' | null;
}

/** One check in the pre-service list. */
export interface PreflightCheck {
    id: 'admin_pin' | 'settings_file' | 'media' | 'listener_port' | 'network' | 'certificate' | 'microphone' | 'secure_storage' | 'disk' | 'openai';
    status: 'ok' | 'warn' | 'fail';
    detail: string;
}

/** One channel on the operator's live dashboard. */
export interface LiveChannel {
    id: string;
    name: string;
    live: boolean;
    role: 'original' | 'translation' | 'interpreter' | 'test' | null;
    since: number | null;
    paused: boolean;
    listeners: number;
    peakListeners: number;
    recording: boolean;
    /** Phones that tapped "I can't hear" in the last two minutes. */
    reports: number;
    /** When the phone interpreter on air loses access; null for anyone else. */
    accessEndsAt: number | null;
    /** An AI channel whose OpenAI connection is closed for silence. */
    aiPaused: boolean;
    /** An AI channel translated by Steady voice. */
    steady: boolean;
}

export interface LiveStatus {
    channels: LiveChannel[];
    totalListeners: number;
    aiSeconds: number;
    /** Both engines together: per-minute time plus Steady voice's reported usage. */
    aiCostUsd: number;
    aiPricePerMinute: number;
    budgetUsd: number;
    since: number;
    now: number;
}

/** A saved audio recording or caption transcript on the operator's computer. */
export interface RecordingItem {
    name: string;
    type: 'audio' | 'transcript';
    size: number;
    channelId: string;
    channelName: string;
    role?: 'original' | 'translation' | 'interpreter';
    startedAt: string;
    endedAt: string;
    durationMs?: number;
    lines?: number;
    date?: string;
    active: boolean;
}

type Listener<T> = (value: T) => void;

const EMPTY_SETTINGS: AppSettings = { languages: [] };
const SETTINGS_CACHE_KEY = 'lingua_franca_settings_cache';
// The socket pushes changes the moment they happen; this is only a safety net for a client
// whose socket is down, so it can be slow. It used to run every 5s for every phone at once.
const REFRESH_INTERVAL_MS = 60_000;

class SettingsService {
    private settings: AppSettings = EMPTY_SETTINGS;
    private admin: AdminSettings | null = null;
    private adminFetch: Promise<AdminSettings> | null = null;
    private listeners = new Set<Listener<AppSettings>>();
    private adminListeners = new Set<Listener<AdminSettings | null>>();
    private authListeners = new Set<(authenticated: boolean) => void>();
    private interpreterAuthListeners = new Set<(authenticated: boolean) => void>();
    private initialized = false;
    private adminToken = sessionStorage.getItem('lingua_franca_admin_token') || '';
    private interpreterToken = sessionStorage.getItem('lingua_franca_interpreter_token') || '';
    private interpreterChannelId = sessionStorage.getItem('lingua_franca_interpreter_channel_id') || '';
    private interpreterChannelName = sessionStorage.getItem('lingua_franca_interpreter_channel_name') || '';
    // When this phone's interpreter access ends (epoch ms), for the warning before it does.
    private interpreterExpiresAt = Number(sessionStorage.getItem('lingua_franca_interpreter_expires_at')) || 0;
    private refreshTimer: number;

    constructor() {
        this.restoreCache();
        void this.fetchSettings();
        realtimeSocket.setAuthToken(this.getPublisherToken());
        realtimeSocket.on<AppSettings>('settingsChanged', (settings) => {
            this.settings = settings;
            this.initialized = true;
            this.cache();
            this.notify();
            // Channel state changes can coincide with configuration changes the operator
            // screen renders, so keep its payload in step.
            if (this.adminToken) void this.fetchAdminSettings().catch(() => undefined);
        });
        // The operator ended this session: a PIN change signs out other operator sessions, and
        // "End all interpreter access" ends every phone's. The socket authenticated with the
        // publisher token, so that is the one to drop; the guards then ask to sign in again.
        // The operator gave this phone interpreter more time.
        realtimeSocket.on<{ expiresAt: number }>('sessionExtended', ({ expiresAt }) => {
            if (this.interpreterToken && Number(expiresAt) > 0) this.setInterpreterExpiresAt(Number(expiresAt));
        });
        realtimeSocket.on('sessionRevoked', () => {
            if (this.adminToken) this.clearAdminSession();
            else this.clearInterpreterSession();
        });
        void realtimeSocket.connect().catch(() => undefined);
        this.refreshTimer = window.setInterval(() => void this.fetchSettings(), REFRESH_INTERVAL_MS);
        window.addEventListener('beforeunload', this.dispose);
        // Vite re-executes this module on hot update, which would otherwise stack a new
        // interval and a new listener on every reload.
        import.meta.hot?.dispose(() => this.dispose());
    }

    /** Releases the refresh interval and the unload listener. */
    dispose = () => {
        window.clearInterval(this.refreshTimer);
        window.removeEventListener('beforeunload', this.dispose);
    };

    private restoreCache() {
        const saved = localStorage.getItem(SETTINGS_CACHE_KEY);
        if (!saved) return;
        try { this.settings = JSON.parse(saved) as AppSettings; }
        catch { localStorage.removeItem(SETTINGS_CACHE_KEY); }
    }

    private cache() {
        try { localStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(this.settings)); }
        catch { /* private browsing or a full quota; the cache is optional */ }
    }

    private async fetchSettings() {
        try {
            const response = await fetch('/api/settings', { cache: 'no-store' });
            if (!response.ok) throw new Error(`Settings request failed (${response.status})`);
            this.settings = await response.json() as AppSettings;
            this.initialized = true;
            this.cache();
            this.notify();
        } catch (error) {
            console.error('Failed to fetch settings:', error);
            if (!this.initialized) this.notify();
        }
    }

    private async fetchAdminSettings() {
        // Share one in-flight request: several components subscribe at mount and would
        // otherwise each issue their own.
        if (this.adminFetch) return this.adminFetch;
        this.adminFetch = this.loadAdminSettings().finally(() => { this.adminFetch = null; });
        return this.adminFetch;
    }

    private async loadAdminSettings() {
        const response = await this.adminRequest('/api/admin/settings');
        this.admin = await response.json() as AdminSettings;
        this.settings = publicPart(this.admin);
        this.notifyAdmin();
        this.notify();
        return this.admin;
    }

    private notify() { this.listeners.forEach((listener) => listener(this.settings)); }
    private notifyAdmin() { this.adminListeners.forEach((listener) => listener(this.admin)); }
    private notifyAuth() { this.authListeners.forEach((listener) => listener(this.isAdminAuthenticated())); }
    private notifyInterpreterAuth() {
        this.interpreterAuthListeners.forEach((listener) => listener(this.isInterpreterAuthenticated()));
    }

    private async adminRequest(path: string, init: RequestInit = {}) {
        if (!this.adminToken) throw new Error('Administrator login required.');
        const response = await fetch(path, {
            ...init,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.adminToken}`, ...init.headers },
        });
        if (response.status === 401) {
            this.clearAdminSession();
            throw new Error('Administrator session expired.');
        }
        if (!response.ok) {
            const data = await response.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error || `Request failed (${response.status})`);
        }
        return response;
    }

    private async patchAdminSettings(patch: Record<string, unknown>) {
        const response = await this.adminRequest('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(patch) });
        this.admin = await response.json() as AdminSettings;
        this.settings = publicPart(this.admin);
        this.cache();
        this.notifyAdmin();
        this.notify();
    }

    subscribe(listener: Listener<AppSettings>) {
        this.listeners.add(listener);
        listener(this.settings);
        return () => { this.listeners.delete(listener); };
    }

    /** Fires when the operator session is established or lost, so guards can re-gate. */
    subscribeAuth(listener: (authenticated: boolean) => void) {
        this.authListeners.add(listener);
        listener(this.isAdminAuthenticated());
        return () => { this.authListeners.delete(listener); };
    }

    /** The interpreter counterpart of subscribeAuth. */
    subscribeInterpreterAuth(listener: (authenticated: boolean) => void) {
        this.interpreterAuthListeners.add(listener);
        listener(this.isInterpreterAuthenticated());
        return () => { this.interpreterAuthListeners.delete(listener); };
    }

    subscribeAdmin(listener: Listener<AdminSettings | null>) {
        this.adminListeners.add(listener);
        listener(this.admin);
        if (this.adminToken && !this.admin) void this.fetchAdminSettings().catch(() => undefined);
        return () => { this.adminListeners.delete(listener); };
    }

    getSettings() { return this.settings; }
    getLanguages() { return this.settings.languages; }
    getAdminSettings() { return this.admin; }
    getLanguage(channelId: string) { return this.settings.languages.find((language) => language.id === channelId) || null; }
    getAdminToken() { return this.adminToken; }
    getPublisherToken() { return this.adminToken || this.interpreterToken; }
    getInterpreterChannelId() { return this.interpreterChannelId; }
    getInterpreterChannelName() { return this.interpreterChannelName; }
    getInterpreterExpiresAt() { return this.interpreterExpiresAt; }
    isAdminAuthenticated() { return Boolean(this.adminToken); }
    isInterpreterAuthenticated() { return Boolean(this.interpreterToken && this.interpreterChannelId); }

    async login(pin: string) {
        const response = await fetch('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
        });
        const data = await response.json().catch(() => ({})) as { token?: string; error?: string };
        if (!response.ok || !data.token) throw new Error(data.error || 'Login failed.');
        this.adminToken = data.token;
        sessionStorage.setItem('lingua_franca_admin_token', data.token);
        realtimeSocket.setAuthToken(this.getPublisherToken());
        this.notifyAuth();
        await this.fetchAdminSettings();
    }

    clearAdminSession() {
        this.adminToken = '';
        this.admin = null;
        this.adminFetch = null;
        sessionStorage.removeItem('lingua_franca_admin_token');
        realtimeSocket.setAuthToken(this.getPublisherToken());
        this.notifyAdmin();
        this.notifyAuth();
    }

    async loginInterpreter(code: string) {
        const response = await fetch('/api/interpreter/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
        });
        const data = await response.json().catch(() => ({})) as
            { token?: string; channelId?: string; channelName?: string; expiresAt?: number; error?: string };
        if (!response.ok || !data.token || !data.channelId) throw new Error(data.error || 'Interpreter login failed.');
        this.interpreterToken = data.token;
        this.interpreterChannelId = data.channelId;
        this.interpreterChannelName = data.channelName || data.channelId;
        sessionStorage.setItem('lingua_franca_interpreter_token', data.token);
        sessionStorage.setItem('lingua_franca_interpreter_channel_id', data.channelId);
        sessionStorage.setItem('lingua_franca_interpreter_channel_name', this.interpreterChannelName);
        this.setInterpreterExpiresAt(Number(data.expiresAt) || 0);
        realtimeSocket.setAuthToken(this.getPublisherToken());
        this.notifyInterpreterAuth();
    }

    /** Also used when the operator extends this phone's access. */
    setInterpreterExpiresAt(expiresAt: number) {
        this.interpreterExpiresAt = expiresAt;
        try { sessionStorage.setItem('lingua_franca_interpreter_expires_at', String(expiresAt)); } catch { /* optional */ }
        this.notifyInterpreterAuth();
    }

    clearInterpreterSession() {
        this.interpreterToken = '';
        this.interpreterChannelId = '';
        this.interpreterChannelName = '';
        sessionStorage.removeItem('lingua_franca_interpreter_token');
        sessionStorage.removeItem('lingua_franca_interpreter_channel_id');
        sessionStorage.removeItem('lingua_franca_interpreter_channel_name');
        sessionStorage.removeItem('lingua_franca_interpreter_expires_at');
        this.interpreterExpiresAt = 0;
        realtimeSocket.setAuthToken(this.getPublisherToken());
        this.notifyInterpreterAuth();
    }

    async logout() {
        if (this.adminToken) await this.adminRequest('/api/admin/logout', { method: 'POST' }).catch(() => undefined);
        this.clearAdminSession();
    }

    async refreshAdminSettings() { return this.fetchAdminSettings(); }

    async addLanguage(name: string, description: string, code?: string) {
        const languages = this.admin?.languages || this.settings.languages;
        await this.patchAdminSettings({ languages: [...languages, { name, description, code }] });
    }

    async updateLanguage(id: string, name: string, description: string, code?: string) {
        const languages = this.admin?.languages || this.settings.languages;
        // The id is sent back unchanged so the server keeps a live broadcast attached to this
        // channel through a rename.
        await this.patchAdminSettings({
            languages: languages.map((language) => language.id === id
                ? { ...language, name, description, code: code || language.code } : language),
        });
    }

    async removeLanguage(id: string) {
        const languages = this.admin?.languages || this.settings.languages;
        await this.patchAdminSettings({ languages: languages.filter((language) => language.id !== id) });
    }

    async setAdminPin(currentPin: string, adminPin: string) { await this.patchAdminSettings({ currentPin, adminPin }); }
    /** The interface language a phone uses until it picks EN or RU itself. */
    async setInterfaceLanguage(interfaceLanguage: InterfaceLanguage) { await this.patchAdminSettings({ interfaceLanguage }); }
    async setEvent(event: EventInfo) { await this.patchAdminSettings({ event }); }
    async setContact(contact: ContactInfo) { await this.patchAdminSettings({ contact }); }
    async setOpenAiApiKey(openaiApiKey: string) { await this.patchAdminSettings({ openaiApiKey }); }
    async clearOpenAiApiKey() { await this.patchAdminSettings({ clearOpenaiApiKey: true }); }
    async setPreferredAddress(preferredAddress: string) { await this.patchAdminSettings({ preferredAddress }); }
    async setRecordingEnabled(recordingEnabled: boolean) { await this.patchAdminSettings({ recordingEnabled }); }
    async setTranscriptsEnabled(transcriptsEnabled: boolean) { await this.patchAdminSettings({ transcriptsEnabled }); }

    async getLiveStatus() {
        return await (await this.adminRequest('/api/admin/live', { cache: 'no-store' })).json() as LiveStatus;
    }

    async runPreflight() {
        return await (await this.adminRequest('/api/admin/preflight', { cache: 'no-store' })).json() as { checks: PreflightCheck[]; at: number };
    }

    /** Two more hours for the phone interpreter on a channel. */
    async extendInterpreter(channelId: string) {
        return await (await this.adminRequest('/api/admin/interpreter-sessions/extend', {
            method: 'POST', body: JSON.stringify({ channelId }),
        })).json() as { expiresAt: number };
    }

    async setAiBudget(aiBudgetUsd: number) { await this.patchAdminSettings({ aiBudgetUsd }); }
    async setSilencePause(aiSilencePauseMinutes: number) { await this.patchAdminSettings({ aiSilencePauseMinutes }); }
    async setAiStyle(style: Partial<Pick<AdminSettings, 'aiEngine' | 'aiVoice' | 'aiPace' | 'aiInstructions' | 'aiNotes'>>) {
        await this.patchAdminSettings(style);
    }

    /** The text of a slide deck, Word document or text file, for the Steady voice notes. */
    async extractNotes(file: File) {
        const response = await this.adminRequest(`/api/admin/ai-notes/extract?name=${encodeURIComponent(file.name)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
        });
        return (await response.json() as { text: string }).text;
    }

    /** Starts the dashboard's listener peaks and AI time from now, for a new event. */
    async resetLiveCounters() {
        await this.adminRequest('/api/admin/live/reset', { method: 'POST' });
    }

    async listRecordings() {
        return await (await this.adminRequest('/api/admin/recordings', { cache: 'no-store' })).json() as { folder: string; items: RecordingItem[] };
    }

    /** Fetched with the operator token, since a plain link cannot carry the Authorization header. */
    async downloadRecording(name: string) {
        return (await this.adminRequest(`/api/admin/recordings/file/${encodeURIComponent(name)}`, { cache: 'no-store' })).blob();
    }

    async deleteRecording(name: string) {
        await this.adminRequest(`/api/admin/recordings/file/${encodeURIComponent(name)}`, { method: 'DELETE' });
    }

    async openRecordingsFolder() {
        await this.adminRequest('/api/admin/recordings/open-folder', { method: 'POST' });
    }
    /** Reverts to the local self-signed certificate after the next restart. */
    async useSelfSignedCertificate() { await this.patchAdminSettings({ certificateMode: 'self-signed' }); }

    async createInterpreterLink(channelId: string) {
        const response = await this.adminRequest('/api/admin/interpreter-link', {
            method: 'POST', body: JSON.stringify({ channelId }),
        });
        return response.json() as Promise<{ code: string; channelId: string; channelName: string; expiresAt: number }>;
    }

    /** Ends every interpreter session and unused interpreter code. */
    async revokeInterpreterSessions() {
        const response = await this.adminRequest('/api/admin/interpreter-sessions/revoke', { method: 'POST' });
        return response.json() as Promise<{ ok: boolean; sessions: number; codes: number }>;
    }

    async configureCertificate(domain: string, token: string, email: string) {
        const response = await this.adminRequest('/api/admin/certificate', {
            method: 'POST', body: JSON.stringify({ domain, token, email }),
        });
        return response.json() as Promise<{ ok: boolean; publicHost: string }>;
    }

    async createRealtimeSession(sourceLanguage: string, targetLanguage: string, engine: AiEngine = 'translate') {
        const response = await this.adminRequest('/api/realtime/session', {
            method: 'POST', body: JSON.stringify({ sourceLanguage, targetLanguage, engine }),
        });
        return response.json() as Promise<{ value: string; engine: AiEngine }>;
    }

    /** Relaunches the desktop app. Every broadcast stops until it is back. */
    async restartApp() {
        await this.adminRequest('/api/admin/restart', { method: 'POST' });
    }
}

export const settingsService = new SettingsService();
