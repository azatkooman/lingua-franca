// Listener links for QR codes, shared by Admin and the printable poster.

export interface HealthInfo {
    ok: boolean;
    localAddress: string;
    addresses: { name: string; address: string }[];
    sfu: string;
    sfuError: string;
    portMode: 'multiplexed' | 'range' | 'unknown';
    addressDrift: string;
    secureStorageAvailable: boolean;
    certificatePath: string;
    publicHost: string;
    certificate: { type: 'trusted' | 'self-signed'; hostname: string; expiresAt: string; error: string };
    ports: { https: number; local: number; listener: number | null; rtc: string };
    listenerPortError: string;
}

export type PhoneLink = 'plain' | 'secure';
const PHONE_LINK_KEY = 'lingua_franca_phone_link';

// Which address listener QR codes carry, as chosen on this operator device; null when no choice
// was made, which means: the best link available (see effectivePhoneLink).
export function readPhoneLink(): PhoneLink | null {
    try {
        const saved = localStorage.getItem(PHONE_LINK_KEY);
        return saved === 'secure' || saved === 'plain' ? saved : null;
    } catch { return null; }
}

// Plain HTTP opens with no certificate warning and needs neither DuckDNS nor internet, but its
// page and signalling are not authenticated. With a trusted certificate HTTPS also opens without
// a warning, so it becomes the default then.
export function effectivePhoneLink(health: HealthInfo | null, preference: PhoneLink | null): PhoneLink {
    return preference ?? (health?.certificate.type === 'trusted' ? 'secure' : 'plain');
}

export function savePhoneLink(value: PhoneLink) {
    try { localStorage.setItem(PHONE_LINK_KEY, value); } catch { /* optional preference */ }
}

/** Falls back to HTTPS when the plain port could not start, so a QR never points at a dead address. */
export function usesPlainLink(health: HealthInfo | null, preference: PhoneLink | null) {
    return effectivePhoneLink(health, preference) === 'plain' && Boolean(health?.ports.listener);
}

// Every channel gets its own link. The plain link uses the LAN address directly: it needs no
// DNS, so it works on Wi-Fi without internet.
export function listenerUrl(health: HealthInfo | null, preference: PhoneLink | null, channelId: string) {
    if (!health) return '';
    const query = `/listener?channel=${encodeURIComponent(channelId)}`;
    if (usesPlainLink(health, preference)) return `http://${health.localAddress}:${health.ports.listener}${query}`;
    const host = health.publicHost || health.localAddress;
    return host ? `https://${host}:${health.ports.https}${query}` : '';
}

export async function fetchAdminHealth(token: string): Promise<HealthInfo | null> {
    try {
        const response = await fetch('/api/admin/health', { cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
        return response.ok ? await response.json() as HealthInfo : null;
    } catch { return null; }
}
