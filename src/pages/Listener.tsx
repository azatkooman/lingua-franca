import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Headphones, Volume2, VolumeX, Cpu, Ear } from 'lucide-react';
import { useState, useEffect, useRef, type CSSProperties } from 'react';
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
    const [channel, setChannel] = useState(() => new URLSearchParams(window.location.search).get('channel') || '');
    const [volume, setVolume] = useState(80);
    const [isMuted, setIsMuted] = useState(false);
    const [playbackMode, setPlaybackMode] = useState<'speaker' | 'earpiece'>('speaker');
    const [playbackHint, setPlaybackHint] = useState('');
    const [status, setStatus] = useState(t('loading'));
    const [isInterpreterMuted, setIsInterpreterMuted] = useState(false);
    const [selectedLanguage, setSelectedLanguage] = useState<Language | null>(null);
    const [signalLevel, setSignalLevel] = useState(0);

    // AI Translation States
    const [subtitleText, setSubtitleText] = useState('');
    const [originalSubtitleText, setOriginalSubtitleText] = useState('');

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const playbackModeRef = useRef<'speaker' | 'earpiece'>('speaker');
    const meterCleanup = useRef<(() => void) | null>(null);
    const activeLanguage = languages.find((language) => language.name === channel) || selectedLanguage;

    type AudioSessionNavigator = Navigator & {
        audioSession?: { type: 'auto' | 'playback' | 'play-and-record' };
        mediaDevices: MediaDevices & {
            selectAudioOutput?: () => Promise<MediaDeviceInfo>;
        };
    };

    type SinkAudioElement = HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
    };

    const applyPlaybackMode = async (mode: 'speaker' | 'earpiece') => {
        const audio = audioRef.current as SinkAudioElement | null;
        if (!audio) return;

        const phoneNavigator = navigator as AudioSessionNavigator;
        let routedToNamedDevice = false;
        let audioSessionApplied = false;
        setPlaybackHint(mode === 'speaker' ? t('speaker_active') : t('earpiece_requested'));

        try {
            if (phoneNavigator.audioSession) {
                phoneNavigator.audioSession.type = mode === 'speaker' ? 'playback' : 'play-and-record';
                audioSessionApplied = true;
            }

            if (audio.setSinkId && navigator.mediaDevices?.enumerateDevices) {
                const outputs = (await navigator.mediaDevices.enumerateDevices())
                    .filter((device) => device.kind === 'audiooutput');
                const pattern = mode === 'speaker'
                    ? /speaker|speakerphone|loudspeaker|громк/i
                    : /earpiece|receiver|handset|телефон|динамик вызова/i;
                const matchingOutput = outputs.find((device) => pattern.test(device.label));

                if (matchingOutput) {
                    await audio.setSinkId(matchingOutput.deviceId);
                    routedToNamedDevice = true;
                } else if (mode === 'speaker') {
                    // Empty sink ID restores the normal media/speaker output.
                    await audio.setSinkId('');
                }
            }

            if (mode === 'earpiece' && !routedToNamedDevice && !audioSessionApplied) {
                setPlaybackHint(t('earpiece_fallback'));
            } else {
                setPlaybackHint(mode === 'speaker' ? t('speaker_active') : t('earpiece_active'));
            }
        } catch (error) {
            console.warn('Audio output routing is controlled by the phone:', error);
            setPlaybackHint(mode === 'speaker' ? t('speaker_active') : t('earpiece_fallback'));
        }
    };

    // Subscribe to settings
    useEffect(() => {
        return settingsService.subscribe(s => setLanguages(s.languages));
    }, []);

    useEffect(() => {
        // Create audio element for playback
        const audio = new Audio();
        audio.autoplay = true;
        audio.setAttribute('playsinline', '');
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
            audioRef.current.muted = isMuted;
            audioRef.current.volume = volume / 100;
        }
        if (isMuted && window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }
    }, [volume, isMuted]);

    const speakText = (text: string, languageName: string) => {
        if (!window.speechSynthesis) return;

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
        // Read from the audio element so delayed translation callbacks respect the latest controls.
        utterance.volume = audioRef.current?.muted ? 0 : (audioRef.current?.volume ?? volume / 100);

        // Find match voice
        const voices = window.speechSynthesis.getVoices();
        const voice = voices.find(v => v.lang.startsWith(locale) || v.lang === locale);
        if (voice) {
            utterance.voice = voice;
        }

        window.speechSynthesis.speak(utterance);
    };

    const connectToChannel = (langOverride?: Language) => {
        const lang = langOverride || languages.find((language) => language.name.toLowerCase() === channel.toLowerCase()) || selectedLanguage;
        if (!lang) return;

        setIsConnected(true);
        setStatus(t('connecting'));

        if (!lang.activePeerId) {
            setStatus(t('waiting_interpreter'));
        }

        voiceService.listenToChannel(
            lang.activePeerId || '',
            lang.name,
            (newStatus) => setStatus(newStatus),
            (stream) => {
                if (audioRef.current) {
                    audioRef.current.srcObject = stream;
                    audioRef.current.play().then(() => {
                        void applyPlaybackMode(playbackModeRef.current);
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
            },
            (text, originalText) => {
                setSubtitleText(text);
                setOriginalSubtitleText(originalText);
                // Text fallback has no centralized media producer, so the device speaks it.
                if (!audioRef.current?.srcObject) speakText(text, lang.name);
            },
        );
    };

    const disconnect = () => {
        voiceService.stopListening();
        setIsConnected(false);
        setStatus(t('loading'));
        setSignalLevel(0);
        setSubtitleText('');
        setOriginalSubtitleText('');
        setPlaybackHint('');
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
                    {activeLanguage?.activePeerId === 'ai-active' && (
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
                        <div className="center-orb bg-primary" style={{ background: activeLanguage?.activePeerId === 'ai-active' ? 'var(--primary)' : 'var(--accent)' }}>
                            {activeLanguage?.activePeerId === 'ai-active' ? <Cpu size={40} color="white" /> : <Headphones size={40} color="white" />}
                        </div>
                    </div>

                    <h3 className="listening-title">{t('listener_mode')}: {channel}</h3>
                    <p className={`status-text ${isInterpreterMuted ? 'text-danger pulse' : 'text-accent'}`}>
                        {isInterpreterMuted ? t('interpreter_muted') : status}
                    </p>

                    {/* Subtitles Area for AI Mode */}
                    {activeLanguage?.activePeerId === 'ai-active' && (
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

                    <div className="playback-controls glass-panel" role="group" aria-label={t('audio_output')}>
                        <button
                            type="button"
                            className={`playback-mode-btn ${playbackMode === 'earpiece' ? 'active' : ''}`}
                            aria-pressed={playbackMode === 'earpiece'}
                            onClick={() => {
                                playbackModeRef.current = 'earpiece';
                                setPlaybackMode('earpiece');
                                void applyPlaybackMode('earpiece');
                            }}
                        >
                            <Ear size={22} />
                            <span>{t('earpiece')}</span>
                        </button>
                        <button
                            type="button"
                            className={`playback-mode-btn ${playbackMode === 'speaker' ? 'active' : ''}`}
                            aria-pressed={playbackMode === 'speaker'}
                            onClick={() => {
                                playbackModeRef.current = 'speaker';
                                setPlaybackMode('speaker');
                                void applyPlaybackMode('speaker');
                            }}
                        >
                            <Volume2 size={22} />
                            <span>{t('speaker')}</span>
                        </button>
                        <button
                            type="button"
                            className={`playback-mode-btn mute-btn ${isMuted ? 'active muted' : ''}`}
                            aria-pressed={isMuted}
                            onClick={() => setIsMuted((muted) => !muted)}
                        >
                            <VolumeX size={22} />
                            <span>{isMuted ? t('unmute_audio') : t('mute_audio')}</span>
                        </button>
                    </div>
                    {playbackHint && <p className="playback-hint">{playbackHint}</p>}

                    <div className="volume-control glass-panel">
                        <div className="signal-meter">
                            <div className="signal-bar" style={{ height: `${signalLevel}%` }}></div>
                        </div>
                        <button className="btn-icon" onClick={() => setIsMuted(!isMuted)} aria-label={isMuted ? t('unmute_audio') : t('mute_audio')}>
                            {isMuted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
                        </button>
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={isMuted ? 0 : volume}
                            style={{ '--volume-percent': `${isMuted ? 0 : volume}%` } as CSSProperties}
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
