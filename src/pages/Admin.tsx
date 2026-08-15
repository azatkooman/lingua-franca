import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Plus, Trash2, Edit2, QrCode, Monitor, Languages, X, Cpu } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { settingsService } from '../lib/SettingsService';
import type { Language, AppSettings } from '../lib/SettingsService';
import { useTranslation } from '../lib/i18n';
import './Admin.css';

export default function Admin() {
    const navigate = useNavigate();
    const { t, locale, setLocale } = useTranslation();
    const [serverIp, setServerIp] = useState<string | null>(null);
    const [settings, setSettings] = useState<AppSettings | null>(null);

    // UI State
    const [showQr, setShowQr] = useState(false);
    const [editingLang, setEditingLang] = useState<Language | null>(null);
    const [newLangName, setNewLangName] = useState('');
    const [newLangDesc, setNewLangDesc] = useState('');
    const [pinDigits, setPinDigits] = useState(['', '', '', '']);
    const isPinInitialized = useRef(false);

    // AI State
    const [geminiKey, setGeminiKey] = useState('');
    const [showKey, setShowKey] = useState(false);
    const [testInput, setTestInput] = useState('Hello, how are you?');
    const [testResult, setTestResult] = useState('');
    const [testing, setTesting] = useState(false);

    useEffect(() => {
        fetch('/api/local-ip')
            .then(res => res.json())
            .then(data => setServerIp(data.ip))
            .catch(err => {
                console.log('Not running in Electron or no local IP found', err);
                const currentHost = window.location.hostname;
                if (currentHost && currentHost !== 'localhost' && currentHost !== '127.0.0.1') {
                    setServerIp(currentHost);
                } else {
                    setServerIp('127.0.0.1');
                }
            });

        // Subscribe to settings changes
        const unsubscribe = settingsService.subscribe((s) => {
            setSettings(s);
            if (s.geminiApiKey !== undefined && !isPinInitialized.current) {
                setGeminiKey(s.geminiApiKey || '');
            }
            // Initialize pin digits only once from settings
            if (!isPinInitialized.current && s.adminPin) {
                setPinDigits(s.adminPin.split('').slice(0, 4));
                isPinInitialized.current = true;
            }
        });

        return unsubscribe;
    }, []);

    const toggleMainQr = () => setShowQr(!showQr);

    const handleAddLanguage = async () => {
        if (!newLangName) return;
        await settingsService.addLanguage(newLangName, newLangDesc);
        setNewLangName('');
        setNewLangDesc('');
    };

    const handleUpdateLanguage = async () => {
        if (!editingLang || !newLangName) return;
        await settingsService.updateLanguage(editingLang.id, newLangName, newLangDesc);
        setEditingLang(null);
        setNewLangName('');
        setNewLangDesc('');
    };

    const handleDeleteLanguage = async (id: string) => {
        if (confirm(t('delete') + '?')) {
            // Optimistic update: remove from local list immediately
            setSettings(prev => {
                if (!prev) return null;
                return {
                    ...prev,
                    languages: prev.languages.filter(l => l.id !== id)
                };
            });
            await settingsService.removeLanguage(id);
        }
    };

    const startEditing = (lang: Language) => {
        setEditingLang(lang);
        setNewLangName(lang.name);
        setNewLangDesc(lang.description);
    };

    const savePin = async () => {
        const pin = pinDigits.join('');
        if (pin.length < 4 || pinDigits.some(d => d === '')) {
            alert(t('enter_pin'));
            return;
        }
        await settingsService.setAdminPin(pin);
        alert(t('save') + '!');
    };

    const handleSaveGeminiKey = async () => {
        await settingsService.setGeminiApiKey(geminiKey);
        alert(t('save') + '!');
    };

    const handleTestTranslation = async () => {
        if (!testInput) return;
        setTesting(true);
        setTestResult('');
        try {
            const res = await fetch('/api/translate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: testInput,
                    sourceLang: 'English',
                    targetLang: 'Spanish'
                })
            });
            if (res.ok) {
                const data = await res.json();
                setTestResult(data.translatedText || t('error'));
            } else {
                setTestResult(t('test_failed') + res.statusText);
            }
        } catch (err: any) {
            setTestResult(t('test_failed') + (err.message || String(err)));
        } finally {
            setTesting(false);
        }
    };

    const connectionUrl = serverIp ? `https://${serverIp}:4173` : '';

    if (!settings) return <div className="page-container admin-page">{t('loading')}</div>;

    return (
        <div className="page-container admin-page">
            <header className="page-header">
                <div className="admin-header-left">
                    <button className="btn-icon" onClick={() => navigate(-1)} title={t('back')}>
                        <ArrowLeft size={24} />
                    </button>
                    <h2>{t('admin_title')}</h2>
                </div>
                <div className="admin-header-right" style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                    <div className="language-toggle" style={{ position: 'static' }}>
                        <button
                            className={`lang-btn ${locale === 'en' ? 'active' : ''}`}
                            onClick={() => setLocale('en')}
                        >
                            EN
                        </button>
                        <div className="divider"></div>
                        <button
                            className={`lang-btn ${locale === 'ru' ? 'active' : ''}`}
                            onClick={() => setLocale('ru')}
                        >
                            RU
                        </button>
                    </div>
                </div>
            </header>

            {/* Global Access QR Overlay */}
            {showQr && (
                <div className="card fade-in highlight-card" style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1000, boxShadow: '0 0 100px rgba(0,0,0,0.8)', width: '90%', maxWidth: 400 }}>
                    <div className="card-header">
                        <QrCode size={20} color="var(--primary)" />
                        <h3>{t('active_session')}</h3>
                        <button className="btn-icon-small" onClick={() => setShowQr(false)} style={{ marginLeft: 'auto' }}>
                            <X size={18} />
                        </button>
                    </div>
                    <div className="qr-container" style={{ marginTop: 0, paddingBottom: '2rem' }}>
                        <div className="qr-box">
                            <QRCodeSVG
                                value={connectionUrl}
                                size={250}
                                level="H"
                            />
                        </div>
                        <p className="text-muted" style={{ fontSize: '0.9rem', marginTop: '2rem', wordBreak: 'break-all', padding: '0 1rem', lineHeight: 1.4 }}>
                            {connectionUrl}
                        </p>
                    </div>
                </div>
            )}

            {/* 1. Connection Section */}
            <div className="card fade-in highlight-card">
                <div className="card-header">
                    <Monitor size={20} color="var(--primary)" />
                    <h3>{t('status')}</h3>
                </div>

                <div className="connection-info">
                    <p className="text-muted">{t('welcome_subtitle')}</p>
                    <div className="url-display">
                        <code>{connectionUrl}</code>
                        <button className="btn-icon-small" onClick={toggleMainQr} title="Show Connection QR">
                            <QrCode size={18} />
                        </button>
                    </div>
                </div>
            </div>

            {/* 2. Language Management Section */}
            <div className="card fade-in">
                <div className="card-header">
                    <Languages size={20} color="var(--accent)" />
                    <h3>{t('live_channels')}</h3>
                </div>

                <div className="lang-editor-form">
                    <div className="input-row">
                        <input
                            type="text"
                            placeholder={t('lang_name')}
                            value={newLangName}
                            onChange={(e) => setNewLangName(e.target.value)}
                            className="custom-input"
                        />
                        <button className="btn-primary-small" onClick={editingLang ? handleUpdateLanguage : handleAddLanguage}>
                            {editingLang ? <Save size={18} /> : <Plus size={18} />}
                            <span>{editingLang ? t('save') : t('add_language')}</span>
                        </button>
                    </div>
                    <textarea
                        placeholder={t('lang_desc')}
                        value={newLangDesc}
                        onChange={(e) => setNewLangDesc(e.target.value)}
                        className="custom-input mt-2"
                        rows={2}
                    />
                    {editingLang && (
                        <button className="btn-text mt-2" onClick={() => { setEditingLang(null); setNewLangName(''); setNewLangDesc(''); }}>
                            {t('cancel')}
                        </button>
                    )}
                </div>

                <div className="lang-list mt-4">
                    {settings.languages.map((lang) => (
                        <div key={lang.id} className="lang-item glass-panel">
                            <div className="lang-info">
                                <strong>{lang.name}</strong>
                                <span className="text-muted">{lang.description}</span>
                            </div>
                            <div className="lang-actions">
                                <button className="btn-icon-subtle" onClick={() => startEditing(lang)}>
                                    <Edit2 size={16} />
                                </button>
                                <button className="btn-icon-subtle text-danger" onClick={() => handleDeleteLanguage(lang.id)}>
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        </div>
                    ))}
                    {settings.languages.length === 0 && (
                        <p className="text-muted" style={{ textAlign: 'center', padding: '1rem' }}>{t('no_channels')}</p>
                    )}
                </div>
            </div>

            {/* 3. Security Section */}
            <div className="card fade-in">
                <div className="card-header">
                    <Save size={20} color="var(--primary)" />
                    <h3>{t('change_pin')}</h3>
                </div>
                <div style={{ padding: '0.5rem' }}>
                    <p className="text-muted mb-4">{t('enter_new_pin')}</p>
                    <div className="pin-digit-container" style={{ margin: '1rem 0' }}>
                        {pinDigits.map((digit, idx) => (
                            <input
                                key={idx}
                                id={`setting-pin-${idx}`}
                                type="text"
                                inputMode="numeric"
                                value={digit}
                                onFocus={(e) => e.target.select()}
                                onChange={(e) => {
                                    const val = e.target.value.replace(/\D/g, '');
                                    const newDigits = [...pinDigits];
                                    // Take the last digit entered (supports overwrite)
                                    newDigits[idx] = val.slice(-1);
                                    setPinDigits(newDigits);

                                    if (val && idx < 3) {
                                        document.getElementById(`setting-pin-${idx + 1}`)?.focus();
                                    }
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Backspace' && !pinDigits[idx] && idx > 0) {
                                        document.getElementById(`setting-pin-${idx - 1}`)?.focus();
                                    }
                                }}
                                className="pin-digit-input"
                                style={{ width: 50, height: 60, fontSize: '1.5rem' }}
                                autoComplete="off"
                            />
                        ))}
                    </div>
                    <button className="btn-primary mt-4" onClick={savePin} style={{ maxWidth: 250, margin: '2rem auto 0' }}>
                        {t('save')}
                    </button>
                </div>
            </div>

            {/* 4. AI Settings Section */}
            <div className="card fade-in">
                <div className="card-header">
                    <Cpu size={20} color="var(--primary)" />
                    <h3>{t('ai_mode')} Settings</h3>
                </div>
                <div style={{ padding: '0.5rem' }}>
                    <p className="text-muted mb-4">{t('no_key_warning')}</p>
                    
                    <div style={{ display: 'flex', gap: '1rem', flexDirection: 'column', width: '100%' }}>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <input
                                type={showKey ? 'text' : 'password'}
                                placeholder={t('gemini_api_key')}
                                value={geminiKey}
                                onChange={(e) => setGeminiKey(e.target.value)}
                                className="custom-input"
                                style={{ flex: 1 }}
                            />
                            <button
                                className="btn-secondary"
                                style={{ width: 'auto', padding: '0.75rem 1rem', height: '42px', fontSize: '0.9rem' }}
                                onClick={() => setShowKey(!showKey)}
                            >
                                {showKey ? 'Hide' : 'Show'}
                            </button>
                        </div>

                        <button className="btn-primary" onClick={handleSaveGeminiKey} style={{ maxWidth: 250, margin: '1rem 0 0' }}>
                            {t('save')} Key
                        </button>

                        <div className="glass-panel" style={{ marginTop: '2rem', padding: '1.5rem' }}>
                            <h4 style={{ marginBottom: '1rem', fontSize: '1.1rem' }}>{t('test_translation')} (EN → ES)</h4>
                            <input
                                type="text"
                                value={testInput}
                                onChange={(e) => setTestInput(e.target.value)}
                                className="custom-input"
                                style={{ marginBottom: '1rem' }}
                            />
                            <button
                                className="btn-secondary"
                                style={{ padding: '0.75rem 1.5rem', width: 'auto' }}
                                onClick={handleTestTranslation}
                                disabled={testing}
                            >
                                {testing ? t('loading') : t('test_translation')}
                            </button>

                            {testResult && (
                                <div style={{ marginTop: '1.5rem', background: 'rgba(255,255,255,0.05)', padding: '1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                                    <strong style={{ fontSize: '0.85rem', color: 'var(--primary)', textTransform: 'uppercase', display: 'block', marginBottom: '0.25rem' }}>
                                        Result
                                    </strong>
                                    <p style={{ fontSize: '1rem', wordBreak: 'break-all' }}>{testResult}</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
