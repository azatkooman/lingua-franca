import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, Lock, Mic, ShieldAlert } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { settingsService } from '../lib/SettingsService';
import '../pages/Admin.css';

const isAuthorized = () => settingsService.isAdminAuthenticated() || settingsService.isInterpreterAuthenticated();

export default function InterpreterGuard({ children }: { children: ReactNode }) {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const automaticCode = searchParams.get('code')?.replace(/\D/g, '').slice(0, 6) || '';
    const [authorized, setAuthorized] = useState(isAuthorized);
    // The operator reaches this screen from "Be an Interpreter" on the desktop app and has no
    // interpreter code, only the PIN. Without this they were stuck on a code prompt.
    const [usePin, setUsePin] = useState(false);
    const [code, setCode] = useState(automaticCode);
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');
    const [checking, setChecking] = useState(!authorized && automaticCode.length === 6);
    // Codes are single use, so an automatic attempt must never be repeated by a re-render.
    const attempted = useRef(false);
    const wasAuthorized = useRef(authorized);

    // The operator can end a session while this page is open. Re-gate when that happens, so
    // the broadcast screen unmounts (which stops the microphone) and the phone says why.
    useEffect(() => {
        const update = () => {
            const next = isAuthorized();
            if (wasAuthorized.current && !next) {
                setError('This interpreter session has ended. Ask the operator for a new interpreter QR code.');
            }
            wasAuthorized.current = next;
            setAuthorized(next);
        };
        const stopAdmin = settingsService.subscribeAuth(update);
        const stopInterpreter = settingsService.subscribeInterpreterAuth(update);
        return () => { stopAdmin(); stopInterpreter(); };
    }, []);

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

    const loginOperator = async () => {
        if (pin.length < 4) return;
        setChecking(true); setError('');
        try {
            await settingsService.login(pin);
            setAuthorized(true);
        } catch (loginError) {
            // The server's message includes how long a lockout lasts after repeated misses.
            setError(loginError instanceof Error ? loginError.message : String(loginError));
            setPin('');
        } finally { setChecking(false); }
    };

    useEffect(() => {
        if (authorized || automaticCode.length !== 6 || attempted.current) return;
        attempted.current = true;
        void login(automaticCode);
    }, [authorized, automaticCode]);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        void (usePin ? loginOperator() : login(code));
    };

    const switchMode = () => { setUsePin((current) => !current); setError(''); };

    if (authorized) return <>{children}</>;

    return (
        <div className="page-container admin-gate">
            <form className="card fade-in" onSubmit={submit} style={{ maxWidth: 450, margin: '20px auto', padding: '3rem' }}>
                <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
                    {error ? <ShieldAlert size={48} color="var(--danger)" /> : usePin ? <Lock size={48} color="var(--primary)" /> : <Mic size={48} color="var(--primary)" />}
                    <h2>{usePin ? 'Operator sign-in' : 'Interpreter access'}</h2>
                    <p className="text-muted">
                        {usePin
                            ? 'Enter the administrator PIN to broadcast from this device.'
                            : 'Scan the interpreter QR code from the desktop admin page, or enter its six-digit code.'}
                    </p>
                </div>
                {usePin ? (
                    <input key="pin" className="custom-input" type="password" inputMode="numeric" autoComplete="current-password" autoFocus
                        maxLength={12} value={pin} placeholder="Administrator PIN" disabled={checking}
                        onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 12))} />
                ) : (
                    <input key="code" className="custom-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                        onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6-digit code" disabled={checking} />
                )}
                <button className="btn-primary mt-4" type="submit" disabled={checking || (usePin ? pin.length < 4 : code.length !== 6)}>
                    {checking ? 'Checking…' : usePin ? 'Sign in as operator' : 'Continue as interpreter'}
                </button>
                {error && <p style={{ color: 'var(--danger)', marginTop: '1rem' }}>{error}</p>}
                <button className="btn-secondary mt-4" type="button" onClick={switchMode} disabled={checking} style={{ width: '100%' }}>
                    {usePin ? 'I have an interpreter code' : 'Operator? Sign in with your PIN'}
                </button>
                {/* The desktop app has no browser Back button, so this is the only way out. */}
                <button className="btn-secondary mt-4" type="button" onClick={() => navigate('/')} style={{ width: '100%' }}>
                    <ArrowLeft size={18} /> Back to home
                </button>
            </form>
        </div>
    );
}
