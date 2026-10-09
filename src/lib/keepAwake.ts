import NoSleep from 'nosleep.js';

// Keeps a listener's phone screen on, so it does not lock and cut the sound mid-talk.
//
// On HTTPS pages this is the browser's Screen Wake Lock. On the plain listener link (port
// 4175) browsers hide that API, so NoSleep falls back to playing a tiny silent video in a loop,
// which phones treat as "something is playing" and keep the screen on for.

let noSleep: NoSleep | null = null;
let wanted = false;
const usesVideo = () => !('wakeLock' in navigator);

function instance() {
    if (!noSleep) {
        noSleep = new NoSleep();
        // Muted, so on iPhone the silent video can never take the audio session away from
        // the interpretation that is actually playing.
        const video = (noSleep as unknown as { noSleepVideo?: HTMLVideoElement }).noSleepVideo;
        if (video) {
            video.muted = true;
            video.setAttribute('muted', '');
        }
        // The video stops whenever the page is hidden; start it again on return. (The native
        // lock is taken again by NoSleep itself.) A muted video may play without a tap.
        document.addEventListener('visibilitychange', () => {
            if (wanted && usesVideo() && document.visibilityState === 'visible') void noSleep?.enable().catch(() => undefined);
        });
    }
    return noSleep;
}

/** Call from a tap: the first play of the fallback video needs one. */
export function keepAwake() {
    wanted = true;
    try { void instance().enable().catch(() => undefined); }
    catch { /* not supported; the lobby already asks people to keep the screen on */ }
}

export function allowSleep() {
    wanted = false;
    try { noSleep?.disable(); } catch { /* already released */ }
}
