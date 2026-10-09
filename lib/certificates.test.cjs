const test = require('node:test');
const assert = require('node:assert');
const forge = require('node-forge');
const { certificateCoversHost, certificateDetails } = require('./certificates.cjs');

// A small throwaway certificate; the key size only needs to be valid, not strong.
function makeCertificate({ commonName, dnsNames = [], days = 90 }) {
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = keys.publicKey;
    certificate.serialNumber = '01';
    certificate.validity.notBefore = new Date(Date.now() - 60_000);
    certificate.validity.notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const attributes = [{ name: 'commonName', value: commonName }];
    certificate.setSubject(attributes);
    certificate.setIssuer(attributes);
    if (dnsNames.length) certificate.setExtensions([{ name: 'subjectAltName', altNames: dnsNames.map((value) => ({ type: 2, value })) }]);
    certificate.sign(keys.privateKey, forge.md.sha256.create());
    return forge.pki.certificateToPem(certificate);
}

test('a stored certificate is matched to the host it was issued for', () => {
    const details = certificateDetails(makeCertificate({ commonName: 'old-event.duckdns.org', dnsNames: ['old-event.duckdns.org'] }));
    assert.deepEqual(details.hostnames, ['old-event.duckdns.org']);
    assert.equal(certificateCoversHost(details, 'old-event.duckdns.org'), true);
    assert.equal(certificateCoversHost(details, 'Old-Event.DuckDNS.org'), true, 'host names compare without case');
    assert.equal(certificateCoversHost(details, 'new-event.duckdns.org'), false, 'a renamed DuckDNS host needs a new certificate');
    assert.equal(certificateCoversHost(details, ''), false);
});

test('without alternative names the common name counts; wildcards cover one label only', () => {
    assert.deepEqual(certificateDetails(makeCertificate({ commonName: 'Event.duckdns.org' })).hostnames, ['event.duckdns.org']);
    const wildcard = certificateDetails(makeCertificate({ commonName: 'x', dnsNames: ['*.duckdns.org'] }));
    assert.equal(certificateCoversHost(wildcard, 'event.duckdns.org'), true);
    assert.equal(certificateCoversHost(wildcard, 'a.b.duckdns.org'), false);
    assert.equal(certificateCoversHost(wildcard, 'duckdns.org'), false);
});

test('expiry and the renewal window are reported', () => {
    const fresh = certificateDetails(makeCertificate({ commonName: 'a.duckdns.org', days: 90 }));
    assert.equal(fresh.expiresSoon, false);
    assert.equal(fresh.expired, false);
    const ending = certificateDetails(makeCertificate({ commonName: 'a.duckdns.org', days: 10 }));
    assert.equal(ending.expiresSoon, true);
    assert.equal(ending.expired, false);
});
