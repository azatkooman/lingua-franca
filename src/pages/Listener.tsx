import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Headphones, Volume2, VolumeX, Cpu } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { voiceService } from '../lib/VoiceService';
import { settingsService, type Language } from '../lib/SettingsService';
import { useTranslation } from '../lib/i18n';
import './Interpreter.css';
import './Listener.css';

export default function Listener() {
    const navigate = useNavigate();
    const { t } = useTranslation();
    const [isConnected, setIsConnected] = useState(false);
    const [languages, setLanguages] = useState<Language[]>([]);
    const [channel, setChannel] = useState('');
    const [volume, setVolume] = useState(80);
    const [isMuted, setIsMuted] = useState(false);
    const [status, setStatus] = useState(t('loading'));
    const [isInterpreterMuted, setIsInterpreterMuted] = useState(false);
    const [selectedLanguage, setSelectedLanguage] = useState<Language | null>(null);
    const [signalLevel, setSignalLevel] = useState(0);

    // AI Translation States
    const [subtitleText, setSubtitleText] = useState('');
    const [originalSubtitleText, setOriginalSubtitleText] = useState('');

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const meterCleanup = useRef<(() => void) | null>(null);

    // Subscribe to settings
    useEffect(() => {
        return settingsService.subscribe(s => setLanguages(s.languages));
    }, []);

    useEffect(() => {
        // Handle deep-linking via query params
        const params = new URLSearchParams(window.location.search);
        const urlChannel = params.get('channel');
        if (urlChannel && languages.length > 0) {
            const matchedLang = languages.find(l => l.name.toLowerCase() === urlChannel.toLowerCase());
            if (matchedLang) {
                setChannel(matchedLang.name);
                setSelectedLanguage(matchedLang);
            }
        }
    }, [languages]);

    // Re-connect if the activePeerId changes for our selected channel
    useEffect(() => {
        if (isConnected && selectedLanguage && channel) {
            const currentLang = languages.find(l => l.name === channel);
            if (currentLang && currentLang.activePeerId !== selectedLanguage.activePeerId) {
                setSelectedLanguage(currentLang);
                connectToChannel(currentLang);
            }
        }
    }, [languages, isConnected, channel]);

    useEffect(() => {
        // Create audio element for playback
        const audio = new Audio();
        audio.autoplay = true;
        audioRef.current = audio;

        // Proactively load SpeechSynthesis voices
        if (window.speechSynthesis) {
            window.speechSynthesis.getVoices();
        }

        return () => {
            voiceService.stopListening();
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.srcObject = null;
            }
            if (meterCleanup.current) {
                meterCleanup.current();
            }
            if (window.speechSynthesis) {
                window.speechSynthesis.cancel();
            }
        };
    }, []);

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.volume = isMuted ? 0 : volume / 100;
        }
    }, [volume, isMuted]);

    const speakText = (text: string, languageName: string) => {
        if (!window.speechSynthesis) return;

        // Cancel current speak
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        
        const langMap: Record<string, string> = {
            'english': 'en-US',
            'spanish': 'es-ES',
            'español': 'es-ES',
            'french': 'fr-FR',
            'français': 'fr-FR',
            'german': 'de-DE',
            'deutsch': 'de-DE',
            'russian': 'ru-RU',
            'русский': 'ru-RU'
        };

        const locale = langMap[languageName.toLowerCase()] || 'en-US';
        utterance.lang = locale;
        utterance.volume = isMuted ? 0 : volume / 100;

        // Find match voice
        const voices = window.speechSynthesis.getVoices();
        const voice = voices.find(v => v.lang.startsWith(locale) || v.lang === locale);
        if (voice) {
            utterance.voice = voice;
        }

        window.speechSynthesis.speak(utterance);
    };

    const connectToChannel = (langOverride?: Language) => {
        const lang = langOverride || selectedLanguage;
        if (!lang) return;

        setIsConnected(true);
        setStatus(t('connecting'));

        if (!lang.activePeerId) {
            setStatus(t('waiting_interpreter'));
            return;
        }

        if (lang.activePeerId === 'ai-active') {
            setStatus(t('connected_receiving'));
            setIsInterpreterMuted(false);

            voiceService.listenToChannel(
                'ai-active',
                lang.name,
                (newStatus) => setStatus(newStatus),
                () => {}, // Empty stream
                () => {}, // Empty mute
                (text, originalText) => {
                    setSubtitleText(text);
                    setOriginalSubtitleText(originalText);
                    speakText(text, lang.name);

                    // Signal animation trigger
                    setSignalLevel(60);
                    setTimeout(() => setSignalLevel(0), 1200);
                }
            );
            return;
        }

        // Traditional Human WebRTC stream
        voiceService.listenToChannel(
            lang.activePeerId,
            lang.name,
            (newStatus) => setStatus(newStatus),
            (stream) => {
                if (audioRef.current) {
                    audioRef.current.srcObject = stream;
                    audioRef.current.muted = false;
                    audioRef.current.volume = volume / 100;
                    audioRef.current.play().then(() => {
                    }).catch(err => {
                        console.error('Audio playback failed:', err);
                        setStatus(t('no_sound_hint'));
                    });

                    // Start level meter
                    if (meterCleanup.current) meterCleanup.current();
                    meterCleanup.current = voiceService.createLevelMeter(stream, (level) => {
                        setSignalLevel(level);
                    });
                }
            },
            (muted) => {
                setIsInterpreterMuted(muted);
            }
        );
    };

    const disconnect = () => {
        voiceService.stopListening();
        setIsConnected(false);
        setStatus(t('loading'));
        setSignalLevel(0);
        setSubtitleText('');
        setOriginalSubtitleText('');
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
        if (meterCleanup.current) {
            meterCleanup.current();
            meterCleanup.current = null;
        }
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.srcObject = null;
        }
    };

    return (
        <div className="page-container">
            <header className="page-header">
                <button className="btn-icon" onClick={() => navigate(-1)} title={t('back')}>
                    <ArrowLeft size={24} />
                </button>
                <h2>{t('be_listener')}</h2>
                <div style={{ width: 24 }}></div>
            </header>

            {!isConnected ? (
                <div className="card fade-in">
                    <div className="listener-empty-state">
                        <div className="icon-wrapper base-icon">
                            <Headphones size={40} color="var(--primary)" />
                        </div>
                        <h3>{t('select_channel')}</h3>
                    </div>

                    <div className="channel-list">
                        {languages.map((lang) => {
                            const isLiveChannel = !!lang.activePeerId;
                            const isAiChannel = lang.activePeerId === 'ai-active';
                            return (
                                <button
                                    key={lang.id}
                                    className={`channel-btn ${channel === lang.name ? 'selected' : ''}`}
                                    onClick={() => {
                                        setChannel(lang.name);
                                        setSelectedLanguage(lang);
                                    }}
                                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', padding: '1rem', position: 'relative' }}
                                >
                                    <span style={{ fontWeight: 'bold' }}>{lang.name}</span>
                                    <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>{lang.description}</span>
                                    
                                    {isLiveChannel && (
                                        <span style={{
                                            position: 'absolute',
                                            top: '1rem',
                                            right: '1rem',
                                            background: isAiChannel ? 'var(--primary-glow)' : 'rgba(16, 185, 129, 0.15)',
                                            color: isAiChannel ? 'var(--primary)' : 'var(--accent)',
                                            border: `1px solid ${isAiChannel ? 'var(--primary)' : 'var(--accent)'}`,
                                            padding: '0.15rem 0.5rem',
                                            borderRadius: 'var(--radius-full)',
                                            fontSize: '0.7rem',
                                            fontWeight: 'bold'
                                        }}>
                                            {isAiChannel ? 'AI' : 'LIVE'}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                        {languages.length === 0 && (
                            <p className="text-muted" style={{ textAlign: 'center', padding: '1rem', width: '100%' }}>{t('no_languages')}</p>
                        )}
                    </div>

                    <button
                        className="btn-primary mt-4"
                        disabled={!channel}
                        onClick={() => connectToChannel()}
                    >
                        {t('connect')} {channel || ''}
                    </button>
                </div>
            ) : (
                <div className="card active-listener fade-in">
                    {/* AI Mode Active Badge */}
                    {selectedLanguage?.activePeerId === 'ai-active' && (
                        <div style={{ textAlign: 'center' }}>
                            <div className="ai-active-badge" style={{ background: 'var(--primary-glow)', border: '1px solid var(--primary)', padding: '0.25rem 0.75rem', borderRadius: 'var(--radius-full)', fontSize: '0.85rem', fontWeight: 600, color: 'var(--primary)', marginBottom: '1.5rem', display: 'inline-block' }}>
                                {t('ai_active')}
                            </div>
                        </div>
                    )}

                    <div className="listening-pulse">
                        <div className="ring ring-1"></div>
                        <div className="ring ring-2"></div>
                        <div className="ring ring-3"></div>
                        <div className="center-orb bg-primary" style={{ background: selectedLanguage?.activePeerId === 'ai-active' ? 'var(--primary)' : 'var(--accent)' }}>
                            {selectedLanguage?.activePeerId === 'ai-active' ? <Cpu size={40} color="white" /> : <Headphones size={40} color="white" />}
                        </div>
                    </div>

                    <h3 className="listening-title">{t('listener_mode')}: {channel}</h3>
                    <p className={`status-text ${isInterpreterMuted ? 'text-danger pulse' : 'text-accent'}`}>
                        {isInterpreterMuted ? t('interpreter_muted') : status}
                    </p>

                    {/* Subtitles Area for AI Mode */}
                    {selectedLanguage?.activePeerId === 'ai-active' && (
                        <div className="glass-panel" style={{ width: '100%', minHeight: '120px', margin: '2rem 0', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center', padding: '1.5rem', background: 'rgba(255,255,255,0.03)' }}>
                            <p style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-main)', lineHeight: 1.4, marginBottom: originalSubtitleText ? '0.5rem' : 0 }}>
                                {subtitleText || 'Waiting for speech...'}
                            </p>
                            {originalSubtitleText && (
                                <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                    {t('original_text')}: {originalSubtitleText}
                                </p>
                            )}
                        </div>
                    )}

                    <div className="volume-control glass-panel">
                        <div className="signal-meter">
                            <div className="signal-bar" style={{ height: `${signalLevel}%` }}></div>
                        </div>
                        <button className="btn-icon" onClick={() => setIsMuted(!isMuted)}>
                            {isMuted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
                        </button>
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={isMuted ? 0 : volume}
                            style={{ '--volume-percent': `${isMuted ? 0 : volume}%` } as any}
                            onChange={(e) => {
                                setVolume(parseInt(e.target.value));
                                if (isMuted) setIsMuted(false);
                            }}
                            className="volume-slider"
                        />
                    </div>

                    <button className="btn-secondary mt-4" onClick={disconnect}>
                        {t('disconnect')}
                    </button>
                </div>
            )}
        </div>
    );
}
