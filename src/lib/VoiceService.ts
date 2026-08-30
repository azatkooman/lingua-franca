import * as mediasoupClient from 'mediasoup-client';
import { realtimeSocket } from './realtimeSocket';

export const SYSTEM_AUDIO_DEVICE_ID = '__lingua_franca_system_audio__';
type StatusCallback = (status: string) => void;

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
    private recvTransport: mediasoupClient.types.Transport | null = null;
    private consumer: mediasoupClient.types.Consumer | null = null;
    private currentListenerChannelId: string | null = null;
    private onListenerStatus?: StatusCallback;
    private onListenerStreamReceived?: (stream: MediaStream) => void;
    private onTranslationTextReceived?: (text: string, originalText: string) => void;
    private onMuteStatusChange?: (muted: boolean) => void;
    private onConnectionsChange?: (count: number) => void;
    private handlersBound = false;

    getBroadcastStream() { return this.sourceStream; }
    isDesktopApp() { return /\bElectron\//i.test(navigator.userAgent); }

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
            if (!deviceId || !(error instanceof DOMException) || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw this.mediaError(error);
            try { this.sourceStream = await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: undefined } }); }
            catch (fallbackError) { throw this.mediaError(fallbackError); }
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
        realtimeSocket.on<{ channelId: string; text: string; originalText: string }>('translationText', ({ channelId, text, originalText }) => {
            if (this.currentListenerChannelId === channelId) this.onTranslationTextReceived?.(text, originalText);
        });
        realtimeSocket.on<{ channelId: string; muted: boolean }>('channelMuted', ({ channelId, muted }) => {
            if (this.currentListenerChannelId === channelId) this.onMuteStatusChange?.(muted);
        });
        realtimeSocket.on<{ channelId: string; count: number }>('listenerCount', ({ channelId, count }) => {
            if (this.producers.has(channelId)) this.onConnectionsChange?.(count);
        });
        // The router is rebuilt when the media worker is restarted, so the cached device
        // capabilities and every transport from the previous router are stale.
        realtimeSocket.on('sfuRestarting', () => {
            this.device = null;
            this.onListenerStatus?.('Media engine restarting…');
        });
        realtimeSocket.on('sfuReady', () => {
            this.device = null;
            if (this.currentListenerChannelId) void this.reconnectListener();
        });
        // A dropped Wi-Fi link gives the reconnected socket a new id, so the server holds no
        // transports for it and the listener has to negotiate again.
        realtimeSocket.on('connect', () => {
            if (this.currentListenerChannelId && !this.consumer) void this.reconnectListener();
        });
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

    async publishTrack(
        channelId: string,
        track: MediaStreamTrack,
        mode: 'human' | 'ai',
        onStatus: StatusCallback = () => undefined,
        onConnectionsChange: (count: number) => void = () => undefined,
    ) {
        await this.loadDevice();
        this.onConnectionsChange = onConnectionsChange;
        onStatus('Connecting…');
        const transportInfo = await realtimeSocket.request<TransportResponse>('createWebRtcTransport', { type: 'producer' });
        if (transportInfo.error) throw new Error(transportInfo.error);
        const transport = this.device!.createSendTransport(transportInfo);
        this.sendTransports.set(channelId, transport);
        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            void realtimeSocket.request<{ error?: string } | undefined>('connectTransport', { transportId: transport.id, dtlsParameters })
                .then((result) => result?.error ? errback(new Error(result.error)) : callback());
        });
        transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
            void realtimeSocket.request<{ id?: string; error?: string }>('produce', {
                transportId: transport.id, kind, rtpParameters, appData: { channelId, mode },
            }).then((result) => result.error || !result.id
                ? errback(new Error(result.error || 'No producer ID returned.'))
                : callback({ id: result.id }));
        });
        const producer = await transport.produce({ track });
        this.producers.set(channelId, producer);
        producer.on('trackended', () => this.stopChannel(channelId));
        onStatus('Broadcasting');
    }

    async startBroadcast(channelId: string, onStatus: StatusCallback, onConnectionsChange: (count: number) => void, deviceId?: string) {
        try {
            const stream = await this.getInputStream(deviceId);
            await this.publishTrack(channelId, stream.getAudioTracks()[0], 'human', onStatus, onConnectionsChange);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onStatus(`Error: ${message}`);
            throw error;
        }
    }

    setMuted(muted: boolean) {
        for (const [channelId, producer] of this.producers) {
            if (muted) producer.pause(); else producer.resume();
            // producer.pause() only pauses the local object; the server has to pause the real
            // producer so listeners actually stop receiving and are told why.
            realtimeSocket.emit('setProducerPaused', { channelId, paused: muted });
        }
        for (const track of this.sourceStream?.getAudioTracks() || []) track.enabled = !muted;
    }

    sendTranslationText(channelId: string, text: string, originalText: string) {
        realtimeSocket.emit('sendTranslationText', { channelId, text, originalText });
    }

    async setTextChannel(channelId: string, active: boolean) {
        const result = await realtimeSocket.request<{ ok?: boolean; error?: string }>('setTextChannel', { channelId, active });
        if (result?.error) throw new Error(result.error);
    }

    /**
     * Tears a channel down locally and tells the server. Closing only the local objects leaves
     * the server publishing a dead producer until DTLS eventually times out, during which a
     * listener can "successfully" subscribe to silence.
     */
    stopChannel(channelId: string) {
        this.producers.get(channelId)?.close();
        this.sendTransports.get(channelId)?.close();
        this.producers.delete(channelId);
        this.sendTransports.delete(channelId);
        realtimeSocket.emit('closeProducer', { channelId });
    }

    stopBroadcast() {
        for (const channelId of [...this.producers.keys()]) this.stopChannel(channelId);
        this.sourceStream?.getTracks().forEach((track) => track.stop());
        this.sourceStream = null;
        this.onConnectionsChange?.(0);
        if (!this.currentListenerChannelId) this.device = null;
    }

    async listenToChannel(
        channelId: string,
        onStatus: StatusCallback,
        onStreamReceived: (stream: MediaStream) => void,
        onMuteStatusChange?: (muted: boolean) => void,
        onTranslationTextReceived?: (text: string, originalText: string) => void,
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
        try {
            this.consumer?.close();
            this.recvTransport?.close();
            this.consumer = null;
            this.recvTransport = null;
            onStatus('Connecting…');
            await this.loadDevice();
            const transportInfo = await realtimeSocket.request<TransportResponse>('createWebRtcTransport', { type: 'consumer' });
            if (transportInfo.error) throw new Error(transportInfo.error);
            const recvTransport = this.device!.createRecvTransport(transportInfo);
            this.recvTransport = recvTransport;
            recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
                void realtimeSocket.request<{ error?: string } | undefined>('connectTransport', { transportId: recvTransport.id, dtlsParameters })
                    .then((result) => result?.error ? errback(new Error(result.error)) : callback());
            });
            const consumeInfo = await realtimeSocket.request<ConsumeResponse>('consume', {
                transportId: recvTransport.id, rtpCapabilities: this.device!.rtpCapabilities, channelId,
            });
            if (consumeInfo.error) { onStatus('Waiting for the broadcast to start…'); return; }
            this.consumer = await recvTransport.consume(consumeInfo);
            this.consumer.on('transportclose', () => this.handleStreamLoss());
            this.consumer.on('trackended', () => this.handleStreamLoss());
            this.onMuteStatusChange?.(Boolean(consumeInfo.producerPaused));
            onStatus('Connected & receiving');
            this.onListenerStreamReceived?.(new MediaStream([this.consumer.track]));
        } catch (error) {
            console.error('Listen failed:', error);
            onStatus(error instanceof Error && /waiting/i.test(error.message) ? error.message : 'Connection error. Waiting…');
        }
    }

    private handleStreamLoss() {
        this.consumer?.close();
        this.consumer = null;
        if (this.currentListenerChannelId) this.onListenerStatus?.('Waiting for the broadcast to start…');
    }

    stopListening() {
        this.currentListenerChannelId = null;
        this.onMuteStatusChange = undefined;
        this.consumer?.close();
        this.recvTransport?.close();
        this.consumer = null;
        this.recvTransport = null;
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
