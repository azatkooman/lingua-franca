import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Cpu, Edit2, Languages, Mic, Monitor, Plus, QrCode, Save, ShieldAlert, Trash2, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { settingsService, type AiProvider, type AppSettings, type Language } from '../lib/SettingsService';
import { useTranslation } from '../lib/i18n';
import './Admin.css';

interface HealthInfo {
    ok: boolean;
    localAddress: string;
    addresses: { name: string; address: string }[];
    sfu: string;
    sfuError: string;
    certificatePath: string;
    publicHost: string;
    certificate: { type: 'trusted' | 'self-signed'; hostname: string; expiresAt: string; error: string };
    ports: { https: number; local: number; rtc: string };
}

export default function Admin() {
    const navigate = useNavigate();
    const { t, locale, setLocale } = useTranslation();
    const [settings, setSettings] = useState<AppSettings | null>(null);
    const [health, setHealth] = useState<HealthInfo | null>(null);
    const [showQr, setShowQr] = useState(false);
    const [interpreterLink, setInterpreterLink] = useState<{ url: string; code: string; channelName: string } | null>(null);
    const [interpreterChannel, setInterpreterChannel] = useState('English');
    const [duckDomain, setDuckDomain] = useState('');
    const [duckToken, setDuckToken] = useState('');
    const [certificateEmail, setCertificateEmail] = useState('');
    const [editingLang, setEditingLang] = useState<Language | null>(null);
    const [languageName, setLanguageName] = useState('');
    const [languageCode, setLanguageCode] = useState('');
    const [languageDescription, setLanguageDescription] = useState('');
    const [pinDigits, setPinDigits] = useState(['', '', '', '']);
    const [openaiKey, setOpenaiKey] = useState('');
    const [geminiKey, setGeminiKey] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => settingsService.subscribe(setSettings), []);
    useEffect(() => {
        fetch('/api/health').then((response) => response.json()).then(setHealth).catch(() => setHealth(null));
    }, []);

    const run = async (action: () => Promise<unknown>, success: string) => {
        setBusy(true); setMessage('');
        try { await action(); setMessage(success); }
        catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };

    const resetLanguageForm = () => {
        setEditingLang(null); setLanguageName(''); setLanguageCode(''); setLanguageDescription('');
    };

    const saveLanguage = async () => {
        if (!languageName.trim() || !languageCode.trim()) return;
        await run(async () => {
            if (editingLang) await settingsService.updateLanguage(editingLang.id, languageName, languageDescription, languageCode);
            else await settingsService.addLanguage(languageName, languageDescription, languageCode);
            resetLanguageForm();
        }, 'Language saved.');
    };

    const editLanguage = (language: Language) => {
        setEditingLang(language); setLanguageName(language.name); setLanguageCode(language.code); setLanguageDescription(language.description);
    };

    const listenerUrl = health ? `https://${health.publicHost || health.localAddress}:${health.ports.https}/listener?channel=English` : '';
    const createInterpreterLink = async () => {
        await run(async () => {
            const access = await settingsService.createInterpreterLink(interpreterChannel);
            const host = health?.publicHost || health?.localAddress;
            if (!host) throw new Error('Network address is not ready.');
            setInterpreterLink({
                url: `https://${host}:${health!.ports.https}/interpreter?code=${access.code}`,
                code: access.code,
                channelName: access.channelName,
            });
        }, 'Interpreter link created. It is valid for eight hours and can be used once.');
    };
    if (!settings) return <div className="page-container admin-page">{t('loading')}</div>;

    return (
        <div className="page-container admin-page">
            <header className="page-header">
                <div className="admin-header-left">
                    <button className="btn-icon" onClick={() => navigate(-1)} title={t('back')}><ArrowLeft size={24} /></button>
                    <h2>{t('admin_title')}</h2>
                </div>
                <div className="language-toggle" style={{ position: 'static' }}>
                    <button className={`lang-btn ${locale === 'en' ? 'active' : ''}`} onClick={() => setLocale('en')}>EN</button>
                    <div className="divider" />
                    <button className={`lang-btn ${locale === 'ru' ? 'active' : ''}`} onClick={() => setLocale('ru')}>RU</button>
                </div>
            </header>

            {message && <div className="glass-panel" style={{ padding: '0.8rem 1rem', marginBottom: '1rem' }}>{message}</div>}

            {showQr && listenerUrl && (
                <div className="card fade-in highlight-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1000, width: '90%', maxWidth: 400 }}>
                    <div className="card-header"><QrCode size={20} /><h3>English listener</h3><button className="btn-icon-small" onClick={() => setShowQr(false)} style={{ marginLeft: 'auto' }}><X size={18} /></button></div>
                    <div className="qr-container"><div className="qr-box"><QRCodeSVG value={listenerUrl} size={250} level="H" /></div><p className="text-muted">{listenerUrl}</p></div>
                </div>
            )}

            {interpreterLink && (
                <div className="card fade-in highlight-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1000, width: '90%', maxWidth: 420 }}>
                    <div className="card-header"><Mic size={20} /><h3>{interpreterLink.channelName} interpreter</h3><button className="btn-icon-small" onClick={() => setInterpreterLink(null)} style={{ marginLeft: 'auto' }}><X size={18} /></button></div>
                    <div className="qr-container"><div className="qr-box"><QRCodeSVG value={interpreterLink.url} size={250} level="H" /></div>
                        <p><strong>Code: {interpreterLink.code}</strong></p><p className="text-muted">{interpreterLink.url}</p></div>
                </div>
            )}

            <div className="card fade-in highlight-card">
                <div className="card-header"><Monitor size={20} /><h3>System status</h3></div>
                <div className="connection-info">
                    <p>SFU: <strong>{health?.sfu || 'checking'}</strong></p>
                    {health?.sfuError && <p style={{ color: 'var(--danger)' }}>{health.sfuError}</p>}
                    <p>Listener URL: <code>{listenerUrl || 'detecting network'}</code></p>
                    <p>Certificate: <strong>{health?.certificate.type === 'trusted' ? 'trusted (no warning)' : 'local fallback (browser warning)'}</strong></p>
                    {health?.certificate.expiresAt && <p className="text-muted">Expires: {new Date(health.certificate.expiresAt).toLocaleDateString()}</p>}
                    {health?.certificate.error && <p style={{ color: 'var(--danger)' }}>{health.certificate.error}</p>}
                    <p className="text-muted">Windows Firewall must allow TCP 4173 and UDP 10000–10100.</p>
                    <button className="btn-primary" disabled={!listenerUrl} onClick={() => setShowQr(true)}><QrCode size={18} /> Show English QR</button>
                </div>
            </div>

            <div className="card fade-in">
                <div className="card-header"><Mic size={20} /><h3>Phone interpreter</h3></div>
                <p className="text-muted">Create a limited one-time link. The phone can broadcast only the selected language and cannot open admin settings.</p>
                <select className="custom-select" value={interpreterChannel} onChange={(event) => setInterpreterChannel(event.target.value)}>
                    {settings.languages.map((language) => <option key={language.id} value={language.name}>{language.name}</option>)}
                </select>
                <button className="btn-primary mt-4" disabled={busy || !health} onClick={() => void createInterpreterLink()}><QrCode size={18} /> Create interpreter QR</button>
            </div>

            <div className="card fade-in">
                <div className="card-header"><ShieldAlert size={20} /><h3>Trusted phone certificate</h3></div>
                <p className="text-muted">Free option: create a subdomain at DuckDNS, then enter its name and token here. Lingua Franca will obtain a Let’s Encrypt certificate, point the hostname to this computer on the LAN, and renew it automatically when the app starts.</p>
                <label>DuckDNS subdomain</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><input className="custom-input" value={duckDomain} onChange={(event) => setDuckDomain(event.target.value.replace(/\.duckdns\.org$/i, ''))} placeholder="my-church" /><span>.duckdns.org</span></div>
                <label className="mt-4">DuckDNS token</label>
                <input className="custom-input" type="password" value={duckToken} onChange={(event) => setDuckToken(event.target.value)} placeholder="Token from duckdns.org" />
                <label className="mt-4">Certificate contact email</label>
                <input className="custom-input" type="email" value={certificateEmail} onChange={(event) => setCertificateEmail(event.target.value)} placeholder="admin@example.com" />
                <button className="btn-primary mt-4" disabled={busy || !duckDomain || !duckToken || !certificateEmail} onClick={() => void run(async () => {
                    await settingsService.configureCertificate(duckDomain, duckToken, certificateEmail);
                    setDuckToken('');
                    const response = await fetch('/api/health', { cache: 'no-store' });
                    setHealth(await response.json());
                }, 'Trusted certificate installed. New QR codes now use the warning-free hostname.')}><ShieldAlert size={18} /> Install / renew free certificate</button>
            </div>

            <div className="card fade-in">
                <div className="card-header"><Languages size={20} /><h3>{t('languages_title')}</h3></div>
                <div className="add-language-form">
                    <input value={languageName} onChange={(event) => setLanguageName(event.target.value)} placeholder={t('lang_name')} className="custom-input" />
                    <input value={languageCode} onChange={(event) => setLanguageCode(event.target.value.toLowerCase().slice(0, 8))} placeholder="ISO code (en, ru)" className="custom-input" style={{ maxWidth: 160 }} />
                    <button className="btn-primary-small" onClick={saveLanguage} disabled={busy}>{editingLang ? <Save size={18} /> : <Plus size={18} />}</button>
                </div>
                <input value={languageDescription} onChange={(event) => setLanguageDescription(event.target.value)} placeholder={t('lang_desc')} className="custom-input" />
                {editingLang && <button className="btn-secondary mt-4" onClick={resetLanguageForm}>{t('cancel')}</button>}
                <div className="language-list mt-4">
                    {settings.languages.map((language) => (
                        <div key={language.id} className="language-item">
                            <div><strong>{language.name}</strong> <code>{language.code}</code><p className="text-muted">{language.description}</p></div>
                            <div className="language-actions">
                                <button className="btn-icon-small" onClick={() => editLanguage(language)}><Edit2 size={16} /></button>
                                <button className="btn-icon-small danger" onClick={() => void run(() => settingsService.removeLanguage(language.id), 'Language removed.')}><Trash2 size={16} /></button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div className="card fade-in">
                <div className="card-header"><Cpu size={20} /><h3>AI translation</h3></div>
                <label>Provider</label>
                <select className="custom-select" value={settings.aiProvider} onChange={(event) => void run(() => settingsService.setAiProvider(event.target.value as AiProvider), 'Provider saved.')}>
                    <option value="openai">OpenAI Realtime audio</option>
                    <option value="gemini">Gemini text fallback</option>
                    <option value="browser">Browser/MyMemory fallback</option>
                </select>
                <p className="text-muted">OpenAI configured: {settings.openaiConfigured ? 'yes' : 'no'} · Gemini configured: {settings.geminiConfigured ? 'yes' : 'no'}</p>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input type={showKey ? 'text' : 'password'} value={openaiKey} onChange={(event) => setOpenaiKey(event.target.value)} placeholder="OpenAI API key" className="custom-input" />
                    <button className="btn-secondary" onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide' : 'Show'}</button>
                </div>
                <button className="btn-primary mt-4" disabled={!openaiKey || busy} onClick={() => void run(async () => { await settingsService.setOpenAiApiKey(openaiKey); setOpenaiKey(''); }, 'OpenAI key encrypted and saved.')}>Save OpenAI key</button>
                {settings.openaiConfigured && <button className="btn-secondary mt-4" disabled={busy} onClick={() => void run(async () => { await settingsService.createRealtimeSession('ru', 'en'); }, 'OpenAI Realtime credential test passed.')}>Test OpenAI</button>}

                <input type="password" value={geminiKey} onChange={(event) => setGeminiKey(event.target.value)} placeholder="Optional Gemini API key" className="custom-input mt-4" />
                <button className="btn-secondary mt-4" disabled={!geminiKey || busy} onClick={() => void run(async () => { await settingsService.setGeminiApiKey(geminiKey); setGeminiKey(''); }, 'Gemini key encrypted and saved.')}>Save Gemini key</button>

                <label className="mt-4">Church terminology and names</label>
                <textarea className="custom-input" rows={4} value={settings.glossary} onChange={(event) => setSettings({ ...settings, glossary: event.target.value })} />
                <button className="btn-secondary mt-4" disabled={busy} onClick={() => void run(() => settingsService.setGlossary(settings.glossary), 'Glossary saved.')}>Save glossary</button>
                <label className="mt-4" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <input type="checkbox" checked={settings.recordingEnabled} onChange={(event) => void run(() => settingsService.setRecordingEnabled(event.target.checked), 'Recording preference saved.')} />
                    Download original and translated recordings when a session stops
                </label>
            </div>

            <div className="card fade-in">
                <div className="card-header"><Monitor size={20} /><h3>Network adapter</h3></div>
                <select className="custom-select" value={settings.preferredAddress} onChange={(event) => void run(() => settingsService.setPreferredAddress(event.target.value), 'Network saved. Restart the app to apply it.')}>
                    <option value="">Automatic</option>
                    {health?.addresses.map((entry) => <option key={`${entry.name}-${entry.address}`} value={entry.address}>{entry.name}: {entry.address}</option>)}
                </select>
            </div>

            <div className="card fade-in">
                <div className="card-header"><Save size={20} /><h3>Security</h3></div>
                <p className="text-muted">Enter a new four-digit administrator PIN. The current PIN is never sent to browsers.</p>
                <div className="pin-digit-container">
                    {pinDigits.map((digit, index) => (
                        <input key={index} type="password" inputMode="numeric" maxLength={1} value={digit} className="pin-digit-input"
                            onChange={(event) => {
                                if (!/^\d?$/.test(event.target.value)) return;
                                const next = [...pinDigits]; next[index] = event.target.value; setPinDigits(next);
                            }} />
                    ))}
                </div>
                <button className="btn-primary mt-4" disabled={pinDigits.some((digit) => !digit) || busy} onClick={() => void run(async () => { await settingsService.setAdminPin(pinDigits.join('')); setPinDigits(['', '', '', '']); }, 'PIN changed.')}>{t('save')}</button>
            </div>
        </div>
    );
}
