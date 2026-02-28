import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Mic } from 'lucide-react';
import { useState, useEffect } from 'react';
import { voiceService } from '../lib/VoiceService';
import { settingsService, type Language } from '../lib/SettingsService';
import { useTranslation } from '../lib/i18n';
import './Interpreter.css';
import './Listener.css';

export default function Interpreter() {
    const navigate = useNavigate();
    const { t } = useTranslation();
    const [isLive, setIsLive] = useState(false);
    const [languages, setLanguages] = useState<Language[]>([]);
    const [language, setLanguage] = useState('');
    const [status, setStatus] = useState(t('offline'));
    const [listenersCount, setListenersCount] = useState(0);
    const [isMuted, setIsMuted] = useState(false);
    const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
    const [selectedMic, setSelectedMic] = useState('');

    useEffect(() => {
        const unsubscribe = settingsService.subscribe(s => {
            setLanguages(s.languages);
            // Default to first language if none selected
            if (!language && s.languages.length > 0) {
                setLanguage(s.languages[0].name);
            }
        });

        // Fetch microphones
        voiceService.getMicrophones().then(mics => {
            setMicrophones(mics);
            if (mics.length > 0) setSelectedMic(mics[0].deviceId);
        });

        return unsubscribe;
    }, [language]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            voiceService.stopBroadcast();
        };
    }, []);

    const toggleBroadcast = async () => {
        if (isLive) {
            voiceService.stopBroadcast();
            setIsLive(false);
            setStatus(t('offline'));
            setListenersCount(0);
        } else {
            setStatus(t('starting'));
            try {
                await voiceService.startBroadcast(
                    language,
                    (newStatus) => setStatus(newStatus),
                    (count) => setListenersCount(count),
                    selectedMic
                );
                setIsLive(true);
                setIsMuted(false);
            } catch (err) {
                setIsLive(false);
                setStatus(t('mic_denied'));
            }
        }
    };

    const toggleMute = () => {
        const newMuteState = !isMuted;
        setIsMuted(newMuteState);
        voiceService.setMuted(newMuteState);
        setStatus(newMuteState ? t('interpreter_muted') : t('on_air'));
    };

    return (
        <div className="page-container">
            <header className="page-header">
                <button className="btn-icon" onClick={() => navigate(-1)} title={t('back')}>
                    <ArrowLeft size={24} />
                </button>
                <h2>{t('interpreter_studio')}</h2>
                <div style={{ width: 24 }}></div>
            </header>

            <div className="card interpreter-card fade-in">
                <div className="status-indicator">
                    <div className={`led ${isLive ? 'led-on' : 'led-off'}`}></div>
                    <span style={{ minWidth: 100, textAlign: 'center' }}>
                        {isLive ? t('on_air') : status}
                    </span>
                </div>

                <div className="language-selector">
                    <label>{t('translating_into')}</label>
                    <select
                        value={language}
                        onChange={(e) => setLanguage(e.target.value)}
                        className="custom-select"
                        disabled={isLive}
                    >
                        {languages.map(lang => (
                            <option key={lang.id} value={lang.name}>{lang.name}</option>
                        ))}
                    </select>
                </div>

                <div className="language-selector">
                    <label>{t('select_mic')}</label>
                    <select
                        value={selectedMic}
                        onChange={(e) => setSelectedMic(e.target.value)}
                        className="custom-select"
                        disabled={isLive}
                    >
                        {microphones.length === 0 ? (
                            <option value="">No microphones found</option>
                        ) : (
                            microphones.map(mic => (
                                <option key={mic.deviceId} value={mic.deviceId}>
                                    {mic.label || `Microphone ${mic.deviceId.substring(0, 5)}`}
                                </option>
                            ))
                        )}
                    </select>
                </div>

                <div className="mic-controls-main" style={{ marginTop: '2rem' }}>
                    {!isLive ? (
                        <button
                            className="btn-primary"
                            style={{
                                width: '100%',
                                height: '80px',
                                fontSize: '1.5rem',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '1rem',
                                background: 'var(--accent)'
                            }}
                            onClick={toggleBroadcast}
                        >
                            <Mic size={32} />
                            {t('go_live')}
                        </button>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%' }}>
                            <div style={{ display: 'flex', gap: '1rem' }}>
                                <button
                                    className={`btn-primary ${isMuted ? 'muted' : ''}`}
                                    style={{
                                        flex: 1,
                                        height: '80px',
                                        fontSize: '1.25rem',
                                        background: isMuted ? 'var(--dark)' : 'var(--accent)',
                                        border: isMuted ? '2px solid var(--accent)' : 'none'
                                    }}
                                    onClick={toggleMute}
                                >
                                    {isMuted ? t('unmute_mic') : t('mute_mic')}
                                </button>

                                <button
                                    className="btn-primary"
                                    style={{
                                        flex: 1,
                                        height: '80px',
                                        fontSize: '1.25rem',
                                        background: 'var(--danger)'
                                    }}
                                    onClick={toggleBroadcast}
                                >
                                    {t('stop_broadcast')}
                                </button>
                            </div>

                            {isMuted && (
                                <div className="mute-warning fade-in" style={{ textAlign: 'center', color: 'var(--danger)', fontWeight: 'bold' }}>
                                    {t('mute_warning')}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="stats-panel glass-panel" style={{ opacity: isLive ? 1 : 0.5, marginTop: '2rem' }}>
                    <div className="stat">
                        <span className="stat-value">{listenersCount}</span>
                        <span className="stat-label">{t('listeners')}</span>
                    </div>
                    <div className="stat">
                        <span className="stat-value text-accent" style={{ fontSize: '1rem', marginTop: 10 }}>
                            {status}
                        </span>
                        <span className="stat-label">{t('status')}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
