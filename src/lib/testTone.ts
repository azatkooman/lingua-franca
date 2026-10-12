import { voiceService } from './VoiceService';

/**
 * A test tone on a channel, for the pre-service check: a short beep every second, broadcast
 * like an interpreter. A phone that scans the channel's QR and hears it has proved the whole
 * path at once: the Wi-Fi, the firewall (TCP and UDP), the media engine and its own speaker.
 *
 * The server never records it, and it stops by itself after a few minutes so a forgotten
 * tone cannot run into the service.
 */
const AUTO_STOP_MS = 3 * 60 * 1000;
const BEEP_HZ = 880;
const BEEP_SECONDS = 0.25;
const BEEP_LEVEL = 0.25;

interface RunningTone {
    channelId: string;
    stop: () => void;
}

let running: RunningTone | null = null;
const listeners = new Set<(channelId: string | null) => void>();
const publish = () => listeners.forEach((listener) => listener(running?.channelId ?? null));

export function subscribeTestTone(listener: (channelId: string | null) => void) {
    listeners.add(listener);
    listener(running?.channelId ?? null);
    return () => { listeners.delete(listener); };
}

/** Starts the tone on `channelId` (stopping any other). Call from a tap: it needs audio. */
export async function startTestTone(channelId: string) {
    stopTestTone();
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    oscillator.frequency.value = BEEP_HZ;
    const gate = context.createGain();
    gate.gain.value = 0;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gate).connect(destination);
    oscillator.start();
    // Beeps are scheduled a few seconds ahead on the audio clock, which stays exact even when
    // this timer runs late.
    let scheduledUntil = context.currentTime;
    const schedule = () => {
        while (scheduledUntil < context.currentTime + 4) {
            const start = Math.max(scheduledUntil, context.currentTime + 0.05);
            gate.gain.setValueAtTime(BEEP_LEVEL, start);
            gate.gain.setValueAtTime(0, start + BEEP_SECONDS);
            scheduledUntil = start + 1;
        }
    };
    schedule();
    const scheduler = window.setInterval(schedule, 1000);
    const [track] = destination.stream.getAudioTracks();

    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        window.clearInterval(scheduler);
        window.clearTimeout(autoStop);
        voiceService.stopChannel(channelId);
        try { oscillator.stop(); } catch { /* already stopped */ }
        track.stop();
        void context.close().catch(() => undefined);
        if (running?.stop === stop) { running = null; publish(); }
    };
    const autoStop = window.setTimeout(stop, AUTO_STOP_MS);
    running = { channelId, stop };
    publish();
    try {
        await voiceService.publishTrack(channelId, track, 'human', () => undefined, () => undefined, 'test');
    } catch (error) {
        stop();
        throw error;
    }
}

export function stopTestTone() {
    running?.stop();
}
