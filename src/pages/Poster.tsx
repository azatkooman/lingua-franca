import { useEffect, useState } from 'react';
import { ArrowLeft, FileDown, Printer } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { settingsService, type AdminSettings } from '../lib/SettingsService';
import { LOCALES, formatEventDates, translateFor, useTranslation, type Locale } from '../lib/i18n';
import { fetchAdminHealth, listenerUrl, readPhoneLink, type HealthInfo } from '../lib/listenerLinks';
import { useGoBack } from '../lib/navigation';
import { desktopBridge } from '../lib/desktop';
import './Poster.css';

const WIFI_KEY = 'lingua_franca_poster_wifi';
interface WifiDetails { name: string; password: string }

// The Wi-Fi details are only for the printout, so they stay on this device and never reach
// the server.
function readWifi(): WifiDetails {
    try {
        const saved = JSON.parse(localStorage.getItem(WIFI_KEY) || '{}') as Partial<WifiDetails>;
        return { name: String(saved.name || ''), password: String(saved.password || '') };
    } catch { return { name: '', password: '' }; }
}

function saveWifi(value: WifiDetails) {
    try { localStorage.setItem(WIFI_KEY, JSON.stringify(value)); } catch { /* optional */ }
}

// The Wi-Fi QR format phone cameras understand: scanning it offers to join the network.
const escapeWifi = (value: string) => value.replace(/([\\;,:"])/g, '\\$1');
const wifiPayload = ({ name, password }: WifiDetails) => password
    ? `WIFI:T:WPA;S:${escapeWifi(name)};P:${escapeWifi(password)};;`
    : `WIFI:T:nopass;S:${escapeWifi(name)};;`;

const asLocale = (code: string) => LOCALES.find((option) => option.code === code.toLowerCase())?.code ?? null;

/** A printable page: event, how to join the Wi-Fi, and a QR code for every language. */
export default function Poster() {
    const goBack = useGoBack();
    const { t, locale } = useTranslation();
    const [settings, setSettings] = useState<AdminSettings | null>(settingsService.getAdminSettings());
    const [health, setHealth] = useState<HealthInfo | null>(null);
    const [wifi, setWifi] = useState<WifiDetails>(readWifi);
    const [hidden, setHidden] = useState<Set<string>>(() => new Set());
    const [phoneLink] = useState(readPhoneLink);
    const [pdfMessage, setPdfMessage] = useState('');
    const [savingPdf, setSavingPdf] = useState(false);
    const eventName = settings?.event?.name || '';
    // The page title is the file name a browser suggests for "Save as PDF".
    const fileName = `${t('poster_title')} - ${eventName || 'Lingua Franca'}`;

    useEffect(() => {
        const previous = document.title;
        document.title = fileName;
        return () => { document.title = previous; };
    }, [fileName]);

    useEffect(() => settingsService.subscribeAdmin(setSettings), []);
    useEffect(() => { void fetchAdminHealth(settingsService.getAdminToken()).then(setHealth); }, []);

    const updateWifi = (next: WifiDetails) => { setWifi(next); saveWifi(next); };

    const savePdf = async () => {
        if (!desktopBridge) return;
        setSavingPdf(true); setPdfMessage('');
        try {
            const result = await desktopBridge.savePageAsPdf(fileName);
            if (result.saved) setPdfMessage(t('poster_pdf_saved', { path: result.saved }));
            else if (result.error) setPdfMessage(result.error);
        } finally { setSavingPdf(false); }
    };

    if (!settings) return <div className="page-container">{t('loading')}</div>;

    const channels = settings.languages.filter((language) => !hidden.has(language.id));
    // The heading in every language on the poster, so each group sees its own.
    const posterLocales = [...new Set<Locale>([locale, ...channels.map((language) => asLocale(language.code)).filter((code): code is Locale => code !== null)])];
    const heading = posterLocales.map((code) => translateFor(code, 'poster_heading')).join(' · ');
    const event = settings.event;
    const dates = event ? formatEventDates(event.startDate, event.endDate, locale) : '';
    const wifiName = wifi.name.trim();
    // Fewer languages leave room for bigger codes, which scan from further away.
    const qrSize = channels.length <= 2 ? 230 : 170;

    return (
        <div className="page-container poster-page">
            <header className="page-header poster-controls">
                <button className="btn-icon" onClick={goBack} title={t('back')} aria-label={t('back')}><ArrowLeft size={24} /></button>
                <h2>{t('poster_title')}</h2>
                <div style={{ width: 24 }} />
            </header>

            <div className="card poster-controls">
                <p className="text-muted card-hint">{t('poster_hint')}</p>
                <div className="form-row">
                    <div>
                        <label>{t('poster_wifi_name')}</label>
                        <input className="custom-input" maxLength={32} value={wifi.name} onChange={(change) => updateWifi({ ...wifi, name: change.target.value })} />
                    </div>
                    <div>
                        <label>{t('poster_wifi_password')}</label>
                        <input className="custom-input" maxLength={63} value={wifi.password} onChange={(change) => updateWifi({ ...wifi, password: change.target.value })} />
                    </div>
                </div>
                <p className="text-muted checkbox-hint">{t('poster_wifi_hint')}</p>
                <p className="poster-channels-label">{t('poster_channels')}</p>
                <div className="poster-channel-picks">
                    {settings.languages.map((language) => (
                        <label key={language.id} className="checkbox-row">
                            <input type="checkbox" checked={!hidden.has(language.id)} onChange={() => setHidden((current) => {
                                const next = new Set(current);
                                if (next.has(language.id)) next.delete(language.id); else next.add(language.id);
                                return next;
                            })} />
                            <span>{language.name}</span>
                        </label>
                    ))}
                </div>
                {!health && <p className="text-danger">{t('network_not_ready')}</p>}
                <div className="poster-actions mt-4">
                    {desktopBridge && (
                        <button className="btn-primary" disabled={!health || !channels.length || savingPdf} onClick={() => void savePdf()}>
                            <FileDown size={18} /> {t('poster_save_pdf')}
                        </button>
                    )}
                    <button className={desktopBridge ? 'btn-secondary' : 'btn-primary'} disabled={!health || !channels.length} onClick={() => window.print()}>
                        <Printer size={18} /> {t('poster_print')}
                    </button>
                </div>
                {pdfMessage && <p className="poster-pdf-message">{pdfMessage}</p>}
                {!desktopBridge && <p className="text-muted checkbox-hint">{t('poster_print_hint')}</p>}
            </div>

            <article className="poster-sheet" lang={locale}>
                <header className="poster-top">
                    <h1>{event?.name || heading}</h1>
                    {event?.name && <p className="poster-heading">{heading}</p>}
                    {dates && <p className="poster-dates">{dates}</p>}
                </header>

                {wifiName && (
                    <section className="poster-wifi">
                        <QRCodeSVG value={wifiPayload({ name: wifiName, password: wifi.password })} size={120} level="M" />
                        <div>
                            <h2>{t('poster_step_wifi')}</h2>
                            <p>{t('poster_network', { name: wifiName })}</p>
                            {wifi.password && <p>{t('poster_password', { password: wifi.password })}</p>}
                        </div>
                    </section>
                )}

                {wifiName && <h2 className="poster-step">{t('poster_step_listen')}</h2>}
                <div className={`poster-grid count-${Math.min(channels.length, 4)}`}>
                    {channels.map((language) => {
                        const url = listenerUrl(health, phoneLink, language.id);
                        return (
                            <div key={language.id} className="poster-channel" lang={asLocale(language.code) ?? undefined}>
                                <h3>{language.name}</h3>
                                {url && <QRCodeSVG value={url} size={qrSize} level="M" />}
                                <p className="poster-scan">{translateFor(asLocale(language.code) ?? locale, 'poster_scan')}</p>
                                <p className="poster-url">{url}</p>
                            </div>
                        );
                    })}
                </div>

                <footer className="poster-foot">{t('poster_headphones')}</footer>
            </article>
        </div>
    );
}
