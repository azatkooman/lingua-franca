import { useEffect, useState } from 'react';
import { ArrowLeft, Cpu, Edit2, Globe, Languages, LogOut, Mic, Monitor, Plus, QrCode, RotateCcw, Save, ShieldAlert, Trash2, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { settingsService, type AdminSettings, type Language } from '../lib/SettingsService';
import { useTranslation, type Locale } from '../lib/i18n';
import { useGoBack } from '../lib/navigation';
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
    ports: { https: number; local: number; listener: number | null; rtc: string };
    listenerPortError: string;
}

type PhoneLink = 'plain' | 'secure';
const PHONE_LINK_KEY = 'lingua_franca_phone_link';

// Which address listener QR codes carry. Plain HTTP is the default because it opens with no
// certificate warning and needs neither DuckDNS nor internet. Kept per operator device.
function readPhoneLink(): PhoneLink {
    try { return localStorage.getItem(PHONE_LINK_KEY) === 'secure' ? 'secure' : 'plain'; }
    catch { return 'plain'; }
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
    const goBack = useGoBack();
    const { t, locale, setLocale } = useTranslation();
    const [settings, setSettings] = useState<AdminSettings | null>(settingsService.getAdminSettings());
    const [health, setHealth] = useState<HealthInfo | null>(null);
    const [qrChannelId, setQrChannelId] = useState('');
    const [phoneLink, setPhoneLink] = useState<PhoneLink>(readPhoneLink);
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
    const [newPin, setNewPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const [openaiKey, setOpenaiKey] = useState('');
    const [showKey, setShowKey] = useState(false);
    // Set after a change that only takes effect on restart, so the button sits right there
    // instead of a message telling the operator to go and find the window's close button.
    const [restartNeeded, setRestartNeeded] = useState(false);
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
        }, t('language_saved'));
    };

    const editLanguage = (language: Language) => {
        setEditingLang(language); setLanguageName(language.name); setLanguageCode(language.code); setLanguageDescription(language.description);
    };

    const host = health?.publicHost || health?.localAddress;
    const plainAvailable = Boolean(health?.ports.listener);
    // Falls back to HTTPS when the plain port could not start, so a QR never points at a dead
    // address.
    const usePlainLink = phoneLink === 'plain' && plainAvailable;
    const choosePhoneLink = (next: PhoneLink) => {
        setPhoneLink(next);
        try { localStorage.setItem(PHONE_LINK_KEY, next); } catch { /* optional preference */ }
    };
    // Every channel gets its own link; the QR used to be hard-coded to a channel named
    // "English", which broke as soon as the channel list was renamed. The plain link uses the
    // LAN address directly: it needs no DNS, so it works on Wi-Fi without internet.
    const listenerUrlFor = (channelId: string) => {
        if (!health) return '';
        const query = `/listener?channel=${encodeURIComponent(channelId)}`;
        if (usePlainLink) return `http://${health.localAddress}:${health.ports.listener}${query}`;
        return host ? `https://${host}:${health.ports.https}${query}` : '';
    };
    const qrLanguage = settings?.languages.find((language) => language.id === qrChannelId) || null;
    const qrUrl = listenerUrlFor(qrChannelId);

    const createInterpreterLink = async () => {
        await run(async () => {
            if (!host || !health) throw new Error(t('network_not_ready'));
            const access = await settingsService.createInterpreterLink(interpreterChannelId);
            setInterpreterLink({
                url: `https://${host}:${health.ports.https}/interpreter?code=${access.code}`,
                code: access.code,
                channelName: access.channelName,
            });
        }, t('interpreter_link_created'));
    };

    const revokeInterpreters = async () => {
        await run(async () => {
            await settingsService.revokeInterpreterSessions();
            setInterpreterLink(null);
        }, t('interpreter_access_ended'));
    };

    const changePin = async () => {
        if (newPin !== confirmPin) { setMessage(t('pins_mismatch')); return; }
        if (!/^\d{4,12}$/.test(newPin)) { setMessage(t('pin_length')); return; }
        await run(async () => {
            await settingsService.setAdminPin(newPin);
            setNewPin(''); setConfirmPin('');
        }, t('pin_changed'));
    };

    const restartApp = async () => {
        if (!window.confirm(t('restart_confirm'))) return;
        await run(() => settingsService.restartApp(), t('restarting'));
    };

    if (!settings) return <div className="page-container admin-page">{t('loading')}</div>;

    const sfuText = health ? (health.sfu === 'ready' ? t('status_ready') : t('status_unavailable')) : t('status_checking');
    const showRestart = restartNeeded || health?.portMode === 'range' || Boolean(health?.addressDrift);

    return (
        <div className="page-container admin-page">
            <header className="page-header">
                <div className="admin-header-left">
                    <button className="btn-icon" onClick={goBack} title={t('back')}><ArrowLeft size={24} /></button>
                    <h2>{t('admin_title')}</h2>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div className="language-toggle" style={{ position: 'static' }}>
                        <button className={`lang-btn ${locale === 'en' ? 'active' : ''}`} onClick={() => setLocale('en')}>EN</button>
                        <div className="divider" />
                        <button className={`lang-btn ${locale === 'ru' ? 'active' : ''}`} onClick={() => setLocale('ru')}>RU</button>
                    </div>
                    {/* There was no way to sign out, so a shared church computer stayed signed in. */}
                    <button className="btn-secondary" onClick={() => void settingsService.logout()}><LogOut size={18} /> {t('sign_out')}</button>
                </div>
            </header>

            {message && <div className="glass-panel" style={{ padding: '0.8rem 1rem', marginBottom: '1rem' }}>{message}</div>}

            {showRestart && (
                <div className="glass-panel" style={{ padding: '0.8rem 1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                    <span style={{ flex: 1 }}>{restartNeeded ? t('restart_needed') : (health?.addressDrift || t('port_range_warning'))}</span>
                    <button className="btn-primary" disabled={busy} onClick={() => void restartApp()}><RotateCcw size={18} /> {t('restart_app')}</button>
                </div>
            )}

            {showQr && qrUrl && (
                <div className="card fade-in highlight-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1000, width: '90%', maxWidth: 400 }}>
                    <div className="card-header"><QrCode size={20} /><h3>{t('listener_qr_title', { channel: qrLanguage?.name || '' })}</h3><button className="btn-icon-small" onClick={() => setShowQr(false)} style={{ marginLeft: 'auto' }}><X size={18} /></button></div>
                    <div className="qr-container"><div className="qr-box"><QRCodeSVG value={qrUrl} size={250} level="H" /></div><p className="text-muted">{qrUrl}</p></div>
                </div>
            )}

            {interpreterLink && (
                <div className="card fade-in highlight-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1000, width: '90%', maxWidth: 420 }}>
                    <div className="card-header"><Mic size={20} /><h3>{t('interpreter_qr_title', { channel: interpreterLink.channelName })}</h3><button className="btn-icon-small" onClick={() => setInterpreterLink(null)} style={{ marginLeft: 'auto' }}><X size={18} /></button></div>
                    <div className="qr-container"><div className="qr-box"><QRCodeSVG value={interpreterLink.url} size={250} level="H" /></div>
                        <p><strong>{t('code_label', { code: interpreterLink.code })}</strong></p><p className="text-muted">{interpreterLink.url}</p></div>
                </div>
            )}

            <div className="card fade-in highlight-card">
                <div className="card-header"><Monitor size={20} /><h3>{t('system_status')}</h3></div>
                <div className="connection-info">
                    <p>{t('media_engine')} <strong>{sfuText}</strong></p>
                    {health?.sfuError && <p style={{ color: 'var(--danger)' }}>{health.sfuError}</p>}
                    {health?.portMode === 'range' && <p style={{ color: 'var(--danger)' }}>{t('port_range_warning')}</p>}
                    {health?.addressDrift && <p style={{ color: 'var(--danger)' }}>{health.addressDrift}</p>}
                    {health && !health.secureStorageAvailable && <p style={{ color: 'var(--danger)' }}>{t('secure_storage_missing')}</p>}
                    <p>{t('certificate_label')} <strong>{health?.certificate.type === 'trusted' ? t('certificate_trusted') : t('certificate_local')}</strong></p>
                    {health?.certificate.expiresAt && <p className="text-muted">{t('expires', { date: new Date(health.certificate.expiresAt).toLocaleDateString(locale) })}</p>}
                    {health?.certificate.error && <p style={{ color: 'var(--danger)' }}>{health.certificate.error}</p>}
                    <p className="text-muted">{t('firewall_hint', { https: health?.ports.https ?? 4173, listener: health?.ports.listener ?? 4175, rtc: health?.ports.rtc ?? '10000/udp+tcp' })}</p>

                    <label className="mt-4">{t('phone_link_type')}</label>
                    <select className="custom-select" value={usePlainLink ? 'plain' : 'secure'} onChange={(event) => choosePhoneLink(event.target.value as PhoneLink)}>
                        <option value="plain" disabled={!plainAvailable}>{t('phone_link_plain')}</option>
                        <option value="secure">{t('phone_link_secure')}</option>
                    </select>
                    <p className="text-muted">{usePlainLink ? t('phone_link_plain_hint') : t('phone_link_secure_hint')}</p>
                    {health?.listenerPortError && (
                        <p style={{ color: 'var(--danger)' }}>{t('listener_port_unavailable', { error: health.listenerPortError })}</p>
                    )}

                    <label className="mt-4">{t('listener_qr_channel')}</label>
                    <select className="custom-select" value={qrChannelId} onChange={(event) => setQrChannelId(event.target.value)}>
                        {settings.languages.map((language) => <option key={language.id} value={language.id}>{language.name}</option>)}
                    </select>
                    <p className="text-muted"><code>{qrUrl || t('detecting_network')}</code></p>
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <button className="btn-primary" disabled={!qrUrl} onClick={() => setShowQr(true)}><QrCode size={18} /> {t('show_listener_qr')}</button>
                        <button className="btn-secondary" disabled={busy} onClick={() => void restartApp()}><RotateCcw size={18} /> {t('restart_app')}</button>
                    </div>
                </div>
            </div>

            <div className="card fade-in">
                <div className="card-header"><Mic size={20} /><h3>{t('phone_interpreter')}</h3></div>
                <p className="text-muted">{t('phone_interpreter_hint')}</p>
                <select className="custom-select" value={interpreterChannelId} onChange={(event) => setInterpreterChannelId(event.target.value)}>
                    {settings.languages.map((language) => <option key={language.id} value={language.id}>{language.name}</option>)}
                </select>
                <button className="btn-primary mt-4" disabled={busy || !health || !interpreterChannelId} onClick={() => void createInterpreterLink()}><QrCode size={18} /> {t('create_interpreter_qr')}</button>
                <p className="text-muted mt-4">{t('end_access_hint')}</p>
                <button className="btn-secondary" disabled={busy} onClick={() => void revokeInterpreters()}><X size={18} /> {t('end_interpreter_access')}</button>
            </div>

            <div className="card fade-in">
                <div className="card-header"><ShieldAlert size={20} /><h3>{t('trusted_certificate')}</h3></div>
                <p className="text-muted">{t('trusted_certificate_hint')}</p>
                <label>{t('duckdns_subdomain')}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><input className="custom-input" value={duckDomain} onChange={(event) => setDuckDomain(normaliseDuckDomain(event.target.value))} placeholder="my-church" /><span>.duckdns.org</span></div>
                <label className="mt-4">{t('duckdns_token')} {settings.duckDnsConfigured && <span className="text-muted">{t('token_saved')}</span>}</label>
                <input className="custom-input" type="password" value={duckToken} onChange={(event) => setDuckToken(event.target.value)} placeholder={t('duckdns_token_placeholder')} />
                <label className="mt-4">{t('certificate_email')}</label>
                <input className="custom-input" type="email" value={certificateEmail} onChange={(event) => setCertificateEmail(event.target.value)} placeholder="admin@example.com" />
                <button className="btn-primary mt-4" disabled={busy || !duckDomain || !certificateEmail || (!duckToken && !settings.duckDnsConfigured)} onClick={() => void run(async () => {
                    await settingsService.configureCertificate(duckDomain, duckToken, certificateEmail);
                    setDuckToken('');
                    await refreshHealth();
                }, t('certificate_ready'))}><ShieldAlert size={18} /> {t('install_certificate')}</button>
                {health?.certificate.type === 'trusted' && (
                    <button className="btn-secondary mt-4" disabled={busy} onClick={() => void run(async () => {
                        await settingsService.useSelfSignedCertificate();
                        await refreshHealth();
                        setRestartNeeded(true);
                    }, t('certificate_reverted'))}>
                        {t('stop_trusted_certificate')}
                    </button>
                )}
            </div>

            <div className="card fade-in">
                <div className="card-header"><Languages size={20} /><h3>{t('languages_title')}</h3></div>
                <div className="add-language-form">
                    <input value={languageName} onChange={(event) => setLanguageName(event.target.value)} placeholder={t('lang_name')} className="custom-input" />
                    <input value={languageCode} onChange={(event) => setLanguageCode(event.target.value.toLowerCase().slice(0, 8))} placeholder={t('iso_code_placeholder')} className="custom-input" style={{ maxWidth: 160 }} />
                    <button className="btn-primary-small" onClick={saveLanguage} disabled={busy} title={t('save')}>{editingLang ? <Save size={18} /> : <Plus size={18} />}</button>
                </div>
                <input value={languageDescription} onChange={(event) => setLanguageDescription(event.target.value)} placeholder={t('lang_desc')} className="custom-input" />
                {editingLang && <button className="btn-secondary mt-4" onClick={resetLanguageForm}>{t('cancel')}</button>}
                <div className="language-list mt-4">
                    {settings.languages.map((language) => (
                        <div key={language.id} className="language-item">
                            <div><strong>{language.name}</strong> <code>{language.code}</code><p className="text-muted">{language.description}</p></div>
                            <div className="language-actions">
                                <button className="btn-icon-small" onClick={() => editLanguage(language)}><Edit2 size={16} /></button>
                                <button className="btn-icon-small danger" disabled={settings.languages.length < 2} onClick={() => void run(() => settingsService.removeLanguage(language.id), t('language_removed'))}><Trash2 size={16} /></button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Phones fall back to this until they tap EN or RU themselves. It existed on the
                server but nothing could set it, so every phone started in English. */}
            <div className="card fade-in">
                <div className="card-header"><Globe size={20} /><h3>{t('phone_language')}</h3></div>
                <p className="text-muted">{t('phone_language_hint')}</p>
                <select className="custom-select" value={settings.interfaceLanguage || 'en'} disabled={busy}
                    onChange={(event) => void run(() => settingsService.setInterfaceLanguage(event.target.value as Locale), t('phone_language_saved'))}>
                    <option value="en">English</option>
                    <option value="ru">Русский</option>
                </select>
            </div>

            <div className="card fade-in">
                <div className="card-header"><Cpu size={20} /><h3>{t('openai_translation')}</h3></div>
                <p className="text-muted">{t('openai_billing_hint')}</p>
                <p className="text-muted">{t('openai_configured', { state: settings.openaiConfigured ? t('yes') : t('no') })}</p>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input type={showKey ? 'text' : 'password'} value={openaiKey} onChange={(event) => setOpenaiKey(event.target.value)} placeholder={t('openai_key_placeholder')} className="custom-input" />
                    <button className="btn-secondary" onClick={() => setShowKey(!showKey)}>{showKey ? t('hide') : t('show')}</button>
                </div>
                <button className="btn-primary mt-4" disabled={!openaiKey || busy} onClick={() => void run(async () => { await settingsService.setOpenAiApiKey(openaiKey); setOpenaiKey(''); }, t('openai_key_saved'))}>{t('save_openai_key')}</button>
                {settings.openaiConfigured && (
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <button className="btn-secondary mt-4" disabled={busy} onClick={() => void run(async () => { await settingsService.createRealtimeSession('ru', 'en'); }, t('openai_test_passed'))}>{t('test_openai')}</button>
                        <button className="btn-secondary mt-4" disabled={busy} onClick={() => void run(() => settingsService.clearOpenAiApiKey(), t('openai_key_removed'))}><Trash2 size={18} /> {t('remove_openai_key')}</button>
                    </div>
                )}
                <label className="mt-4" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <input type="checkbox" checked={settings.recordingEnabled} onChange={(event) => void run(() => settingsService.setRecordingEnabled(event.target.checked), t('recording_saved'))} />
                    {t('recording_label')}
                </label>
            </div>

            <div className="card fade-in">
                <div className="card-header"><Monitor size={20} /><h3>{t('network_adapter')}</h3></div>
                <select className="custom-select" value={settings.preferredAddress} onChange={(event) => void run(async () => {
                    await settingsService.setPreferredAddress(event.target.value);
                    setRestartNeeded(true);
                }, t('network_saved'))}>
                    <option value="">{t('automatic')}</option>
                    {health?.addresses.map((entry) => <option key={`${entry.name}-${entry.address}`} value={entry.address}>{entry.name}: {entry.address}</option>)}
                </select>
            </div>

            <div className="card fade-in">
                <div className="card-header"><Save size={20} /><h3>{t('security')}</h3></div>
                <p className="text-muted">{t('security_hint')}</p>
                <label>{t('new_pin')}</label>
                <input className="custom-input" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12}
                    value={newPin} onChange={(event) => setNewPin(event.target.value.replace(/\D/g, '').slice(0, 12))} />
                <label className="mt-4">{t('confirm_pin')}</label>
                <input className="custom-input" type="password" inputMode="numeric" autoComplete="new-password" maxLength={12}
                    value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 12))} />
                <button className="btn-primary mt-4" disabled={newPin.length < 4 || busy} onClick={() => void changePin()}>{t('save')}</button>
            </div>
        </div>
    );
}
