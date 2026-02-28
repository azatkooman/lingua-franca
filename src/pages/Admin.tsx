import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Plus, Trash2, Edit2, QrCode, Monitor, Languages, X } from 'lucide-react';
import { useState, useEffect } from 'react';
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
    const [pin, setPin] = useState('');

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
            setPin(s.adminPin);
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
        if (pin.length < 4) {
            alert(t('enter_pin'));
            return;
        }
        await settingsService.setAdminPin(pin);
        alert(t('save') + '!');
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
                    <h3>{t('admin_title')}</h3>
                </div>
                <div style={{ padding: '0.5rem' }}>
                    <p className="text-muted mb-4">{t('enter_pin')}</p>
                    <div className="pin-digit-container" style={{ margin: '1rem 0' }}>
                        {[0, 1, 2, 3].map((idx) => (
                            <input
                                key={idx}
                                id={`setting-pin-${idx}`}
                                type="text"
                                inputMode="numeric"
                                maxLength={1}
                                value={pin[idx] || ''}
                                onChange={(e) => {
                                    const val = e.target.value.replace(/\D/g, '');
                                    if (!val) return;
                                    const newPin = pin.split('');
                                    newPin[idx] = val.slice(-1);
                                    setPin(newPin.join(''));
                                    if (idx < 3) document.getElementById(`setting-pin-${idx + 1}`)?.focus();
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Backspace' && !pin[idx] && idx > 0) {
                                        document.getElementById(`setting-pin-${idx - 1}`)?.focus();
                                    }
                                }}
                                className="pin-digit-input"
                                style={{ width: 50, height: 60, fontSize: '1.5rem' }}
                            />
                        ))}
                    </div>
                    <button className="btn-primary mt-4" onClick={savePin} style={{ maxWidth: 250, margin: '2rem auto 0' }}>
                        {t('save')}
                    </button>
                </div>
            </div>
        </div>
    );
}
