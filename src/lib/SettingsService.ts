import { realtimeSocket } from './realtimeSocket';

export interface Language {
    id: string;
    name: string;
    code: string;
    description: string;
    activePeerId?: 'sfu-active' | 'ai-active';
}

export type AiProvider = 'openai' | 'gemini' | 'browser';

/** What every listener device is allowed to see. Deliberately small. */
export interface AppSettings {
    languages: Language[];
    interfaceLanguage?: 'en' | 'ru';
}

/** Operator-only configuration, fetched separately once an admin session exists. */
export interface AdminSettings extends AppSettings {
    aiProvider: AiProvider;
    openaiConfigured: boolean;
    geminiConfigured: boolean;
    glossary: string;
    preferredAddress: string;
    recordingEnabled: boolean;
    duckDnsConfigured: boolean;
    certificateHostname: string;
    certificateEmail: string;
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
    private initialized = false;
    private adminToken = sessionStorage.getItem('lingua_franca_admin_token') || '';
    private interpreterToken = sessionStorage.getItem('lingua_franca_interpreter_token') || '';
    private interpreterChannelId = sessionStorage.getItem('lingua_franca_interpreter_channel_id') || '';
    private interpreterChannelName = sessionStorage.getItem('lingua_franca_interpreter_channel_name') || '';
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
        this.settings = { languages: this.admin.languages, interfaceLanguage: this.admin.interfaceLanguage };
        this.notifyAdmin();
        this.notify();
        return this.admin;
    }

    private notify() { this.listeners.forEach((listener) => listener(this.settings)); }
    private notifyAdmin() { this.adminListeners.forEach((listener) => listener(this.admin)); }
    private notifyAuth() { this.authListeners.forEach((listener) => listener(this.isAdminAuthenticated())); }

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
        this.settings = { languages: this.admin.languages, interfaceLanguage: this.admin.interfaceLanguage };
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
            { token?: string; channelId?: string; channelName?: string; error?: string };
        if (!response.ok || !data.token || !data.channelId) throw new Error(data.error || 'Interpreter login failed.');
        this.interpreterToken = data.token;
        this.interpreterChannelId = data.channelId;
        this.interpreterChannelName = data.channelName || data.channelId;
        sessionStorage.setItem('lingua_franca_interpreter_token', data.token);
        sessionStorage.setItem('lingua_franca_interpreter_channel_id', data.channelId);
        sessionStorage.setItem('lingua_franca_interpreter_channel_name', this.interpreterChannelName);
        realtimeSocket.setAuthToken(this.getPublisherToken());
    }

    clearInterpreterSession() {
        this.interpreterToken = '';
        this.interpreterChannelId = '';
        this.interpreterChannelName = '';
        sessionStorage.removeItem('lingua_franca_interpreter_token');
        sessionStorage.removeItem('lingua_franca_interpreter_channel_id');
        sessionStorage.removeItem('lingua_franca_interpreter_channel_name');
        realtimeSocket.setAuthToken(this.getPublisherToken());
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

    async setAdminPin(adminPin: string) { await this.patchAdminSettings({ adminPin }); }
    async setInterfaceLanguage(interfaceLanguage: 'en' | 'ru') { await this.patchAdminSettings({ interfaceLanguage }); }
    async setAiProvider(aiProvider: AiProvider) { await this.patchAdminSettings({ aiProvider }); }
    async setOpenAiApiKey(openaiApiKey: string) { await this.patchAdminSettings({ openaiApiKey }); }
    async clearOpenAiApiKey() { await this.patchAdminSettings({ clearOpenaiApiKey: true }); }
    async setGeminiApiKey(geminiApiKey: string) { await this.patchAdminSettings({ geminiApiKey }); }
    async clearGeminiApiKey() { await this.patchAdminSettings({ clearGeminiApiKey: true }); }
    async setGlossary(glossary: string) { await this.patchAdminSettings({ glossary }); }
    async setPreferredAddress(preferredAddress: string) { await this.patchAdminSettings({ preferredAddress }); }
    async setRecordingEnabled(recordingEnabled: boolean) { await this.patchAdminSettings({ recordingEnabled }); }
    /** Reverts to the local self-signed certificate after the next restart. */
    async useSelfSignedCertificate() { await this.patchAdminSettings({ certificateMode: 'self-signed' }); }

    async createInterpreterLink(channelId: string) {
        const response = await this.adminRequest('/api/admin/interpreter-link', {
            method: 'POST', body: JSON.stringify({ channelId }),
        });
        return response.json() as Promise<{ code: string; channelId: string; channelName: string; expiresAt: number }>;
    }

    async configureCertificate(domain: string, token: string, email: string) {
        const response = await this.adminRequest('/api/admin/certificate', {
            method: 'POST', body: JSON.stringify({ domain, token, email }),
        });
        return response.json() as Promise<{ ok: boolean; publicHost: string }>;
    }

    async createRealtimeSession(sourceLanguage: string, targetLanguage: string) {
        const response = await this.adminRequest('/api/realtime/session', {
            method: 'POST', body: JSON.stringify({ sourceLanguage, targetLanguage }),
        });
        return response.json() as Promise<{ value: string }>;
    }

    async translateText(text: string, sourceLang: string, targetLang: string) {
        const response = await this.adminRequest('/api/translate', {
            method: 'POST', body: JSON.stringify({ text, sourceLang, targetLang }),
        });
        return response.json() as Promise<{ translatedText: string; provider?: string }>;
    }
}

export const settingsService = new SettingsService();
