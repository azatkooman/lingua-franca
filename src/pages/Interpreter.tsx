import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Cpu, Mic, Radio, RefreshCw, ShieldAlert, Square } from 'lucide-react';
import { SYSTEM_AUDIO_DEVICE_ID, voiceService } from '../lib/VoiceService';
import { settingsService, type AdminSettings, type AppSettings } from '../lib/SettingsService';
import { realtimeTranslationService, type TranslationUpdate } from '../lib/RealtimeTranslationService';
import { intlLocale, useTranslation } from '../lib/i18n';
import { clearAlerts, raiseAlert } from '../lib/alerts';
import { useGoBack } from '../lib/navigation';
import './Interpreter.css';
import './Listener.css';

interface TranscriptItem { id: number; key: string; original: string; translations: Record<string, string>; latencyMs?: number; }

export default function Interpreter() {
    const goBack = useGoBack();
    const { t, locale } = useTranslation();
    const [settings, setSettings] = useState<AppSettings>(settingsService.getSettings());
    const [admin, setAdmin] = useState<AdminSettings | null>(settingsService.getAdminSettings());
    const isAdmin = settingsService.isAdminAuthenticated();
    const authorizedChannelId = settingsService.getInterpreterChannelId();
    const isDesktopApp = voiceService.isDesktopApp();
    const [mode, setMode] = useState<'human' | 'ai'>('human');
    const [isLive, setIsLive] = useState(false);
    // A start in progress: the button waits for it rather than starting a second broadcast.
    // The ref is the guard (state only updates on the next render, so quick clicks got past
    // it); the state greys the button out.
    const [starting, setStarting] = useState(false);
    const startingRef = useRef(false);
    const [status, setStatus] = useState(t('offline'));
    const [humanChannelId, setHumanChannelId] = useState(authorizedChannelId);
    const [sourceChannelId, setSourceChannelId] = useState('');
    const [targetIds, setTargetIds] = useState<Set<string>>(new Set());
    // AI mode can also put the speaker's own audio and captions on the source channel.
    const [floorChannel, setFloorChannel] = useState(true);
    // Human mode on the operator's computer can do the same from a second input, so listeners
    // who want the speaker's own voice still have a channel for it.
    const [humanOriginal, setHumanOriginal] = useState(() => localStorage.getItem('lingua_franca_human_original') === '1');
    const [originalChannelId, setOriginalChannelId] = useState('');
    const [originalMic, setOriginalMic] = useState(() => localStorage.getItem('lingua_franca_original_input') || '');
    const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
    const [selectedMic, setSelectedMic] = useState('');
    const [isMuted, setIsMuted] = useState(false);
    const [signalLevel, setSignalLevel] = useState(0);
    const [listeners, setListeners] = useState(0);
    const [microphoneAccess, setMicrophoneAccess] = useState('checking');
    const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
    // Two interpreters taking turns. As the next one: 'offer' after finding the channel taken,
    // 'waiting' once asked. As the one on air: the channel someone is waiting to take over.
    const [handoverAsk, setHandoverAsk] = useState<'offer' | 'waiting' | null>(null);
    const [handoverRequestFor, setHandoverRequestFor] = useState<string | null>(null);
    // A phone interpreter's access ends at a fixed time; warn before it cuts them off.
    const [interpreterExpiresAt, setInterpreterExpiresAt] = useState(settingsService.getInterpreterExpiresAt());
    const [now, setNow] = useState(() => Date.now());
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
    useEffect(() => settingsService.subscribeInterpreterAuth(() => setInterpreterExpiresAt(settingsService.getInterpreterExpiresAt())), []);
    useEffect(() => {
        if (!authorizedChannelId) return;
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, [authorizedChannelId]);

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
        setOriginalChannelId((current) => current || source.id);
        setTargetIds((current) => (current.size || !target ? current : new Set([target.id])));
    }, [languages, authorizedChannelId]);

    // The chosen input is not connected right now. It stays chosen and is shown as missing,
    // so starting fails visibly instead of picking another microphone.
    const selectedMissing = Boolean(selectedMic) && (selectedMic === SYSTEM_AUDIO_DEVICE_ID
        ? !isDesktopApp
        : !microphones.some((microphone) => microphone.deviceId === selectedMic));

    // Only the operator, and only with a second channel to put it on. Interpreter phones are
    // limited to their own channel by the server.
    const canBroadcastOriginal = isAdmin && !authorizedChannelId && languages.length > 1;
    const originalActive = mode === 'human' && canBroadcastOriginal && humanOriginal;
    // Never the interpreter's own channel: falls back to the first other one.
    const originalTarget = originalChannelId && originalChannelId !== humanChannelId
        ? originalChannelId
        : languages.find((language) => language.id !== humanChannelId)?.id || '';

    const targetCandidates = useMemo(
        () => languages.filter((language) => language.id !== sourceChannelId),
        [languages, sourceChannelId],
    );

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
            // Keep the operator's choice even when that input is not in the list: switching to
            // the default microphone here quietly undid the "no silent fallback" rule, and
            // reset "System output", which is never in the list at all.
            setSelectedMic((current) => current || remembered);
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
        if (mode === 'ai') realtimeTranslationService.stop();
        // Always release the capture device and the send transports, including in AI mode --
        // skipping this left the microphone open and the server still holding the producer.
        voiceService.stopBroadcast();
    }, [mode, t]);

    // The operator can take a live channel over from this device. Say so, and once nothing
    // is left on air, stop properly instead of showing "live" for audio nobody receives.
    useEffect(() => voiceService.onProducerReplaced((channelId, reason) => {
        setHandoverRequestFor(null);
        clearAlerts('handover', channelId);
        const message = reason === 'handover'
            ? t('handed_over', { channel: languageName(channelId) })
            : t('operator_took_over', { channel: languageName(channelId) });
        if (voiceService.isPublishing()) { setStatus(message); return; }
        void stopBroadcast().then(() => setStatus(`${message} ${t('broadcast_stopped')}`));
    }), [languageName, stopBroadcast, t]);

    useEffect(() => () => {
        meterCleanup.current?.();
        meterCleanup.current = null;
        realtimeTranslationService.stop();
        voiceService.stopBroadcast();
    }, []);

    const updateTranscript = (update: TranslationUpdate) => {
        // One card per caption sentence. Matching on the text itself made a new card for every
        // word, since the original grows with each update.
        setTranscript((previous) => {
            const index = previous.findIndex((item) => item.key === update.segmentId);
            if (index >= 0) {
                const next = [...previous];
                next[index] = { ...next[index], original: update.originalText, translations: { [update.targetName]: update.translatedText }, latencyMs: update.latencyMs };
                return next;
            }
            transcriptId.current += 1;
            return [
                { id: transcriptId.current, key: update.segmentId, original: update.originalText, translations: { [update.targetName]: update.translatedText }, latencyMs: update.latencyMs },
                ...previous,
            ].slice(0, 50);
        });
    };

    // The handover approval arrives as an event; it starts the broadcast through this ref so
    // it always uses the current choices.
    const startRef = useRef<() => Promise<void>>(async () => undefined);
    const handoverAskRef = useRef(handoverAsk);
    useEffect(() => { handoverAskRef.current = handoverAsk; }, [handoverAsk]);

    useEffect(() => voiceService.onHandover((event) => {
        if (event.type === 'requested' && voiceService.isPublishing()) {
            setHandoverRequestFor(event.channelId);
            raiseAlert('handover', t('handover_requested', { channel: languageName(event.channelId) }), { channelId: event.channelId });
        }
        if (event.type === 'cancelled') {
            setHandoverRequestFor((current) => (current === event.channelId ? null : current));
            clearAlerts('handover', event.channelId);
        }
        if (event.type === 'approved' && handoverAskRef.current === 'waiting') {
            setHandoverAsk(null);
            void startRef.current();
        }
    }), [languageName, t]);

    const askHandover = async () => {
        try {
            const result = await voiceService.requestHandover(humanChannelId);
            // Freed meanwhile, or already ours: just start.
            if (result.free || result.own) { setHandoverAsk(null); await startRef.current(); return; }
            setHandoverAsk('waiting');
            setStatus(t('handover_waiting', { channel: languageName(humanChannelId) }));
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        }
    };

    const cancelHandoverAsk = () => {
        voiceService.cancelHandover(humanChannelId);
        setHandoverAsk(null);
        setStatus(t('offline'));
    };

    const handOver = async () => {
        const channelId = handoverRequestFor;
        if (!channelId) return;
        try {
            await voiceService.acceptHandover(channelId);
            setStatus(t('handover_sent'));
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
            setHandoverRequestFor(null);
        }
        clearAlerts('handover', channelId);
    };

    const startBroadcast = async () => {
        if (startingRef.current) return;
        startingRef.current = true;
        setStarting(true);
        setStatus(t('starting'));
        try {
            if (mode === 'human') {
                if (!humanChannelId) throw new Error(t('choose_channel_first'));
                await voiceService.startBroadcast(humanChannelId, setStatus, setListeners, selectedMic);
                // A failure here fails the whole start, like any other input problem: going live
                // without the original the operator asked for would go unnoticed.
                if (originalActive) await voiceService.startOriginalChannel(originalTarget, originalMic, selectedMic, setStatus, setListeners);
                liveRef.current = true;
                localStorage.setItem('lingua_franca_microphone', selectedMic);
                void refreshMicrophones(false);
                const stream = voiceService.getBroadcastStream();
                if (stream) meterCleanup.current = voiceService.createLevelMeter(stream, setSignalLevel);
                setStatus(originalActive
                    ? `${t('on_air')}: ${languageName(humanChannelId)} · ${t('role_original')}: ${languageName(originalTarget)}`
                    : `${t('on_air')}: ${languageName(humanChannelId)}`);
            } else {
                const source = languages.find((language) => language.id === sourceChannelId);
                const targetLanguages = languages.filter((language) => targetIds.has(language.id) && language.id !== sourceChannelId);
                if (!source || !targetLanguages.length) throw new Error(t('choose_source_target'));
                await realtimeTranslationService.start(source, targetLanguages, selectedMic, setStatus, updateTranscript, setListeners, { floorChannel });
                const stream = voiceService.getBroadcastStream();
                if (stream) meterCleanup.current = voiceService.createLevelMeter(stream, setSignalLevel);
                setStatus(t('openai_live'));
            }
            setIsLive(true);
            setHandoverAsk(null);
        } catch (error) {
            setIsLive(false);
            setStatus(error instanceof Error ? error.message : String(error));
            // Someone else is on this channel: the next interpreter can ask them to hand over.
            if (mode === 'human' && (error as { code?: string }).code === 'channel_taken') setHandoverAsk('offer');
            realtimeTranslationService.stop();
            voiceService.stopBroadcast();
        } finally {
            startingRef.current = false;
            setStarting(false);
        }
    };

    useEffect(() => { startRef.current = startBroadcast; });

    const accessLeftMs = authorizedChannelId && interpreterExpiresAt ? interpreterExpiresAt - now : null;
    const accessEnding = accessLeftMs !== null && accessLeftMs < 15 * 60_000;
    const accessEndsAt = interpreterExpiresAt
        ? new Date(interpreterExpiresAt).toLocaleTimeString(intlLocale(locale), { hour: '2-digit', minute: '2-digit' })
        : '';
    useEffect(() => {
        if (accessEnding) raiseAlert('access_ending', t('access_ending', { time: accessEndsAt }));
        else clearAlerts('access_ending');
    }, [accessEnding, accessEndsAt, t]);

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
                    <select className="custom-select" value={selectedMic} disabled={isLive || starting} onChange={(event) => { setSelectedMic(event.target.value); localStorage.setItem('lingua_franca_microphone', event.target.value); }}>
                        <option value="">{t('default_input')}</option>
                        {isDesktopApp && <option value={SYSTEM_AUDIO_DEVICE_ID}>{t('system_output_input')}</option>}
                        {selectedMissing && <option value={selectedMic}>{t('input_missing_option')}</option>}
                        {microphones.map((microphone, index) => <option key={microphone.deviceId || `input-${index}`} value={microphone.deviceId}>{microphone.label || `Audio input ${index + 1}`}</option>)}
                    </select>
                    <button className="btn-secondary" disabled={isLive} onClick={() => void refreshMicrophones(true)} title={t('refresh_inputs')} aria-label={t('refresh_inputs')}><RefreshCw size={18} /></button>
                </div>
                {selectedMissing && <p className="text-danger">{t('input_missing_hint')}</p>}
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
                        {canBroadcastOriginal && (
                            <label className="checkbox-row mt-4">
                                <input type="checkbox" checked={humanOriginal} disabled={isLive || starting} onChange={(event) => {
                                    setHumanOriginal(event.target.checked);
                                    localStorage.setItem('lingua_franca_human_original', event.target.checked ? '1' : '0');
                                }} />
                                <span>{t('human_original_option')}</span>
                            </label>
                        )}
                        {originalActive && (
                            <div className="glass-panel" style={{ padding: '1rem', margin: '0.5rem 0 1rem' }}>
                                <label>{t('original_channel')}</label>
                                <select className="custom-select" value={originalTarget} disabled={isLive || starting} onChange={(event) => setOriginalChannelId(event.target.value)}>
                                    {languages.filter((language) => language.id !== humanChannelId).map((language) => <option key={language.id} value={language.id}>{language.name}</option>)}
                                </select>
                                <label>{t('original_input')}</label>
                                <select className="custom-select" value={originalMic} disabled={isLive || starting} onChange={(event) => { setOriginalMic(event.target.value); localStorage.setItem('lingua_franca_original_input', event.target.value); }}>
                                    <option value="">{t('default_input')}</option>
                                    {isDesktopApp && <option value={SYSTEM_AUDIO_DEVICE_ID}>{t('system_output_input')}</option>}
                                    {originalMic && originalMic !== SYSTEM_AUDIO_DEVICE_ID && !microphones.some((microphone) => microphone.deviceId === originalMic) && <option value={originalMic}>{t('input_missing_option')}</option>}
                                    {microphones.map((microphone, index) => <option key={microphone.deviceId || `original-${index}`} value={microphone.deviceId}>{microphone.label || `Audio input ${index + 1}`}</option>)}
                                </select>
                                <p className="text-muted">{t('original_hint')}</p>
                            </div>
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
                        <label className="checkbox-row mt-4">
                            <input type="checkbox" checked={floorChannel} disabled={isLive} onChange={(event) => setFloorChannel(event.target.checked)} />
                            <span>{t('floor_channel_option', { channel: languageName(sourceChannelId) })}</span>
                        </label>
                    </>
                )}

                <div className="broadcast-visual mt-4">
                    <div className={`mic-circle ${isLive ? 'live' : ''}`}><Radio size={38} /></div>
                    <div className="signal-meter" style={{ height: 60 }}><div className="signal-bar" style={{ height: `${signalLevel}%` }} /></div>
                    <p className={isLive ? 'text-accent' : 'text-muted'}>{status}</p>
                    {isLive && <p className="text-muted">{t('listeners_connected', { count: listeners })}</p>}
                    {isLive && isMuted && <p className="text-danger">{t('mute_warning')}</p>}
                    {accessEnding && <p className="address-warning">{t('access_ending', { time: accessEndsAt })}</p>}
                    {isLive && originalActive && <p className="text-muted">{t('original_mute_note')}</p>}
                </div>

                {isLive && handoverRequestFor && (
                    <div className="glass-panel handover-panel">
                        <p>{t('handover_requested', { channel: languageName(handoverRequestFor) })}</p>
                        <button type="button" className="btn-primary" onClick={() => void handOver()}>{t('handover_accept')}</button>
                    </div>
                )}
                {!isLive && handoverAsk === 'offer' && (
                    <div className="glass-panel handover-panel">
                        <p>{t('handover_offer', { channel: languageName(humanChannelId) })}</p>
                        <button type="button" className="btn-primary" onClick={() => void askHandover()}>{t('handover_ask')}</button>
                    </div>
                )}
                {!isLive && handoverAsk === 'waiting' && (
                    <div className="glass-panel handover-panel">
                        <p>{t('handover_waiting', { channel: languageName(humanChannelId) })}</p>
                        <button type="button" className="btn-secondary" onClick={cancelHandoverAsk}>{t('cancel')}</button>
                    </div>
                )}

                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                    <button className={isLive ? 'btn-danger' : 'btn-primary'} disabled={starting} onClick={() => void (isLive ? stopBroadcast() : startBroadcast())}>{isLive ? <><Square size={18} /> {t('stop_audio')}</> : <><Radio size={18} /> {t('start_broadcast')}</>}</button>
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
