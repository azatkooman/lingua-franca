import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, ShieldAlert, ArrowLeft } from 'lucide-react';
import { settingsService } from '../lib/SettingsService';
import { useTranslation } from '../lib/i18n';
import { isPlainListenerLink, secureLocation } from '../lib/navigation';
import '../pages/Admin.css';

export default function AdminGuard({ children }: { children: ReactNode }) {
    const navigate = useNavigate();
    const { t, locale, setLocale } = useTranslation();
    const [isAuthorized, setIsAuthorized] = useState(settingsService.isAdminAuthenticated());
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');
    const [isChecking, setIsChecking] = useState(false);

    // A token can expire while the page is open. Without this the guard kept rendering the
    // admin screen against a dead session, which showed a permanent loading state instead of
    // asking for the PIN again.
    useEffect(() => settingsService.subscribeAuth((authenticated) => {
        setIsAuthorized(authenticated);
        if (!authenticated) setError('');
    }), []);

    // Reached from the plain listener link (for example Home, then Admin): move to HTTPS before
    // a PIN can be typed. The server would refuse it on that port anyway, but only after the
    // PIN had already crossed the Wi-Fi unencrypted.
    const insecure = isPlainListenerLink();
    useEffect(() => { if (insecure) window.location.replace(secureLocation()); }, [insecure]);

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (pin.length < 4 || isChecking) return;
        setIsChecking(true);
        setError('');
        try {
            await settingsService.login(pin);
            setIsAuthorized(true);
        } catch (loginError) {
            // Surface the server's message verbatim: after repeated failures it reports how
            // long the lockout lasts, which a generic "incorrect PIN" would hide.
            setError(loginError instanceof Error ? loginError.message : t('incorrect_pin'));
            setPin('');
        } finally {
            setIsChecking(false);
        }
    };

    if (insecure) return <div className="page-container admin-gate"><p className="text-muted">{t('redirecting_secure')}</p></div>;
    if (isAuthorized) return <>{children}</>;

    return (
        <div className="page-container admin-gate">
            <div className="language-toggle">
                <button className={`lang-btn ${locale === 'en' ? 'active' : ''}`} onClick={() => setLocale('en')}>EN</button>
                <div className="divider"></div>
                <button className={`lang-btn ${locale === 'ru' ? 'active' : ''}`} onClick={() => setLocale('ru')}>RU</button>
            </div>

            <form className="card fade-in" onSubmit={submit} style={{ maxWidth: 450, margin: '20px auto', padding: '3rem' }}>
                <div style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
                    <div className="icon-wrapper" style={{
                        margin: '0 auto 1.5rem',
                        width: 80,
                        height: 80,
                        borderRadius: '50%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: error ? 'rgba(239, 68, 68, 0.1)' : 'rgba(139, 92, 246, 0.1)'
                    }}>
                        {error ? <ShieldAlert size={40} color="#ef4444" /> : <Lock size={40} color="var(--primary)" />}
                    </div>
                    <h2 style={{ fontSize: '1.75rem', marginBottom: '0.5rem' }}>{t('admin_access')}</h2>
                    <p className="text-muted">{t('enter_pin_to_manage')}</p>
                </div>

                {/* A single field rather than four boxes: the PIN may be 4 to 12 digits, and a
                    fixed-width box row silently could not accept a longer one. */}
                <input
                    className={`custom-input ${error ? 'error' : ''}`}
                    type="password"
                    inputMode="numeric"
                    autoComplete="current-password"
                    autoFocus
                    maxLength={12}
                    aria-label={t('pin_placeholder')}
                    style={{ textAlign: 'center', letterSpacing: '0.5em', fontSize: '1.5rem' }}
                    value={pin}
                    disabled={isChecking}
                    onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 12))}
                />

                <button className="btn-primary mt-4" type="submit" disabled={pin.length < 4 || isChecking} style={{ width: '100%' }}>
                    {isChecking ? t('checking') : t('enter_pin')}
                </button>

                {error && (
                    <p style={{ color: '#ef4444', textAlign: 'center', marginTop: '1rem', fontSize: '0.9rem', fontWeight: 500 }}>
                        {error}
                    </p>
                )}

                {/* The old exit was a small dark icon floating above the card, easy to miss, and
                    the desktop app has no browser Back button. */}
                <button className="btn-secondary mt-4" type="button" onClick={() => navigate('/')} style={{ width: '100%' }}>
                    <ArrowLeft size={18} /> {t('back_home')}
                </button>
            </form>
        </div>
    );
}
