import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Mic, Cpu } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
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
    const [signalLevel, setSignalLevel] = useState(0);

    // AI Translation States
    const [mode, setMode] = useState<'human' | 'ai'>('human');
    const [sourceLang, setSourceLang] = useState('English');
    const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
    const [transcript, setTranscript] = useState<{ original: string; translations: Record<string, string>; id: number }[]>([]);
    const [interimText, setInterimText] = useState('');

    const meterCleanup = useRef<(() => void) | null>(null);
    const recognitionRef = useRef<any>(null);

    // Refs for AI callbacks to avoid stale state closures
    const isLiveRef = useRef(false);
    const modeRef = useRef<'human' | 'ai'>('human');
    const sourceLangRef = useRef('English');
    const selectedTargetsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        isLiveRef.current = isLive;
    }, [isLive]);

    useEffect(() => {
        modeRef.current = mode;
    }, [mode]);

    useEffect(() => {
        sourceLangRef.current = sourceLang;
    }, [sourceLang]);

    useEffect(() => {
        selectedTargetsRef.current = selectedTargets;
    }, [selectedTargets]);

    useEffect(() => {
        const unsubscribe = settingsService.subscribe(s => {
            setLanguages(s.languages);
            
            // Set default language selections
            if (s.languages.length > 0) {
                if (!language) {
                    setLanguage(s.languages[0].name);
                }
                if (!sourceLang) {
                    setSourceLang(s.languages[0].name);
                }
            }
        });

        // Fetch microphones
        voiceService.getMicrophones().then(mics => {
            setMicrophones(mics);
            if (mics.length > 0) setSelectedMic(mics[0].deviceId);
        });

        return unsubscribe;
    }, [language, sourceLang]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (modeRef.current === 'ai') {
                stopAiBroadcast();
            } else {
                voiceService.stopBroadcast();
            }
            if (meterCleanup.current) {
                meterCleanup.current();
                meterCleanup.current = null;
            }
        };
    }, []);

    const handleFinalPhrase = async (text: string) => {
        if (!text || selectedTargetsRef.current.size === 0) return;

        const phraseId = Date.now();
        const currentTargets = Array.from(selectedTargetsRef.current);
        const currentSource = sourceLangRef.current;

        // Optimistically insert transcript container
        const newEntry = { original: text, translations: {} as Record<string, string>, id: phraseId };
        setTranscript(prev => [newEntry, ...prev].slice(0, 50));

        // Call the translate endpoint in parallel for each target
        currentTargets.forEach(async (target) => {
            try {
                const res = await fetch('/api/translate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text,
                        sourceLang: currentSource,
                        targetLang: target
                    })
                });

                if (res.ok) {
                    const data = await res.json();
                    const translatedText = data.translatedText;

                    // Emit translation via Socket.io
                    voiceService.sendTranslationText(target, translatedText, text);

                    // Update UI transcript list
                    setTranscript(prev => prev.map(item => {
                        if (item.id === phraseId) {
                            return {
                                ...item,
                                translations: {
                                    ...item.translations,
                                    [target]: translatedText
                                }
                            };
                        }
                        return item;
                    }));
                }
            } catch (err) {
                console.error(`AI translation failed for ${target}:`, err);
            }
        });
    };

    const startAiBroadcast = async () => {
        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognition) {
            alert("Speech recognition is not supported in this browser. Please use Chrome or Safari.");
            setStatus(t('offline'));
            return;
        }

        if (selectedTargets.size === 0) {
            alert("Please select at least one Target Language to translate into.");
            setStatus(t('offline'));
            return;
        }

        setStatus(t('starting'));
        try {
            // 1. Mark target channels as live in AI mode
            for (const target of selectedTargets) {
                await settingsService.updateLanguagePeerId(target, 'ai-active');
            }

            // 2. Connect signaling socket
            await voiceService.startBroadcast(
                'ai-session', 
                () => {},
                () => {},
                selectedMic
            ).catch(err => {
                console.warn('WebRTC audio transport failed, but continuing in text-only signaling mode: ', err);
            });

            // 3. Initialize Speech Recognition
            const rec = new SpeechRecognition();
            rec.continuous = true;
            rec.interimResults = true;

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

            const locale = langMap[sourceLang.toLowerCase()] || 'en-US';
            rec.lang = locale;

            let finalTranscript = '';

            rec.onresult = (event: any) => {
                let interim = '';
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    if (event.results[i].isFinal) {
                        finalTranscript = event.results[i][0].transcript.trim();
                        if (finalTranscript) {
                            handleFinalPhrase(finalTranscript);
                            finalTranscript = '';
                        }
                    } else {
                        interim += event.results[i][0].transcript;
                    }
                }
                setInterimText(interim);
            };

            rec.onerror = (event: any) => {
                console.error("Speech Recognition Error:", event.error);
                if (isLiveRef.current) {
                    setStatus(`Error: ${event.error}`);
                }
            };

            rec.onend = () => {
                // Auto restart if still live
                if (isLiveRef.current && modeRef.current === 'ai') {
                    try {
                        recognitionRef.current.start();
                    } catch (e) {
                        console.error("Failed to auto-restart recognition:", e);
                    }
                }
            };

            recognitionRef.current = rec;
            rec.start();

            setIsLive(true);
            setIsMuted(false);
            setStatus(t('on_air'));
        } catch (err: any) {
            console.error("AI Broadcast start failed:", err);
            setIsLive(false);
            setStatus(err.message || "Failed to start AI");
        }
    };

    const stopAiBroadcast = async () => {
        setIsLive(false);
        setStatus(t('offline'));
        setSignalLevel(0);
        setInterimText('');

        if (recognitionRef.current) {
            recognitionRef.current.onend = null;
            try {
                recognitionRef.current.stop();
            } catch (e) {}
            recognitionRef.current = null;
        }

        voiceService.stopBroadcast();

        // Mark target channels as offline
        const targets = Array.from(selectedTargetsRef.current);
        for (const target of targets) {
            await settingsService.updateLanguagePeerId(target, undefined);
        }
    };

    const toggleBroadcast = async () => {
        if (mode === 'ai') {
            if (isLive) {
                await stopAiBroadcast();
            } else {
                await startAiBroadcast();
            }
            return;
        }

        // Traditional Human Mode
        if (isLive) {
            voiceService.stopBroadcast();
            setIsLive(false);
            setStatus(t('offline'));
            setListenersCount(0);
            setSignalLevel(0);
            if (meterCleanup.current) {
                meterCleanup.current();
                meterCleanup.current = null;
            }
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

                // Start level meter
                const stream = voiceService.getBroadcastStream();
                if (stream) {
                    if (meterCleanup.current) meterCleanup.current();
                    meterCleanup.current = voiceService.createLevelMeter(stream, (level) => {
                        setSignalLevel(level);
                    });
                }
            } catch (err: any) {
                console.error("Broadcast start failed:", err);
                setIsLive(false);
                setStatus(err.message || t('mic_denied'));
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
                {/* 1. Mode Tabs */}
                <div className="mode-toggle-tabs" style={{ display: 'flex', background: 'rgba(255, 255, 255, 0.05)', borderRadius: 'var(--radius-md)', padding: '0.25rem', marginBottom: '2rem' }}>
                    <button
                        className={`tab-btn ${mode === 'human' ? 'active' : ''}`}
                        style={{ flex: 1, padding: '0.75rem', textAlign: 'center', borderRadius: 'var(--radius-sm)', fontWeight: 600, background: mode === 'human' ? 'var(--primary)' : 'transparent', color: '#fff' }}
                        onClick={() => !isLive && setMode('human')}
                        disabled={isLive}
                    >
                        {t('human_mode')}
                    </button>
                    <button
                        className={`tab-btn ${mode === 'ai' ? 'active' : ''}`}
                        style={{ flex: 1, padding: '0.75rem', textAlign: 'center', borderRadius: 'var(--radius-sm)', fontWeight: 600, background: mode === 'ai' ? 'var(--primary)' : 'transparent', color: '#fff' }}
                        onClick={() => !isLive && setMode('ai')}
                        disabled={isLive}
                    >
                        {t('ai_mode')}
                    </button>
                </div>

                <div className="status-indicator">
                    <span style={{ minWidth: 100, textAlign: 'center' }}>
                        {isLive ? t('on_air') : status}
                    </span>
                </div>

                {/* 2. Language Selection Fields */}
                {mode === 'human' ? (
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
                ) : (
                    <>
                        <div className="language-selector">
                            <label>{t('source_lang')}</label>
                            <select
                                value={sourceLang}
                                onChange={(e) => setSourceLang(e.target.value)}
                                className="custom-select"
                                disabled={isLive}
                            >
                                {languages.map(lang => (
                                    <option key={lang.id} value={lang.name}>{lang.name}</option>
                                ))}
                            </select>
                        </div>

                        <div style={{ margin: '1.5rem 0' }}>
                            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500, color: 'var(--text-muted)' }}>
                                {t('target_langs')}
                            </label>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: 150, overflowY: 'auto', background: 'rgba(255,255,255,0.02)', padding: '1rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                                {languages.map(lang => {
                                    if (lang.name === sourceLang) return null;
                                    const isChecked = selectedTargets.has(lang.name);
                                    return (
                                        <label key={lang.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: isLive ? 'default' : 'pointer' }}>
                                            <input
                                                type="checkbox"
                                                checked={isChecked}
                                                disabled={isLive}
                                                onChange={() => {
                                                    const newTargets = new Set(selectedTargets);
                                                    if (isChecked) {
                                                        newTargets.delete(lang.name);
                                                    } else {
                                                        newTargets.add(lang.name);
                                                    }
                                                    setSelectedTargets(newTargets);
                                                }}
                                                style={{ accentColor: 'var(--primary)', width: 18, height: 18 }}
                                            />
                                            <span>{lang.name}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                    </>
                )}

                {/* 3. Microphone Input Selector */}
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

                {/* 4. Controls section */}
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
                                background: mode === 'ai' ? 'var(--primary)' : 'var(--accent)'
                            }}
                            onClick={toggleBroadcast}
                        >
                            {mode === 'ai' ? <Cpu size={32} /> : <Mic size={32} />}
                            {mode === 'ai' ? t('start_ai') : t('go_live')}
                        </button>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%' }}>
                            {mode === 'human' ? (
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
                            ) : (
                                <button
                                    className="btn-primary"
                                    style={{
                                        width: '100%',
                                        height: '80px',
                                        fontSize: '1.5rem',
                                        background: 'var(--danger)'
                                    }}
                                    onClick={toggleBroadcast}
                                >
                                    {t('stop_ai')}
                                </button>
                            )}

                            {isMuted && mode === 'human' && (
                                <div className="mute-warning fade-in" style={{ textAlign: 'center', color: 'var(--danger)', fontWeight: 'bold' }}>
                                    {t('mute_warning')}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* 5. Live Transcript / Signal Level Panel */}
                {mode === 'human' ? (
                    <div className="stats-panel glass-panel" style={{ opacity: isLive ? 1 : 0.5, marginTop: '2rem' }}>
                        <div className="stat">
                            <span className="stat-value">{listenersCount}</span>
                            <span className="stat-label">{t('listeners')}</span>
                        </div>
                        <div className="stat">
                            <div className="signal-meter" style={{ height: 40, width: 40, padding: 0 }}>
                                <div className="signal-bar" style={{ height: `${signalLevel}%`, width: 6 }}></div>
                            </div>
                            <span className="stat-label">Signal</span>
                        </div>
                        <div className="stat">
                            <span className="stat-value text-accent" style={{ fontSize: '1rem', marginTop: 10 }}>
                                {status}
                            </span>
                            <span className="stat-label">{t('status')}</span>
                        </div>
                    </div>
                ) : (
                    isLive && (
                        <div className="glass-panel" style={{ marginTop: '2rem', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                            <div>
                                <h4 style={{ color: 'var(--primary)', marginBottom: '0.5rem', fontSize: '1rem' }}>{t('live_transcript')} ({sourceLang})</h4>
                                <div style={{ background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: 'var(--radius-sm)', minHeight: 60, border: '1px solid var(--border)' }}>
                                    <p style={{ fontStyle: 'italic', color: interimText ? 'var(--text-main)' : 'var(--text-muted)' }}>
                                        {interimText || 'Speak into your microphone...'}
                                    </p>
                                </div>
                            </div>

                            {transcript.length > 0 && (
                                <div>
                                    <h4 style={{ color: 'var(--accent)', marginBottom: '0.5rem', fontSize: '1rem' }}>{t('ai_translating_into')}</h4>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: 200, overflowY: 'auto', paddingRight: '0.5rem' }}>
                                        {transcript.map((item) => (
                                            <div key={item.id} style={{ borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem' }}>
                                                <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                                                    {item.original}
                                                </p>
                                                {Object.entries(item.translations).map(([lang, trans]) => (
                                                    <p key={lang} style={{ fontSize: '0.95rem', paddingLeft: '0.5rem', borderLeft: '2px solid var(--accent)' }}>
                                                        <strong>{lang}:</strong> {trans}
                                                    </p>
                                                ))}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )
                )}
            </div>
        </div>
    );
}
