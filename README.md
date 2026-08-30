# Lingua Franca

Local-network simultaneous interpretation for churches and meetings. A Windows computer captures the soundboard or microphone, translates Russian speech into English, and broadcasts one synchronized audio channel to listeners who join by QR code.

## Modes

- **Human:** publishes an interpreter's microphone directly over the local WebRTC SFU.
- **OpenAI Realtime:** sends the source track to `gpt-realtime-translate`, republishes the translated audio track through the local SFU, and sends synchronized captions.
- **Text fallback:** browser speech recognition plus Gemini or MyMemory translation. Listener devices synthesize this fallback text themselves.

Human mode remains available as the operational fallback if AI or internet service is unavailable.

## Windows x64 setup

Install Node.js LTS x64 and Visual Studio Build Tools with **Desktop development with C++**. Keep the project in a local Windows directory; never copy `node_modules` or `release` from a Mac.

```powershell
npm ci
npm run electron:build:win
```

The build preflight rejects ARM builds and non-Windows `mediasoup-worker` binaries. The installer is written to `release` and adds private-network firewall rules for **TCP 4173** (the web UI) and **UDP and TCP 10000** (media).

For development:

```powershell
npm ci
npm run electron:dev
```

The Vite dev server proxies `/api` and `/socket.io` to the Electron process, so the app behaves the same as a packaged build.

## macOS build

Windows is the deployment target; macOS builds are useful for development and demos.

```bash
npm run electron:build:mac
```

This packages the app, signs it, and only then wraps it in a DMG — in that order deliberately.
electron-builder skips signing when no Developer ID is installed, and an unsigned arm64 bundle
will not launch at all, so building the DMG in a single pass seals an app that cannot run.

If a **Developer ID Application** identity is in the keychain the script uses it. Otherwise it
falls back to an ad-hoc signature, which runs fine locally but is neither trusted by Gatekeeper
nor notarised. An ad-hoc build that is emailed, AirDropped or downloaded picks up a quarantine
flag and macOS will refuse to open it; the recipient must clear it:

```bash
xattr -dr com.apple.quarantine "/Applications/Lingua Franca.app"
```

Copying the DMG onto a machine by hand (USB, local file share) does not set that flag. For
anything wider, a paid Apple Developer account for signing and notarisation is the real fix.

## Capacity

Every WebRTC transport needs an ICE port. Lingua Franca puts all transports on a single shared port (10000), so listener capacity is bounded by CPU and Wi-Fi rather than by a port range. If that port cannot be bound at startup, the app falls back to allocating a port per transport, which limits the room to roughly 45 phones — Admin shows a warning when this happens, and restarting usually clears it.

## First service

1. Connect the computer and listener phones to the same private Wi-Fi network.
2. Connect the soundboard line output to a USB audio interface on the computer.
3. Launch Lingua Franca and sign in as operator. The initial PIN is `1234`; change it immediately. A PIN may be 4 to 12 digits, and longer is meaningfully harder to guess. Repeated wrong entries lock the app out for progressively longer.
4. In Admin, select the physical network adapter and restart if the automatic address is wrong.
5. Add an OpenAI API key if using Realtime translation. ChatGPT subscriptions do not include API usage.
6. Add names and church terminology to the glossary.
7. For warning-free phone access, create a free subdomain at [DuckDNS](https://www.duckdns.org), then enter the subdomain, DuckDNS token, and contact email under **Trusted phone certificate**. The app obtains a free Let's Encrypt certificate and renews it automatically once it has fewer than 30 days remaining. A still-valid certificate is reused rather than reissued, which keeps you clear of the CA's weekly duplicate-certificate limit.
8. Pick a channel under **Listener QR channel** and show its QR. Each channel has its own link. With a trusted certificate configured, phones open it without a certificate warning.
9. On the operator screen, select the soundboard, USB interface, or microphone input. The desktop app also offers **System output / loopback** to capture whatever Windows is currently playing. Choose the source and target languages, then start the broadcast.

If a human interpreter will use a phone, choose the target channel under **Phone interpreter** and create an interpreter QR. The link is valid for eight hours, can be exchanged once, and authorizes that phone to publish only the selected channel. The interpreter opens it, chooses the phone microphone, and taps **Start broadcast**. No administrator PIN is shared with the interpreter. Repeated wrong codes are rate limited the same way the operator PIN is.

The API key and PIN are never returned to listener browsers. Listener devices receive only the channel list; the glossary, network configuration and diagnostics require an operator session. API keys are encrypted with the operating system's secure storage and only short-lived operator sessions may publish media or captions.

Renaming a channel keeps its identity, so a rename mid-service will not interrupt a live broadcast. Deleting a channel stops its broadcast immediately.

## Pre-service checks

- SFU status reads **ready** in Admin, with no capacity warning.
- The selected IP belongs to the church Wi-Fi adapter, not VPN/VMware/Hyper-V.
- A listener phone can open the displayed listener hostname on the church Wi-Fi.
- The source meter moves without clipping.
- Translation quality has been checked for names, Bible books, numbers, and quotations.
- A human interpreter is ready to take over.

## Tests

```powershell
npm test
```

Unit tests for the settings, credential and session helpers in `lib/`. They run with the Node test runner and need no extra dependencies.

```powershell
npm run test:server
```

An end-to-end check of the HTTP surface with Electron stubbed out. It binds ports 4173 and 4174, so close the app first. It covers the listener/operator data split, the host allowlist, PIN and interpreter-code rate limiting, and that renaming a channel preserves its identity.

## Load test

With the desktop app running:

```powershell
$env:LINGUA_FRANCA_URL='https://127.0.0.1:4173'
$env:LINGUA_FRANCA_CLIENTS='60'
npm run test:load
```

Each simulated client connects and allocates a real listener transport, so this verifies both signalling concurrency and media-port capacity. It does not replace a real Wi-Fi test with 20–50 phones and live audio.

## Troubleshooting

- **The app will not start:** it now reports the reason in the window and in an error dialog instead of failing silently. The usual cause is a second copy already running, or something else holding TCP 4173 or 4174. Only one instance can run at a time; launching again focuses the existing window.
- **Worker missing or wrong format:** remove only `node_modules`, then run `npm ci` locally on Windows.
- **Phones cannot connect:** confirm the Windows network is Private, the firewall rules exist for TCP 4173 and UDP/TCP 10000, and the displayed IP is correct.
- **Certificate warning:** the app is still using its self-signed fallback. Complete **Trusted phone certificate** setup in Admin; a public CA cannot issue a trusted certificate directly for a private `192.168.x.x`/`10.x.x.x` address. To rehearse the setup without consuming the CA's weekly issuance budget, start the app with `LINGUA_FRANCA_ACME_STAGING=1` — staging certificates still show a warning on phones.
- **Trusted hostname does not open:** confirm the phone is on the same Wi-Fi, DuckDNS resolves to the computer's current LAN address, and TCP 4173 is allowed through Windows Firewall. The app re-points DuckDNS automatically if the computer's address changes while it is running.
- **No microphone labels:** tap the refresh button next to the input selector and allow microphone access. Some phones expose only the system-default input.
- **A speaker or virtual-cable playback endpoint is missing:** Windows exposes playback and recording endpoints separately. Select **System output / loopback** for the current Windows playback mix, or select the virtual cable's recording endpoint (usually named "Output") as the microphone input.
- **Human interpreter cannot start:** create a new interpreter QR; links are single-use and expire after eight hours. Confirm the certificate status says **trusted** on phones and the SFU status says **ready**.
- **A listener hears nothing on iPhone:** the listener must tap **Connect** on the phone itself; iOS only permits audio playback that begins from a tap.
- **Media engine stopped:** the worker restarts automatically and listeners reconnect on their own. If Admin keeps reporting the SFU as unavailable, restart the app.
- **OpenAI unavailable:** switch to Human mode immediately; use text fallback only as a secondary option.

## Releases

Installers are not committed to the repository. Build with `npm run electron:build:win` and publish the output from `release` to GitHub Releases.
