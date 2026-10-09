import * as mediasoupClient from 'mediasoup-client';
import { realtimeSocket } from './realtimeSocket';

export const SYSTEM_AUDIO_DEVICE_ID = '__lingua_franca_system_audio__';
type StatusCallback = (status: string) => void;
/** What a broadcast carries, so recordings and the dashboard can label it. */
export type BroadcastRole = 'original' | 'translation' | 'interpreter';
/**
 * Listener connection states as codes, not sentences. Listener phones are the audience most
 * likely to use Russian, and English status text went straight onto their screens.
 */
export type ListenerStatus = 'connecting' | 'receiving' | 'waiting' | 'restarting' | 'error';
type ListenerStatusCallback = (status: ListenerStatus) => void;

/**
 * One caption sentence. The broadcaster sends the same id repeatedly while the sentence
 * grows, then once more with `final` set, so the screen updates a line in place.
 */
export interface CaptionSegment {
    id: string;
    text: string;
    originalText: string;
    final: boolean;
    at: number;
}
type CaptionCallback = (segment: CaptionSegment) => void;

interface TransportResponse {
    id: string;
    iceParameters: mediasoupClient.types.IceParameters;
    iceCandidates: mediasoupClient.types.IceCandidate[];
    dtlsParameters: mediasoupClient.types.DtlsParameters;
    error?: string;
}

interface ConsumeResponse {
    id: string;
    producerId: string;
    kind: mediasoupClient.types.MediaKind;
    rtpParameters: mediasoupClient.types.RtpParameters;
    producerPaused?: boolean;
    error?: string;
}

export class VoiceService {
    private device: mediasoupClient.Device | null = null;
    private sourceStream: MediaStream | null = null;
    private sendTransports = new Map<string, mediasoupClient.types.Transport>();
    private producers = new Map<string, mediasoupClient.types.Producer>();
    // What should be on air from this device, kept apart from the current producers and
    // transports: those are rebuilt after a dropped link, and a failed rebuild must not forget
    // the broadcast it was rebuilding.
    private intended = new Map<string, { track: MediaStreamTrack; mode: 'human' | 'ai'; role?: BroadcastRole }>();
    private recordOnlyIntent: { channelId: string; track: MediaStreamTrack } | null = null;
    // Bumped by stopBroadcast, so a start still waiting for the microphone or the server is
    // abandoned instead of going live after the operator stopped or left the page.
    private broadcastGeneration = 0;
    private republishAttempt = 0;
    private republishing = false;
    private republishAgain = false;
    // The original speech in AI mode, sent only to the server's recorder when it is not being
    // broadcast on its own channel.
    private recordOnly: { channelId: string; transport: mediasoupClient.types.Transport; producer: mediasoupClient.types.Producer } | null = null;
    private recvTransport: mediasoupClient.types.Transport | null = null;
    private consumer: mediasoupClient.types.Consumer | null = null;
    private currentListenerChannelId: string | null = null;
    // Bumped on every listen attempt, so a slow handshake for a channel the listener has
    // already switched away from cannot finish last and take over.
    private listenAttempt = 0;
    private onListenerStatus?: ListenerStatusCallback;
    private onListenerStreamReceived?: (stream: MediaStream) => void;
    private onTranslationTextReceived?: CaptionCallback;
    private onMuteStatusChange?: (muted: boolean) => void;
    private onConnectionsChange?: (count: number) => void;
    private onPublishStatus: StatusCallback = () => undefined;
    private replacedHandlers = new Set<(channelId: string) => void>();
    private listenerCounts = new Map<string, number>();
    private muted = false;
    private handlersBound = false;
    // Set when the signalling connection drops on its own. The server tears down every transport
    // of a socket that goes away, so on the next connect this device must publish and listen again.
    private socketDropped = false;
    private republishTimer = 0;

    private totalListeners() {
        let total = 0;
        for (const [channelId, count] of this.listenerCounts) {
            if (this.producers.has(channelId)) total += count;
        }
        return total;
    }

    getBroadcastStream() { return this.sourceStream; }
    isDesktopApp() { return /\bElectron\//i.test(navigator.userAgent); }
    isPublishing() { return this.producers.size > 0; }

    /** Fires when the operator takes over a channel this device was publishing. */
    onProducerReplaced(handler: (channelId: string) => void) {
        this.replacedHandlers.add(handler);
        return () => { this.replacedHandlers.delete(handler); };
    }

    private mediaError(error: unknown) {
        const name = error instanceof DOMException ? error.name : '';
        const detail = error instanceof Error ? error.message : String(error);
        if (name === 'NotAllowedError' || name === 'SecurityError') {
            return new Error('Microphone permission was denied. In Windows Settings, enable Privacy & security → Microphone → Microphone access and “Let desktop apps access your microphone,” then restart Lingua Franca.');
        }
        if (name === 'NotFoundError') return new Error('Windows reported no recording device. Connect or enable an input in Settings → System → Sound → Input.');
        if (name === 'NotReadableError' || name === 'AbortError') return new Error('Windows could not open the input. Close other audio applications or disable exclusive mode for this recording device, then refresh.');
        if (name === 'OverconstrainedError') return new Error('The selected audio device is no longer available. Refresh the input list and choose it again.');
        return new Error(`${name ? `${name}: ` : ''}${detail || 'Unknown audio-device error.'}`);
    }

    async getMicrophones(requestPermission = false) {
        try {
            if (!navigator.mediaDevices?.enumerateDevices) throw new Error('This browser does not expose audio-device enumeration.');
            if (requestPermission) {
                const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                permissionStream.getTracks().forEach((track) => track.stop());
                await new Promise((resolve) => window.setTimeout(resolve, 150));
            }
            // Windows/Chromium can update endpoint labels and IDs asynchronously after permission is granted.
            const firstPass = await navigator.mediaDevices.enumerateDevices();
            await new Promise((resolve) => window.setTimeout(resolve, 100));
            const secondPass = await navigator.mediaDevices.enumerateDevices();
            const byId = new Map<string, MediaDeviceInfo>();
            for (const device of [...firstPass, ...secondPass]) {
                if (device.kind === 'audioinput' && device.deviceId) byId.set(device.deviceId, device);
            }
            const devices = [...byId.values()].sort((left, right) => (left.label || '').localeCompare(right.label || ''));
            if (!devices.length) throw new Error('Chromium returned zero recording devices. Check Windows microphone privacy and confirm the device is enabled under System → Sound → Input.');
            return devices;
        }
        catch (error) { console.error('Error enumerating devices:', error); throw this.mediaError(error); }
    }

    async getInputStream(deviceId?: string) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires HTTPS or localhost.');
        this.sourceStream?.getTracks().forEach((track) => track.stop());
        this.sourceStream = null;
        if (deviceId === SYSTEM_AUDIO_DEVICE_ID) {
            if (!this.isDesktopApp() || !navigator.mediaDevices.getDisplayMedia) {
                throw new Error('System-output capture is available only in the desktop app.');
            }
            let displayStream: MediaStream;
            try { displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }); }
            catch (error) { throw this.mediaError(error); }
            displayStream.getVideoTracks().forEach((track) => { track.stop(); displayStream.removeTrack(track); });
            if (!displayStream.getAudioTracks().length) throw new Error('Windows did not provide a system-audio track.');
            this.sourceStream = displayStream;
            return displayStream;
        }
        const audio: MediaTrackConstraints = {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: false,
            noiseSuppression: true,
            autoGainControl: false,
            channelCount: 1,
            sampleRate: 48000,
        };
        try {
            this.sourceStream = await navigator.mediaDevices.getUserMedia({ audio });
        } catch (error) {
            // A chosen input that is gone used to fall back to the default device without a word,
            // which could broadcast the laptop microphone instead of the mixer feed.
            if (deviceId && error instanceof DOMException && ['NotFoundError', 'OverconstrainedError'].includes(error.name)) {
                throw new Error('The selected input is not available. Reconnect it, press refresh and choose it again. Nothing was broadcast.');
            }
            throw this.mediaError(error);
        }
        return this.sourceStream;
    }

    private bindHandlers() {
        if (this.handlersBound) return;
        this.handlersBound = true;

        realtimeSocket.on<{ channelId: string }>('producerAvailable', ({ channelId }) => {
            if (this.currentListenerChannelId === channelId && !this.consumer) void this.reconnectListener();
        });
        realtimeSocket.on<{ channelId: string }>('producerClosed', ({ channelId }) => {
            if (this.currentListenerChannelId === channelId) this.handleStreamLoss();
        });
        realtimeSocket.on<{ channelId: string }>('producerReplaced', ({ channelId }) => {
            if (!this.producers.has(channelId)) return;
            // The server already closed this producer when the operator took the channel
            // over, so tear down locally without asking it to close the channel again.
            this.intended.delete(channelId);
            this.dropChannel(channelId);
            this.onConnectionsChange?.(this.totalListeners());
            this.replacedHandlers.forEach((handler) => handler(channelId));
        });
        realtimeSocket.on<CaptionSegment & { channelId: string }>('translationText', ({ channelId, ...segment }) => {
            if (this.currentListenerChannelId === channelId) this.onTranslationTextReceived?.(segment);
        });
        realtimeSocket.on<{ channelId: string; muted: boolean }>('channelMuted', ({ channelId, muted }) => {
            if (this.currentListenerChannelId === channelId) this.onMuteStatusChange?.(muted);
        });
        realtimeSocket.on<{ channelId: string; count: number }>('listenerCount', ({ channelId, count }) => {
            if (!this.producers.has(channelId)) return;
            // AI mode publishes one channel per target language, so report the audience
            // across all of them rather than whichever reported last.
            this.listenerCounts.set(channelId, count);
            this.onConnectionsChange?.(this.totalListeners());
        });
        // The router is rebuilt when the media worker is restarted, so the cached device
        // capabilities and every transport from the previous router are stale.
        realtimeSocket.on('sfuRestarting', () => {
            this.device = null;
            this.onListenerStatus?.('restarting');
            if (this.producers.size) this.onPublishStatus('Media engine restarting…');
        });
        realtimeSocket.on('sfuReady', () => {
            this.device = null;
            if (this.intended.size || this.recordOnlyIntent) void this.republish();
            if (this.currentListenerChannelId) void this.reconnectListener();
        });
        // A dropped Wi-Fi link gives the reconnected socket a new id, so the server holds no
        // transports for it and the listener has to negotiate again.
        realtimeSocket.on<string>('disconnect', (reason) => {
            // Our own disconnect (a sign-in change) is not a dropped link.
            if (reason === 'io client disconnect') return;
            this.socketDropped = true;
            if (this.producers.size) this.onPublishStatus('Connection to the computer lost. Reconnecting…');
            if (this.currentListenerChannelId) this.onListenerStatus?.('restarting');
        });
        realtimeSocket.on('connect', () => {
            const recovering = this.socketDropped;
            this.socketDropped = false;
            // After a drop the server has already closed this device's producers and consumer,
            // even if the objects here still look alive, so rebuild both.
            if (recovering && (this.intended.size || this.recordOnlyIntent)) void this.republish();
            if (this.currentListenerChannelId && (recovering || !this.consumer)) void this.reconnectListener();
        });
    }

    /** Rebuilds the broadcasts after a media link failed, or retries a rebuild that failed. */
    private scheduleRepublish(delayMs = 1000) {
        if (this.republishTimer || (!this.intended.size && !this.recordOnlyIntent)) return;
        this.republishTimer = window.setTimeout(() => {
            this.republishTimer = 0;
            if (this.intended.size || this.recordOnlyIntent) void this.republish();
        }, delayMs);
    }

    /** Closes a transport here and on the server; the server otherwise kept it until the phone left. */
    private closeTransport(transport: mediasoupClient.types.Transport | null | undefined) {
        if (!transport) return;
        realtimeSocket.emit('closeTransport', { transportId: transport.id });
        if (!transport.closed) transport.close();
    }

    private async loadDevice() {
        this.bindHandlers();
        await realtimeSocket.connect();
        if (this.device?.loaded) return;
        const capabilities = await realtimeSocket.request<mediasoupClient.types.RtpCapabilities & { error?: string }>(
            'getRouterRtpCapabilities');
        if (capabilities.error) throw new Error(capabilities.error);
        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: capabilities });
        this.device = device;
    }

    /** A send transport whose producer is announced to the server with `appData`. */
    private async openSendTransport(appData: Record<string, unknown>) {
        const transportInfo = await realtimeSocket.request<TransportResponse>('createWebRtcTransport', { type: 'producer' });
        if (transportInfo.error) throw new Error(transportInfo.error);
        const transport = this.device!.createSendTransport(transportInfo);
        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            void realtimeSocket.request<{ error?: string } | undefined>('connectTransport', { transportId: transport.id, dtlsParameters })
                .then((result) => result?.error ? errback(new Error(result.error)) : callback());
        });
        transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
            void realtimeSocket.request<{ id?: string; error?: string }>('produce', {
                transportId: transport.id, kind, rtpParameters, appData,
            }).then((result) => result.error || !result.id
                ? errback(new Error(result.error || 'No producer ID returned.'))
                : callback({ id: result.id }));
        });
        transport.on('connectionstatechange', (state) => { if (state === 'failed') this.scheduleRepublish(); });
        return transport;
    }

    async publishTrack(
        channelId: string,
        track: MediaStreamTrack,
        mode: 'human' | 'ai',
        onStatus: StatusCallback = () => undefined,
        onConnectionsChange: (count: number) => void = () => undefined,
        role?: BroadcastRole,
    ) {
        const generation = this.broadcastGeneration;
        await this.loadDevice();
        this.onConnectionsChange = onConnectionsChange;
        this.onPublishStatus = onStatus;
        onStatus('Connecting…');
        this.intended.set(channelId, { track, mode, role });
        // Abandoned when the broadcast was stopped meanwhile, or this channel was handed a
        // newer track (an OpenAI reconnect) by a later call.
        const superseded = () => generation !== this.broadcastGeneration || this.intended.get(channelId)?.track !== track;
        const transport = await this.openSendTransport({ channelId, mode, role });
        if (superseded()) { this.closeTransport(transport); throw new Error('The broadcast was stopped.'); }
        this.sendTransports.set(channelId, transport);
        let producer: mediasoupClient.types.Producer;
        try {
            // The track belongs to the caller (the capture stream or the OpenAI leg), which
            // stops it. Letting the producer stop it on close would kill the track the moment
            // the channel is re-published after a media-engine restart.
            producer = await transport.produce({ track, stopTracks: false });
        } catch (error) {
            if (this.sendTransports.get(channelId) === transport) this.sendTransports.delete(channelId);
            this.closeTransport(transport);
            throw error;
        }
        if (superseded()) {
            producer.close();
            if (this.sendTransports.get(channelId) === transport) this.sendTransports.delete(channelId);
            this.closeTransport(transport);
            throw new Error('The broadcast was stopped.');
        }
        this.producers.set(channelId, producer);
        // The input itself stopped (a USB interface unplugged, the device switched off). The
        // channel ends; say so, since the screen otherwise still looked live.
        producer.on('trackended', () => {
            this.stopChannel(channelId);
            this.onPublishStatus('The audio input stopped sending sound, so this channel is off air. Check the cable or device, then press Stop and start again.');
        });
        onStatus('Broadcasting');
    }

    /**
     * Swaps the audio on a live channel without making listeners renegotiate. Used when the
     * OpenAI leg reconnects, and with `null` to send silence while it does. Returns false when
     * the channel is not published from this device.
     */
    async replaceTrack(channelId: string, track: MediaStreamTrack | null) {
        const producer = this.producers.get(channelId);
        if (!producer || producer.closed) return false;
        await producer.replaceTrack({ track });
        const intent = this.intended.get(channelId);
        if (intent && track) this.intended.set(channelId, { ...intent, track });
        return true;
    }

    /**
     * Re-publishes every live channel once a restarted media worker is ready. The server
     * forgets all producers when the worker dies, so without this a broadcaster went on
     * "broadcasting" to an engine that no longer knew about them until someone pressed Stop
     * and Start again.
     */
    private async republish() {
        // One rebuild at a time; a request arriving meanwhile runs once more afterwards.
        if (this.republishing) { this.republishAgain = true; return; }
        this.republishing = true;
        window.clearTimeout(this.republishTimer);
        this.republishTimer = 0;
        const generation = this.broadcastGeneration;
        let failed = false;
        try {
            const recordOnly = this.recordOnlyIntent;
            if (recordOnly) {
                this.dropRecordOnly();
                if (recordOnly.track.readyState === 'live') {
                    try { await this.publishRecordOnly(recordOnly.channelId, recordOnly.track); }
                    catch (error) { failed = true; console.warn('Could not resume recording the original:', error); }
                }
            }
            for (const [channelId, { track, mode, role }] of [...this.intended]) {
                if (generation !== this.broadcastGeneration) return;
                this.dropChannel(channelId);
                // An AI leg that is mid-reconnect has no live track yet; it publishes on its own
                // once the new OpenAI connection delivers audio.
                if (track.readyState !== 'live') continue;
                try {
                    await this.publishTrack(channelId, track, mode, this.onPublishStatus, this.onConnectionsChange, role);
                } catch (error) {
                    if (generation !== this.broadcastGeneration) return;
                    failed = true;
                    this.onPublishStatus(`Could not resume broadcasting yet (${error instanceof Error ? error.message : String(error)}). Trying again…`);
                }
            }
            if (this.muted) this.setMuted(true);
        } finally {
            this.republishing = false;
        }
        if (generation !== this.broadcastGeneration) return;
        if (failed) {
            // Keep trying with growing pauses: the channels stay in `intended` until it works
            // or the operator stops. One failed attempt used to end recovery for good.
            this.republishAttempt += 1;
            this.scheduleRepublish(Math.min(30_000, 1000 * 2 ** this.republishAttempt));
        } else {
            this.republishAttempt = 0;
        }
        if (this.republishAgain) { this.republishAgain = false; void this.republish(); }
    }

    /**
     * Sends a track to the server's recorder only: listeners never receive it and the channel
     * does not show as live. Used for the original speech in AI mode when it is not broadcast.
     */
    async publishRecordOnly(channelId: string, track: MediaStreamTrack) {
        const generation = this.broadcastGeneration;
        await this.loadDevice();
        this.dropRecordOnly();
        this.recordOnlyIntent = { channelId, track };
        const superseded = () => generation !== this.broadcastGeneration || this.recordOnlyIntent?.track !== track;
        const transport = await this.openSendTransport({ channelId, recordOnly: true });
        try {
            if (superseded()) throw new Error('The broadcast was stopped.');
            const producer = await transport.produce({ track, stopTracks: false });
            if (superseded()) { producer.close(); throw new Error('The broadcast was stopped.'); }
            this.recordOnly = { channelId, transport, producer };
        } catch (error) {
            this.closeTransport(transport);
            throw error;
        }
    }

    /** The record-only producer's local objects, keeping the intent to record. */
    private dropRecordOnly() {
        const current = this.recordOnly;
        if (!current) return;
        this.recordOnly = null;
        realtimeSocket.emit('closeRecordOnly', { producerId: current.producer.id });
        current.producer.close();
        this.closeTransport(current.transport);
    }

    stopRecordOnly() {
        this.recordOnlyIntent = null;
        this.dropRecordOnly();
    }

    async startBroadcast(channelId: string, onStatus: StatusCallback, onConnectionsChange: (count: number) => void, deviceId?: string) {
        const generation = this.broadcastGeneration;
        try {
            const stream = await this.getInputStream(deviceId);
            // Stopped (or the page left) while Windows was opening the input: let it go again
            // instead of broadcasting a microphone nobody asked for any more.
            if (generation !== this.broadcastGeneration) {
                stream.getTracks().forEach((track) => track.stop());
                if (this.sourceStream === stream) this.sourceStream = null;
                throw new Error('The broadcast was stopped.');
            }
            const [track] = stream.getAudioTracks();
            if (!track) throw new Error('That input opened but produced no audio track. Choose a different device and try again.');
            await this.publishTrack(channelId, track, 'human', onStatus, onConnectionsChange);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onStatus(`Error: ${message}`);
            throw error;
        }
    }

    setMuted(muted: boolean) {
        this.muted = muted;
        for (const [channelId, producer] of this.producers) {
            if (muted) producer.pause(); else producer.resume();
            // producer.pause() only pauses the local object; the server has to pause the real
            // producer so listeners actually stop receiving and are told why.
            realtimeSocket.emit('setProducerPaused', { channelId, paused: muted });
        }
        for (const track of this.sourceStream?.getAudioTracks() || []) track.enabled = !muted;
    }

    sendTranslationText(channelId: string, segment: { segmentId: string; text: string; originalText: string; final: boolean }) {
        realtimeSocket.emit('sendTranslationText', { channelId, ...segment });
    }

    /** The channel's recent captions, so a phone joining mid-talk does not start blank. */
    async getTranscript(channelId: string) {
        const result = await realtimeSocket.request<{ segments?: CaptionSegment[]; error?: string }>('getTranscript', { channelId });
        return result?.segments ?? [];
    }

    /** Closes a channel's local objects only, for when the server side is already gone. */
    private dropChannel(channelId: string) {
        this.producers.get(channelId)?.close();
        this.closeTransport(this.sendTransports.get(channelId));
        this.producers.delete(channelId);
        this.sendTransports.delete(channelId);
        this.listenerCounts.delete(channelId);
    }

    /**
     * Tears a channel down locally and tells the server. Closing only the local objects leaves
     * the server publishing a dead producer until DTLS eventually times out, during which a
     * listener can "successfully" subscribe to silence.
     */
    stopChannel(channelId: string) {
        this.intended.delete(channelId);
        realtimeSocket.emit('closeProducer', { channelId });
        this.dropChannel(channelId);
    }

    stopBroadcast() {
        this.broadcastGeneration += 1;
        window.clearTimeout(this.republishTimer);
        this.republishTimer = 0;
        this.republishAttempt = 0;
        for (const channelId of new Set([...this.producers.keys(), ...this.intended.keys()])) this.stopChannel(channelId);
        this.stopRecordOnly();
        this.sourceStream?.getTracks().forEach((track) => track.stop());
        this.sourceStream = null;
        this.listenerCounts.clear();
        this.muted = false;
        this.onConnectionsChange?.(0);
        if (!this.currentListenerChannelId) this.device = null;
    }

    async listenToChannel(
        channelId: string,
        onStatus: ListenerStatusCallback,
        onStreamReceived: (stream: MediaStream) => void,
        onMuteStatusChange?: (muted: boolean) => void,
        onTranslationTextReceived?: CaptionCallback,
    ) {
        this.currentListenerChannelId = channelId;
        this.onListenerStatus = onStatus;
        this.onListenerStreamReceived = onStreamReceived;
        this.onMuteStatusChange = onMuteStatusChange;
        this.onTranslationTextReceived = onTranslationTextReceived;
        await this.negotiateListener();
    }

    private async reconnectListener() {
        if (!this.currentListenerChannelId || !this.onListenerStatus || !this.onListenerStreamReceived) return;
        await this.negotiateListener();
    }

    private async negotiateListener() {
        const channelId = this.currentListenerChannelId;
        if (!channelId) return;
        const onStatus = this.onListenerStatus ?? (() => undefined);
        const attempt = ++this.listenAttempt;
        const stale = () => attempt !== this.listenAttempt;
        try {
            this.consumer?.close();
            this.consumer = null;
            this.closeRecvTransport();
            onStatus('connecting');
            await this.loadDevice();
            const transportInfo = await realtimeSocket.request<TransportResponse>('createWebRtcTransport', { type: 'consumer' });
            if (transportInfo.error) throw new Error(transportInfo.error);
            if (stale()) return;
            const recvTransport = this.device!.createRecvTransport(transportInfo);
            this.recvTransport = recvTransport;
            // A media link that fails (Wi-Fi roaming, the computer's address changing) gives no
            // other sign: the consumer object stays, and the listener just hears nothing.
            recvTransport.on('connectionstatechange', (state) => {
                if (state !== 'failed' || stale() || this.recvTransport !== recvTransport) return;
                this.handleStreamLoss();
                window.setTimeout(() => {
                    if (!stale() && this.currentListenerChannelId === channelId) void this.reconnectListener();
                }, 1000);
            });
            recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
                void realtimeSocket.request<{ error?: string } | undefined>('connectTransport', { transportId: recvTransport.id, dtlsParameters })
                    .then((result) => result?.error ? errback(new Error(result.error)) : callback());
            });
            const consumeInfo = await realtimeSocket.request<ConsumeResponse>('consume', {
                transportId: recvTransport.id, rtpCapabilities: this.device!.rtpCapabilities, channelId,
            });
            if (stale()) { this.closeTransport(recvTransport); return; }
            // No broadcast yet: give the transport back now; a fresh one is made on retry.
            if (consumeInfo.error) { this.closeRecvTransport(); onStatus('waiting'); return; }
            const consumer = await recvTransport.consume(consumeInfo);
            if (stale()) { consumer.close(); this.closeTransport(recvTransport); return; }
            this.consumer = consumer;
            this.consumer.on('transportclose', () => this.handleStreamLoss());
            this.consumer.on('trackended', () => this.handleStreamLoss());
            this.onMuteStatusChange?.(Boolean(consumeInfo.producerPaused));
            onStatus('receiving');
            this.onListenerStreamReceived?.(new MediaStream([this.consumer.track]));
        } catch (error) {
            if (stale()) return;
            console.error('Listen failed:', error);
            onStatus(error instanceof Error && /waiting/i.test(error.message) ? 'waiting' : 'error');
        }
    }

    private handleStreamLoss() {
        this.consumer?.close();
        this.consumer = null;
        if (this.currentListenerChannelId) this.onListenerStatus?.('waiting');
    }

    /** The listening transport, closed here and on the server, so the phone stops counting as a listener. */
    private closeRecvTransport() {
        const transport = this.recvTransport;
        this.recvTransport = null;
        this.closeTransport(transport);
    }

    stopListening() {
        this.listenAttempt += 1;
        this.currentListenerChannelId = null;
        this.onMuteStatusChange = undefined;
        this.consumer?.close();
        this.consumer = null;
        this.closeRecvTransport();
        if (!this.producers.size) this.device = null;
    }

    createLevelMeter(stream: MediaStream, onLevel: (level: number) => void) {
        try {
            const audioContext = new AudioContext();
            const source = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.5; source.connect(analyser);
            const data = new Uint8Array(analyser.frequencyBinCount);
            let frame = 0;
            const update = () => {
                analyser.getByteFrequencyData(data);
                const average = data.reduce((sum, value) => sum + value, 0) / data.length;
                onLevel(Math.max(0, Math.min(100, (average - 3) * 1.2)));
                frame = requestAnimationFrame(update);
            };
            update();
            return () => { cancelAnimationFrame(frame); void audioContext.close(); };
        } catch (error) { console.error('Level meter failed:', error); return () => undefined; }
    }
}

export const voiceService = new VoiceService();
