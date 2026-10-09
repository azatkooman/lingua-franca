import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, Headphones, Settings } from 'lucide-react';
import { formatEventDates, useTranslation } from '../lib/i18n';
import { settingsService, type EventInfo } from '../lib/SettingsService';
import LogoMark from '../components/LogoMark';
import './Home.css';

export default function Home() {
    const navigate = useNavigate();
    const { t, locale } = useTranslation();
    const [event, setEvent] = useState<EventInfo | undefined>(settingsService.getSettings().event);

    useEffect(() => settingsService.subscribe((settings) => setEvent(settings.event)), []);

    const dates = event ? formatEventDates(event.startDate, event.endDate, locale) : '';

    return (
        <div className="home-container">
            <main className="hero fade-in">
                <LogoMark className="hero-mark" />
                <h1 className="title">{t('welcome_title')}</h1>
                <p className="subtitle">{t('welcome_subtitle')}</p>

                {event?.name && (
                    <div className="home-event">
                        <strong>{event.name}</strong>
                        {dates && <span>{dates}</span>}
                    </div>
                )}

                <div className="action-grid">
                    <button type="button" className="mode-card listener" onClick={() => navigate('/listener')}>
                        <div className="icon-circle">
                            <Headphones size={40} />
                        </div>
                        <h3>{t('be_listener')}</h3>
                    </button>

                    <button type="button" className="mode-card interpreter" onClick={() => navigate('/interpreter')}>
                        <div className="icon-circle">
                            <Mic size={40} />
                        </div>
                        <h3>{t('be_interpreter')}</h3>
                    </button>
                </div>

                <div className="qr-hint">
                    <p>{t('scan_to_join')}</p>
                </div>
            </main>

            <div className="admin-footer">
                <button className="btn-icon-text" onClick={() => navigate('/admin')}>
                    <Settings size={18} />
                    <span>{t('admin_title')}</span>
                </button>
            </div>
        </div>
    );
}
