import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, ShieldAlert, ArrowLeft } from 'lucide-react';
import { settingsService } from '../lib/SettingsService';
import { useTranslation } from '../lib/i18n';
import '../pages/Admin.css';

interface AdminGuardProps {
    children: React.ReactNode;
}

export default function AdminGuard({ children }: AdminGuardProps) {
    const navigate = useNavigate();
    const { t, locale, setLocale } = useTranslation();
    const [isAuthorized, setIsAuthorized] = useState(false);
    const [pinDigits, setPinDigits] = useState(['', '', '', '']);
    const [error, setError] = useState(false);

    const handleDigitChange = (index: number, value: string) => {
        if (!/^\d*$/.test(value)) return;

        const newDigits = [...pinDigits];
        newDigits[index] = value.slice(-1); // Only take last digit
        setPinDigits(newDigits);

        // Auto focus next input
        if (value && index < 3) {
            const nextInput = document.getElementById(`pin-${index + 1}`);
            nextInput?.focus();
        }

        // Auto submit if all filled
        if (newDigits.every(d => d !== '')) {
            verifyPin(newDigits.join(''));
        }
    };

    const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
        if (e.key === 'Backspace' && !pinDigits[index] && index > 0) {
            const prevInput = document.getElementById(`pin-${index - 1}`);
            prevInput?.focus();
        }
    };

    const verifyPin = (submittedPin: string) => {
        const correctPin = settingsService.getAdminPin();
        if (submittedPin === correctPin) {
            setIsAuthorized(true);
            setError(false);
        } else {
            setError(true);
            setPinDigits(['', '', '', '']);
            const firstInput = document.getElementById('pin-0');
            firstInput?.focus();
        }
    };

    if (isAuthorized) {
        return <>{children}</>;
    }

    return (
        <div className="page-container admin-gate">
            <button
                className="btn-icon"
                onClick={() => navigate('/')}
                style={{ position: 'fixed', top: '1.5rem', left: '1.5rem', zIndex: 1000 }}
                title={t('back')}
            >
                <ArrowLeft size={24} />
            </button>

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

            <div className="card fade-in" style={{ maxWidth: 450, margin: '20px auto', padding: '3rem' }}>
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

                <div className="pin-digit-container">
                    {pinDigits.map((digit, idx) => (
                        <input
                            key={idx}
                            id={`pin-${idx}`}
                            type="text"
                            inputMode="numeric"
                            maxLength={1}
                            value={digit}
                            onChange={(e) => handleDigitChange(idx, e.target.value)}
                            onKeyDown={(e) => handleKeyDown(idx, e)}
                            className={`pin-digit-input ${error ? 'error' : ''}`}
                            autoComplete="off"
                            autoFocus={idx === 0}
                        />
                    ))}
                </div>

                {error && (
                    <p style={{ color: '#ef4444', textAlign: 'center', marginTop: '1rem', fontSize: '0.9rem', fontWeight: 500 }}>
                        {t('incorrect_pin')}
                    </p>
                )}

                <div style={{ marginTop: '3rem', textAlign: 'center' }}>
                    <p className="text-muted" style={{ fontSize: '0.85rem' }}>
                        {t('default_pin')}: <span style={{ color: 'var(--primary)', fontWeight: 600 }}>1234</span>
                    </p>
                </div>
            </div>
        </div>
    );
}
