import { settingsService, type Language } from './SettingsService';
import { voiceService } from './VoiceService';

export interface TranslationUpdate {
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

class RealtimeTranslationService {
    private sessions = new Map<string, ActiveSession>();
    private recordings: Recording[] = [];
    private sourceStream: MediaStream | null = null;
    private stopping = false;

    async start(
        sourceLanguage: Language,
        targets: Language[],
        deviceId: string | undefined,
        onStatus: (message: string) => void,
        onUpdate: (update: TranslationUpdate) => void,
        onListeners: (count: number) => void,
    ) {
        if (!targets.length) throw new Error('Select at least one target language.');
        if (!settingsService.getSettings().openaiConfigured) throw new Error('Add an OpenAI API key in Admin settings first.');
        this.stopping = false;
        this.sourceStream = await voiceService.getInputStream(deviceId);
        if (settingsService.getSettings().recordingEnabled) this.recordStream(this.sourceStream, 'source');
        await Promise.all(targets.map((target) => this.startTarget(sourceLanguage, target, onStatus, onUpdate, onListeners)));
    }

    private async startTarget(
        sourceLanguage: Language,
        target: Language,
        onStatus: (message: string) => void,
        onUpdate: (update: TranslationUpdate) => void,
        onListeners: (count: number) => void,
    ) {
        onStatus(`Connecting OpenAI ${target.name}...`);
        const { value: clientSecret } = await settingsService.createRealtimeSession(sourceLanguage.code, target.code);
        if (!clientSecret) throw new Error(`OpenAI did not return a client secret for ${target.name}.`);
        const peer = new RTCPeerConnection();
        const sourceTrack = this.sourceStream!.getAudioTracks()[0].clone();
        peer.addTrack(sourceTrack, new MediaStream([sourceTrack]));
        const session: ActiveSession = {
            peer, target, sourceTrack, translatedText: '', originalText: '', startedAt: performance.now(),
        };
        this.sessions.set(target.name, session);

        peer.ontrack = ({ track, streams }) => {
            if (this.stopping) return;
            session.outputTrack = track;
            session.firstOutputAt ||= performance.now();
            const outputStream = streams[0] || new MediaStream([track]);
            if (settingsService.getSettings().recordingEnabled) this.recordStream(outputStream, `translated-${target.code}`);
            void voiceService.publishTrack(target.name, track, 'ai', onStatus, onListeners).catch((error) => {
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
                    const update = {
                        targetName: target.name,
                        translatedText: session.translatedText,
                        originalText: session.originalText,
                        latencyMs: session.firstOutputAt ? Math.round(session.firstOutputAt - session.startedAt) : undefined,
                    };
                    onUpdate(update);
                    voiceService.sendTranslationText(target.name, update.translatedText, update.originalText);
                }
                if (event.type === 'session.output_transcript.done') {
                    session.translatedText = ''; session.originalText = ''; session.startedAt = performance.now(); session.firstOutputAt = undefined;
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

    setMuted(muted: boolean) {
        for (const track of this.sourceStream?.getAudioTracks() || []) track.enabled = !muted;
    }

    async stop(downloadRecordings = true) {
        this.stopping = true;
        for (const [targetName, session] of this.sessions) {
            session.sourceTrack.stop(); session.peer.close(); voiceService.stopChannel(targetName);
        }
        this.sessions.clear();
        this.sourceStream?.getTracks().forEach((track) => track.stop());
        this.sourceStream = null;
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
        await Promise.all(recordings.map((recording) => new Promise<void>((resolve) => {
            recording.recorder.onstop = () => {
                if (download && recording.chunks.length) {
                    const blob = new Blob(recording.chunks, { type: recording.recorder.mimeType || 'audio/webm' });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `lingua-franca-${recording.label}-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
                    link.click();
                    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
                }
                resolve();
            };
            if (recording.recorder.state === 'inactive') resolve(); else recording.recorder.stop();
        })));
    }
}

export const realtimeTranslationService = new RealtimeTranslationService();
