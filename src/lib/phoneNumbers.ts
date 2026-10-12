// Phone numbers as the organiser typed them: "+7 701 …", "00 7 701 …" or a local "8 701 …".

const digits = (value: string) => value.replace(/\D/g, '');

/** True for a number written with its country code (a leading + or 00). */
export function isInternationalNumber(value: string) {
    const trimmed = value.trim();
    return (trimmed.startsWith('+') || trimmed.startsWith('00')) && digits(trimmed).length >= 8;
}

/**
 * The number for a wa.me link, or null when it cannot make one. WhatsApp links need the country
 * code; a local "8 701 …" became wa.me/8701…, which opens a chat with a different number.
 */
export function whatsappNumber(value: string) {
    if (!isInternationalNumber(value)) return null;
    const trimmed = value.trim();
    return trimmed.startsWith('00') ? digits(trimmed).slice(2) : digits(trimmed);
}
