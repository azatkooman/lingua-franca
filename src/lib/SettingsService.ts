export interface Language {
    id: string;
    name: string;
    description: string;
    activePeerId?: string;
}

export interface AppSettings {
    languages: Language[];
    adminPin: string;
    interfaceLanguage?: 'en' | 'ru';
}

type SettingsListener = (settings: AppSettings) => void;

class SettingsService {
    private settings: AppSettings = {
        languages: [],
        adminPin: '1234'
    };
    private listeners: Set<SettingsListener> = new Set();
    private initialized = false;

    constructor() {
        this.fetchSettings();
        // Periodically refresh settings to stay in sync
        setInterval(() => this.fetchSettings(), 10000);
    }

    private async fetchSettings() {
        try {
            const res = await fetch('/api/settings');
            if (res.ok) {
                const data = await res.json();
                this.settings = data;
                this.initialized = true;
                this.notify();
            }
        } catch (e) {
            console.error('Failed to fetch settings:', e);
            // Fallback to local storage if API fails (useful in some dev scenarios)
            if (!this.initialized) {
                const saved = localStorage.getItem('lingua_franca_settings_cache');
                if (saved) {
                    this.settings = JSON.parse(saved);
                    this.notify();
                }
            }
        }
    }

    private async save() {
        // Optimistic update
        this.notify();
        localStorage.setItem('lingua_franca_settings_cache', JSON.stringify(this.settings));

        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.settings)
            });
        } catch (e) {
            console.error('Failed to save settings:', e);
        }
    }

    private notify() {
        this.listeners.forEach(l => l(this.settings));
    }

    subscribe(listener: SettingsListener) {
        this.listeners.add(listener);
        listener(this.settings);
        return () => { this.listeners.delete(listener); };
    }

    getLanguages(): Language[] {
        return this.settings.languages;
    }

    async addLanguage(name: string, description: string) {
        const id = name.toLowerCase().replace(/\s+/g, '-');
        this.settings.languages.push({ id, name, description });
        await this.save();
    }

    async updateLanguage(id: string, name: string, description: string) {
        const index = this.settings.languages.findIndex(l => l.id === id);
        if (index !== -1) {
            this.settings.languages[index] = { ...this.settings.languages[index], name, description };
            await this.save();
        }
    }

    async removeLanguage(id: string) {
        this.settings.languages = this.settings.languages.filter(l => l.id !== id);
        await this.save();
    }

    getAdminPin(): string {
        return this.settings.adminPin;
    }

    async setAdminPin(newPin: string) {
        this.settings.adminPin = newPin;
        await this.save();
    }

    async updateLanguagePeerId(name: string, peerId?: string) {
        const lang = this.settings.languages.find(l => l.name === name);
        if (lang) {
            lang.activePeerId = peerId;
            await this.save();
        }
    }

    async setInterfaceLanguage(lang: 'en' | 'ru') {
        this.settings.interfaceLanguage = lang;
        await this.save();
    }
}

export const settingsService = new SettingsService();
