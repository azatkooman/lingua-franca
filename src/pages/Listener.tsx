import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Headphones, Volume2, VolumeX } from 'lucide-react';
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

    const audioRef = useRef<HTMLAudioElement | null>(null);

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

        return () => {
            voiceService.stopListening();
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.srcObject = null;
            }
        };
    }, []);

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.volume = isMuted ? 0 : volume / 100;
        }
    }, [volume, isMuted]);

    const connectToChannel = (langOverride?: Language) => {
        const lang = langOverride || selectedLanguage;
        if (!lang) return;

        setIsConnected(true);
        setStatus(t('connecting'));

        if (!lang.activePeerId) {
            setStatus(t('waiting_interpreter'));
            // We just wait for SettingsService refresh to give us a real ID
            return;
        }

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
                        <p>{t('select_channel')}</p>
                    </div>

                    <div className="channel-list">
                        {languages.map((lang) => (
                            <button
                                key={lang.id}
                                className={`channel-btn ${channel === lang.name ? 'selected' : ''}`}
                                onClick={() => {
                                    setChannel(lang.name);
                                    setSelectedLanguage(lang);
                                }}
                                style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', padding: '1rem' }}
                            >
                                <span style={{ fontWeight: 'bold' }}>{lang.name}</span>
                                <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>{lang.description}</span>
                            </button>
                        ))}
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
                    <div className="listening-pulse">
                        <div className="ring ring-1"></div>
                        <div className="ring ring-2"></div>
                        <div className="ring ring-3"></div>
                        <div className="center-orb bg-primary">
                            <Headphones size={40} color="white" />
                        </div>
                    </div>

                    <h3 className="listening-title">{t('listener_mode')}: {channel}</h3>
                    <p className={`status-text ${isInterpreterMuted ? 'text-danger pulse' : 'text-accent'}`}>
                        {isInterpreterMuted ? `● ${t('interpreter_muted')}` : `● ${status}`}
                    </p>

                    <div className="volume-control glass-panel">
                        <button className="btn-icon" onClick={() => setIsMuted(!isMuted)}>
                            {isMuted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
                        </button>
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={isMuted ? 0 : volume}
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
