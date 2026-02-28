import Peer, { type MediaConnection } from 'peerjs';

export interface VoiceConfig {
    host?: string;
    port?: number;
    path?: string;
    secure?: boolean;
}

export class VoiceService {
    private peer: Peer | null = null;
    private stream: MediaStream | null = null;
    private connections: Map<string, MediaConnection> = new Map();
    private currentLanguageName: string | null = null;
    private onStatusChange?: (status: string) => void;
    private onPeerConnected?: (count: number) => void;

    // Custom PeerJS server config for offline local networks
    private config: VoiceConfig = {
        // Empty config uses default PeerJS cloud server.
        // In Admin, you can set host to a local IP like '192.168.1.100'
    };

    setConfig(config: VoiceConfig) {
        this.config = config;
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

    private getPeerOptions(): any {
        if (Object.keys(this.config).length > 0) {
            return {
                ...this.config,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' }
                    ]
                }
            };
        }

        let defaultHost = window.location.hostname;
        let defaultPort = parseInt(window.location.port) || 443;
        let defaultSecure = window.location.protocol === 'https:';

        // Fix for development environment if needed
        if (window.location.port === '5173') {
            // In Vite dev mode, Electron is still hosting PeerJS on 4173
            // But we need to find the local IP for the desktop app usually
            // However, on the desktop itself 'localhost' works
        }

        return {
            host: defaultHost,
            port: defaultPort,
            path: '/peerjs',
            secure: defaultSecure,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            }
        };
    }

    private dataConnections: Map<string, any> = new Map();
    private isMuted = false;

    // INTERPRETER: Broadcast mute status to all listeners
    setMuted(muted: boolean) {
        this.isMuted = muted;
        if (this.stream) {
            this.stream.getAudioTracks().forEach(track => {
                track.enabled = !muted;
            });
        }

        // Notify all connected data channels
        this.dataConnections.forEach(conn => {
            if (conn.open) {
                conn.send({ type: 'mute-status', muted });
            }
        });
    }

    // Helper to generate a safe alphanumeric ID for PeerJS (supports Cyrillic/special chars)
    // Now appends a random suffix to ensure uniqueness even after a quick reload
    private getSafePeerId(channelName: string): string {
        const prefix = 'lingua-franca-v1-';
        // Base64 encode the UTF-8 string and make it URL-safe/PeerJS-safe
        try {
            const base64 = btoa(encodeURIComponent(channelName.toLowerCase()));
            // Remove non-alphanumeric chars that might be in base64
            const safeBase64 = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
            // Append random suffix (e.g. 4 chars) to prevent "ID taken"
            const suffix = Math.random().toString(36).substring(2, 6);
            return `${prefix}${safeBase64}-${suffix}`;
        } catch (e) {
            // Fallback to simple sanitization if btoa fails
            const suffix = Math.random().toString(36).substring(2, 6);
            return `${prefix}${channelName.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}-${suffix}`;
        }
    }

    // INTERPRETER: Start broadcasting on a specific channel name
    async startBroadcast(channelName: string,
        onStatus: (status: string) => void,
        onConnectionsChange: (count: number) => void,
        deviceId?: string
    ) {
        this.onStatusChange = onStatus;
        this.onPeerConnected = onConnectionsChange;
        this.currentLanguageName = channelName;

        try {
            // 1. Get audio stream with low bandwidth constraints
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: deviceId ? { exact: deviceId } : undefined,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                }
            });

            // 2. Initialize Peer with a known ID so listeners can find it
            const peerId = this.getSafePeerId(channelName);
            const peerOptions = this.getPeerOptions();

            this.peer = new Peer(peerId, peerOptions);

            this.peer.on('open', (id) => {
                this.onStatusChange?.(`Broadcasting on ${channelName}`);
                // Notify settings about the active unique ID
                import('./SettingsService').then(({ settingsService }) => {
                    settingsService.updateLanguagePeerId(channelName, id);
                });
            });

            // 3. Answer incoming listener calls with our audio stream
            this.peer.on('call', (call) => {
                call.answer(this.stream!);
                this.connections.set(call.peer, call);
                this.onPeerConnected?.(this.connections.size);

                call.on('close', () => {
                    this.connections.delete(call.peer);
                    this.onPeerConnected?.(this.connections.size);
                });

                call.on('error', () => {
                    this.connections.delete(call.peer);
                    this.onPeerConnected?.(this.connections.size);
                });
            });

            // 4. Handle incoming data connections (for mute status)
            this.peer.on('connection', (conn) => {
                this.dataConnections.set(conn.peer, conn);
                conn.on('open', () => {
                    // Send initial mute status
                    conn.send({ type: 'mute-status', muted: this.isMuted });
                });
                conn.on('close', () => {
                    this.dataConnections.delete(conn.peer);
                });
            });

            this.peer.on('error', (err) => {
                console.error("PeerJS Error:", err);
                this.onStatusChange?.(`Error: ${err.message}`);
            });

        } catch (err) {
            console.error("Failed to start broadcast", err);
            this.onStatusChange?.("Microphone access denied");
            throw err;
        }
    }

    // INTERPRETER: Stop broadcasting
    stopBroadcast() {
        if (this.currentLanguageName) {
            const langName = this.currentLanguageName;
            import('./SettingsService').then(({ settingsService }) => {
                settingsService.updateLanguagePeerId(langName, undefined);
            });
        }
        this.currentLanguageName = null;

        this.connections.forEach(conn => conn.close());
        this.connections.clear();

        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }

        this.onStatusChange?.('Offline');
        this.onPeerConnected?.(0);
    }

    private retryTimer: any = null;

    listenToChannel(targetPeerId: string,
        channelName: string,
        onStatus: (status: string) => void,
        onStreamReceived: (stream: MediaStream) => void,
        onMuteStatusChange?: (muted: boolean) => void
    ) {
        this.stopListening();
        const peerOptions = this.getPeerOptions();
        this.peer = new Peer(peerOptions);

        const tryConnect = () => {
            if (!this.peer || this.peer.destroyed) return;

            onStatus("Connecting to interpreter...");

            // Create a completely silent audio stream context to satisfy PeerJS
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const oscillator = ctx.createOscillator();
            const dst = ctx.createMediaStreamDestination();
            oscillator.connect(dst);
            oscillator.start();

            // Mute the actual track so it sends pure silence
            dst.stream.getAudioTracks().forEach(track => {
                track.enabled = false;
            });

            // Call the interpreter with our silent stream
            const call = this.peer.call(targetPeerId, dst.stream, {
                metadata: { role: 'listener' }
            });

            // Also establish a data connection for metadata (mute status)
            const conn = this.peer.connect(targetPeerId);
            conn.on('data', (data: any) => {
                if (data && data.type === 'mute-status') {
                    onMuteStatusChange?.(data.muted);
                }
            });

            call.on('stream', (remoteStream) => {
                if (this.retryTimer) {
                    clearInterval(this.retryTimer);
                    this.retryTimer = null;
                }
                onStatus("Connected & Receiving");
                onStreamReceived(remoteStream);
            });

            call.on('close', () => {
                onStatus("Interpreter disconnected. Waiting for reconnection...");
                if (!this.retryTimer) {
                    this.retryTimer = setInterval(tryConnect, 3000);
                }
            });

            call.on('error', (err) => {
                console.error("Call error:", err);
                if (!this.retryTimer) {
                    this.retryTimer = setInterval(tryConnect, 3000);
                }
            });
        };

        this.peer.on('open', () => {
            tryConnect();
        });

        this.peer.on('error', (err) => {
            console.error("Listener Peer error:", err);
            if (err.type === 'peer-unavailable') {
                onStatus(`Waiting for interpreter on ${channelName}...`);
                if (!this.retryTimer) {
                    this.retryTimer = setInterval(tryConnect, 3000);
                }
            } else {
                onStatus(`Error: ${err.message}`);
            }
        });
    }

    stopListening() {
        if (this.retryTimer) {
            clearInterval(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }
    }
}

export const voiceService = new VoiceService();
