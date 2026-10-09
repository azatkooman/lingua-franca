import { settingsService, type Language } from './SettingsService';
import { voiceService } from './VoiceService';

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
// The original speech is transcribed only when asked for (input transcription). Without it the
// Original box and the original channel's captions stayed empty.
const INPUT_TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';

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

    async start(
        sourceLanguage: Language,
        targets: Language[],
        deviceId: string | undefined,
        onStatus: (message: string) => void,
        onUpdate: (update: TranslationUpdate) => void,
        onListeners: (count: number) => void,
        options: { floorChannel?: boolean } = {},
    ) {
        if (!targets.length) throw new Error('Select at least one target language.');
        if (!settingsService.getAdminSettings()?.openaiConfigured) throw new Error('Add an OpenAI API key in Admin settings first.');
        this.stopping = false;
        this.muted = false;
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
            throw new Error('The broadcast was stopped.');
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
        await Promise.all(targets.map((target) => this.startTarget(target)));
    }

    private async startTarget(target: Language) {
        const context = this.context;
        if (!context) throw new Error('Translation is not running.');
        context.onStatus(`Connecting OpenAI ${target.name}…`);
        const { value: clientSecret } = await settingsService.createRealtimeSession(context.sourceLanguage.code, target.code);
        if (!clientSecret) throw new Error(`OpenAI did not return a client secret for ${target.name}.`);
        // Stopped meanwhile: opening an OpenAI connection now would keep billing with nobody to stop it.
        if (this.stopping || this.context !== context) throw new Error('The broadcast was stopped.');
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
            abort: new AbortController(),
        };
        this.sessions.set(target.id, session);
        const isCurrent = () => !this.stopping && this.sessions.get(target.id) === session;

        peer.ontrack = ({ track }) => {
            if (!isCurrent()) return;
            session.outputTrack = track;
            session.firstOutputAt ||= performance.now();
            // After a reconnect the channel is still published, so swap the audio in place and
            // keep every listener attached instead of making them all renegotiate.
            void voiceService.replaceTrack(target.id, track).then((replaced) => {
                if (replaced) { context.onStatus(`OpenAI ${target.name} reconnected`); return; }
                return voiceService.publishTrack(target.id, track, 'ai', context.onStatus, context.onListeners, 'translation');
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

        const sendCaptions = (final: boolean) => {
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
            segmentOpenedAt = 0;
            if (session.translatedText || session.originalText) sendCaptions(true);
            session.translatedText = ''; session.originalText = '';
            session.startedAt = performance.now(); session.firstOutputAt = undefined;
            session.segment += 1;
        };
        session.flush = finishSegment;

        const events = peer.createDataChannel('oai-events');
        events.onopen = () => {
            events.send(JSON.stringify({
                type: 'session.update',
                session: { audio: { input: { transcription: { model: INPUT_TRANSCRIPTION_MODEL } } } },
            }));
        };
        events.onmessage = ({ data }) => {
            try {
                const event = JSON.parse(String(data)) as { type?: string; delta?: string; error?: { message?: string } };
                if (event.type === 'session.output_transcript.delta') {
                    session.translatedText += event.delta || '';
                    // Translation is flowing again, so a later drop starts its backoff afresh.
                    this.reconnectAttempts.delete(target.id);
                }
                if (event.type === 'session.input_transcript.delta') session.originalText += event.delta || '';
                if (event.type === 'session.output_transcript.delta' || event.type === 'session.input_transcript.delta') {
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
                if (event.type === 'error') context.onStatus(`OpenAI ${target.name}: ${event.error?.message || 'unknown error'}`);
            } catch (error) { console.error('Invalid OpenAI realtime event:', error); }
        };

        try {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            const deadline = window.setTimeout(() => session.abort.abort(new Error(`OpenAI ${target.name} did not answer in time.`)), SDP_TIMEOUT_MS);
            try {
                const answer = await fetch('https://api.openai.com/v1/realtime/translations/calls', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
                    body: offer.sdp,
                    signal: session.abort.signal,
                });
                if (!answer.ok) throw new Error(`OpenAI ${target.name} session failed: ${await answer.text()}`);
                const sdp = await answer.text();
                if (!isCurrent()) throw new Error('The broadcast was stopped.');
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
        session.abort.abort();
        session.peer.ontrack = null;
        session.peer.onconnectionstatechange = null;
        session.sourceTrack.stop();
        session.peer.close();
    }

    private scheduleReconnect(targetId: string, minimumDelayMs = 0) {
        if (this.stopping || this.reconnectTimers.has(targetId) || !this.targets.has(targetId)) return;
        const attempts = this.reconnectAttempts.get(targetId) ?? 0;
        const backoff = attempts ? RECONNECT_DELAYS_MS[Math.min(attempts - 1, RECONNECT_DELAYS_MS.length - 1)] : 0;
        const timer = window.setTimeout(() => {
            this.reconnectTimers.delete(targetId);
            void this.reconnectTarget(targetId);
        }, Math.max(minimumDelayMs, backoff));
        this.reconnectTimers.set(targetId, timer);
    }

    private async reconnectTarget(targetId: string) {
        const target = this.targets.get(targetId);
        const context = this.context;
        if (this.stopping || !target || !context) return;
        const current = this.sessions.get(targetId);
        // A "disconnected" leg that recovered during the grace period needs nothing.
        if (current?.peer.connectionState === 'connected') return;
        const attempt = (this.reconnectAttempts.get(targetId) ?? 0) + 1;
        this.reconnectAttempts.set(targetId, attempt);
        if (attempt > RECONNECT_DELAYS_MS.length) {
            context.onStatus(`OpenAI ${target.name} could not reconnect. Switch to Human mode, or stop and start again.`);
            return;
        }
        context.onStatus(`OpenAI ${target.name} connection lost. Reconnecting (attempt ${attempt} of ${RECONNECT_DELAYS_MS.length})…`);
        // Detach the dying track before closing its connection: listeners hear silence and
        // stay connected, rather than the channel ending when that track does.
        await voiceService.replaceTrack(targetId, null).catch(() => false);
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
        this.muted = false;
    }
}

export const realtimeTranslationService = new RealtimeTranslationService();
