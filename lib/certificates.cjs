// Facts about a stored certificate. Kept free of Electron so it can be unit tested.
const forge = require('node-forge');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Expiry, and the host names it was issued for (subject alternative names, else the CN). */
function certificateDetails(certPem, renewalDays = 30, now = Date.now()) {
    const certificate = forge.pki.certificateFromPem(String(certPem));
    const notAfter = certificate.validity.notAfter.getTime();
    const altNames = certificate.getExtension('subjectAltName')?.altNames || [];
    const dnsNames = altNames.filter((name) => name.type === 2).map((name) => String(name.value).toLowerCase());
    const commonName = certificate.subject.getField('CN')?.value;
    return {
        expiresAt: certificate.validity.notAfter.toISOString(),
        expiresSoon: notAfter <= now + renewalDays * DAY_MS,
        expired: notAfter <= now,
        hostnames: dnsNames.length ? dnsNames : commonName ? [String(commonName).toLowerCase()] : [],
    };
}

// A stored certificate is only worth reusing for the host name it was issued for. Changing the
// DuckDNS name used to keep serving the old certificate, which every browser then rejected.
function certificateCoversHost(details, hostname) {
    const wanted = String(hostname || '').toLowerCase();
    return Boolean(wanted) && (details?.hostnames || []).some((name) =>
        name === wanted || (name.startsWith('*.') && wanted.endsWith(name.slice(1)) && !wanted.slice(0, -name.length + 1).includes('.')));
}

module.exports = { certificateCoversHost, certificateDetails };
