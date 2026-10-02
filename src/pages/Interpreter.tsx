import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Cpu, Mic, Radio, RefreshCw, ShieldAlert, Square } from 'lucide-react';
import { SYSTEM_AUDIO_DEVICE_ID, voiceService } from '../lib/VoiceService';
import { settingsService, type AdminSettings, type AppSettings, type Language } from '../lib/SettingsService';
import { realtimeTranslationService, type TranslationUpdate } from '../lib/RealtimeTranslationService';
import { useTranslation } from '../lib/i18n';
import './Interpreter.css';
import './Listener.css';

interface TranscriptItem { id: number; original: string; translations: Record<string, string>; latencyMs?: number; }

export default function Interpreter() {
    const navigate = useNavigate();
    const { t } = useTranslation();
    const [settings, setSettings] = useState<AppSettings>(settingsService.getSettings());
    const [admin, setAdmin] = useState<AdminSettings | null>(settingsService.getAdminSettings());
    const isAdmin = settingsService.isAdminAuthenticated();
    const authorizedChannelId = settingsService.getInterpreterChannelId();
    const isDesktopApp = voiceService.isDesktopApp();
    const [mode, setMode] = useState<'human' | 'ai'>('human');
    const [isLive, setIsLive] = useState(false);
    const [status, setStatus] = useState(t('offline'));
    const [humanChannelId, setHumanChannelId] = useState(authorizedChannelId);
    const [sourceChannelId, setSourceChannelId] = useState('');
    const [targetIds, setTargetIds] = useState<Set<string>>(new Set());
    const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
    const [selectedMic, setSelectedMic] = useState('');
    const [isMuted, setIsMuted] = useState(false);
    const [signalLevel, setSignalLevel] = useState(0);
    const [listeners, setListeners] = useState(0);
    const [microphoneAccess, setMicrophoneAccess] = useState('checking');
    const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
    const recognitionRef = useRef<{ stop: () => void; start: () => void; onend: (() => void) | null } | null>(null);
    const meterCleanup = useRef<(() => void) | null>(null);
    const liveRef = useRef(false);
    const transcriptId = useRef(0);

    const languages = settings.languages;
    const languageName = useCallback(
        (id: string) => languages.find((language) => language.id === id)?.name || id,
        [languages],
    );

    useEffect(() => settingsService.subscribe(setSettings), []);
    useEffect(() => settingsService.subscribeAdmin(setAdmin), []);

    // Seed the channel pickers once the configured list arrives, rather than assuming a
    // channel literally named "English" or "Русский" exists.
    useEffect(() => {
        if (!languages.length) return;
        setHumanChannelId((current) => current || authorizedChannelId || languages[0].id);
        setSourceChannelId((current) => current || languages[0].id);
    }, [languages, authorizedChannelId]);

    const targetCandidates = useMemo(
        () => languages.filter((language) => language.id !== sourceChannelId),
        [languages, sourceChannelId],
    );

    // Drop targets that no longer exist or that became the source.
    useEffect(() => {
        setTargetIds((previous) => {
            const allowed = new Set(targetCandidates.map((language) => language.id));
            const next = new Set([...previous].filter((id) => allowed.has(id)));
            return next.size === previous.size ? previous : next;
        });
    }, [targetCandidates]);

    useEffect(() => {
        if (!isDesktopApp) return;
        void fetch('/api/diagnostics', { cache: 'no-store' })
            .then((response) => response.ok ? response.json() : Promise.reject(new Error('unavailable')))
            .then((diagnostics: { microphoneAccess?: string }) => setMicrophoneAccess(diagnostics.microphoneAccess || 'unknown'))
            .catch(() => setMicrophoneAccess('unknown'));
    }, [isDesktopApp]);

    useEffect(() => { liveRef.current = isLive; }, [isLive]);

    const refreshMicrophones = useCallback(async (requestPermission = false) => {
        try {
            const devices = await voiceService.getMicrophones(requestPermission);
            setMicrophones(devices);
            const remembered = localStorage.getItem('lingua_franca_microphone') || '';
            setSelectedMic((current) => {
                const preferred = current || remembered;
                return devices.some((device) => device.deviceId === preferred) ? preferred : '';
            });
            if (!devices.length) setStatus('No microphone or audio input was detected.');
        } catch (error) {
            setMicrophones([]);
            setStatus(`Microphone: ${error instanceof Error ? error.message : String(error)}`);
        }
    }, []);

    useEffect(() => {
        const refreshTimer = window.setTimeout(() => void refreshMicrophones(isDesktopApp), 0);
        const mediaDevices = navigator.mediaDevices;
        const handleDeviceChange = () => void refreshMicrophones(false);
        mediaDevices?.addEventListener('devicechange', handleDeviceChange);
        return () => { window.clearTimeout(refreshTimer); mediaDevices?.removeEventListener('devicechange', handleDeviceChange); };
    }, [refreshMicrophones, isDesktopApp]);

    const stopBroadcast = useCallback(async () => {
        liveRef.current = false;
        setIsLive(false); setIsMuted(false); setStatus(t('offline')); setSignalLevel(0); setListeners(0);
        recognitionRef.current?.stop(); recognitionRef.current = null;
        meterCleanup.current?.(); meterCleanup.current = null;
        if (mode === 'ai') {
            await Promise.all([...targetIds].map((id) => voiceService.setTextChannel(id, false).catch(() => undefined)));
            await realtimeTranslationService.stop();
        }
        // Always release the capture device and the send transports, including in AI mode --
        // skipping this left the microphone open and the server still holding the producer.
        voiceService.stopBroadcast();
    }, [mode, targetIds, t]);

    // The operator can take a live channel over from this device. Say so, and once nothing
    // is left on air, stop properly instead of showing "live" for audio nobody receives.
    useEffect(() => voiceService.onProducerReplaced((channelId) => {
        const message = `The operator took over ${languageName(channelId)}.`;
        if (voiceService.isPublishing()) { setStatus(message); return; }
        void stopBroadcast().then(() => setStatus(`${message} Your broadcast has stopped.`));
    }), [languageName, stopBroadcast]);

    useEffect(() => () => {
        // Clear liveRef first: recognition.onend restarts itself while it is true, so a
        // component unmounted mid-broadcast would otherwise keep the recogniser alive.
        liveRef.current = false;
        recognitionRef.current?.stop();
        recognitionRef.current = null;
        meterCleanup.current?.();
        meterCleanup.current = null;
        void realtimeTranslationService.stop(false);
        voiceService.stopBroadcast();
    }, []);

    const updateTranscript = (update: TranslationUpdate) => {
        setTranscript((previous) => {
            const first = previous[0];
            if (first && first.original === update.originalText) {
                return [
                    { ...first, translations: { ...first.translations, [update.targetName]: update.translatedText }, latencyMs: update.latencyMs },
                    ...previous.slice(1),
                ];
            }
            transcriptId.current += 1;
            return [
                { id: transcriptId.current, original: update.originalText, translations: { [update.targetName]: update.translatedText }, latencyMs: update.latencyMs },
                ...previous,
            ].slice(0, 50);
        });
    };

    const startBrowserFallback = async (source: Language, targetLanguages: Language[]) => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) throw new Error('Browser speech recognition is unavailable. Use OpenAI Realtime or current Chrome/Edge.');
        await voiceService.getInputStream(selectedMic);
        await Promise.all(targetLanguages.map((target) => voiceService.setTextChannel(target.id, true)));
        const recognition = new SpeechRecognition();
        recognition.continuous = true; recognition.interimResults = true; recognition.lang = source.code;
        recognition.onresult = (event: SpeechRecognitionEvent) => {
            for (let index = event.resultIndex; index < event.results.length; index += 1) {
                if (!event.results[index].isFinal) continue;
                const original = event.results[index][0].transcript.trim();
                if (!original) continue;
                void Promise.all(targetLanguages.map(async (target) => {
                    const result = await settingsService.translateText(original, source.name, target.name);
                    voiceService.sendTranslationText(target.id, result.translatedText, original);
                    updateTranscript({ targetId: target.id, targetName: target.name, translatedText: result.translatedText, originalText: original });
                })).catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
            }
        };
        recognition.onerror = (event: SpeechRecognitionErrorEvent) => setStatus(`Recognition: ${event.error}`);
        recognition.onend = () => { if (liveRef.current) recognition.start(); };
        recognitionRef.current = recognition;
        recognition.start();
    };

    const startBroadcast = async () => {
        setStatus(t('starting'));
        try {
            if (mode === 'human') {
                if (!humanChannelId) throw new Error('Choose a language channel first.');
                await voiceService.startBroadcast(humanChannelId, setStatus, setListeners, selectedMic);
                localStorage.setItem('lingua_franca_microphone', selectedMic);
                void refreshMicrophones(false);
                const stream = voiceService.getBroadcastStream();
                if (stream) meterCleanup.current = voiceService.createLevelMeter(stream, setSignalLevel);
                setStatus(`${t('on_air')}: ${languageName(humanChannelId)}`);
            } else {
                const source = languages.find((language) => language.id === sourceChannelId);
                const targetLanguages = languages.filter((language) => targetIds.has(language.id) && language.id !== sourceChannelId);
                if (!source || !targetLanguages.length) throw new Error('Choose a source and at least one different target language.');
                if (admin?.aiProvider === 'openai') {
                    await realtimeTranslationService.start(source, targetLanguages, selectedMic, setStatus, updateTranscript, setListeners);
                } else await startBrowserFallback(source, targetLanguages);
                const stream = voiceService.getBroadcastStream();
                if (stream) meterCleanup.current = voiceService.createLevelMeter(stream, setSignalLevel);
                setStatus(admin?.aiProvider === 'openai' ? 'OpenAI translating live' : 'Text fallback translating live');
            }
            liveRef.current = true; setIsLive(true);
        } catch (error) {
            liveRef.current = false; setIsLive(false);
            setStatus(error instanceof Error ? error.message : String(error));
            await realtimeTranslationService.stop(false);
            voiceService.stopBroadcast();
        }
    };

    const toggleMute = () => {
        const next = !isMuted; setIsMuted(next);
        if (mode === 'ai') realtimeTranslationService.setMuted(next); else voiceService.setMuted(next);
    };

    return (
        <div className="page-container">
            <header className="page-header">
                <button className="btn-icon" onClick={() => navigate(-1)} title={t('back')}><ArrowLeft size={24} /></button>
                <h2>{t('be_interpreter')}</h2><div style={{ width: 24 }} />
            </header>

            <div className="card fade-in">
                {isAdmin && <div className="mode-toggle">
                    <button className={`mode-toggle-btn ${mode === 'human' ? 'active' : ''}`} disabled={isLive} onClick={() => setMode('human')}><Mic size={18} /> Human</button>
                    <button className={`mode-toggle-btn ${mode === 'ai' ? 'active' : ''}`} disabled={isLive} onClick={() => setMode('ai')}><Cpu size={18} /> AI</button>
                </div>}

                <label>{t('select_mic')}</label>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <select className="custom-select" value={selectedMic} disabled={isLive} onChange={(event) => { setSelectedMic(event.target.value); localStorage.setItem('lingua_franca_microphone', event.target.value); }}>
                        <option value="">System default audio input</option>
                        {isDesktopApp && <option value={SYSTEM_AUDIO_DEVICE_ID}>System output / loopback (what this computer is playing)</option>}
                        {microphones.map((microphone, index) => <option key={microphone.deviceId || `input-${index}`} value={microphone.deviceId}>{microphone.label || `Audio input ${index + 1}`}</option>)}
                    </select>
                    <button className="btn-secondary" disabled={isLive} onClick={() => void refreshMicrophones(true)} title="Allow microphone access and refresh inputs"><RefreshCw size={18} /></button>
                </div>
                <p className="text-muted">{microphones.length} recording input{microphones.length === 1 ? '' : 's'} detected. Choose a microphone/USB interface, or use system output to capture audio playing through Windows. Use refresh after connecting a new device.</p>
                {isDesktopApp && <p className="text-muted">Windows microphone privacy status: <strong>{microphoneAccess}</strong></p>}

                {mode === 'human' ? (
                    <>
                        <label>{t('target_langs')}</label>
                        <select
                            className="custom-select"
                            value={humanChannelId}
                            disabled={isLive || Boolean(authorizedChannelId)}
                            onChange={(event) => setHumanChannelId(event.target.value)}
                        >
                            {languages.map((language) => <option key={language.id} value={language.id}>{language.name}</option>)}
                        </select>
                        {authorizedChannelId && (
                            <p className="text-muted">This interpreter link is authorised for {settingsService.getInterpreterChannelName()} only.</p>
                        )}
                    </>
                ) : (
                    <>
                        <div className="glass-panel" style={{ padding: '1rem', margin: '1rem 0' }}>
                            <strong>Provider: {admin?.aiProvider || 'unknown'}</strong>
                            {admin?.aiProvider === 'openai' && !admin?.openaiConfigured && <p style={{ color: 'var(--danger)' }}><ShieldAlert size={16} /> Add an OpenAI API key in Admin settings.</p>}
                            <p className="text-muted">OpenAI mode broadcasts one centralized translated voice. Browser/Gemini mode is a text-and-device-voice fallback.</p>
                        </div>
                        <label>Source language</label>
                        <select className="custom-select" value={sourceChannelId} disabled={isLive} onChange={(event) => setSourceChannelId(event.target.value)}>
                            {languages.map((language) => <option key={language.id} value={language.id}>{language.name}</option>)}
                        </select>
                        <label>Target channels</label>
                        <div className="channel-list">
                            {targetCandidates.map((language) => (
                                <button key={language.id} disabled={isLive} className={`channel-btn ${targetIds.has(language.id) ? 'selected' : ''}`} onClick={() => setTargetIds((previous) => {
                                    const next = new Set(previous);
                                    if (next.has(language.id)) next.delete(language.id); else next.add(language.id);
                                    return next;
                                })}>{language.name}</button>
                            ))}
                        </div>
                    </>
                )}

                <div className="broadcast-visual mt-4">
                    <div className={`mic-circle ${isLive ? 'live' : ''}`}><Radio size={38} /></div>
                    <div className="signal-meter" style={{ height: 60 }}><div className="signal-bar" style={{ height: `${signalLevel}%` }} /></div>
                    <p className={isLive ? 'text-accent' : 'text-muted'}>{status}</p>
                    {isLive && <p className="text-muted">{listeners} connected listener{listeners === 1 ? '' : 's'}</p>}
                    {isLive && isMuted && <p className="text-danger">{t('mute_warning')}</p>}
                </div>

                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                    <button className={isLive ? 'btn-danger' : 'btn-primary'} onClick={() => void (isLive ? stopBroadcast() : startBroadcast())}>{isLive ? <><Square size={18} /> Stop / kill audio</> : <><Radio size={18} /> Start broadcast</>}</button>
                    {isLive && <button className="btn-secondary" onClick={toggleMute}>{isMuted ? 'Unmute source' : 'Mute source'}</button>}
                </div>
            </div>

            {mode === 'ai' && transcript.length > 0 && (
                <div className="card fade-in"><h3>{t('live_transcript')}</h3>
                    {transcript.map((item) => <div key={item.id} className="glass-panel" style={{ padding: '1rem', marginTop: '0.75rem' }}>
                        <p className="text-muted">{item.original || 'Listening…'}</p>
                        {Object.entries(item.translations).map(([language, text]) => <p key={language}><strong>{language}:</strong> {text}</p>)}
                        {item.latencyMs !== undefined && <small>First audio latency: {(item.latencyMs / 1000).toFixed(1)} s</small>}
                    </div>)}
                </div>
            )}
        </div>
    );
}

declare global {
    interface Window {
        SpeechRecognition?: new () => SpeechRecognition;
        webkitSpeechRecognition?: new () => SpeechRecognition;
    }
    interface SpeechRecognition {
        continuous: boolean;
        interimResults: boolean;
        lang: string;
        onresult: ((event: SpeechRecognitionEvent) => void) | null;
        onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
        onend: (() => void) | null;
        start(): void;
        stop(): void;
    }
    interface SpeechRecognitionEvent extends Event { resultIndex: number; results: SpeechRecognitionResultList; }
    interface SpeechRecognitionErrorEvent extends Event { error: string; }
}
