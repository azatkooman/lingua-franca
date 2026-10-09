import { io, type Socket } from 'socket.io-client';

// Generous enough for a slow phone on congested Wi-Fi, short enough that a dead link
// surfaces as an error rather than an indefinite spinner.
const REQUEST_TIMEOUT_MS = 15_000;

type Handler = (payload: never) => void;
type InternalHandler = (payload: unknown) => void;

/**
 * One Socket.IO connection shared by the whole page.
 *
 * The API and the socket are served by the same origin as the app in every mode -- packaged
 * (4173 for phones, 4174 for the Electron window) and development (proxied by Vite) -- so the
 * connection is always same-origin and needs no host or port guessing.
 *
 * Handlers are registered here rather than on the raw socket so they survive the reconnects
 * that happen on a token change or a dropped Wi-Fi link.
 */
class RealtimeSocket {
    private socket: Socket | null = null;
    private token = '';
    private handlers = new Map<string, Set<InternalHandler>>();
    // Callers waiting for a connection. They carry over when the socket is replaced.
    private waiters: { resolve: (socket: Socket) => void; reject: (error: Error) => void }[] = [];

    setAuthToken(token: string) {
        if (token === this.token) return;
        this.token = token;
        if (!this.socket) return;
        // Reconnect so the server re-reads the handshake with the new credentials.
        this.socket.disconnect();
        this.socket = null;
        this.open();
    }

    private open() {
        const socket = io({
            transports: ['websocket'],
            auth: { token: this.token },
            reconnection: true,
            reconnectionDelay: 500,
            reconnectionDelayMax: 5000,
        });
        this.socket = socket;
        for (const [event, handlers] of this.handlers) {
            for (const handler of handlers) socket.on(event, handler);
        }
        socket.on('connect', () => {
            if (this.socket !== socket) return;
            for (const waiter of this.waiters.splice(0)) waiter.resolve(socket);
        });
        // The socket keeps retrying on its own; waiting callers get the error now, and the next
        // connect() waits for this same socket rather than opening another.
        socket.on('connect_error', (error) => {
            if (this.socket !== socket) return;
            const failure = error instanceof Error ? error : new Error(String(error));
            for (const waiter of this.waiters.splice(0)) waiter.reject(failure);
        });
    }

    on<T>(event: string, handler: (payload: T) => void): () => void {
        const internal = handler as InternalHandler;
        const existing = this.handlers.get(event) || new Set<InternalHandler>();
        existing.add(internal);
        this.handlers.set(event, existing);
        this.socket?.on(event, internal);
        return () => {
            this.handlers.get(event)?.delete(internal);
            this.socket?.off(event, internal);
        };
    }

    connect(): Promise<Socket> {
        if (this.socket?.connected) return Promise.resolve(this.socket);
        if (!this.socket) this.open();
        return new Promise<Socket>((resolve, reject) => { this.waiters.push({ resolve, reject }); });
    }

    emit(event: string, ...args: unknown[]) {
        this.socket?.emit(event, ...args);
    }

    /**
     * Promise-wrapped emit for the SFU signalling calls.
     *
     * Resolves with an `{ error }` payload rather than hanging if the server never
     * acknowledges -- a link that drops mid-handshake would otherwise leave a listener stuck
     * on "Connecting…" with no way back.
     */
    request<T>(event: string, payload?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
        return this.connect().then((socket) => new Promise<T>((resolve) => {
            // Preserve arity: handlers for payload-less events expect the ack as the first argument.
            const args = payload === undefined ? [] : [payload];
            socket.timeout(timeoutMs).emit(event, ...args, (timedOut: Error | null, response: T) => {
                resolve(timedOut ? ({ error: `The server did not respond to ${event}.` } as T) : response);
            });
        }));
    }

    get connected() {
        return Boolean(this.socket?.connected);
    }

    disconnect() {
        this.socket?.disconnect();
        this.socket = null;
        for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Disconnected.'));
    }
}

export type { Handler };
export const realtimeSocket = new RealtimeSocket();
