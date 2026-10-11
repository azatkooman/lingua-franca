// Plays a received WebRTC stream through Web Audio, with a real volume control and a boost.
//
// Why: on Android, sound from a media element playing WebRTC audio goes through the phone's call
// path. It is quieter, the element's volume cannot go above 100%, and the page's volume slider
// did little. Here the audible sound comes from Web Audio instead, through a gain stage (up to
// 200%, with a limiter so loud parts do not distort).
//
// Chrome only decodes a received WebRTC track while a media element is playing received audio,
// so a muted element still plays the stream; it makes no sound and only keeps the decoding going.
// (Measured: with no element playing, Web Audio and MediaStreamTrackProcessor both get silence.)

export type PlaybackPath = 'direct' | 'element';

/**
 * Which way this device plays the stream: Web Audio on Android, the plain media element
 * elsewhere (it works well there, and iPhones only honour their hardware volume buttons anyway).
 * `?playback=direct` or `?playback=element` overrides it, to compare on a phone.
 */
export function choosePlaybackPath(): PlaybackPath {
    const forced = new URLSearchParams(window.location.search).get('playback');
    const supported = 'AudioContext' in window;
    if (forced === 'element') return 'element';
    if (forced === 'direct') return supported ? 'direct' : 'element';
    return supported && /Android/i.test(navigator.userAgent) ? 'direct' : 'element';
}

export interface DirectPlayback {
    /** 0 = silent, 1 = as received, up to 2 = louder. */
    setGain(gain: number): void;
    stop(): void;
}

/**
 * Starts playing `stream` on `context` (created and resumed during the listener's tap), using
 * `element` muted to keep Chrome decoding it. Rejects if the element cannot start; the caller
 * then falls back to normal element playback.
 */
export async function startDirectPlayback(
    context: AudioContext,
    element: HTMLAudioElement,
    stream: MediaStream,
    { gain = 1, onLevel }: { gain?: number; onLevel?: (level: number) => void } = {},
): Promise<DirectPlayback> {
    element.muted = true;
    element.srcObject = stream;
    await element.play();
    // Not awaited: without a tap the browser keeps resume() pending. The page shows its
    // "sound is blocked, tap here" button then, and that tap resumes the context.
    if (context.state !== 'running') void context.resume().catch(() => undefined);

    const source = context.createMediaStreamSource(stream);
    const volume = context.createGain();
    volume.gain.value = gain;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.15;
    source.connect(volume).connect(limiter).connect(context.destination);

    // Level meter from the received signal (before the volume), on a timer rather than
    // animation frames, which stop when the screen is off.
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const meter = onLevel ? window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        onLevel(Math.min(100, Math.sqrt(sum / samples.length) * 400));
    }, 100) : 0;

    let stopped = false;
    return {
        setGain(next) {
            volume.gain.setTargetAtTime(Math.max(0, Math.min(2, next)), context.currentTime, 0.02);
        },
        stop() {
            if (stopped) return;
            stopped = true;
            window.clearInterval(meter);
            source.disconnect();
            volume.disconnect();
            limiter.disconnect();
            analyser.disconnect();
            onLevel?.(0);
        },
    };
}
