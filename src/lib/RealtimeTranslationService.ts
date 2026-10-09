import { settingsService, type Language } from './SettingsService';
import { voiceService } from './VoiceService';

export interface TranslationUpdate {
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
}

interface Recording {
    recorder: MediaRecorder;
    chunks: Blob[];
    label: string;
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

class RealtimeTranslationService {
    private sessions = new Map<string, ActiveSession>();
    private recordings: Recording[] = [];
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
        if (this.floorChannel) {
            const [floorTrack] = this.sourceStream.getAudioTracks();
            // Published as 'ai' because the channel carries live captions, which tells phones
            // to show the transcript rather than the audio-only notice.
            if (floorTrack) await voiceService.publishTrack(this.floorChannel.id, floorTrack, 'ai', onStatus, onListeners);
        }
        if (settingsService.getAdminSettings()?.recordingEnabled) this.recordStream(this.sourceStream, 'source');
        await Promise.all(targets.map((target) => this.startTarget(target)));
    }

    private async startTarget(target: Language) {
        const context = this.context;
        if (!context) throw new Error('Translation is not running.');
        context.onStatus(`Connecting OpenAI ${target.name}…`);
        const { value: clientSecret } = await settingsService.createRealtimeSession(context.sourceLanguage.code, target.code);
        if (!clientSecret) throw new Error(`OpenAI did not return a client secret for ${target.name}.`);
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
            segmentKey: `${target.id}-${Date.now().toString(36)}`, segment: 1,
        };
        this.sessions.set(target.id, session);
        const isCurrent = () => !this.stopping && this.sessions.get(target.id) === session;

        peer.ontrack = ({ track, streams }) => {
            if (!isCurrent()) return;
            session.outputTrack = track;
            session.firstOutputAt ||= performance.now();
            const outputStream = streams[0] || new MediaStream([track]);
            if (settingsService.getAdminSettings()?.recordingEnabled) this.recordStream(outputStream, `translated-${target.code}`);
            // After a reconnect the channel is still published, so swap the audio in place and
            // keep every listener attached instead of making them all renegotiate.
            void voiceService.replaceTrack(target.id, track).then((replaced) => {
                if (replaced) { context.onStatus(`OpenAI ${target.name} reconnected`); return; }
                return voiceService.publishTrack(target.id, track, 'ai', context.onStatus, context.onListeners);
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

        const events = peer.createDataChannel('oai-events');
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
                        targetId: target.id,
                        targetName: target.name,
                        translatedText: session.translatedText,
                        originalText: session.originalText,
                        latencyMs: session.firstOutputAt ? Math.round(session.firstOutputAt - session.startedAt) : undefined,
                    };
                    context.onUpdate(update);
                    sendCaptions(false);
                }
                if (event.type === 'session.output_transcript.done') {
                    // Mark the sentence finished on every phone, then start a new line.
                    if (session.translatedText || session.originalText) sendCaptions(true);
                    session.translatedText = ''; session.originalText = '';
                    session.startedAt = performance.now(); session.firstOutputAt = undefined;
                    session.segment += 1;
                }
                if (event.type === 'error') context.onStatus(`OpenAI ${target.name}: ${event.error?.message || 'unknown error'}`);
            } catch (error) { console.error('Invalid OpenAI realtime event:', error); }
        };

        try {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            const answer = await fetch('https://api.openai.com/v1/realtime/translations/calls', {
                method: 'POST',
                headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
                body: offer.sdp,
            });
            if (!answer.ok) throw new Error(`OpenAI ${target.name} session failed: ${await answer.text()}`);
            await peer.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
        } catch (error) {
            // Leave nothing half-negotiated behind if the exchange fails.
            this.closeSession(session);
            if (this.sessions.get(target.id) === session) this.sessions.delete(target.id);
            throw error;
        }
    }

    private closeSession(session: ActiveSession) {
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

    async stop(downloadRecordings = true) {
        this.stopping = true;
        this.stopReplacedWatch?.();
        this.stopReplacedWatch = null;
        for (const timer of this.reconnectTimers.values()) window.clearTimeout(timer);
        this.reconnectTimers.clear();
        this.reconnectAttempts.clear();
        // A target that is between reconnect attempts has no session but is still published.
        const channelIds = new Set([...this.sessions.keys(), ...this.targets.keys()]);
        if (this.floorChannel) channelIds.add(this.floorChannel.id);
        this.floorChannel = null;
        this.captionLead = null;
        for (const targetId of channelIds) voiceService.stopChannel(targetId);
        for (const session of this.sessions.values()) this.closeSession(session);
        this.sessions.clear();
        this.targets.clear();
        this.context = null;
        this.sourceStream?.getTracks().forEach((track) => track.stop());
        this.sourceStream = null;
        this.muted = false;
        await this.finishRecordings(downloadRecordings);
    }

    private recordStream(stream: MediaStream, label: string) {
        if (typeof MediaRecorder === 'undefined') return;
        const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const recording: Recording = { recorder, chunks: [], label };
        recorder.ondataavailable = (event) => { if (event.data.size) recording.chunks.push(event.data); };
        recorder.start(1000);
        this.recordings.push(recording);
    }

    private async finishRecordings(download: boolean) {
        const recordings = [...this.recordings];
        this.recordings = [];
        const finished = await Promise.all(recordings.map((recording) => new Promise<Recording | null>((resolve) => {
            recording.recorder.onstop = () => resolve(recording.chunks.length ? recording : null);
            if (recording.recorder.state === 'inactive') resolve(recording.chunks.length ? recording : null);
            else recording.recorder.stop();
        })));
        if (!download) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        // Saved one at a time: Chromium blocks a burst of simultaneous downloads from one page.
        for (const recording of finished.filter((entry): entry is Recording => entry !== null)) {
            const blob = new Blob(recording.chunks, { type: recording.recorder.mimeType || 'audio/webm' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `lingua-franca-${recording.label}-${stamp}.webm`;
            link.click();
            await new Promise((resolve) => window.setTimeout(resolve, 400));
            URL.revokeObjectURL(url);
        }
    }
}

export const realtimeTranslationService = new RealtimeTranslationService();
