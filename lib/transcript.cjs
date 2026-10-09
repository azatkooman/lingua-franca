// Recent captions per channel. A phone that opens the link mid-talk, or reconnects after a
// Wi-Fi drop, gets what was just said instead of an empty box. Pure, so it is unit tested.

const MAX_SEGMENTS = 40;
const MAX_TEXT = 2000;

const clip = (value) => String(value ?? '').slice(0, MAX_TEXT);

class TranscriptStore {
    constructor({ maxSegments = MAX_SEGMENTS, now = Date.now } = {}) {
        this.maxSegments = maxSegments;
        this.now = now;
        this.channels = new Map();
    }

    /**
     * Adds or updates one caption segment. The broadcaster sends the same segment id
     * repeatedly while a sentence grows, then once more with `final` set, so an update
     * replaces the text in place rather than appending a near-duplicate.
     */
    update(channelId, { segmentId, text, originalText, final } = {}) {
        const id = String(segmentId ?? '').slice(0, 64);
        if (!channelId || !id) return null;
        const segments = this.channels.get(channelId) || [];
        const segment = { id, text: clip(text), originalText: clip(originalText), final: Boolean(final), at: this.now() };
        const index = segments.findIndex((entry) => entry.id === id);
        if (index >= 0) segments[index] = segment;
        else {
            segments.push(segment);
            if (segments.length > this.maxSegments) segments.splice(0, segments.length - this.maxSegments);
        }
        this.channels.set(channelId, segments);
        return { ...segment };
    }

    recent(channelId) {
        return (this.channels.get(channelId) || []).map((segment) => ({ ...segment }));
    }

    clear(channelId) {
        this.channels.delete(channelId);
    }

    /** Drops history for channels that no longer exist. */
    retain(channelIds) {
        for (const channelId of [...this.channels.keys()]) if (!channelIds.has(channelId)) this.channels.delete(channelId);
    }
}

module.exports = { MAX_SEGMENTS, MAX_TEXT, TranscriptStore };
