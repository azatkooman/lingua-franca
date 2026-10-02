import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Headphones, Volume2, VolumeX, Cpu, Ear } from 'lucide-react';
import { useState, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { voiceService } from '../lib/VoiceService';
import { settingsService, type Language } from '../lib/SettingsService';
import { useTranslation } from '../lib/i18n';
import './Interpreter.css';
import './Listener.css';

// Older printed QR codes carry the channel display name; current ones carry the stable id.
// Accept either so previously distributed codes keep working after a rename.
function resolveChannel(languages: Language[], requested: string): Language | null {
    if (!requested) return null;
    const wanted = requested.toLowerCase();
    return languages.find((language) => language.id.toLowerCase() === wanted)
        || languages.find((language) => language.name.toLowerCase() === wanted)
        || null;
}

const VOLUME_KEY = 'lingua_franca_listener_volume';

// Start at full volume: the phone's own buttons are the main control, and the old fixed 80%
// start capped how loud a listener could ever get. A listener's own choice is remembered on
// this device. A saved 0 is ignored so nobody reconnects to apparent silence.
function readSavedVolume() {
    try {
        const saved = Number(localStorage.getItem(VOLUME_KEY) ?? NaN);
        return Number.isFinite(saved) && saved > 0 && saved <= 100 ? saved : 100;
    } catch { return 100; }
}

function saveVolume(volume: number) {
    try { localStorage.setItem(VOLUME_KEY, String(volume)); }
    catch { /* private browsing or a full quota; remembering is optional */ }
}

export default function Listener() {
    const navigate = useNavigate();
    const { t } = useTranslation();
    const [isConnected, setIsConnected] = useState(false);
    const [languages, setLanguages] = useState<Language[]>([]);
    const [requestedChannel] = useState(() => new URLSearchParams(window.location.search).get('channel') || '');
    const [selectedId, setSelectedId] = useState('');
    const [volume, setVolume] = useState(readSavedVolume);
    const [isMuted, setIsMuted] = useState(false);
    const [playbackMode, setPlaybackMode] = useState<'speaker' | 'earpiece'>('speaker');
    const [playbackHint, setPlaybackHint] = useState('');
    const [status, setStatus] = useState(t('loading'));
    const [notice, setNotice] = useState('');
    const [isInterpreterMuted, setIsInterpreterMuted] = useState(false);
    const [signalLevel, setSignalLevel] = useState(0);

    const [subtitleText, setSubtitleText] = useState('');
    const [originalSubtitleText, setOriginalSubtitleText] = useState('');

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const playbackModeRef = useRef<'speaker' | 'earpiece'>('speaker');
    const meterCleanup = useRef<(() => void) | null>(null);
    // The channel from the QR link is derived, not stored: it resolves as soon as the channel
    // list loads, and an explicit tap simply overrides it.
    const linkedLanguage = useMemo(() => resolveChannel(languages, requestedChannel), [languages, requestedChannel]);
    const channelId = selectedId || linkedLanguage?.id || '';
    const linkedChannelMissing = Boolean(requestedChannel) && languages.length > 0 && !linkedLanguage;
    const activeLanguage = languages.find((language) => language.id === channelId) || null;
    const isAiChannel = activeLanguage?.activePeerId === 'ai-active';

    type AudioSessionNavigator = Navigator & {
        audioSession?: { type: 'auto' | 'playback' | 'play-and-record' };
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

    useEffect(() => settingsService.subscribe((settings) => setLanguages(settings.languages)), []);

    useEffect(() => {
        const audio = new Audio();
        audio.autoplay = true;
        audio.setAttribute('playsinline', '');
        audioRef.current = audio;

        if (window.speechSynthesis) window.speechSynthesis.getVoices();

        return () => {
            voiceService.stopListening();
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.srcObject = null;
            }
            meterCleanup.current?.();
            void audioContextRef.current?.close();
            audioContextRef.current = null;
            if (window.speechSynthesis) window.speechSynthesis.cancel();
        };
    }, []);

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.muted = isMuted;
            audioRef.current.volume = volume / 100;
        }
        if (isMuted && window.speechSynthesis) window.speechSynthesis.cancel();
    }, [volume, isMuted]);

    /**
     * iOS only grants playback while a user gesture is still on the stack. The SFU handshake
     * takes several awaits, so calling play() once the stream arrives is far too late and the
     * listener silently hears nothing. Start a silent stream during the tap instead: the
     * element is then already playing when the real track is swapped in.
     */
    const unlockPlayback = () => {
        const audio = audioRef.current;
        if (!audio) return;
        try {
            const context = audioContextRef.current ?? new AudioContext();
            audioContextRef.current = context;
            void context.resume();
            if (!audio.srcObject) audio.srcObject = context.createMediaStreamDestination().stream;
            audio.muted = isMuted;
            audio.volume = volume / 100;
            void audio.play().catch(() => undefined);
        } catch (error) {
            console.warn('Could not pre-authorise audio playback:', error);
        }
    };

    const speakText = (text: string, language: Language) => {
        if (!window.speechSynthesis) return;
        const utterance = new SpeechSynthesisUtterance(text);
        const voices = window.speechSynthesis.getVoices();
        const code = (language.code || 'en').toLowerCase();
        const voice = voices.find((candidate) => candidate.lang.toLowerCase().startsWith(code));
        utterance.lang = voice?.lang || code;
        if (voice) utterance.voice = voice;
        // Read from the audio element so delayed translation callbacks respect the latest controls.
        utterance.volume = audioRef.current?.muted ? 0 : (audioRef.current?.volume ?? volume / 100);
        window.speechSynthesis.speak(utterance);
    };

    const connectToChannel = () => {
        const language = languages.find((entry) => entry.id === channelId);
        if (!language) {
            setNotice(t('channel_not_found'));
            return;
        }
        setNotice('');
        unlockPlayback();
        setIsConnected(true);
        setStatus(language.activePeerId ? t('connecting') : t('waiting_interpreter'));

        void voiceService.listenToChannel(
            language.id,
            (newStatus) => setStatus(newStatus),
            (stream) => {
                const audio = audioRef.current;
                if (!audio) return;
                audio.srcObject = stream;
                audio.play().then(() => {
                    void applyPlaybackMode(playbackModeRef.current);
                }).catch((error) => {
                    console.error('Audio playback failed:', error);
                    setStatus(t('no_sound_hint'));
                });
                meterCleanup.current?.();
                meterCleanup.current = voiceService.createLevelMeter(stream, setSignalLevel);
            },
            (muted) => setIsInterpreterMuted(muted),
            (text, originalText) => {
                setSubtitleText(text);
                setOriginalSubtitleText(originalText);
                // Text fallback has no centralized media producer, so the device speaks it.
                if (!audioRef.current?.srcObject) speakText(text, language);
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
        setIsInterpreterMuted(false);
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        meterCleanup.current?.();
        meterCleanup.current = null;
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

                    {(notice || linkedChannelMissing) && (
                        <p className="text-danger" style={{ textAlign: 'center' }}>{notice || t('channel_not_found')}</p>
                    )}

                    <div className="channel-list">
                        {languages.map((language) => {
                            const isLive = Boolean(language.activePeerId);
                            const isAi = language.activePeerId === 'ai-active';
                            return (
                                <button
                                    key={language.id}
                                    className={`channel-btn ${channelId === language.id ? 'selected' : ''}`}
                                    aria-pressed={channelId === language.id}
                                    onClick={() => { setSelectedId(language.id); setNotice(''); }}
                                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', padding: '1rem', position: 'relative' }}
                                >
                                    <span style={{ fontWeight: 'bold' }}>{language.name}</span>
                                    <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>{language.description}</span>

                                    {isLive && (
                                        <span style={{
                                            position: 'absolute',
                                            top: '1rem',
                                            right: '1rem',
                                            background: isAi ? 'var(--primary-glow)' : 'rgba(16, 185, 129, 0.15)',
                                            color: isAi ? 'var(--primary)' : 'var(--accent)',
                                            border: `1px solid ${isAi ? 'var(--primary)' : 'var(--accent)'}`,
                                            padding: '0.15rem 0.5rem',
                                            borderRadius: 'var(--radius-full)',
                                            fontSize: '0.7rem',
                                            fontWeight: 'bold'
                                        }}>
                                            {isAi ? 'AI' : 'LIVE'}
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
                        disabled={!channelId}
                        onClick={connectToChannel}
                    >
                        {t('connect')} {activeLanguage?.name || ''}
                    </button>
                </div>
            ) : (
                <div className="card active-listener fade-in">
                    {isAiChannel && (
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
                        <div className="center-orb bg-primary" style={{ background: isAiChannel ? 'var(--primary)' : 'var(--accent)' }}>
                            {isAiChannel ? <Cpu size={40} color="white" /> : <Headphones size={40} color="white" />}
                        </div>
                    </div>

                    <h3 className="listening-title">{t('listener_mode')}: {activeLanguage?.name}</h3>
                    <p className={`status-text ${isInterpreterMuted ? 'text-danger pulse' : 'text-accent'}`}>
                        {isInterpreterMuted ? t('interpreter_muted') : status}
                    </p>

                    {isAiChannel && (
                        <div className="glass-panel" style={{ width: '100%', minHeight: '120px', margin: '2rem 0', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', textAlign: 'center', padding: '1.5rem', background: 'rgba(255,255,255,0.03)' }}>
                            <p style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-main)', lineHeight: 1.4, marginBottom: originalSubtitleText ? '0.5rem' : 0 }}>
                                {subtitleText || t('waiting_for_speech')}
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
                        <div className="signal-meter" role="meter" aria-label="Incoming audio level" title="Incoming audio level"
                            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(signalLevel)}>
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
                                const next = parseInt(e.target.value);
                                setVolume(next);
                                saveVolume(next);
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
