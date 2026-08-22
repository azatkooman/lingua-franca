import { io, type Socket } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import { settingsService } from './SettingsService';

export interface VoiceConfig { host?: string; port?: number; secure?: boolean; }
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
    error?: string;
}

export class VoiceService {
    private socket: Socket | null = null;
    private socketAuthToken = '';
    private device: mediasoupClient.Device | null = null;
    private sourceStream: MediaStream | null = null;
    private sendTransports = new Map<string, mediasoupClient.types.Transport>();
    private producers = new Map<string, mediasoupClient.types.Producer>();
    private recvTransport: mediasoupClient.types.Transport | null = null;
    private consumer: mediasoupClient.types.Consumer | null = null;
    private currentListenerChannel: string | null = null;
    private onListenerStatus?: StatusCallback;
    private onListenerStreamReceived?: (stream: MediaStream) => void;
    private onTranslationTextReceived?: (text: string, originalText: string) => void;
    private onConnectionsChange?: (count: number) => void;
    private config: VoiceConfig = {};

    setConfig(config: VoiceConfig) { this.config = config; }
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

    private socketUrl() {
        if (this.config.host) {
            const protocol = this.config.secure ? 'https' : 'http';
            return `${protocol}://${this.config.host}:${this.config.port || (this.config.secure ? 4173 : 4174)}`;
        }
        const host = window.location.hostname;
        const port = window.location.port === '5173' ? 4173 : (Number(window.location.port) || (window.location.protocol === 'https:' ? 4173 : 4174));
        return `${window.location.protocol === 'https:' ? 'https' : 'http'}://${host}:${port}`;
    }

    private async connectSocket() {
        const authToken = settingsService.getPublisherToken();
        if (this.socket?.connected && this.socketAuthToken === authToken) return this.socket;
        if (this.socket) { this.socket.disconnect(); this.socket = null; this.device = null; }
        return new Promise<Socket>((resolve, reject) => {
            const socket = io(this.socketUrl(), {
                transports: ['websocket'],
                auth: { token: authToken },
                reconnection: true,
                reconnectionDelay: 500,
                reconnectionDelayMax: 5000,
            });
            this.socket = socket;
            this.socketAuthToken = authToken;
            socket.once('connect', () => resolve(socket));
            socket.once('connect_error', reject);
            socket.on('producerAvailable', ({ channelName }: { channelName: string }) => {
                if (this.currentListenerChannel === channelName && !this.consumer && this.onListenerStatus && this.onListenerStreamReceived) {
                    void this.listenToChannel('', channelName, this.onListenerStatus, this.onListenerStreamReceived, undefined, this.onTranslationTextReceived);
                }
            });
            socket.on('producerClosed', ({ channelName }: { channelName: string }) => {
                if (this.currentListenerChannel === channelName) this.handleStreamLoss();
            });
            socket.on('translationText', ({ channelName, text, originalText }: { channelName: string; text: string; originalText: string }) => {
                if (this.currentListenerChannel === channelName) this.onTranslationTextReceived?.(text, originalText);
            });
            socket.on('listenerCount', ({ channelName, count }: { channelName: string; count: number }) => {
                if (this.producers.has(channelName)) this.onConnectionsChange?.(count);
            });
        });
    }

    private async loadDevice() {
        const socket = await this.connectSocket();
        const capabilities = await new Promise<mediasoupClient.types.RtpCapabilities & { error?: string }>((resolve) =>
            socket.emit('getRouterRtpCapabilities', resolve));
        if (capabilities.error) throw new Error(capabilities.error);
        if (!this.device?.loaded) {
            this.device = new mediasoupClient.Device();
            await this.device.load({ routerRtpCapabilities: capabilities });
        }
        return socket;
    }

    async publishTrack(
        channelName: string,
        track: MediaStreamTrack,
        mode: 'human' | 'ai',
        onStatus: StatusCallback = () => undefined,
        onConnectionsChange: (count: number) => void = () => undefined,
    ) {
        const socket = await this.loadDevice();
        this.onConnectionsChange = onConnectionsChange;
        onStatus(`Connecting ${channelName}...`);
        const transportInfo = await new Promise<TransportResponse>((resolve) =>
            socket.emit('createWebRtcTransport', { type: 'producer' }, resolve));
        if (transportInfo.error) throw new Error(transportInfo.error);
        const transport = this.device!.createSendTransport(transportInfo);
        this.sendTransports.set(channelName, transport);
        transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            socket.emit('connectTransport', { transportId: transport.id, dtlsParameters }, (result?: { error?: string }) =>
                result?.error ? errback(new Error(result.error)) : callback());
        });
        transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
            socket.emit('produce', {
                transportId: transport.id, kind, rtpParameters, appData: { channelName, mode },
            }, (result: { id?: string; error?: string }) =>
                result.error || !result.id ? errback(new Error(result.error || 'No producer ID returned.')) : callback({ id: result.id }));
        });
        const producer = await transport.produce({ track });
        this.producers.set(channelName, producer);
        producer.on('trackended', () => this.stopChannel(channelName));
        onStatus(`Broadcasting ${channelName}`);
    }

    async startBroadcast(channelName: string, onStatus: StatusCallback, onConnectionsChange: (count: number) => void, deviceId?: string) {
        try {
            const stream = await this.getInputStream(deviceId);
            await this.publishTrack(channelName, stream.getAudioTracks()[0], 'human', onStatus, onConnectionsChange);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onStatus(`Error: ${message}`);
            throw error;
        }
    }

    setMuted(muted: boolean) {
        for (const producer of this.producers.values()) {
            if (muted) producer.pause(); else producer.resume();
        }
        for (const track of this.sourceStream?.getAudioTracks() || []) track.enabled = !muted;
    }

    sendTranslationText(channelName: string, text: string, originalText: string) {
        this.socket?.emit('sendTranslationText', { channelName, text, originalText });
    }

    async setTextChannel(channelName: string, active: boolean) {
        const socket = await this.connectSocket();
        const result = await new Promise<{ ok?: boolean; error?: string }>((resolve) =>
            socket.emit('setTextChannel', { channelName, active }, resolve));
        if (result.error) throw new Error(result.error);
    }

    stopChannel(channelName: string) {
        this.producers.get(channelName)?.close();
        this.sendTransports.get(channelName)?.close();
        this.producers.delete(channelName);
        this.sendTransports.delete(channelName);
    }

    stopBroadcast() {
        for (const channelName of [...this.producers.keys()]) this.stopChannel(channelName);
        this.sourceStream?.getTracks().forEach((track) => track.stop());
        this.sourceStream = null;
        if (!this.currentListenerChannel) { this.socket?.disconnect(); this.socket = null; this.device = null; }
        this.onConnectionsChange?.(0);
    }

    async listenToChannel(
        _targetPeerId: string,
        channelName: string,
        onStatus: StatusCallback,
        onStreamReceived: (stream: MediaStream) => void,
        _onMuteStatusChange?: (muted: boolean) => void,
        onTranslationTextReceived?: (text: string, originalText: string) => void,
    ) {
        this.currentListenerChannel = channelName;
        this.onListenerStatus = onStatus;
        this.onListenerStreamReceived = onStreamReceived;
        this.onTranslationTextReceived = onTranslationTextReceived;
        try {
            this.consumer?.close(); this.recvTransport?.close(); this.consumer = null;
            onStatus('Connecting...');
            const socket = await this.loadDevice();
            const transportInfo = await new Promise<TransportResponse>((resolve) =>
                socket.emit('createWebRtcTransport', { type: 'consumer' }, resolve));
            if (transportInfo.error) throw new Error(transportInfo.error);
            this.recvTransport = this.device!.createRecvTransport(transportInfo);
            this.recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
                socket.emit('connectTransport', { transportId: this.recvTransport!.id, dtlsParameters }, (result?: { error?: string }) =>
                    result?.error ? errback(new Error(result.error)) : callback());
            });
            const consumeInfo = await new Promise<ConsumeResponse>((resolve) => socket.emit('consume', {
                transportId: this.recvTransport!.id, rtpCapabilities: this.device!.rtpCapabilities, channelName,
            }, resolve));
            if (consumeInfo.error) { onStatus(`Waiting for ${channelName}...`); return; }
            this.consumer = await this.recvTransport.consume(consumeInfo);
            this.consumer.on('transportclose', () => this.handleStreamLoss());
            this.consumer.on('trackended', () => this.handleStreamLoss());
            onStatus('Connected & receiving');
            onStreamReceived(new MediaStream([this.consumer.track]));
        } catch (error) {
            console.error('Listen failed:', error);
            onStatus(error instanceof Error && /waiting/i.test(error.message) ? error.message : 'Connection error. Waiting...');
        }
    }

    private handleStreamLoss() {
        this.consumer?.close(); this.consumer = null;
        if (this.currentListenerChannel) this.onListenerStatus?.(`Waiting for ${this.currentListenerChannel}...`);
    }

    stopListening() {
        this.currentListenerChannel = null;
        this.consumer?.close(); this.recvTransport?.close();
        this.consumer = null; this.recvTransport = null;
        if (!this.producers.size) { this.socket?.disconnect(); this.socket = null; this.device = null; }
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
