import { ArrowDown, ArrowLeft, Captions, Ear, Headphones, Maximize2, Minimize2, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { voiceService, type CaptionSegment, type ListenerStatus } from '../lib/VoiceService';
import { settingsService, type EventInfo, type Language } from '../lib/SettingsService';
import { formatEventDates, useTranslation, type TranslationKey } from '../lib/i18n';
import { useGoBack } from '../lib/navigation';
import { allowSleep, keepAwake } from '../lib/keepAwake';
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

/* ------------------------------------------------------------ per-device preferences */

const VOLUME_KEY = 'lingua_franca_listener_volume';
const TEXT_SIZE_KEY = 'lingua_franca_text_size';
const ORIGINAL_KEY = 'lingua_franca_show_original';
// Cycled by the "A" button: medium, large, small, back to medium.
const TEXT_SIZES = ['medium', 'large', 'small'] as const;
type TextSize = typeof TEXT_SIZES[number];

const readStored = <T,>(key: string, parse: (value: string | null) => T): T => {
    try { return parse(localStorage.getItem(key)); } catch { return parse(null); }
};
const store = (key: string, value: string) => {
    try { localStorage.setItem(key, value); } catch { /* private browsing; remembering is optional */ }
};

// Start at full volume: the phone's own buttons are the main control, and the old fixed 80%
// start capped how loud a listener could ever get. A saved 0 is ignored so nobody
// reconnects to apparent silence.
const readSavedVolume = () => readStored(VOLUME_KEY, (value) => {
    const saved = Number(value ?? NaN);
    return Number.isFinite(saved) && saved > 0 && saved <= 100 ? saved : 100;
});
const readTextSize = () => readStored(TEXT_SIZE_KEY, (value): TextSize => (TEXT_SIZES.includes(value as TextSize) ? value as TextSize : 'medium'));
const readShowOriginal = () => readStored(ORIGINAL_KEY, (value) => value !== 'false');

/* ------------------------------------------------------------ captions */

const MAX_SEGMENTS = 120;

// Live updates and the catch-up history can arrive in either order; merge by segment id so a
// sentence is never shown twice and a newer version of it always wins.
function mergeSegments(current: CaptionSegment[], incoming: CaptionSegment[]) {
    const byId = new Map(current.map((segment) => [segment.id, segment]));
    for (const segment of incoming) {
        const existing = byId.get(segment.id);
        if (!existing || segment.at >= existing.at) byId.set(segment.id, segment);
    }
    return [...byId.values()].sort((left, right) => left.at - right.at).slice(-MAX_SEGMENTS);
}

/**
 * A scrolling caption list that follows the newest line, unless the listener has scrolled up
 * to reread something: then it stays put and offers a button back to the latest line.
 */
function Transcript({ segments, field, empty, sizeClass, jumpLabel }: {
    segments: CaptionSegment[];
    field: 'text' | 'originalText';
    empty: string;
    sizeClass: string;
    jumpLabel: string;
}) {
    const box = useRef<HTMLDivElement>(null);
    const [pinned, setPinned] = useState(true);
    const lines = segments.filter((segment) => segment[field].trim());

    useLayoutEffect(() => {
        if (pinned && box.current) box.current.scrollTop = box.current.scrollHeight;
    }, [lines, pinned, sizeClass]);

    const onScroll = () => {
        const element = box.current;
        if (!element) return;
        setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 48);
    };

    const jump = () => {
        setPinned(true);
        box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' });
    };

    return (
        <div className="transcript-shell">
            <div ref={box} className={`transcript ${sizeClass}`} onScroll={onScroll} aria-live="polite" aria-atomic="false">
                {lines.length === 0
                    ? <p className="transcript-empty">{empty}</p>
                    : lines.map((segment, index) => (
                        <p key={segment.id} className={`transcript-line ${index === lines.length - 1 ? 'current' : ''}`}>{segment[field]}</p>
                    ))}
            </div>
            {!pinned && lines.length > 0 && (
                <button type="button" className="transcript-jump" onClick={jump}><ArrowDown size={16} /> {jumpLabel}</button>
            )}
        </div>
    );
}

/* ------------------------------------------------------------ device helpers */

type AudioSessionNavigator = Navigator & { audioSession?: { type: 'auto' | 'playback' | 'play-and-record' } };
type SinkAudioElement = HTMLAudioElement & { setSinkId?: (sinkId: string) => Promise<void> };

/* ------------------------------------------------------------ page */

export default function Listener() {
    const goBack = useGoBack();
    const { t, locale } = useTranslation();
    const [languages, setLanguages] = useState<Language[]>(settingsService.getSettings().languages);
    const [event, setEvent] = useState<EventInfo | undefined>(settingsService.getSettings().event);
    const [requestedChannel] = useState(() => new URLSearchParams(window.location.search).get('channel') || '');
    const [selectedId, setSelectedId] = useState('');
    const [listening, setListening] = useState(false);
    const [connection, setConnection] = useState<ListenerStatus>('connecting');
    const [receiving, setReceiving] = useState(false);
    const [notice, setNotice] = useState('');
    const [segments, setSegments] = useState<CaptionSegment[]>([]);
    const [isMuted, setIsMuted] = useState(false);
    const [volume, setVolume] = useState(readSavedVolume);
    const [playbackMode, setPlaybackMode] = useState<'speaker' | 'earpiece'>('speaker');
    const [playbackHint, setPlaybackHint] = useState('');
    const [playBlocked, setPlayBlocked] = useState(false);
    const [isInterpreterMuted, setIsInterpreterMuted] = useState(false);
    const [signalLevel, setSignalLevel] = useState(0);
    const [textSize, setTextSize] = useState<TextSize>(readTextSize);
    const [showOriginal, setShowOriginal] = useState(readShowOriginal);
    const [fullscreen, setFullscreen] = useState(false);

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const playbackModeRef = useRef<'speaker' | 'earpiece'>('speaker');
    const meterCleanup = useRef<(() => void) | null>(null);
    const fullscreenRef = useRef<HTMLDivElement>(null);
    // Ignores replies for a channel the listener has already switched away from.
    const listeningTo = useRef('');

    // The channel from the QR link is derived, not stored: it resolves as soon as the channel
    // list loads, and an explicit tap simply overrides it.
    const linkedLanguage = useMemo(() => resolveChannel(languages, requestedChannel), [languages, requestedChannel]);
    const channelId = selectedId || linkedLanguage?.id || '';
    const linkedChannelMissing = Boolean(requestedChannel) && languages.length > 0 && !linkedLanguage;
    const activeLanguage = languages.find((language) => language.id === channelId) || null;
    const channelLive = Boolean(activeLanguage?.activePeerId);
    // Human interpreters produce no captions. Show the transcript when the channel is an AI
    // channel or captions have actually arrived; otherwise say it is audio only.
    const captioned = activeLanguage?.activePeerId === 'ai-active' || segments.length > 0;
    // This channel is the speaker's own voice: its captions are the original already.
    const isOriginalChannel = activeLanguage?.liveRole === 'original';
    // A human interpreter's channel has no captions at all, so nothing to show either way.
    const audioOnly = channelLive && !captioned;
    // Shown from the start, like the translation box, so listeners know it is there; it fills
    // in as soon as the speaker talks. Hidden only when it would repeat the main box.
    const showOriginalCard = showOriginal && !audioOnly && !isOriginalChannel;
    const dates = event ? formatEventDates(event.startDate, event.endDate, locale) : '';

    useEffect(() => settingsService.subscribe((settings) => {
        setLanguages(settings.languages);
        setEvent(settings.event);
    }), []);

    useEffect(() => {
        const audio = new Audio();
        audio.autoplay = true;
        audio.setAttribute('playsinline', '');
        audioRef.current = audio;
        return () => {
            listeningTo.current = '';
            allowSleep();
            voiceService.stopListening();
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.srcObject = null;
            }
            meterCleanup.current?.();
            void audioContextRef.current?.close();
            audioContextRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.muted = isMuted;
            audioRef.current.volume = volume / 100;
        }
    }, [volume, isMuted]);

    // Leaving browser fullscreen with the system gesture or Escape also leaves the view.
    useEffect(() => {
        const onChange = () => { if (!document.fullscreenElement) setFullscreen(false); };
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);

    const applyPlaybackMode = useCallback(async (mode: 'speaker' | 'earpiece') => {
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
                const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audiooutput');
                const pattern = mode === 'speaker' ? /speaker|speakerphone|loudspeaker|громк/i : /earpiece|receiver|handset|телефон|динамик вызова/i;
                const matchingOutput = outputs.find((device) => pattern.test(device.label));
                if (matchingOutput) {
                    await audio.setSinkId(matchingOutput.deviceId);
                    routedToNamedDevice = true;
                } else if (mode === 'speaker') {
                    // Empty sink ID restores the normal media/speaker output.
                    await audio.setSinkId('');
                }
            }
            if (mode === 'earpiece' && !routedToNamedDevice && !audioSessionApplied) setPlaybackHint(t('earpiece_fallback'));
            else setPlaybackHint(mode === 'speaker' ? t('speaker_active') : t('earpiece_active'));
        } catch (error) {
            console.warn('Audio output routing is controlled by the phone:', error);
            setPlaybackHint(mode === 'speaker' ? t('speaker_active') : t('earpiece_fallback'));
        }
    }, [t]);

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

    const connect = (language: Language) => {
        listeningTo.current = language.id;
        setSegments([]);
        setReceiving(false);
        setConnection('connecting');
        setIsInterpreterMuted(false);
        setPlayBlocked(false);

        // Catch up on what was just said, merged with whatever arrives live meanwhile.
        void voiceService.getTranscript(language.id).then((history) => {
            if (listeningTo.current === language.id) setSegments((current) => mergeSegments(current, history));
        }).catch(() => undefined);

        void voiceService.listenToChannel(
            language.id,
            (next) => {
                if (listeningTo.current !== language.id) return;
                setConnection(next);
                setReceiving(next === 'receiving');
            },
            (stream) => {
                const audio = audioRef.current;
                if (!audio || listeningTo.current !== language.id) return;
                audio.srcObject = stream;
                audio.play().then(() => {
                    setPlayBlocked(false);
                    void applyPlaybackMode(playbackModeRef.current);
                }).catch((error) => {
                    console.error('Audio playback failed:', error);
                    setPlayBlocked(true);
                });
                meterCleanup.current?.();
                meterCleanup.current = voiceService.createLevelMeter(stream, setSignalLevel);
            },
            (muted) => setIsInterpreterMuted(muted),
            (segment) => {
                if (listeningTo.current === language.id) setSegments((current) => mergeSegments(current, [segment]));
            },
        );
    };

    const startListening = () => {
        const language = languages.find((entry) => entry.id === channelId);
        if (!language) {
            setNotice(t('channel_not_found'));
            return;
        }
        setNotice('');
        unlockPlayback();
        // Inside the tap: the plain-link fallback (a silent video) needs a gesture to start.
        keepAwake();
        setListening(true);
        connect(language);
    };

    // Switching channel while listening keeps the audio element and its unlock, and just
    // reconnects. Before listening it only changes the selection.
    const chooseChannel = (language: Language) => {
        setSelectedId(language.id);
        setNotice('');
        if (listening && language.id !== listeningTo.current) {
            meterCleanup.current?.();
            meterCleanup.current = null;
            setSignalLevel(0);
            connect(language);
        }
    };

    const stopListening = () => {
        listeningTo.current = '';
        allowSleep();
        voiceService.stopListening();
        setListening(false);
        setFullscreen(false);
        setSegments([]);
        setSignalLevel(0);
        setPlaybackHint('');
        setIsInterpreterMuted(false);
        setPlayBlocked(false);
        meterCleanup.current?.();
        meterCleanup.current = null;
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.srcObject = null;
        }
    };

    const retryPlayback = () => {
        void audioRef.current?.play().then(() => setPlayBlocked(false)).catch(() => undefined);
    };

    const cycleTextSize = () => {
        const next = TEXT_SIZES[(TEXT_SIZES.indexOf(textSize) + 1) % TEXT_SIZES.length];
        setTextSize(next);
        store(TEXT_SIZE_KEY, next);
    };

    const toggleOriginal = () => {
        setShowOriginal((current) => {
            store(ORIGINAL_KEY, String(!current));
            return !current;
        });
    };

    // Real fullscreen where the browser offers it; otherwise (iPhone) the view still fills
    // the page, which is what matters for reading.
    const toggleFullscreen = () => {
        if (fullscreen) {
            setFullscreen(false);
            if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
            return;
        }
        setFullscreen(true);
        requestAnimationFrame(() => {
            const element = fullscreenRef.current;
            if (element?.requestFullscreen && !document.fullscreenElement) void element.requestFullscreen().catch(() => undefined);
        });
    };

    const statusKey: TranslationKey = connection === 'connecting' ? 'status_connecting'
        : connection === 'restarting' || connection === 'error' ? 'status_reconnecting'
            : channelLive && receiving ? 'status_live' : 'status_waiting';
    const statusTone = statusKey === 'status_live' ? 'live' : statusKey === 'status_waiting' ? 'waiting' : 'pending';
    const sizeClass = `size-${textSize}`;
    const emptyTranslation = channelLive ? t('waiting_for_speech') : t('speaker_not_started');

    const statusChip = (
        <span className={`status-chip ${statusTone}`} role="status">
            <span className="status-dot" aria-hidden="true" />{isInterpreterMuted ? t('interpreter_muted') : t(statusKey)}
        </span>
    );

    const muteButton = (compact: boolean) => (
        <button type="button" className={`listen-control ${compact ? 'icon-only' : 'wide'} ${isMuted ? 'active muted' : ''}`}
            aria-pressed={isMuted} aria-label={isMuted ? t('unmute_audio') : t('mute_audio')} title={isMuted ? t('unmute_audio') : t('mute_audio')}
            onClick={() => setIsMuted((value) => !value)}>
            {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
            {!compact && <span>{isMuted ? t('unmute_audio') : t('mute_audio')}</span>}
        </button>
    );

    const textSizeButton = (
        <button type="button" className={`listen-control icon-only text-size-btn ${textSize}`} onClick={cycleTextSize}
            aria-label={t('text_size')} title={t('text_size')}>A</button>
    );

    const channelTabs = (
        <div className="channel-tabs" role="tablist" aria-label={t('select_channel')}>
            {languages.map((language) => (
                <button key={language.id} type="button" role="tab" aria-selected={channelId === language.id}
                    className={`channel-tab ${channelId === language.id ? 'selected' : ''}`} onClick={() => chooseChannel(language)}>
                    <span>{language.name}</span>
                    {language.activePeerId && <span className="live-dot" aria-hidden="true" />}
                </button>
            ))}
        </div>
    );

    return (
        <div className="page-container listen-page">
            <header className="page-header listen-page-header">
                <button className="btn-icon" onClick={goBack} title={t('back')} aria-label={t('back')}>
                    <ArrowLeft size={24} />
                </button>
                <div className="listen-event">
                    <h2>{event?.name || t('be_listener')}</h2>
                    {event?.name && dates && <p>{dates}</p>}
                </div>
            </header>

            {!listening ? (
                <div className="listen-lobby fade-in">
                    <p className="listen-label">{t('select_channel')}</p>
                    {(notice || linkedChannelMissing) && <p className="text-danger listen-notice">{notice || t('channel_not_found')}</p>}
                    {languages.length === 0 ? <p className="text-muted">{t('no_languages')}</p> : (
                        <div className="lobby-channels" role="radiogroup" aria-label={t('select_channel')}>
                            {languages.map((language) => {
                                const isAi = language.activePeerId === 'ai-active';
                                const isOriginal = language.liveRole === 'original';
                                return (
                                    <button key={language.id} type="button" role="radio" aria-checked={channelId === language.id}
                                        className={`lobby-channel ${channelId === language.id ? 'selected' : ''}`} onClick={() => chooseChannel(language)}>
                                        <span className="lobby-channel-text">
                                            <strong>{language.name}</strong>
                                            {language.description && <small>{language.description}</small>}
                                        </span>
                                        {language.activePeerId && (
                                            <span className={`channel-badge ${isOriginal ? 'original' : isAi ? 'ai' : 'live'}`}>
                                                {isOriginal ? t('role_original') : isAi ? 'AI' : 'LIVE'}
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    <div className="lobby-cta">
                        <button type="button" className="btn-primary listen-cta" disabled={!channelId} onClick={startListening}>
                            <Headphones size={22} /> {t('tap_to_listen')}
                        </button>
                        <p className="lobby-hint">{t('lobby_hint')}</p>
                    </div>
                </div>
            ) : (
                <div className={`listen-session fade-in ${showOriginalCard ? 'with-original' : ''}`}>
                    {channelTabs}

                    <div className="listen-controls">
                        {muteButton(false)}
                        {/* Only where there is an original to show: not on an interpreter's
                            audio-only channel, nor on the channel that is the original itself. */}
                        {!audioOnly && !isOriginalChannel && (
                            <button type="button" className={`listen-control icon-only ${showOriginal ? 'active' : ''}`} onClick={toggleOriginal}
                                aria-pressed={showOriginal} aria-label={t('show_original')} title={t('show_original')}>
                                <Captions size={20} />
                            </button>
                        )}
                        {textSizeButton}
                        <button type="button" className="listen-control icon-only" onClick={toggleFullscreen} aria-label={t('fullscreen')} title={t('fullscreen')}>
                            <Maximize2 size={20} />
                        </button>
                    </div>

                    {playBlocked && (
                        <button type="button" className="sound-blocked" onClick={retryPlayback}><VolumeX size={18} /> {t('no_sound_hint')}</button>
                    )}

                    {captioned || !channelLive ? (
                        <section className="caption-card">
                            <div className="caption-card-head">
                                <span className="caption-label">{isOriginalChannel ? t('original_speech_label') : t('translation_label')} · {activeLanguage?.name}</span>
                                {statusChip}
                            </div>
                            <Transcript segments={segments} field="text" empty={emptyTranslation} sizeClass={sizeClass} jumpLabel={t('jump_latest')} />
                        </section>
                    ) : (
                        <section className="caption-card audio-only">
                            <div className="caption-card-head">
                                <span className="caption-label">{activeLanguage?.name}</span>
                                {statusChip}
                            </div>
                            <div className="audio-only-body">
                                <div className="listening-pulse small" aria-hidden="true">
                                    <div className="ring ring-1"></div>
                                    <div className="ring ring-2"></div>
                                    <div className="center-orb" style={{ background: 'var(--accent)' }}><Headphones size={28} color="white" /></div>
                                </div>
                                <p>{t('audio_only')}</p>
                            </div>
                        </section>
                    )}

                    {showOriginalCard && (
                        <section className="caption-card original">
                            <div className="caption-card-head">
                                <span className="caption-label">{t('original_label')}</span>
                            </div>
                            <Transcript segments={segments} field="originalText" empty={t('original_waiting')} sizeClass="size-small" jumpLabel={t('jump_latest')} />
                        </section>
                    )}

                    <details className="sound-settings">
                        <summary>{t('sound_settings')}</summary>
                        <div className="playback-controls" role="group" aria-label={t('audio_output')}>
                            <button type="button" className={`playback-mode-btn ${playbackMode === 'earpiece' ? 'active' : ''}`} aria-pressed={playbackMode === 'earpiece'}
                                onClick={() => { playbackModeRef.current = 'earpiece'; setPlaybackMode('earpiece'); void applyPlaybackMode('earpiece'); }}>
                                <Ear size={22} /><span>{t('earpiece')}</span>
                            </button>
                            <button type="button" className={`playback-mode-btn ${playbackMode === 'speaker' ? 'active' : ''}`} aria-pressed={playbackMode === 'speaker'}
                                onClick={() => { playbackModeRef.current = 'speaker'; setPlaybackMode('speaker'); void applyPlaybackMode('speaker'); }}>
                                <Volume2 size={22} /><span>{t('speaker')}</span>
                            </button>
                        </div>
                        {playbackHint && <p className="playback-hint">{playbackHint}</p>}
                        <div className="volume-control">
                            <div className="signal-meter" role="meter" aria-label={t('audio_level')} title={t('audio_level')}
                                aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(signalLevel)}>
                                <div className="signal-bar" style={{ height: `${signalLevel}%` }}></div>
                            </div>
                            <input type="range" min="0" max="100" value={isMuted ? 0 : volume} aria-label={t('sound_settings')}
                                style={{ '--volume-percent': `${isMuted ? 0 : volume}%` } as CSSProperties}
                                onChange={(change) => {
                                    const next = parseInt(change.target.value);
                                    setVolume(next);
                                    store(VOLUME_KEY, String(next));
                                    if (isMuted) setIsMuted(false);
                                }}
                                className="volume-slider" />
                        </div>
                    </details>

                    <button type="button" className="stop-listening" onClick={stopListening}>{t('stop_listening')}</button>
                </div>
            )}

            {listening && fullscreen && (
                <div ref={fullscreenRef} className="fullscreen-view" role="dialog" aria-label={activeLanguage?.name}>
                    <Transcript segments={segments} field="text" empty={captioned || !channelLive ? emptyTranslation : t('audio_only')}
                        sizeClass={`${sizeClass} fullscreen-text`} jumpLabel={t('jump_latest')} />
                    <div className="fullscreen-bar">
                        {statusChip}
                        <span className="fullscreen-bar-spacer" />
                        {textSizeButton}
                        {muteButton(true)}
                        <button type="button" className="listen-control icon-only" onClick={toggleFullscreen} aria-label={t('exit_fullscreen')} title={t('exit_fullscreen')}>
                            <Minimize2 size={20} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
