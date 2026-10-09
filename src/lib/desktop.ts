// Actions only the desktop app offers (see desktop/preload.cjs). Null in a phone or browser.

interface DesktopBridge {
    savePageAsPdf(fileName: string): Promise<{ saved?: string; canceled?: boolean; error?: string }>;
}

export const desktopBridge: DesktopBridge | null =
    (window as Window & { linguaFrancaDesktop?: DesktopBridge }).linguaFrancaDesktop ?? null;
