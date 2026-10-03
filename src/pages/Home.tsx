import { useNavigate } from 'react-router-dom';
import { Mic, Headphones, Settings } from 'lucide-react';
import { useTranslation } from '../lib/i18n';
import LogoMark from '../components/LogoMark';
import './Home.css';

export default function Home() {
    const navigate = useNavigate();
    const { t, locale, setLocale } = useTranslation();

    return (
        <div className="home-container">
            <div className="language-toggle">
                <button
                    className={`lang-btn ${locale === 'en' ? 'active' : ''}`}
                    onClick={() => setLocale('en')}
                >
                    EN
                </button>
                <div className="divider"></div>
                <button
                    className={`lang-btn ${locale === 'ru' ? 'active' : ''}`}
                    onClick={() => setLocale('ru')}
                >
                    RU
                </button>
            </div>

            <main className="hero fade-in">
                <LogoMark className="hero-mark" />
                <h1 className="title">{t('welcome_title')}</h1>
                <p className="subtitle">{t('welcome_subtitle')}</p>

                <div className="action-grid">
                    <div className="mode-card interpreter" onClick={() => navigate('/interpreter')}>
                        <div className="icon-circle">
                            <Mic size={40} />
                        </div>
                        <h3>{t('be_interpreter')}</h3>
                    </div>

                    <div className="mode-card listener" onClick={() => navigate('/listener')}>
                        <div className="icon-circle">
                            <Headphones size={40} />
                        </div>
                        <h3>{t('be_listener')}</h3>
                    </div>
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
