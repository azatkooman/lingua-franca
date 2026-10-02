import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, Mic, ShieldAlert } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { settingsService } from '../lib/SettingsService';
import '../pages/Admin.css';

const isAuthorized = () => settingsService.isAdminAuthenticated() || settingsService.isInterpreterAuthenticated();

export default function InterpreterGuard({ children }: { children: ReactNode }) {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const automaticCode = searchParams.get('code')?.replace(/\D/g, '').slice(0, 6) || '';
    const [authorized, setAuthorized] = useState(isAuthorized);
    const [code, setCode] = useState(automaticCode);
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

    useEffect(() => {
        if (authorized || automaticCode.length !== 6 || attempted.current) return;
        attempted.current = true;
        void login(automaticCode);
    }, [authorized, automaticCode]);

    const submit = (event: FormEvent) => { event.preventDefault(); void login(code); };

    if (authorized) return <>{children}</>;

    return (
        <div className="page-container admin-gate">
            <button className="btn-icon" onClick={() => navigate('/')} style={{ position: 'fixed', top: '1.5rem', left: '1.5rem' }}><ArrowLeft size={24} /></button>
            <form className="card fade-in" onSubmit={submit} style={{ maxWidth: 450, margin: '20px auto', padding: '3rem' }}>
                <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
                    {error ? <ShieldAlert size={48} color="var(--danger)" /> : <Mic size={48} color="var(--primary)" />}
                    <h2>Interpreter access</h2>
                    <p className="text-muted">Scan the interpreter QR code from the desktop admin page, or enter its six-digit code.</p>
                </div>
                <input className="custom-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6-digit code" disabled={checking} />
                <button className="btn-primary mt-4" type="submit" disabled={code.length !== 6 || checking}>{checking ? 'Checking…' : 'Continue as interpreter'}</button>
                {error && <p style={{ color: 'var(--danger)', marginTop: '1rem' }}>{error}</p>}
            </form>
        </div>
    );
}
