export interface Language {
    id: string;
    name: string;
    code: string;
    description: string;
    activePeerId?: 'sfu-active' | 'ai-active';
}

export type AiProvider = 'openai' | 'gemini' | 'browser';

export interface AppSettings {
    languages: Language[];
    interfaceLanguage?: 'en' | 'ru';
    aiProvider: AiProvider;
    openaiConfigured: boolean;
    geminiConfigured: boolean;
    glossary: string;
    preferredAddress: string;
    recordingEnabled: boolean;
}

type SettingsListener = (settings: AppSettings) => void;
const EMPTY_SETTINGS: AppSettings = {
    languages: [], aiProvider: 'openai', openaiConfigured: false, geminiConfigured: false,
    glossary: '', preferredAddress: '', recordingEnabled: false,
};

class SettingsService {
    private settings: AppSettings = EMPTY_SETTINGS;
    private listeners = new Set<SettingsListener>();
    private initialized = false;
    private adminToken = sessionStorage.getItem('lingua_franca_admin_token') || '';
    private interpreterToken = sessionStorage.getItem('lingua_franca_interpreter_token') || '';
    private interpreterChannel = sessionStorage.getItem('lingua_franca_interpreter_channel') || '';
    private refreshTimer: number;

    constructor() {
        void this.fetchSettings();
        this.refreshTimer = window.setInterval(() => void this.fetchSettings(), 5000);
        window.addEventListener('beforeunload', () => window.clearInterval(this.refreshTimer));
    }

    private async fetchSettings() {
        try {
            const response = await fetch('/api/settings', { cache: 'no-store' });
            if (!response.ok) throw new Error(`Settings request failed (${response.status})`);
            this.settings = await response.json() as AppSettings;
            this.initialized = true;
            localStorage.setItem('lingua_franca_settings_cache', JSON.stringify(this.settings));
            this.notify();
        } catch (error) {
            console.error('Failed to fetch settings:', error);
            if (!this.initialized) {
                const saved = localStorage.getItem('lingua_franca_settings_cache');
                if (saved) {
                    try { this.settings = JSON.parse(saved) as AppSettings; this.notify(); }
                    catch { localStorage.removeItem('lingua_franca_settings_cache'); }
                }
            }
        }
    }

    private notify() { this.listeners.forEach((listener) => listener(this.settings)); }

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
        this.settings = await response.json() as AppSettings;
        this.notify();
    }

    subscribe(listener: SettingsListener) {
        this.listeners.add(listener); listener(this.settings);
        return () => { this.listeners.delete(listener); };
    }

    getSettings() { return this.settings; }
    getLanguages() { return this.settings.languages; }
    getAdminToken() { return this.adminToken; }
    getPublisherToken() { return this.adminToken || this.interpreterToken; }
    getInterpreterChannel() { return this.interpreterChannel; }
    isAdminAuthenticated() { return Boolean(this.adminToken); }
    isInterpreterAuthenticated() { return Boolean(this.interpreterToken && this.interpreterChannel); }

    async login(pin: string) {
        const response = await fetch('/api/admin/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
        });
        const data = await response.json() as { token?: string; error?: string };
        if (!response.ok || !data.token) throw new Error(data.error || 'Login failed.');
        this.adminToken = data.token;
        sessionStorage.setItem('lingua_franca_admin_token', data.token);
    }

    clearAdminSession() { this.adminToken = ''; sessionStorage.removeItem('lingua_franca_admin_token'); }

    async loginInterpreter(code: string) {
        const response = await fetch('/api/interpreter/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
        });
        const data = await response.json() as { token?: string; channelName?: string; error?: string };
        if (!response.ok || !data.token || !data.channelName) throw new Error(data.error || 'Interpreter login failed.');
        this.interpreterToken = data.token;
        this.interpreterChannel = data.channelName;
        sessionStorage.setItem('lingua_franca_interpreter_token', data.token);
        sessionStorage.setItem('lingua_franca_interpreter_channel', data.channelName);
    }

    clearInterpreterSession() {
        this.interpreterToken = '';
        this.interpreterChannel = '';
        sessionStorage.removeItem('lingua_franca_interpreter_token');
        sessionStorage.removeItem('lingua_franca_interpreter_channel');
    }

    async logout() {
        if (this.adminToken) await this.adminRequest('/api/admin/logout', { method: 'POST' }).catch(() => undefined);
        this.clearAdminSession();
    }

    async addLanguage(name: string, description: string, code?: string) {
        const id = name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '');
        await this.patchAdminSettings({ languages: [...this.settings.languages, { id, name, description, code: code || name.slice(0, 2).toLowerCase() }] });
    }

    async updateLanguage(id: string, name: string, description: string, code?: string) {
        await this.patchAdminSettings({ languages: this.settings.languages.map((language) => language.id === id
            ? { ...language, name, description, code: code || language.code } : language) });
    }

    async removeLanguage(id: string) {
        await this.patchAdminSettings({ languages: this.settings.languages.filter((language) => language.id !== id) });
    }

    async setAdminPin(adminPin: string) { await this.patchAdminSettings({ adminPin }); }
    async setInterfaceLanguage(interfaceLanguage: 'en' | 'ru') { await this.patchAdminSettings({ interfaceLanguage }); }
    async setAiProvider(aiProvider: AiProvider) { await this.patchAdminSettings({ aiProvider }); }
    async setOpenAiApiKey(openaiApiKey: string) { await this.patchAdminSettings({ openaiApiKey }); }
    async clearOpenAiApiKey() { await this.patchAdminSettings({ clearOpenaiApiKey: true }); }
    async setGeminiApiKey(geminiApiKey: string) { await this.patchAdminSettings({ geminiApiKey }); }
    async setGlossary(glossary: string) { await this.patchAdminSettings({ glossary }); }
    async setPreferredAddress(preferredAddress: string) { await this.patchAdminSettings({ preferredAddress }); }
    async setRecordingEnabled(recordingEnabled: boolean) { await this.patchAdminSettings({ recordingEnabled }); }

    async createInterpreterLink(channelName: string) {
        const response = await this.adminRequest('/api/admin/interpreter-link', {
            method: 'POST', body: JSON.stringify({ channelName }),
        });
        return response.json() as Promise<{ code: string; channelName: string; expiresAt: number }>;
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
