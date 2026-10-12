import { desktopBridge } from './desktop';

/**
 * Things the operator (or a phone interpreter) must notice now, whatever screen they are on:
 * a banner on the broadcasting screen, plus on the desktop a silent system notification and a
 * flashing taskbar button, and on a phone a short vibration.
 *
 * Never a sound. The operator's computer may be wired to the PA, or its playback may be the
 * very thing being broadcast ("System output"), so a beep could reach the whole room.
 */
export type AlertKind = 'ai_failed' | 'input_ended' | 'cant_hear' | 'budget' | 'handover' | 'access_ending';

export interface OperatorAlert {
    id: number;
    kind: AlertKind;
    message: string;
    /** For alerts about one channel, so a repeat replaces rather than stacks. */
    channelId?: string;
}

type Listener = (alerts: OperatorAlert[]) => void;

let alerts: OperatorAlert[] = [];
let nextId = 1;
const listeners = new Set<Listener>();
const publish = () => listeners.forEach((listener) => listener(alerts));

export function raiseAlert(kind: AlertKind, message: string, { channelId, notify = true }: { channelId?: string; notify?: boolean } = {}) {
    alerts = [...alerts.filter((alert) => !(alert.kind === kind && alert.channelId === channelId)), { id: nextId++, kind, message, channelId }];
    publish();
    if (!notify) return;
    void desktopBridge?.notify?.('Lingua Franca', message).catch(() => undefined);
    if (!desktopBridge && 'vibrate' in navigator) navigator.vibrate?.([200, 100, 200]);
}

export function dismissAlert(id: number) {
    alerts = alerts.filter((alert) => alert.id !== id);
    publish();
}

/** Clears alerts of a kind (all channels, or one), once the problem is gone. */
export function clearAlerts(kind: AlertKind, channelId?: string) {
    const next = alerts.filter((alert) => !(alert.kind === kind && (channelId === undefined || alert.channelId === channelId)));
    if (next.length === alerts.length) return;
    alerts = next;
    publish();
}

export function subscribeAlerts(listener: Listener) {
    listeners.add(listener);
    listener(alerts);
    return () => { listeners.delete(listener); };
}
