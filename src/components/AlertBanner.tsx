import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { dismissAlert, subscribeAlerts, type OperatorAlert } from '../lib/alerts';
import { useTranslation } from '../lib/i18n';

/** Urgent problems, above every screen, until dismissed. */
export default function AlertBanner() {
    const { t } = useTranslation();
    const [alerts, setAlerts] = useState<OperatorAlert[]>([]);
    useEffect(() => subscribeAlerts(setAlerts), []);
    if (!alerts.length) return null;
    return (
        <div className="alert-stack" role="alert" aria-live="assertive">
            {alerts.map((alert) => (
                <div key={alert.id} className={`alert-banner ${alert.kind}`}>
                    <AlertTriangle size={20} aria-hidden="true" />
                    <p>{alert.message}</p>
                    <button type="button" className="alert-dismiss" onClick={() => dismissAlert(alert.id)} aria-label={t('dismiss')} title={t('dismiss')}>
                        <X size={18} />
                    </button>
                </div>
            ))}
        </div>
    );
}
