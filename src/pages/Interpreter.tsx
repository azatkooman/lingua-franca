import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Cpu, Mic, Radio, RefreshCw, ShieldAlert, Square } from 'lucide-react';
import { SYSTEM_AUDIO_DEVICE_ID, voiceService } from '../lib/VoiceService';
import { settingsService, type AdminSettings, type AppSettings } from '../lib/SettingsService';
import { realtimeTranslationService, type TranslationUpdate } from '../lib/RealtimeTranslationService';
import { useTranslation } from '../lib/i18n';
import { useGoBack } from '../lib/navigation';
import './Interpreter.css';
import './Listener.css';

interface TranscriptItem { id: number; original: string; translations: Record<string, string>; latencyMs?: number; }

export default function Interpreter() {
    const goBack = useGoBack();
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
    const meterCleanup = useRef<(() => void) | null>(null);
    const transcriptId = useRef(0);
    const pickersSeeded = useRef(false);
    // Read by the input-list refresh, which runs after a broadcast starts and on device changes;
    // its errors must not replace the live status line.
    const liveRef = useRef(false);
    useEffect(() => { liveRef.current = isLive; }, [isLive]);

    const languages = settings.languages;
    const languageName = useCallback(
        (id: string) => languages.find((language) => language.id === id)?.name || id,
        [languages],
    );

    useEffect(() => settingsService.subscribe(setSettings), []);
    useEffect(() => settingsService.subscribeAdmin(setAdmin), []);

    // Seed the channel pickers once the configured list arrives. The usual service translates
    // Russian into English, so prefer those codes; otherwise fall back to the first channel.
    // Seeded once only: settings are pushed again whenever any channel goes live, and that
    // must not undo the operator's own choices.
    useEffect(() => {
        if (!languages.length || pickersSeeded.current) return;
        pickersSeeded.current = true;
        const source = languages.find((language) => language.code === 'ru') ?? languages[0];
        const target = languages.find((language) => language.code === 'en' && language.id !== source.id);
        setHumanChannelId((current) => current || authorizedChannelId || target?.id || languages[0].id);
        setSourceChannelId((current) => current || source.id);
        setTargetIds((current) => (current.size || !target ? current : new Set([target.id])));
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
        // The endpoint needs a broadcaster session. Without the token it always answered 401,
        // so this line permanently read "unknown".
        void fetch('/api/diagnostics', {
            cache: 'no-store',
            headers: { Authorization: `Bearer ${settingsService.getPublisherToken()}` },
        })
            .then((response) => response.ok ? response.json() : Promise.reject(new Error('unavailable')))
            .then((diagnostics: { microphoneAccess?: string }) => setMicrophoneAccess(diagnostics.microphoneAccess || 'unknown'))
            .catch(() => setMicrophoneAccess('unknown'));
    }, [isDesktopApp]);

    const refreshMicrophones = useCallback(async (requestPermission = false) => {
        try {
            const devices = await voiceService.getMicrophones(requestPermission);
            setMicrophones(devices);
            const remembered = localStorage.getItem('lingua_franca_microphone') || '';
            setSelectedMic((current) => {
                const preferred = current || remembered;
                return devices.some((device) => device.deviceId === preferred) ? preferred : '';
            });
            if (!devices.length && !liveRef.current) setStatus(t('no_input_detected'));
        } catch (error) {
            setMicrophones([]);
            if (!liveRef.current) setStatus(error instanceof Error ? error.message : String(error));
        }
    }, [t]);

    useEffect(() => {
        const refreshTimer = window.setTimeout(() => void refreshMicrophones(isDesktopApp), 0);
        const mediaDevices = navigator.mediaDevices;
        const handleDeviceChange = () => void refreshMicrophones(false);
        mediaDevices?.addEventListener('devicechange', handleDeviceChange);
        return () => { window.clearTimeout(refreshTimer); mediaDevices?.removeEventListener('devicechange', handleDeviceChange); };
    }, [refreshMicrophones, isDesktopApp]);

    const stopBroadcast = useCallback(async () => {
        setIsLive(false); setIsMuted(false); setStatus(t('offline')); setSignalLevel(0); setListeners(0);
        meterCleanup.current?.(); meterCleanup.current = null;
        if (mode === 'ai') await realtimeTranslationService.stop();
        // Always release the capture device and the send transports, including in AI mode --
        // skipping this left the microphone open and the server still holding the producer.
        voiceService.stopBroadcast();
    }, [mode, t]);

    // The operator can take a live channel over from this device. Say so, and once nothing
    // is left on air, stop properly instead of showing "live" for audio nobody receives.
    useEffect(() => voiceService.onProducerReplaced((channelId) => {
        const message = t('operator_took_over', { channel: languageName(channelId) });
        if (voiceService.isPublishing()) { setStatus(message); return; }
        void stopBroadcast().then(() => setStatus(`${message} ${t('broadcast_stopped')}`));
    }), [languageName, stopBroadcast, t]);

    useEffect(() => () => {
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

    const startBroadcast = async () => {
        setStatus(t('starting'));
        try {
            if (mode === 'human') {
                if (!humanChannelId) throw new Error(t('choose_channel_first'));
                await voiceService.startBroadcast(humanChannelId, setStatus, setListeners, selectedMic);
                liveRef.current = true;
                localStorage.setItem('lingua_franca_microphone', selectedMic);
                void refreshMicrophones(false);
                const stream = voiceService.getBroadcastStream();
                if (stream) meterCleanup.current = voiceService.createLevelMeter(stream, setSignalLevel);
                setStatus(`${t('on_air')}: ${languageName(humanChannelId)}`);
            } else {
                const source = languages.find((language) => language.id === sourceChannelId);
                const targetLanguages = languages.filter((language) => targetIds.has(language.id) && language.id !== sourceChannelId);
                if (!source || !targetLanguages.length) throw new Error(t('choose_source_target'));
                await realtimeTranslationService.start(source, targetLanguages, selectedMic, setStatus, updateTranscript, setListeners);
                const stream = voiceService.getBroadcastStream();
                if (stream) meterCleanup.current = voiceService.createLevelMeter(stream, setSignalLevel);
                setStatus(t('openai_live'));
            }
            setIsLive(true);
        } catch (error) {
            setIsLive(false);
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
                <button className="btn-icon" onClick={goBack} title={t('back')}><ArrowLeft size={24} /></button>
                <h2>{t('be_interpreter')}</h2><div style={{ width: 24 }} />
            </header>

            <div className="card fade-in">
                {isAdmin && <div className="mode-toggle">
                    <button className={`mode-toggle-btn ${mode === 'human' ? 'active' : ''}`} disabled={isLive} onClick={() => setMode('human')}><Mic size={18} /> {t('mode_human')}</button>
                    <button className={`mode-toggle-btn ${mode === 'ai' ? 'active' : ''}`} disabled={isLive} onClick={() => setMode('ai')}><Cpu size={18} /> {t('mode_ai')}</button>
                </div>}

                <label>{t('select_mic')}</label>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <select className="custom-select" value={selectedMic} disabled={isLive} onChange={(event) => { setSelectedMic(event.target.value); localStorage.setItem('lingua_franca_microphone', event.target.value); }}>
                        <option value="">{t('default_input')}</option>
                        {isDesktopApp && <option value={SYSTEM_AUDIO_DEVICE_ID}>{t('system_output_input')}</option>}
                        {microphones.map((microphone, index) => <option key={microphone.deviceId || `input-${index}`} value={microphone.deviceId}>{microphone.label || `Audio input ${index + 1}`}</option>)}
                    </select>
                    <button className="btn-secondary" disabled={isLive} onClick={() => void refreshMicrophones(true)} title={t('refresh_inputs')} aria-label={t('refresh_inputs')}><RefreshCw size={18} /></button>
                </div>
                <p className="text-muted">{t('inputs_detected', { count: microphones.length })}</p>
                {isDesktopApp && <p className="text-muted">{t('mic_privacy_status')} <strong>{microphoneAccess}</strong></p>}

                {mode === 'human' ? (
                    <>
                        <label>{t('broadcast_channel')}</label>
                        <select
                            className="custom-select"
                            value={humanChannelId}
                            disabled={isLive || Boolean(authorizedChannelId)}
                            onChange={(event) => setHumanChannelId(event.target.value)}
                        >
                            {languages.map((language) => <option key={language.id} value={language.id}>{language.name}</option>)}
                        </select>
                        {authorizedChannelId && (
                            <p className="text-muted">{t('interpreter_link_only', { channel: settingsService.getInterpreterChannelName() })}</p>
                        )}
                    </>
                ) : (
                    <>
                        <div className="glass-panel" style={{ padding: '1rem', margin: '1rem 0' }}>
                            {!admin?.openaiConfigured && <p style={{ color: 'var(--danger)' }}><ShieldAlert size={16} /> {t('openai_key_missing')}</p>}
                            <p className="text-muted">{t('ai_mode_hint')}</p>
                        </div>
                        <label>{t('source_lang')}</label>
                        <select className="custom-select" value={sourceChannelId} disabled={isLive} onChange={(event) => setSourceChannelId(event.target.value)}>
                            {languages.map((language) => <option key={language.id} value={language.id}>{language.name}</option>)}
                        </select>
                        <label>{t('target_channels')}</label>
                        <div className="channel-list">
                            {targetCandidates.map((language) => (
                                <button key={language.id} disabled={isLive} aria-pressed={targetIds.has(language.id)} className={`channel-btn ${targetIds.has(language.id) ? 'selected' : ''}`} onClick={() => setTargetIds((previous) => {
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
                    {isLive && <p className="text-muted">{t('listeners_connected', { count: listeners })}</p>}
                    {isLive && isMuted && <p className="text-danger">{t('mute_warning')}</p>}
                </div>

                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                    <button className={isLive ? 'btn-danger' : 'btn-primary'} onClick={() => void (isLive ? stopBroadcast() : startBroadcast())}>{isLive ? <><Square size={18} /> {t('stop_audio')}</> : <><Radio size={18} /> {t('start_broadcast')}</>}</button>
                    {isLive && <button className="btn-secondary" onClick={toggleMute}>{isMuted ? t('unmute_source') : t('mute_source')}</button>}
                </div>
            </div>

            {mode === 'ai' && transcript.length > 0 && (
                <div className="card fade-in"><h3>{t('live_transcript')}</h3>
                    {transcript.map((item) => <div key={item.id} className="glass-panel" style={{ padding: '1rem', marginTop: '0.75rem' }}>
                        <p className="text-muted">{item.original || t('listening')}</p>
                        {Object.entries(item.translations).map(([language, text]) => <p key={language}><strong>{language}:</strong> {text}</p>)}
                        {item.latencyMs !== undefined && <small>{t('first_audio_latency', { seconds: (item.latencyMs / 1000).toFixed(1) })}</small>}
                    </div>)}
                </div>
            )}
        </div>
    );
}
