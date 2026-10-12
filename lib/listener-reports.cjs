// "I can't hear" reports from listener phones, counted per channel over a short window so the
// operator sees how many phones have a problem right now. Pure, so it is unit tested.

const WINDOW_MS = 2 * 60 * 1000;
// One report per phone per minute: a frustrated listener tapping repeatedly is one problem.
const REPEAT_MS = 60 * 1000;

class ListenerReports {
    constructor({ windowMs = WINDOW_MS, repeatMs = REPEAT_MS, now = Date.now } = {}) {
        this.windowMs = windowMs;
        this.repeatMs = repeatMs;
        this.now = now;
        // channelId -> Map(reporterId -> time of its latest report)
        this.channels = new Map();
    }

    /** Records a report. Returns whether it counted and the channel's count afterwards. */
    record(channelId, reporterId) {
        const id = String(channelId || '');
        if (!id || !reporterId) return { accepted: false, count: 0 };
        const reporters = this.channels.get(id) || new Map();
        const previous = reporters.get(reporterId);
        if (previous !== undefined && this.now() - previous < this.repeatMs) return { accepted: false, count: this.count(id) };
        reporters.set(reporterId, this.now());
        this.channels.set(id, reporters);
        return { accepted: true, count: this.count(id) };
    }

    /** Phones that reported on this channel within the window. */
    count(channelId) {
        const reporters = this.channels.get(channelId);
        if (!reporters) return 0;
        const cutoff = this.now() - this.windowMs;
        let count = 0;
        for (const at of reporters.values()) if (at > cutoff) count += 1;
        return count;
    }

    /** A phone that left stops counting at once. */
    forget(reporterId) {
        for (const reporters of this.channels.values()) reporters.delete(reporterId);
    }

    clear() { this.channels.clear(); }

    prune() {
        const cutoff = this.now() - this.windowMs;
        for (const [channelId, reporters] of this.channels) {
            for (const [reporterId, at] of reporters) if (at <= cutoff) reporters.delete(reporterId);
            if (!reporters.size) this.channels.delete(channelId);
        }
    }
}

module.exports = { ListenerReports, REPEAT_MS, WINDOW_MS };
