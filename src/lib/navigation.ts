import { useNavigate } from 'react-router-dom';

const HTTPS_PORT = 4173;

/**
 * True on the plain-HTTP listener link (http://<LAN address>:4175). That link exists so phones
 * can listen without a certificate warning; nothing secret may be typed into it. The desktop
 * window (http://localhost) and every HTTPS address count as secure contexts.
 */
export const isPlainListenerLink = () => !window.isSecureContext;

/** The same page on the HTTPS address, for sign-in screens reached from the plain link. */
export const secureLocation = () =>
    `https://${window.location.hostname}:${HTTPS_PORT}${window.location.pathname}${window.location.search}`;

/**
 * A Back action that never leaves the app.
 *
 * Phones arrive from a QR code, so the page they land on is the first entry in the app's
 * history. navigate(-1) there either did nothing or went back to whatever the phone showed
 * before. React Router records the position in history.state.idx; with nothing earlier in
 * the app to return to, go to the home screen instead.
 */
export function useGoBack() {
    const navigate = useNavigate();
    return () => {
        const index = (window.history.state as { idx?: number } | null)?.idx ?? 0;
        if (index > 0) navigate(-1);
        else navigate('/', { replace: true });
    };
}
