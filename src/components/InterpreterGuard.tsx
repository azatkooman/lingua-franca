import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Mic, ShieldAlert } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { settingsService } from '../lib/SettingsService';
import '../pages/Admin.css';

export default function InterpreterGuard({ children }: { children: ReactNode }) {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const automaticCode = searchParams.get('code')?.replace(/\D/g, '').slice(0, 6) || '';
    const [authorized, setAuthorized] = useState(settingsService.isAdminAuthenticated() || settingsService.isInterpreterAuthenticated());
    const [code, setCode] = useState(automaticCode);
    const [error, setError] = useState('');
    const [checking, setChecking] = useState(!authorized && automaticCode.length === 6);

    const login = async (accessCode: string) => {
        if (accessCode.length !== 6) return;
        setChecking(true); setError('');
        try {
            await settingsService.loginInterpreter(accessCode);
            setAuthorized(true);
            window.history.replaceState({}, '', '/interpreter');
        } catch (loginError) {
            setError(loginError instanceof Error ? loginError.message : String(loginError));
        } finally { setChecking(false); }
    };

    useEffect(() => {
        if (authorized || automaticCode.length !== 6) return;
        void settingsService.loginInterpreter(automaticCode).then(() => {
            setAuthorized(true);
            window.history.replaceState({}, '', '/interpreter');
        }).catch((loginError: unknown) => {
            setError(loginError instanceof Error ? loginError.message : String(loginError));
        }).finally(() => setChecking(false));
    }, [authorized, automaticCode]);

    if (authorized) return <>{children}</>;

    return (
        <div className="page-container admin-gate">
            <button className="btn-icon" onClick={() => navigate('/')} style={{ position: 'fixed', top: '1.5rem', left: '1.5rem' }}><ArrowLeft size={24} /></button>
            <div className="card fade-in" style={{ maxWidth: 450, margin: '20px auto', padding: '3rem' }}>
                <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
                    {error ? <ShieldAlert size={48} color="var(--danger)" /> : <Mic size={48} color="var(--primary)" />}
                    <h2>Interpreter access</h2>
                    <p className="text-muted">Scan the interpreter QR code from the desktop admin page, or enter its six-digit code.</p>
                </div>
                <input className="custom-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6-digit code" disabled={checking} />
                <button className="btn-primary mt-4" disabled={code.length !== 6 || checking} onClick={() => void login(code)}>{checking ? 'Checking…' : 'Continue as interpreter'}</button>
                {error && <p style={{ color: 'var(--danger)', marginTop: '1rem' }}>{error}</p>}
            </div>
        </div>
    );
}
