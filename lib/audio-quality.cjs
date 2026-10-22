// How well audio is arriving, for the operator's dashboard: what share of the sound each
// listener phone had to fill in because data was lost on the Wi-Fi, and how the internet link
// between this computer and OpenAI is doing for each AI channel. When someone hears the sound
// break up, this says which of the two to look at. Pure, so it is unit tested.

// A phone or link that has not reported for this long is no longer counted.
const STALE_MS = 30 * 1000;
// Phones report every ten seconds; anything much faster is ignored.
const MIN_INTERVAL_MS = 4000;
// Above this share of lost sound, a phone counts as having poor reception. A few percent is
// already audible as small gaps or a robotic edge.
const POOR_LOSS = 0.05;

/** A share between 0 and 1, or null for anything unusable. */
const share = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.min(1, number) : null;
};
const round = (value) => Math.round(value * 10_000) / 10_000;

class AudioQuality {
    constructor({ staleMs = STALE_MS, minIntervalMs = MIN_INTERVAL_MS, now = Date.now } = {}) {
        this.staleMs = staleMs;
        this.minIntervalMs = minIntervalMs;
        this.now = now;
        // phoneId -> { channelId, loss, at }
        this.phones = new Map();
        // channelId -> { received, sent, at }
        this.links = new Map();
    }

    /** A listener phone's share of sound lost since its last report. Returns whether it counted. */
    reportPhone(phoneId, channelId, loss) {
        const value = share(loss);
        if (!phoneId || !channelId || value === null) return false;
        const previous = this.phones.get(phoneId);
        if (previous && previous.channelId === channelId && this.now() - previous.at < this.minIntervalMs) return false;
        this.phones.set(phoneId, { channelId, loss: value, at: this.now() });
        return true;
    }

    /** The AI link for a channel: sound lost coming back from OpenAI, and going to it. */
    reportLink(channelId, { received, sent } = {}) {
        const inbound = share(received);
        const outbound = share(sent);
        if (!channelId || (inbound === null && outbound === null)) return false;
        this.links.set(channelId, { received: inbound ?? 0, sent: outbound ?? 0, at: this.now() });
        return true;
    }

    /** A phone that stopped listening or left. */
    forgetPhone(phoneId) { this.phones.delete(phoneId); }

    /** A broadcast that ended has no AI link any more. */
    forgetLink(channelId) { this.links.delete(channelId); }

    /** What the dashboard shows for one channel. */
    summary(channelId) {
        const cutoff = this.now() - this.staleMs;
        let phones = 0;
        let total = 0;
        let poor = 0;
        for (const entry of this.phones.values()) {
            if (entry.channelId !== channelId || entry.at <= cutoff) continue;
            phones += 1;
            total += entry.loss;
            if (entry.loss >= POOR_LOSS) poor += 1;
        }
        const link = this.links.get(channelId);
        return {
            phones,
            loss: phones ? round(total / phones) : 0,
            poor,
            link: link && link.at > cutoff ? { received: round(link.received), sent: round(link.sent) } : null,
        };
    }

    prune() {
        const cutoff = this.now() - this.staleMs;
        for (const [id, entry] of this.phones) if (entry.at <= cutoff) this.phones.delete(id);
        for (const [id, entry] of this.links) if (entry.at <= cutoff) this.links.delete(id);
    }
}

module.exports = { AudioQuality, MIN_INTERVAL_MS, POOR_LOSS, STALE_MS };
