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
}

interface Recording {
    recorder: MediaRecorder;
    chunks: Blob[];
    label: string;
}

// The OpenAI leg runs over the public internet, so it needs a reflexive candidate. Host
// candidates alone can leave the connection stuck in "checking" behind a symmetric NAT.
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

class RealtimeTranslationService {
    private sessions = new Map<string, ActiveSession>();
    private recordings: Recording[] = [];
    private sourceStream: MediaStream | null = null;
    private stopping = false;
    private muted = false;

    async start(
        sourceLanguage: Language,
        targets: Language[],
        deviceId: string | undefined,
        onStatus: (message: string) => void,
        onUpdate: (update: TranslationUpdate) => void,
        onListeners: (count: number) => void,
    ) {
        if (!targets.length) throw new Error('Select at least one target language.');
        if (!settingsService.getAdminSettings()?.openaiConfigured) throw new Error('Add an OpenAI API key in Admin settings first.');
        this.stopping = false;
        this.muted = false;
        this.sourceStream = await voiceService.getInputStream(deviceId);
        if (settingsService.getAdminSettings()?.recordingEnabled) this.recordStream(this.sourceStream, 'source');
        await Promise.all(targets.map((target) => this.startTarget(sourceLanguage, target, onStatus, onUpdate, onListeners)));
    }

    private async startTarget(
        sourceLanguage: Language,
        target: Language,
        onStatus: (message: string) => void,
        onUpdate: (update: TranslationUpdate) => void,
        onListeners: (count: number) => void,
    ) {
        onStatus(`Connecting OpenAI ${target.name}…`);
        const { value: clientSecret } = await settingsService.createRealtimeSession(sourceLanguage.code, target.code);
        if (!clientSecret) throw new Error(`OpenAI did not return a client secret for ${target.name}.`);
        const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        const sourceTrack = this.sourceStream!.getAudioTracks()[0].clone();
        // A cloned track carries its own enabled flag, so a mute applied before this target
        // started has to be re-applied here or this leg would keep transmitting.
        sourceTrack.enabled = !this.muted;
        peer.addTrack(sourceTrack, new MediaStream([sourceTrack]));
        const session: ActiveSession = {
            peer, target, sourceTrack, translatedText: '', originalText: '', startedAt: performance.now(),
        };
        this.sessions.set(target.id, session);

        peer.ontrack = ({ track, streams }) => {
            if (this.stopping) return;
            session.outputTrack = track;
            session.firstOutputAt ||= performance.now();
            const outputStream = streams[0] || new MediaStream([track]);
            if (settingsService.getAdminSettings()?.recordingEnabled) this.recordStream(outputStream, `translated-${target.code}`);
            void voiceService.publishTrack(target.id, track, 'ai', onStatus, onListeners).catch((error) => {
                onStatus(`Could not publish ${target.name}: ${error instanceof Error ? error.message : String(error)}`);
            });
        };
        peer.onconnectionstatechange = () => {
            if (['failed', 'disconnected'].includes(peer.connectionState) && !this.stopping) {
                onStatus(`OpenAI ${target.name} ${peer.connectionState}. Stop and restart to reconnect.`);
            }
        };

        const events = peer.createDataChannel('oai-events');
        events.onmessage = ({ data }) => {
            try {
                const event = JSON.parse(String(data)) as { type?: string; delta?: string; error?: { message?: string } };
                if (event.type === 'session.output_transcript.delta') session.translatedText += event.delta || '';
                if (event.type === 'session.input_transcript.delta') session.originalText += event.delta || '';
                if (event.type === 'session.output_transcript.delta' || event.type === 'session.input_transcript.delta') {
                    const update: TranslationUpdate = {
                        targetId: target.id,
                        targetName: target.name,
                        translatedText: session.translatedText,
                        originalText: session.originalText,
                        latencyMs: session.firstOutputAt ? Math.round(session.firstOutputAt - session.startedAt) : undefined,
                    };
                    onUpdate(update);
                    voiceService.sendTranslationText(target.id, update.translatedText, update.originalText);
                }
                if (event.type === 'session.output_transcript.done') {
                    session.translatedText = ''; session.originalText = '';
                    session.startedAt = performance.now(); session.firstOutputAt = undefined;
                }
                if (event.type === 'error') onStatus(`OpenAI ${target.name}: ${event.error?.message || 'unknown error'}`);
            } catch (error) { console.error('Invalid OpenAI realtime event:', error); }
        };

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const answer = await fetch('https://api.openai.com/v1/realtime/translations/calls', {
            method: 'POST',
            headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
            body: offer.sdp,
        });
        if (!answer.ok) throw new Error(`OpenAI ${target.name} session failed: ${await answer.text()}`);
        await peer.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
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
        for (const [targetId, session] of this.sessions) {
            session.sourceTrack.stop();
            session.peer.close();
            voiceService.stopChannel(targetId);
        }
        this.sessions.clear();
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
