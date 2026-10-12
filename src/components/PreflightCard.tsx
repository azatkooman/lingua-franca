import { useEffect, useState } from 'react';
import { CheckCircle2, ClipboardCheck, Play, Square, XCircle, AlertTriangle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { settingsService, type AdminSettings, type PreflightCheck } from '../lib/SettingsService';
import { useTranslation, type TranslationKey } from '../lib/i18n';
import { fetchAdminHealth, listenerUrl, readPhoneLink, type HealthInfo } from '../lib/listenerLinks';
import { startTestTone, stopTestTone, subscribeTestTone } from '../lib/testTone';

const LABEL: Record<PreflightCheck['id'], TranslationKey> = {
    media: 'pf_media',
    listener_port: 'pf_listener_port',
    network: 'pf_network',
    certificate: 'pf_certificate',
    microphone: 'pf_microphone',
    secure_storage: 'pf_secure_storage',
    disk: 'pf_disk',
    openai: 'pf_openai',
};

// What to do about a check that did not pass. Absent for a pass.
const ADVICE: Partial<Record<`${PreflightCheck['id']}_${'warn' | 'fail'}`, TranslationKey>> = {
    media_warn: 'pf_media_warn',
    media_fail: 'pf_media_fail',
    listener_port_warn: 'pf_listener_port_warn',
    network_warn: 'pf_network_warn',
    network_fail: 'pf_network_fail',
    certificate_warn: 'pf_certificate_warn',
    microphone_warn: 'pf_microphone_warn',
    microphone_fail: 'pf_microphone_fail',
    secure_storage_warn: 'pf_secure_storage_warn',
    disk_warn: 'pf_disk_warn',
    disk_fail: 'pf_disk_fail',
    openai_warn: 'pf_openai_warn',
    openai_fail: 'pf_openai_fail',
};

const ICON = { ok: CheckCircle2, warn: AlertTriangle, fail: XCircle };

/**
 * The pre-service check: everything this computer can test about itself in one list, and a
 * test tone for what only a phone can prove (that phones in the room can reach it and hear).
 */
export default function PreflightCard({ settings }: { settings: AdminSettings }) {
    const { t } = useTranslation();
    const [checks, setChecks] = useState<PreflightCheck[] | null>(null);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState('');
    const [health, setHealth] = useState<HealthInfo | null>(null);
    const [chosenChannel, setChosenChannel] = useState('');
    const [toneOn, setToneOn] = useState<string | null>(null);

    useEffect(() => subscribeTestTone(setToneOn), []);
    // Leaving Admin ends the tone: it must never run on into the service.
    useEffect(() => () => stopTestTone(), []);
    useEffect(() => { void fetchAdminHealth(settingsService.getAdminToken()).then(setHealth); }, []);

    // Never a channel that is really on air: an operator broadcast would take it over.
    const offAir = settings.languages.filter((language) => !language.activePeerId || language.id === toneOn);
    const toneChannel = toneOn ?? (offAir.some((language) => language.id === chosenChannel) ? chosenChannel : offAir[0]?.id ?? '');
    const toneUrl = toneOn ? listenerUrl(health, readPhoneLink(), toneOn) : '';

    const runChecks = async () => {
        setRunning(true); setError('');
        try { setChecks((await settingsService.runPreflight()).checks); }
        catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
        finally { setRunning(false); }
    };

    const toggleTone = async () => {
        setError('');
        if (toneOn) { stopTestTone(); return; }
        try { await startTestTone(toneChannel); }
        catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    };

    const detail = (check: PreflightCheck) => {
        if (check.id === 'disk' && /^\d+$/.test(check.detail)) return t('pf_disk_free', { size: (Number(check.detail) / 1024 ** 3).toFixed(1) });
        if (check.id === 'openai' && check.detail === 'not_configured') return '';
        return check.detail;
    };

    return (
        <div className="card fade-in">
            <div className="card-header"><ClipboardCheck size={20} /><h3>{t('preflight_title')}</h3></div>
            <p className="text-muted">{t('preflight_hint')}</p>
            <button type="button" className="btn-primary" disabled={running} onClick={() => void runChecks()}>
                <ClipboardCheck size={18} /> {running ? t('checking') : t('preflight_run')}
            </button>
            {checks && (
                <ul className="preflight-list">
                    {checks.map((check) => {
                        const Icon = ICON[check.status];
                        const advice = check.status === 'ok' ? undefined : ADVICE[`${check.id}_${check.status}`];
                        const extra = detail(check);
                        return (
                            <li key={check.id} className={`preflight-item ${check.status}`}>
                                <Icon size={18} className="preflight-icon" aria-label={t(`pf_status_${check.status}` as TranslationKey)} />
                                <div>
                                    <strong>{t(LABEL[check.id])}</strong>
                                    {advice && <span> — {t(advice)}</span>}
                                    {extra && <small>{extra}</small>}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            <div className="test-tone">
                <strong>{t('test_tone_title')}</strong>
                <p className="text-muted">{t('test_tone_hint')}</p>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                    <select className="custom-select" style={{ flex: 1, minWidth: 160 }} value={toneChannel} disabled={Boolean(toneOn)}
                        onChange={(event) => setChosenChannel(event.target.value)}>
                        {offAir.map((language) => <option key={language.id} value={language.id}>{language.name}</option>)}
                    </select>
                    <button type="button" className={toneOn ? 'btn-danger' : 'btn-secondary'} disabled={!toneChannel} onClick={() => void toggleTone()}>
                        {toneOn ? <><Square size={18} /> {t('test_tone_stop')}</> : <><Play size={18} /> {t('test_tone_start')}</>}
                    </button>
                </div>
                {!offAir.length && <p className="text-muted">{t('test_tone_all_live')}</p>}
                {toneOn && toneUrl && (
                    <div className="qr-container mt-4">
                        <div className="qr-box"><QRCodeSVG value={toneUrl} size={180} level="M" /></div>
                        <p className="text-muted">{t('test_tone_scan')}</p>
                        <p className="text-muted"><code>{toneUrl}</code></p>
                    </div>
                )}
            </div>
            {error && <p className="text-danger">{error}</p>}
        </div>
    );
}
