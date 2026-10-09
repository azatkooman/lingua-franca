import { useSyncExternalStore } from 'react';

/**
 * Light or dark interface, per device. "system" follows the phone or computer setting and is
 * the default; the header button cycles system → light → dark. Imported by main.tsx before
 * the first render, so the page never flashes the wrong theme.
 */
export type ThemePreference = 'system' | 'light' | 'dark';
type ResolvedTheme = 'light' | 'dark';

const KEY = 'lingua_franca_theme';
const ORDER: ThemePreference[] = ['system', 'light', 'dark'];
// Matches --bg-color in each theme, so the phone's browser bar blends with the page.
const BROWSER_BAR: Record<ResolvedTheme, string> = { dark: '#0d0f17', light: '#f5f6fb' };

const systemQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
const listeners = new Set<() => void>();

const readPreference = (): ThemePreference => {
    try {
        const saved = localStorage.getItem(KEY);
        return ORDER.includes(saved as ThemePreference) ? saved as ThemePreference : 'system';
    } catch { return 'system'; }
};

let preference = readPreference();
const resolve = (): ResolvedTheme => (preference === 'system' ? (systemQuery?.matches ? 'light' : 'dark') : preference);
let snapshot = { preference, resolved: resolve() };

function apply() {
    snapshot = { preference, resolved: resolve() };
    document.documentElement.dataset.theme = snapshot.resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BROWSER_BAR[snapshot.resolved]);
    listeners.forEach((listener) => listener());
}

apply();
systemQuery?.addEventListener('change', () => { if (preference === 'system') apply(); });

export function cycleTheme() {
    preference = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length];
    try { localStorage.setItem(KEY, preference); } catch { /* private browsing: not remembered */ }
    apply();
}

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export function useTheme() {
    return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
