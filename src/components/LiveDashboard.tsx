import { useEffect, useState } from 'react';
import { Activity, Circle } from 'lucide-react';
import { settingsService, type LiveChannel, type LiveStatus } from '../lib/SettingsService';
import { formatDuration, intlLocale, useTranslation, type TranslationKey } from '../lib/i18n';

const POLL_MS = 3000;
const ROLE_LABEL: Record<NonNullable<LiveChannel['role']>, TranslationKey> = {
    original: 'role_original',
    translation: 'role_translation',
    interpreter: 'role_interpreter',
};

/** What is on air right now, who is listening, what is being recorded, and the AI cost so far. */
export default function LiveDashboard() {
    const { t, locale } = useTranslation();
    const [status, setStatus] = useState<LiveStatus | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        let timer = 0;
        const poll = async (force = false) => {
            window.clearTimeout(timer);
            // A hidden tab has nobody to show it to; skip the request until it is seen again.
            if (force || document.visibilityState === 'visible') {
                try {
                    const next = await settingsService.getLiveStatus();
                    if (!cancelled) { setStatus(next); setFailed(false); }
                } catch {
                    if (!cancelled) setFailed(true);
                }
            }
            if (!cancelled) timer = window.setTimeout(() => void poll(), POLL_MS);
        };
        // Coming back to the tab shows fresh numbers at once rather than up to 3 s later.
        const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };
        void poll(true);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, []);

    const money = (value: number, digits = 2) => new Intl.NumberFormat(intlLocale(locale), {
        style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(value);

    return (
        <div className="card fade-in live-card">
            <div className="card-header">
                <Activity size={20} /><h3>{t('live_title')}</h3>
                {status && <span className="live-total">{t('live_total', { count: status.totalListeners })}</span>}
            </div>
            {!status ? <p className="text-muted">{failed ? t('live_unavailable') : t('loading')}</p> : (
                <>
                    <ul className="live-list">
                        {status.channels.map((channel) => {
                            const onAir = channel.since ? formatDuration((status.now - channel.since) / 1000, locale) : '';
                            return (
                                <li key={channel.id} className={`live-row ${channel.live ? 'on' : ''}`}>
                                    <span className="live-state-dot" aria-hidden="true" />
                                    <div className="live-main">
                                        <strong>{channel.name}</strong>
                                        <span className="text-muted">
                                            {channel.live
                                                ? `${t(ROLE_LABEL[channel.role ?? 'interpreter'])} · ${t('live_on_air', { time: onAir })}`
                                                : t('live_off')}
                                            {channel.live && channel.paused && <span className="live-muted"> · {t('live_muted')}</span>}
                                        </span>
                                    </div>
                                    <div className="live-stats">
                                        {channel.recording && <span className="rec-badge"><Circle size={8} fill="currentColor" /> {t('live_recording')}</span>}
                                        <span className="live-count">{t('live_listeners', { count: channel.listeners })}</span>
                                        <span className="text-muted live-peak">{t('live_peak', { count: channel.peakListeners })}</span>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                    {status.aiSeconds > 0 && (
                        <p className="live-ai">
                            {t('live_ai_usage', { time: formatDuration(status.aiSeconds, locale), cost: money(status.aiSeconds / 60 * status.aiPricePerMinute) })}
                            <small className="text-muted">{t('live_ai_hint', { price: money(status.aiPricePerMinute, 3) })}</small>
                        </p>
                    )}
                </>
            )}
        </div>
    );
}
