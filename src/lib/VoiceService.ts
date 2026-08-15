import { io, Socket } from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';

export interface VoiceConfig {
    host?: string;
    port?: number;
    path?: string;
    secure?: boolean;
}

export class VoiceService {
    private socket: Socket | null = null;
    private device: mediasoupClient.Device | null = null;
    private stream: MediaStream | null = null;
    private sendTransport: mediasoupClient.types.Transport | null = null;
    private recvTransport: mediasoupClient.types.Transport | null = null;
    private producer: mediasoupClient.types.Producer | null = null;
    private consumer: mediasoupClient.types.Consumer | null = null;

    private currentLanguageName: string | null = null;
    private onStatusChange?: (status: string) => void;
    private onPeerConnected?: (count: number) => void;

    // Listener state
    private currentListenerChannel: string | null = null;
    private onListenerStatus?: (status: string) => void;
    private onListenerStreamReceived?: (stream: MediaStream) => void;
    private onTranslationTextReceived?: (text: string, originalText: string) => void;

    private config: VoiceConfig = {};

    setConfig(config: VoiceConfig) {
        this.config = config;
    }

    getBroadcastStream(): MediaStream | null {
        return this.stream;
    }

    async getMicrophones(): Promise<MediaDeviceInfo[]> {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(device => device.kind === 'audioinput');
        } catch (err) {
            console.error("Error enumerating devices", err);
            return [];
        }
    }

    private getSocketUrl(): string {
        if (this.config.host) {
            const protocol = this.config.secure ? 'https' : 'http';
            return `${protocol}://${this.config.host}:${this.config.port || (this.config.secure ? 4173 : 4174)}`;
        }

        const defaultHost = window.location.hostname;
        let defaultPort = parseInt(window.location.port) || (window.location.protocol === 'https:' ? 4173 : 4174);

        if (window.location.port === '5173') {
            defaultPort = 4173; // Always target HTTPS port for signaling if in dev
        }

        const protocol = window.location.protocol === 'https:' ? 'https' : 'http';
        return `${protocol}://${defaultHost}:${defaultPort}`;
    }

    private async connectSocket(): Promise<Socket> {
        if (this.socket?.connected) return this.socket;

        return new Promise((resolve, reject) => {
            const url = this.getSocketUrl();
            console.log("Connecting to SFU Signaling:", url);

            // In Electron/Local env we often use self-signed certs
            this.socket = io(url, {
                rejectUnauthorized: false,
                transports: ['websocket']
            });

            this.socket.on('connect', () => {
                console.log('Socket connected');
                resolve(this.socket!);
            });

            this.socket.on('connect_error', (err) => {
                console.error('Socket connection error:', err);
                reject(err);
            });

            // Listen for producer availability (for listeners)
            this.socket.on('producerAvailable', ({ channelName }) => {
                console.log(`Producer available for channel: ${channelName}`);
                if (this.currentListenerChannel === channelName && !this.consumer) {
                    console.log(`Auto-reconnecting to ${channelName}...`);
                    this.listenToChannel('', channelName, this.onListenerStatus!, this.onListenerStreamReceived!);
                }
            });

            this.socket.on('producerClosed', ({ channelName }) => {
                console.log(`Producer closed for channel: ${channelName}`);
                if (this.currentListenerChannel === channelName) {
                    this.handleStreamLoss();
                }
            });

            this.socket.on('translationText', ({ channelName, text, originalText }) => {
                if (this.currentListenerChannel === channelName) {
                    this.onTranslationTextReceived?.(text, originalText);
                }
            });
        });
    }

    private async loadDevice(routerRtpCapabilities: any) {
        try {
            this.device = new mediasoupClient.Device();
            await this.device.load({ routerRtpCapabilities });
        } catch (error: any) {
            if (error.name === 'UnsupportedError') {
                console.error('Browser not supported');
            }
            throw error;
        }
    }

    setMuted(muted: boolean) {
        if (this.producer) {
            if (muted) {
                this.producer.pause();
            } else {
                this.producer.resume();
            }
        }
        // Signaling server can also broadcast this if needed, 
        // but Mediasoup pause/resume handles it at media level.
    }

    sendTranslationText(channelName: string, text: string, originalText: string) {
        if (this.socket?.connected) {
            this.socket.emit('sendTranslationText', { channelName, text, originalText });
        }
    }

    // INTERPRETER: Start broadcasting
    async startBroadcast(channelName: string,
        onStatus: (status: string) => void,
        onConnectionsChange: (count: number) => void,
        deviceId?: string
    ) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            console.error("Secure context or mediaDevices not available");
            onStatus("Error: Secure context required for microphone access");
            throw new Error("Microphone access is only available over HTTPS or localhost (Secure Context)");
        }
        this.onStatusChange = onStatus;
        this.onPeerConnected = onConnectionsChange;
        this.currentLanguageName = channelName;

        try {
            onStatus("Initializing SFU...");
            const socket = await this.connectSocket();

            // 1. Get Router Capabilities & Load Device
            const response: any = await new Promise(resolve =>
                socket.emit('getRouterRtpCapabilities', resolve)
            );
            if (response.error) throw new Error(response.error);
            await this.loadDevice(response);

            // 2. Get Audio Stream
            try {
                this.stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        deviceId: deviceId ? { exact: deviceId } : undefined,
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        channelCount: 1,
                        sampleRate: 48000
                    }
                });
            } catch (mediaError: any) {
                console.error("getUserMedia failed:", mediaError);
                onStatus(`Error: ${mediaError.name || 'Microphone Error'}`);
                // Re-throw with more detail
                const errorToThrow = new Error(`${mediaError.name}: ${mediaError.message}`);
                (errorToThrow as any).originalError = mediaError;
                throw errorToThrow;
            }

            // 3. Create Send Transport on Server
            const transportInfo: any = await new Promise(resolve =>
                socket.emit('createWebRtcTransport', { type: 'producer' }, resolve)
            );
            if (transportInfo.error) throw new Error(transportInfo.error);

            // 4. Create Send Transport on Client
            this.sendTransport = this.device!.createSendTransport(transportInfo);

            this.sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
                socket.emit('connectTransport', {
                    transportId: this.sendTransport!.id,
                    dtlsParameters
                }, (err: any) => err ? errback(err) : callback());
            });

            this.sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
                socket.emit('produce', {
                    transportId: this.sendTransport!.id,
                    kind,
                    rtpParameters,
                    appData: { ...appData, channelName }
                }, ({ id, error }: any) => error ? errback(error) : callback({ id }));
            });

            // 5. Produce Audio
            const track = this.stream.getAudioTracks()[0];
            this.producer = await this.sendTransport.produce({ track });

            onStatus(`Broadcasting on ${channelName} (SFU)`);
            onConnectionsChange(1);

            // 6. Update SettingsService to signal "Live" status
            import('./SettingsService').then(({ settingsService }) => {
                settingsService.updateLanguagePeerId(channelName, 'sfu-active');
            });

        } catch (err: any) {
            console.error("SFU Broadcast Failed", err);
            onStatus(`Error: ${err.message || 'Check connection'}`);
            throw err;
        }
    }

    stopBroadcast() {
        if (this.currentLanguageName) {
            const langName = this.currentLanguageName;
            import('./SettingsService').then(({ settingsService }) => {
                settingsService.updateLanguagePeerId(langName, undefined);
            });
        }
        this.currentLanguageName = null;

        this.producer?.close();
        this.sendTransport?.close();
        this.socket?.disconnect();

        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        this.producer = null;
        this.sendTransport = null;
        this.socket = null;
        this.onStatusChange?.('Offline');
        this.onPeerConnected?.(0);
    }

    async listenToChannel(targetPeerId: string,
        channelName: string,
        onStatus: (status: string) => void,
        onStreamReceived: (stream: MediaStream) => void,
        _onMuteStatusChange?: (muted: boolean) => void,
        onTranslationTextReceived?: (text: string, originalText: string) => void
    ) {
        this.currentListenerChannel = channelName;
        this.onListenerStatus = onStatus;
        this.onListenerStreamReceived = onStreamReceived;
        this.onTranslationTextReceived = onTranslationTextReceived;

        try {
            // Only stop if we are changing channels or forcing a reset
            // If we are just retrying/reconnecting, we might want to keep the socket.
            // But for simplicity, let's ensure a clean slate if we aren't already connected to this channel.
            if (this.consumer && this.currentListenerChannel !== channelName) {
                this.stopListening();
            }

            onStatus("Connecting to SFU...");
            const socket = await this.connectSocket();

            if (targetPeerId === 'ai-active') {
                onStatus("Connected & Receiving (AI)");
                return;
            }

            // 1. Get Router Capabilities & Load Device
            const response: any = await new Promise(resolve =>
                socket.emit('getRouterRtpCapabilities', resolve)
            );
            if (response.error) throw new Error(response.error);
            await this.loadDevice(response);

            // 2. Create Recv Transport on Server
            const transportInfo: any = await new Promise(resolve =>
                socket.emit('createWebRtcTransport', { type: 'consumer' }, resolve)
            );
            if (transportInfo.error) throw new Error(transportInfo.error);

            // 3. Create Recv Transport on Client
            this.recvTransport = this.device!.createRecvTransport(transportInfo);

            this.recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
                socket.emit('connectTransport', {
                    transportId: this.recvTransport!.id,
                    dtlsParameters
                }, (err: any) => err ? errback(err) : callback());
            });

            // 4. Consume
            const consumeInfo: any = await new Promise(resolve =>
                socket.emit('consume', {
                    transportId: this.recvTransport!.id,
                    rtpCapabilities: this.device!.rtpCapabilities,
                    channelName
                }, resolve)
            );

            if (consumeInfo.error) {
                console.log(`Waiting for producer on ${channelName}...`);
                onStatus(`Waiting for ${channelName}...`);
                // No need for setTimeout retry anymore, the producerAvailable event will handle it
                return;
            }

            this.consumer = await this.recvTransport.consume(consumeInfo);

            this.consumer.on('transportclose', () => {
                console.log('Consumer transport closed');
                this.handleStreamLoss();
            });

            this.consumer.on('trackended', () => {
                console.log('Track ended');
                this.handleStreamLoss();
            });

            const { track } = this.consumer;
            onStatus("Connected & Receiving (SFU)");
            onStreamReceived(new MediaStream([track]));

        } catch (err: any) {
            console.error("SFU Listen Failed", err);
            onStatus("Connection error. Waiting...");
            // The socket connect_error or retry logic will eventually trigger via producerAvailable if it's intermittent
        }
    }

    private handleStreamLoss() {
        this.consumer?.close();
        this.consumer = null;
        if (this.onListenerStatus && this.currentListenerChannel) {
            this.onListenerStatus(`Waiting for ${this.currentListenerChannel}...`);
        }
    }

    stopListening() {
        this.currentListenerChannel = null;
        this.onListenerStatus = undefined;
        this.onListenerStreamReceived = undefined;
        this.onTranslationTextReceived = undefined;

        this.consumer?.close();
        this.recvTransport?.close();
        this.socket?.disconnect();

        this.consumer = null;
        this.recvTransport = null;
        this.socket = null;
    }

    createLevelMeter(stream: MediaStream, onLevel: (level: number) => void): () => void {
        try {
            const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
            const audioContext = new AudioContextClass();
            const source = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.5;
            source.connect(analyser);

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            let animationFrame: number;

            const updateLevel = () => {
                analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += dataArray[i];
                }
                const average = sum / dataArray.length;
                // Scale level to satisfy user: more linear/logarithmic and capped at reasonably high signal
                // Average around 2-3 is background noise. 32-64 is speech.
                const level = Math.max(0, Math.min(100, (average - 3) * 1.2));
                onLevel(level);
                animationFrame = requestAnimationFrame(updateLevel);
            };
            updateLevel();

            return () => {
                if (animationFrame) cancelAnimationFrame(animationFrame);
                if (audioContext.state !== 'closed') audioContext.close();
            };
        } catch (e) {
            console.error('Failed to create audio level meter:', e);
            return () => { };
        }
    }
}

export const voiceService = new VoiceService();
