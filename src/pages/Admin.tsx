import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Cpu, Edit2, Languages, Mic, Monitor, Plus, QrCode, Save, ShieldAlert, Trash2, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { settingsService, type AdminSettings, type AiProvider, type Language } from '../lib/SettingsService';
import { useTranslation } from '../lib/i18n';
import './Admin.css';

interface HealthInfo {
    ok: boolean;
    localAddress: string;
    addresses: { name: string; address: string }[];
    sfu: string;
    sfuError: string;
    portMode: 'multiplexed' | 'range' | 'unknown';
    addressDrift: string;
    secureStorageAvailable: boolean;
    certificatePath: string;
    publicHost: string;
    certificate: { type: 'trusted' | 'self-signed'; hostname: string; expiresAt: string; error: string };
    ports: { https: number; local: number; rtc: string };
}

// Operators paste whatever DuckDNS showed them, which may be a full URL. Reduce it to the
// bare label the server expects rather than rejecting it.
function normaliseDuckDomain(value: string) {
    return value
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, '')
        .replace(/\.duckdns\.org$/i, '')
        .toLowerCase();
}

export default function Admin() {
    const navigate = useNavigate();
    const { t, locale, setLocale } = useTranslation();
    const [settings, setSettings] = useState<AdminSettings | null>(settingsService.getAdminSettings());
    const [health, setHealth] = useState<HealthInfo | null>(null);
    const [qrChannelId, setQrChannelId] = useState('');
    const [showQr, setShowQr] = useState(false);
    const [interpreterLink, setInterpreterLink] = useState<{ url: string; code: string; channelName: string } | null>(null);
    const [interpreterChannelId, setInterpreterChannelId] = useState('');
    const [duckDomain, setDuckDomain] = useState('');
    const [duckToken, setDuckToken] = useState('');
    const [certificateEmail, setCertificateEmail] = useState('');
    const [editingLang, setEditingLang] = useState<Language | null>(null);
    const [languageName, setLanguageName] = useState('');
    const [languageCode, setLanguageCode] = useState('');
    const [languageDescription, setLanguageDescription] = useState('');
    // The glossary is a draft until it is saved. Binding the textarea straight to the shared
    // settings object meant every push from the server wiped whatever was being typed.
    const [glossaryDraft, setGlossaryDraft] = useState<string | null>(null);
    const [newPin, setNewPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const [openaiKey, setOpenaiKey] = useState('');
    const [geminiKey, setGeminiKey] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);

    const refreshHealth = () => fetch('/api/admin/health', {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${settingsService.getAdminToken()}` },
    }).then((response) => response.ok ? response.json() : null).then(setHealth).catch(() => setHealth(null));

    useEffect(() => settingsService.subscribeAdmin(setSettings), []);
    useEffect(() => { void refreshHealth(); }, []);

    useEffect(() => {
        if (!settings?.languages.length) return;
        setQrChannelId((current) => settings.languages.some((l) => l.id === current) ? current : settings.languages[0].id);
        setInterpreterChannelId((current) => settings.languages.some((l) => l.id === current) ? current : settings.languages[0].id);
        setDuckDomain((current) => current || settings.certificateHostname);
        setCertificateEmail((current) => current || settings.certificateEmail);
    }, [settings]);

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

    const host = health?.publicHost || health?.localAddress;
    // Every channel gets its own link; the QR used to be hard-coded to a channel named
    // "English", which broke as soon as the channel list was renamed.
    const listenerUrlFor = (channelId: string) =>
        host && health ? `https://${host}:${health.ports.https}/listener?channel=${encodeURIComponent(channelId)}` : '';
    const qrLanguage = settings?.languages.find((language) => language.id === qrChannelId) || null;
    const qrUrl = listenerUrlFor(qrChannelId);

    const createInterpreterLink = async () => {
        await run(async () => {
            if (!host || !health) throw new Error('Network address is not ready.');
            const access = await settingsService.createInterpreterLink(interpreterChannelId);
            setInterpreterLink({
                url: `https://${host}:${health.ports.https}/interpreter?code=${access.code}`,
                code: access.code,
                channelName: access.channelName,
            });
        }, 'Interpreter link created. It is valid for eight hours and can be used once.');
    };

    const changePin = async () => {
        if (newPin !== confirmPin) { setMessage('The two PINs do not match.'); return; }
        if (!/^\d{4,12}$/.test(newPin)) { setMessage('The PIN must be 4 to 12 digits.'); return; }
        await run(async () => {
            await settingsService.setAdminPin(newPin);
            setNewPin(''); setConfirmPin('');
        }, 'PIN changed.');
    };

    if (!settings) return <div className="page-container admin-page">{t('loading')}</div>;

    const glossaryValue = glossaryDraft ?? settings.glossary;

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

            {showQr && qrUrl && (
                <div className="card fade-in highlight-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1000, width: '90%', maxWidth: 400 }}>
                    <div className="card-header"><QrCode size={20} /><h3>{qrLanguage?.name} listener</h3><button className="btn-icon-small" onClick={() => setShowQr(false)} style={{ marginLeft: 'auto' }}><X size={18} /></button></div>
                    <div className="qr-container"><div className="qr-box"><QRCodeSVG value={qrUrl} size={250} level="H" /></div><p className="text-muted">{qrUrl}</p></div>
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
                    {health?.portMode === 'range' && (
                        <p style={{ color: 'var(--danger)' }}>
                            Shared media port unavailable; using one port per listener, which limits capacity to roughly 45 phones. Restart the app to retry.
                        </p>
                    )}
                    {health?.addressDrift && <p style={{ color: 'var(--danger)' }}>{health.addressDrift}</p>}
                    {health && !health.secureStorageAvailable && (
                        <p style={{ color: 'var(--danger)' }}>Windows secure storage is unavailable, so API keys cannot be saved. Re-enter them after fixing the credential store.</p>
                    )}
                    <p>Certificate: <strong>{health?.certificate.type === 'trusted' ? 'trusted (no warning)' : 'local fallback (browser warning)'}</strong></p>
                    {health?.certificate.expiresAt && <p className="text-muted">Expires: {new Date(health.certificate.expiresAt).toLocaleDateString()}</p>}
                    {health?.certificate.error && <p style={{ color: 'var(--danger)' }}>{health.certificate.error}</p>}
                    <p className="text-muted">Windows Firewall must allow TCP {health?.ports.https ?? 4173} and {health?.ports.rtc ?? '10000/udp+tcp'}.</p>

                    <label className="mt-4">Listener QR channel</label>
                    <select className="custom-select" value={qrChannelId} onChange={(event) => setQrChannelId(event.target.value)}>
                        {settings.languages.map((language) => <option key={language.id} value={language.id}>{language.name}</option>)}
                    </select>
                    <p className="text-muted"><code>{qrUrl || 'detecting network'}</code></p>
                    <button className="btn-primary" disabled={!qrUrl} onClick={() => setShowQr(true)}><QrCode size={18} /> Show listener QR</button>
                </div>
            </div>

            <div className="card fade-in">
                <div className="card-header"><Mic size={20} /><h3>Phone interpreter</h3></div>
                <p className="text-muted">Create a limited one-time link. The phone can broadcast only the selected language and cannot open admin settings.</p>
                <select className="custom-select" value={interpreterChannelId} onChange={(event) => setInterpreterChannelId(event.target.value)}>
                    {settings.languages.map((language) => <option key={language.id} value={language.id}>{language.name}</option>)}
                </select>
                <button className="btn-primary mt-4" disabled={busy || !health || !interpreterChannelId} onClick={() => void createInterpreterLink()}><QrCode size={18} /> Create interpreter QR</button>
            </div>

            <div className="card fade-in">
                <div className="card-header"><ShieldAlert size={20} /><h3>Trusted phone certificate</h3></div>
                <p className="text-muted">Free option: create a subdomain at DuckDNS, then enter its name and token here. Lingua Franca will obtain a Let’s Encrypt certificate, point the hostname to this computer on the LAN, and renew it automatically.</p>
                <label>DuckDNS subdomain</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><input className="custom-input" value={duckDomain} onChange={(event) => setDuckDomain(normaliseDuckDomain(event.target.value))} placeholder="my-church" /><span>.duckdns.org</span></div>
                <label className="mt-4">DuckDNS token {settings.duckDnsConfigured && <span className="text-muted">(saved — leave blank to keep)</span>}</label>
                <input className="custom-input" type="password" value={duckToken} onChange={(event) => setDuckToken(event.target.value)} placeholder="Token from duckdns.org" />
                <label className="mt-4">Certificate contact email</label>
                <input className="custom-input" type="email" value={certificateEmail} onChange={(event) => setCertificateEmail(event.target.value)} placeholder="admin@example.com" />
                <button className="btn-primary mt-4" disabled={busy || !duckDomain || !certificateEmail || (!duckToken && !settings.duckDnsConfigured)} onClick={() => void run(async () => {
                    await settingsService.configureCertificate(duckDomain, duckToken, certificateEmail);
                    setDuckToken('');
                    await refreshHealth();
                }, 'Trusted certificate ready. New QR codes now use the warning-free hostname.')}><ShieldAlert size={18} /> Install / renew free certificate</button>
                {health?.certificate.type === 'trusted' && (
                    <button className="btn-secondary mt-4" disabled={busy} onClick={() => void run(async () => {
                        await settingsService.useSelfSignedCertificate();
                        await refreshHealth();
                    }, 'Reverted to the local certificate. Restart the app to apply it; phones will warn again.')}>
                        Stop using the trusted certificate
                    </button>
                )}
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
                                <button className="btn-icon-small danger" disabled={settings.languages.length < 2} onClick={() => void run(() => settingsService.removeLanguage(language.id), 'Language removed.')}><Trash2 size={16} /></button>
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
                <textarea className="custom-input" rows={4} value={glossaryValue} onChange={(event) => setGlossaryDraft(event.target.value)} />
                <button className="btn-secondary mt-4" disabled={busy || glossaryDraft === null} onClick={() => void run(async () => {
                    await settingsService.setGlossary(glossaryValue);
                    setGlossaryDraft(null);
                }, 'Glossary saved.')}>Save glossary</button>
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
                <p className="text-muted">Set a new administrator PIN of 4 to 12 digits. A longer PIN is meaningfully harder to guess. The current PIN is never sent to browsers.</p>
                <label>New PIN</label>
                <input className="custom-input" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12}
                    value={newPin} onChange={(event) => setNewPin(event.target.value.replace(/\D/g, '').slice(0, 12))} />
                <label className="mt-4">Confirm PIN</label>
                <input className="custom-input" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12}
                    value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 12))} />
                <button className="btn-primary mt-4" disabled={newPin.length < 4 || busy} onClick={() => void changePin()}>{t('save')}</button>
            </div>
        </div>
    );
}
