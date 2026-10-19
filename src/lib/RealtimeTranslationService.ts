import { settingsService, type AiEngine, type Language } from './SettingsService';
import { voiceService } from './VoiceService';
import { translateNow as tr } from './i18n';
import { clearAlerts, raiseAlert } from './alerts';

export interface TranslationUpdate {
    /** Stable for one caption sentence on one target, so a screen updates it in place. */
    segmentId: string;
    targetId: string;
    targetName: string;
    translatedText: string;
    originalText: string;
    latencyMs?: number;
}

interface ActiveSession {
    peer: RTCPeerConnection;
    target: Language;
    sourceTrack: MediaStreamTrack;
    outputTrack?: MediaStreamTrack;
    /** Plays the translation, muted, so Chromium decodes it and it can be sent on (see ontrack). */
    player?: HTMLAudioElement;
    translatedText: string;
    originalText: string;
    startedAt: number;
    firstOutputAt?: number;
    // Caption sentence ids: a key per OpenAI connection plus a running number, so listeners
    // update one line while it grows and start a new line after each finished sentence.
    segmentKey: string;
    segment: number;
    /** Finishes the current caption sentence now (sends it as final). */
    flush: () => void;
    /** Cancels the OpenAI connection setup if it is still in progress. */
    abort: AbortController;
    /** Clears this connection's own timers when it closes. */
    cleanup: (() => void)[];
}

interface StartContext {
    sourceLanguage: Language;
    onStatus: (message: string) => void;
    onUpdate: (update: TranslationUpdate) => void;
    onListeners: (count: number) => void;
}

// The OpenAI leg runs over the public internet, so it needs a reflexive candidate. Host
// candidates alone can leave the connection stuck in "checking" behind a symmetric NAT.
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

// A dropped OpenAI leg used to stay silent until someone pressed Stop and Start. It is now
// rebuilt on its own, with growing pauses, for about two minutes before the operator is asked
// to switch to Human mode.
const RECONNECT_DELAYS_MS = [1000, 3000, 5000, 10_000, 20_000, 30_000, 30_000];
// "disconnected" often recovers by itself within a few seconds; only rebuild if it has not.
const DISCONNECT_GRACE_MS = 5000;
// OpenAI's translation API sends transcript deltas but never says where a sentence ends. A
// caption line is finished after this much quiet, or early at a sentence end once it is long.
const SEGMENT_IDLE_MS = 1400;
const SEGMENT_MAX_CHARS = 280;
// The original speech is transcribed ahead of its translation. A line that has the original but
// no translation yet waits up to this long for it, so the two stay on one line.
const TRANSLATION_WAIT_MS = 8000;
// The OpenAI connection setup (the SDP exchange) gives up after this, so a stalled request
// cannot hold up the start or the reconnect sequence.
const SDP_TIMEOUT_MS = 20_000;
const SENTENCE_END = /[.!?…。！？]["»”')\]]*\s*$/;
// A sentence still growing is sent to phones at most this often. OpenAI sends a delta for every
// few characters, and each one used to go out with the whole sentence so far; finished
// sentences are still sent at once.
const PARTIAL_CAPTION_INTERVAL_MS = 250;
// The original speech is transcribed only when asked for (input transcription). Without it the
// Original box and the original channel's captions stayed empty.
const INPUT_TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
// Below this loudness (RMS of the input, roughly -50 dBFS) counts as silence for the pause.
const SILENCE_RMS = 0.003;
const SILENCE_CHECK_MS = 250;
// Sound this many checks in a row (half a second) reopens the OpenAI connections.
const RESUME_AFTER_CHECKS = 2;
// OpenAI ends a conversational session after 60 minutes. Steady voice opens a fresh one after
// 50, at the first quiet moment, and at 58 whatever is happening.
const STEADY_RENEW_AFTER_MS = 50 * 60_000;
const STEADY_RENEW_BY_MS = 58 * 60_000;
// If OpenAI never says it finished speaking a translation, the next one goes ahead after this.
const STEADY_SPEAKING_LIMIT_MS = 30_000;
// Where each engine is reached once it has a client secret.
const CALLS_URL: Record<AiEngine, string> = {
    translate: 'https://api.openai.com/v1/realtime/translations/calls',
    steady: 'https://api.openai.com/v1/realtime/calls',
};

class RealtimeTranslationService {
    private sessions = new Map<string, ActiveSession>();
    private sourceStream: MediaStream | null = null;
    private stopping = false;
    private muted = false;
    private context: StartContext | null = null;
    private targets = new Map<string, Language>();
    private reconnectAttempts = new Map<string, number>();
    private reconnectTimers = new Map<string, number>();
    private stopReplacedWatch: (() => void) | null = null;
    // When set, the speaker's own audio and original-language captions also go out on the
    // source language's channel, for people outside the room or who are hard of hearing.
    private floorChannel: Language | null = null;
    // The one target whose input transcript feeds those captions; every target hears the same
    // speech, so using them all would print each sentence once per language.
    private captionLead: string | null = null;
    // The optional silence pause: after a stretch with no speech the OpenAI connections are
    // closed (they bill by the minute, speech or not) and reopened as soon as someone speaks.
    // Listeners stay connected throughout; the channel just carries silence.
    private silenceWatch = 0;
    private silenceContext: AudioContext | null = null;
    private silencePauseMs = 0;
    private silentSince = 0;
    private loudChecks = 0;
    private pausedForSilence = false;
    private silenceBusy = false;
    // What a channel carries while its OpenAI leg is closed (the silence pause) or
    // reconnecting. Detaching the track instead stopped all RTP, and every phone's
    // no-audio watchdog then tore down its stream and reconnected, all at once.
    private fillerContext: AudioContext | null = null;
    private fillerTrack: MediaStreamTrack | null = null;
    // Fixed for a whole run, so a change in Admin mid-service never switches a reconnecting
    // channel to the other model.
    private engine: AiEngine = 'translate';

    async start(
        sourceLanguage: Language,
        targets: Language[],
        deviceId: string | undefined,
        onStatus: (message: string) => void,
        onUpdate: (update: TranslationUpdate) => void,
        onListeners: (count: number) => void,
        options: { floorChannel?: boolean; engine?: AiEngine } = {},
    ) {
        if (!targets.length) throw new Error('Select at least one target language.');
        if (!settingsService.getAdminSettings()?.openaiConfigured) throw new Error('Add an OpenAI API key in Admin settings first.');
        this.engine = options.engine ?? settingsService.getAdminSettings()?.aiEngine ?? 'translate';
        this.stopping = false;
        this.muted = false;
        this.pausedForSilence = false;
        clearAlerts('ai_failed');
        this.context = { sourceLanguage, onStatus, onUpdate, onListeners };
        this.targets = new Map(targets.map((target) => [target.id, target]));
        // If the operator hands one of these channels to another broadcaster, stop paying for
        // its OpenAI leg, and stop it from reconnecting and taking the channel back.
        this.stopReplacedWatch?.();
        this.stopReplacedWatch = voiceService.onProducerReplaced((channelId) => {
            if (channelId === this.floorChannel?.id) this.floorChannel = null;
            else this.dropTarget(channelId);
        });
        this.floorChannel = options.floorChannel ? sourceLanguage : null;
        this.captionLead = targets[0]?.id ?? null;
        this.sourceStream = await voiceService.getInputStream(deviceId);
        // Stopped (or the page left) while the input was opening: release it and go no further.
        if (this.stopping) {
            this.sourceStream.getTracks().forEach((track) => track.stop());
            this.sourceStream = null;
            throw new Error(tr('voice_stopped'));
        }
        if (this.floorChannel) {
            const [floorTrack] = this.sourceStream.getAudioTracks();
            // Published as 'ai' because the channel carries live captions, which tells phones
            // to show the transcript rather than the audio-only notice.
            if (floorTrack) await voiceService.publishTrack(this.floorChannel.id, floorTrack, 'ai', onStatus, onListeners, 'original');
        } else if (settingsService.getAdminSettings()?.recordingEnabled) {
            // Not broadcast, but still kept: the server records the original speech so the
            // translation can be checked against it afterwards.
            const [sourceTrack] = this.sourceStream.getAudioTracks();
            if (sourceTrack) await voiceService.publishRecordOnly(sourceLanguage.id, sourceTrack).catch((error) => {
                onStatus(`The original speech will not be recorded: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
        // Made now, while the click that started translation still counts as a user gesture,
        // so the audio context runs; a suspended one would send no packets either.
        this.silentTrack();
        await Promise.all(targets.map((target) => this.startTarget(target)));
        // Steady voice costs nothing while nobody speaks (it is billed per sentence), so the
        // silence pause would only lose the first words after a quiet spell.
        if (this.engine === 'translate') this.startSilenceWatch(settingsService.getAdminSettings()?.aiSilencePauseMinutes ?? 0);
    }

    /** A live track of digital silence, shared by every channel waiting on OpenAI. Null if audio is unavailable. */
    private silentTrack(): MediaStreamTrack | null {
        if (this.fillerTrack?.readyState === 'live') return this.fillerTrack;
        try {
            this.fillerContext ??= new AudioContext();
            void this.fillerContext.resume().catch(() => undefined);
            this.fillerTrack = this.fillerContext.createMediaStreamDestination().stream.getAudioTracks()[0] ?? null;
        } catch (error) {
            console.warn('Could not create the silence track:', error);
            this.fillerTrack = null;
        }
        return this.fillerTrack;
    }

    /** Watches the input's loudness for the silence pause; does nothing when it is off. */
    private startSilenceWatch(minutes: number) {
        this.stopSilenceWatch();
        if (!(minutes > 0) || !this.sourceStream) return;
        this.silencePauseMs = minutes * 60_000;
        try {
            const context = new AudioContext();
            const analyser = context.createAnalyser();
            analyser.fftSize = 2048;
            context.createMediaStreamSource(this.sourceStream).connect(analyser);
            const samples = new Float32Array(analyser.fftSize);
            this.silenceContext = context;
            this.silentSince = performance.now();
            this.silenceWatch = window.setInterval(() => {
                if (this.stopping || this.silenceBusy) return;
                analyser.getFloatTimeDomainData(samples);
                let sum = 0;
                for (const sample of samples) sum += sample * sample;
                const loud = Math.sqrt(sum / samples.length) > SILENCE_RMS;
                if (this.pausedForSilence) {
                    this.loudChecks = loud ? this.loudChecks + 1 : 0;
                    if (this.loudChecks >= RESUME_AFTER_CHECKS) void this.resumeFromSilence();
                    return;
                }
                if (loud) this.silentSince = performance.now();
                else if (performance.now() - this.silentSince >= this.silencePauseMs) void this.pauseForSilence();
            }, SILENCE_CHECK_MS);
        } catch (error) {
            console.warn('The silence pause could not start:', error);
        }
    }

    private stopSilenceWatch() {
        window.clearInterval(this.silenceWatch);
        this.silenceWatch = 0;
        void this.silenceContext?.close().catch(() => undefined);
        this.silenceContext = null;
    }

    /** Closes every OpenAI leg but keeps the channels published, carrying silence. */
    private async pauseForSilence() {
        const context = this.context;
        if (this.pausedForSilence || this.stopping || !context) return;
        this.silenceBusy = true;
        this.pausedForSilence = true;
        this.loudChecks = 0;
        try {
            for (const timer of this.reconnectTimers.values()) window.clearTimeout(timer);
            this.reconnectTimers.clear();
            this.reconnectAttempts.clear();
            const ids = [...this.targets.keys()];
            for (const id of ids) {
                await voiceService.replaceTrack(id, this.silentTrack()).catch(() => false);
                const session = this.sessions.get(id);
                this.sessions.delete(id);
                if (session) this.closeSession(session);
            }
            voiceService.setAiPaused(ids, true);
            context.onStatus(tr('ai_paused_silence', { minutes: Math.round(this.silencePauseMs / 60_000) }));
        } finally {
            this.silenceBusy = false;
        }
    }

    /** Someone is speaking again: reopen the OpenAI legs on the channels already published. */
    private async resumeFromSilence() {
        const context = this.context;
        if (!this.pausedForSilence || this.stopping || !context) return;
        this.silenceBusy = true;
        this.pausedForSilence = false;
        this.silentSince = performance.now();
        try {
            const targets = [...this.targets.values()];
            voiceService.setAiPaused(targets.map((target) => target.id), false);
            context.onStatus(tr('ai_resuming'));
            await Promise.all(targets.map((target) => this.startTarget(target).catch(() => this.scheduleReconnect(target.id))));
            if (this.context === context && !this.stopping) context.onStatus(tr('openai_live'));
        } finally {
            this.silenceBusy = false;
        }
    }

    private async startTarget(target: Language) {
        const context = this.context;
        if (!context) throw new Error('Translation is not running.');
        context.onStatus(`Connecting OpenAI ${target.name}…`);
        const engine = this.engine;
        const { value: clientSecret } = await settingsService.createRealtimeSession(context.sourceLanguage.code, target.code, engine);
        if (!clientSecret) throw new Error(`OpenAI did not return a client secret for ${target.name}.`);
        // Stopped meanwhile: opening an OpenAI connection now would keep billing with nobody to stop it.
        if (this.stopping || this.context !== context) throw new Error(tr('voice_stopped'));
        const [inputTrack] = this.sourceStream?.getAudioTracks() ?? [];
        if (!inputTrack) throw new Error('The selected input produced no audio track.');
        const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const sourceTrack = inputTrack.clone();
        // A cloned track carries its own enabled flag, so a mute applied before this target
        // started has to be re-applied here or this leg would keep transmitting.
        sourceTrack.enabled = !this.muted;
        peer.addTrack(sourceTrack, new MediaStream([sourceTrack]));
        const session: ActiveSession = {
            peer, target, sourceTrack, translatedText: '', originalText: '', startedAt: performance.now(),
            segmentKey: `${target.id}-${Date.now().toString(36)}`, segment: 1, flush: () => undefined,
            abort: new AbortController(), cleanup: [],
        };
        this.sessions.set(target.id, session);
        const isCurrent = () => !this.stopping && this.sessions.get(target.id) === session;

        peer.ontrack = ({ track, streams }) => {
            if (!isCurrent()) return;
            session.outputTrack = track;
            // Chromium only decodes a received WebRTC audio track while something is playing
            // it. Sent on to the media server unplayed, the translation produced no packets at
            // all: phones showed the captions but heard nothing, and the translation recording
            // stayed empty. Playing it here, muted, keeps it flowing without any sound in the
            // room (and so without feeding back into the microphone).
            session.player?.pause();
            const player = new Audio();
            player.muted = true;
            player.srcObject = streams[0] ?? new MediaStream([track]);
            void player.play().catch((error) => console.warn('Could not start the translation player:', error));
            session.player = player;
            session.firstOutputAt ||= performance.now();
            // After a reconnect the channel is still published, so swap the audio in place and
            // keep every listener attached instead of making them all renegotiate.
            void voiceService.replaceTrack(target.id, track).then((replaced) => {
                if (replaced) { context.onStatus(`OpenAI ${target.name} reconnected`); return; }
                return voiceService.publishTrack(target.id, track, 'ai', context.onStatus, context.onListeners, 'translation', engine);
            }).catch((error) => {
                context.onStatus(`Could not publish ${target.name}: ${error instanceof Error ? error.message : String(error)}`);
            });
        };
        peer.onconnectionstatechange = () => {
            if (!isCurrent()) return;
            if (peer.connectionState === 'failed') this.scheduleReconnect(target.id);
            if (peer.connectionState === 'disconnected') {
                context.onStatus(`OpenAI ${target.name} connection unstable…`);
                this.scheduleReconnect(target.id, DISCONNECT_GRACE_MS);
            }
        };

        let lastPartialAt = 0;
        let partialTimer = 0;
        const sendCaptions = (final: boolean) => {
            window.clearTimeout(partialTimer);
            partialTimer = 0;
            if (!final) {
                const wait = lastPartialAt + PARTIAL_CAPTION_INTERVAL_MS - performance.now();
                // Too soon: send the newest text once the interval is up instead.
                if (wait > 0) {
                    partialTimer = window.setTimeout(() => { if (isCurrent()) sendCaptions(false); }, wait);
                    return;
                }
                lastPartialAt = performance.now();
            }
            const segmentId = `${session.segmentKey}-${session.segment}`;
            voiceService.sendTranslationText(target.id, {
                segmentId, text: session.translatedText, originalText: session.originalText, final,
            });
            if (this.floorChannel && this.captionLead === target.id && session.originalText) {
                voiceService.sendTranslationText(this.floorChannel.id, {
                    segmentId: `${segmentId}-original`, text: session.originalText, originalText: '', final,
                });
            }
        };

        let idleTimer = 0;
        let segmentOpenedAt = 0;
        // Sends the current sentence as final (so phones close the line and the transcript file
        // gets it), then starts a new one.
        const finishSegment = () => {
            window.clearTimeout(idleTimer);
            idleTimer = 0;
            // A pending partial belongs to the sentence ending now; it must not fire into the next.
            window.clearTimeout(partialTimer);
            partialTimer = 0;
            segmentOpenedAt = 0;
            if (session.translatedText || session.originalText) sendCaptions(true);
            session.translatedText = ''; session.originalText = '';
            session.startedAt = performance.now(); session.firstOutputAt = undefined;
            session.segment += 1;
        };
        session.flush = finishSegment;

        const events = peer.createDataChannel('oai-events');
        const send = (event: object) => { if (events.readyState === 'open') events.send(JSON.stringify(event)); };
        events.onopen = () => {
            // Steady voice is configured in full when its client secret is made.
            if (engine === 'steady') return;
            send({
                type: 'session.update',
                session: { audio: { input: { transcription: { model: INPUT_TRANSCRIPTION_MODEL }, noise_reduction: { type: 'near_field' } } } },
            });
        };

        // Steady voice: the app asks for each translation itself, one at a time, like an
        // interpreter who finishes a sentence before starting the next. Speech that ends while
        // a translation is still being spoken waits, and is translated together afterwards.
        const steady = {
            pendingTurn: false, responding: false, speaking: false, userSpeaking: false, speechStartMs: 0, speakingTimer: 0,
            // Speech items whose transcript arrived in pieces; any other arrives whole at the end.
            streamedItems: new Set<string>(),
        };
        const respondIfReady = () => {
            if (!steady.pendingTurn || steady.responding || steady.speaking || !isCurrent()) return;
            steady.pendingTurn = false;
            steady.responding = true;
            send({ type: 'response.create' });
        };
        const setSpeaking = (speaking: boolean) => {
            steady.speaking = speaking;
            window.clearTimeout(steady.speakingTimer);
            if (speaking) steady.speakingTimer = window.setTimeout(() => { steady.speaking = false; respondIfReady(); }, STEADY_SPEAKING_LIMIT_MS);
            else respondIfReady();
        };
        session.cleanup.push(() => window.clearTimeout(steady.speakingTimer));
        if (engine === 'steady') {
            // A fresh session before OpenAI's 60-minute limit, at the first quiet moment.
            const openedAt = performance.now();
            const renewTimer = window.setInterval(() => {
                if (!isCurrent()) return;
                const age = performance.now() - openedAt;
                const quiet = !steady.pendingTurn && !steady.responding && !steady.speaking && !steady.userSpeaking;
                if (age >= STEADY_RENEW_BY_MS || (age >= STEADY_RENEW_AFTER_MS && quiet)) {
                    window.clearInterval(renewTimer);
                    void this.renewTarget(target.id);
                }
            }, 1000);
            session.cleanup.push(() => window.clearInterval(renewTimer));
        }

        events.onmessage = ({ data }) => {
            try {
                const event = JSON.parse(String(data)) as {
                    type?: string; delta?: string; audio_start_ms?: number; audio_end_ms?: number; item_id?: string; transcript?: string;
                    response?: { usage?: unknown }; error?: { message?: string; code?: string };
                };
                const translatedType = engine === 'steady' ? 'response.output_audio_transcript.delta' : 'session.output_transcript.delta';
                const originalType = engine === 'steady' ? 'conversation.item.input_audio_transcription.delta' : 'session.input_transcript.delta';
                if (engine === 'steady') {
                    switch (event.type) {
                        case 'input_audio_buffer.speech_started':
                            steady.userSpeaking = true;
                            steady.speechStartMs = event.audio_start_ms ?? 0;
                            break;
                        case 'input_audio_buffer.speech_stopped':
                            steady.userSpeaking = false;
                            // The transcription of the original is billed by the second.
                            if (event.audio_end_ms !== undefined && event.audio_end_ms > steady.speechStartMs) {
                                voiceService.reportAiUsage(target.id, { transcribedSeconds: (event.audio_end_ms - steady.speechStartMs) / 1000 });
                            }
                            break;
                        case 'input_audio_buffer.committed':
                            steady.pendingTurn = true;
                            respondIfReady();
                            break;
                        case 'response.created':
                            steady.responding = true;
                            // Each translation is its own caption line.
                            if (session.translatedText) finishSegment();
                            break;
                        case 'response.done':
                            steady.responding = false;
                            if (event.response?.usage) voiceService.reportAiUsage(target.id, { usage: event.response.usage });
                            respondIfReady();
                            break;
                        case 'output_audio_buffer.started':
                            setSpeaking(true);
                            break;
                        case 'output_audio_buffer.stopped':
                        case 'output_audio_buffer.cleared':
                            setSpeaking(false);
                            break;
                        case 'conversation.item.input_audio_transcription.delta':
                            if (event.item_id) steady.streamedItems.add(event.item_id);
                            break;
                        case 'conversation.item.input_audio_transcription.completed':
                            // Not every transcription model streams; take the whole text then.
                            if (event.item_id && !steady.streamedItems.delete(event.item_id) && event.transcript) {
                                event.type = 'conversation.item.input_audio_transcription.delta';
                                event.delta = `${session.originalText ? ' ' : ''}${event.transcript}`;
                            }
                            break;
                    }
                }
                if (event.type === translatedType) {
                    session.translatedText += event.delta || '';
                    // Translation is flowing again, so a later drop starts its backoff afresh.
                    this.reconnectAttempts.delete(target.id);
                }
                if (event.type === originalType) session.originalText += event.delta || '';
                if (event.type === translatedType || event.type === originalType) {
                    const update: TranslationUpdate = {
                        segmentId: `${session.segmentKey}-${session.segment}`,
                        targetId: target.id,
                        targetName: target.name,
                        translatedText: session.translatedText,
                        originalText: session.originalText,
                        latencyMs: session.firstOutputAt ? Math.round(session.firstOutputAt - session.startedAt) : undefined,
                    };
                    context.onUpdate(update);
                    sendCaptions(false);
                    window.clearTimeout(idleTimer);
                    segmentOpenedAt ||= performance.now();
                    // Quiet for a moment: finish the line, unless the original is there but its
                    // translation has not started yet. Finishing then split them onto two lines.
                    const onIdle = () => {
                        if (!isCurrent()) return;
                        const awaitingTranslation = session.originalText.trim() && !session.translatedText.trim();
                        if (awaitingTranslation && performance.now() - segmentOpenedAt < TRANSLATION_WAIT_MS) {
                            idleTimer = window.setTimeout(onIdle, SEGMENT_IDLE_MS);
                            return;
                        }
                        finishSegment();
                    };
                    if (session.translatedText.length > SEGMENT_MAX_CHARS && SENTENCE_END.test(session.translatedText)) finishSegment();
                    else idleTimer = window.setTimeout(onIdle, SEGMENT_IDLE_MS);
                }
                if (event.type === 'error') {
                    // Asked for a translation while one was still running: it is asked for again
                    // when that one finishes.
                    if (event.error?.code === 'conversation_already_has_active_response') { steady.pendingTurn = true; return; }
                    context.onStatus(`OpenAI ${target.name}: ${event.error?.message || 'unknown error'}`);
                }
            } catch (error) { console.error('Invalid OpenAI realtime event:', error); }
        };

        try {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            const deadline = window.setTimeout(() => session.abort.abort(new Error(`OpenAI ${target.name} did not answer in time.`)), SDP_TIMEOUT_MS);
            try {
                const answer = await fetch(CALLS_URL[engine], {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
                    body: offer.sdp,
                    signal: session.abort.signal,
                });
                if (!answer.ok) throw new Error(`OpenAI ${target.name} session failed: ${await answer.text()}`);
                const sdp = await answer.text();
                if (!isCurrent()) throw new Error(tr('voice_stopped'));
                await peer.setRemoteDescription({ type: 'answer', sdp });
            } finally {
                window.clearTimeout(deadline);
            }
        } catch (error) {
            // Leave nothing half-negotiated behind if the exchange fails.
            this.closeSession(session);
            if (this.sessions.get(target.id) === session) this.sessions.delete(target.id);
            throw error;
        }
    }

    private closeSession(session: ActiveSession) {
        // Whatever was being said is kept as a finished line rather than lost.
        session.flush();
        session.flush = () => undefined;
        session.cleanup.splice(0).forEach((cleanup) => cleanup());
        session.abort.abort();
        if (session.player) {
            session.player.pause();
            session.player.srcObject = null;
            session.player = undefined;
        }
        session.peer.ontrack = null;
        session.peer.onconnectionstatechange = null;
        session.sourceTrack.stop();
        session.peer.close();
    }

    private scheduleReconnect(targetId: string, minimumDelayMs = 0) {
        if (this.stopping || this.pausedForSilence || this.reconnectTimers.has(targetId) || !this.targets.has(targetId)) return;
        const attempts = this.reconnectAttempts.get(targetId) ?? 0;
        const backoff = attempts ? RECONNECT_DELAYS_MS[Math.min(attempts - 1, RECONNECT_DELAYS_MS.length - 1)] : 0;
        const timer = window.setTimeout(() => {
            this.reconnectTimers.delete(targetId);
            void this.reconnectTarget(targetId);
        }, Math.max(minimumDelayMs, backoff));
        this.reconnectTimers.set(targetId, timer);
    }

    /**
     * Swaps a Steady voice connection for a fresh one before OpenAI's session limit ends it.
     * Listeners hear silence for the second or two this takes, at a quiet moment.
     */
    private async renewTarget(targetId: string) {
        const target = this.targets.get(targetId);
        const context = this.context;
        const current = this.sessions.get(targetId);
        if (this.stopping || this.pausedForSilence || !target || !context || !current) return;
        await voiceService.replaceTrack(targetId, this.silentTrack()).catch(() => false);
        this.closeSession(current);
        if (this.sessions.get(targetId) === current) this.sessions.delete(targetId);
        try {
            await this.startTarget(target);
        } catch (error) {
            context.onStatus(`OpenAI ${target.name} reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
            this.scheduleReconnect(targetId);
        }
    }

    private async reconnectTarget(targetId: string) {
        const target = this.targets.get(targetId);
        const context = this.context;
        if (this.stopping || this.pausedForSilence || !target || !context) return;
        const current = this.sessions.get(targetId);
        // A "disconnected" leg that recovered during the grace period needs nothing.
        if (current?.peer.connectionState === 'connected') return;
        const attempt = (this.reconnectAttempts.get(targetId) ?? 0) + 1;
        this.reconnectAttempts.set(targetId, attempt);
        if (attempt > RECONNECT_DELAYS_MS.length) {
            context.onStatus(`OpenAI ${target.name} could not reconnect. Switch to Human mode, or stop and start again.`);
            // This channel is now silent for good. A status line is easy to miss mid-service.
            raiseAlert('ai_failed', tr('ai_failed_alert', { channel: target.name }), { channelId: targetId });
            // No OpenAI leg is open any more, so the dashboard stops counting its cost.
            voiceService.setAiPaused([targetId], true);
            return;
        }
        context.onStatus(`OpenAI ${target.name} connection lost. Reconnecting (attempt ${attempt} of ${RECONNECT_DELAYS_MS.length})…`);
        // Swap in silence before closing the dying connection: listeners stay connected and
        // keep receiving packets, rather than the channel ending when that track does.
        await voiceService.replaceTrack(targetId, this.silentTrack()).catch(() => false);
        if (current) this.closeSession(current);
        this.sessions.delete(targetId);
        try {
            await this.startTarget(target);
        } catch (error) {
            context.onStatus(`OpenAI ${target.name} reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
            this.scheduleReconnect(targetId);
        }
    }

    /** Ends one target's OpenAI leg, e.g. after the operator handed its channel to someone else. */
    private dropTarget(targetId: string) {
        const timer = this.reconnectTimers.get(targetId);
        if (timer !== undefined) window.clearTimeout(timer);
        this.reconnectTimers.delete(targetId);
        this.reconnectAttempts.delete(targetId);
        this.targets.delete(targetId);
        if (this.captionLead === targetId) this.captionLead = [...this.targets.keys()][0] ?? null;
        const session = this.sessions.get(targetId);
        this.sessions.delete(targetId);
        if (session) this.closeSession(session);
    }

    /**
     * Mutes every leg of the AI path.
     *
     * Each target gets its own clone of the microphone track, and a clone's `enabled` flag is
     * independent of the original. Toggling only the source stream therefore left the audio
     * flowing to OpenAI and the translation playing to every listener while the UI reported
     * the source as muted.
     */
    setMuted(muted: boolean) {
        this.muted = muted;
        for (const track of this.sourceStream?.getAudioTracks() || []) track.enabled = !muted;
        for (const session of this.sessions.values()) session.sourceTrack.enabled = !muted;
        // Also pause the republished translation so anything already in flight stops.
        voiceService.setMuted(muted);
    }

    isMuted() { return this.muted; }

    stop() {
        this.stopping = true;
        this.stopSilenceWatch();
        this.pausedForSilence = false;
        this.stopReplacedWatch?.();
        this.stopReplacedWatch = null;
        for (const timer of this.reconnectTimers.values()) window.clearTimeout(timer);
        this.reconnectTimers.clear();
        this.reconnectAttempts.clear();
        // Finish the sentence being spoken first, while the original channel is still known, so
        // the last line reaches phones and the transcript files.
        for (const session of this.sessions.values()) session.flush();
        // A target that is between reconnect attempts has no session but is still published.
        const channelIds = new Set([...this.sessions.keys(), ...this.targets.keys()]);
        if (this.floorChannel) channelIds.add(this.floorChannel.id);
        this.floorChannel = null;
        this.captionLead = null;
        for (const targetId of channelIds) voiceService.stopChannel(targetId);
        voiceService.stopRecordOnly();
        for (const session of this.sessions.values()) this.closeSession(session);
        this.sessions.clear();
        this.targets.clear();
        this.context = null;
        this.sourceStream?.getTracks().forEach((track) => track.stop());
        this.sourceStream = null;
        this.fillerTrack?.stop();
        this.fillerTrack = null;
        void this.fillerContext?.close().catch(() => undefined);
        this.fillerContext = null;
        this.muted = false;
    }
}

export const realtimeTranslationService = new RealtimeTranslationService();
