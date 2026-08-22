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

The build preflight rejects ARM builds and non-Windows `mediasoup-worker` binaries. The installer is written to `release` and adds private-network firewall rules for TCP 4173 and UDP 10000–10100.

For development:

```powershell
npm ci
npm run electron:dev
```

## First service

1. Connect the computer and listener phones to the same private Wi-Fi network.
2. Connect the soundboard line output to a USB audio interface on the computer.
3. Launch Lingua Franca and sign in as operator. The initial PIN is `1234`; change it immediately.
4. In Admin, select the physical network adapter and restart if the automatic address is wrong.
5. Add an OpenAI API key if using Realtime translation. ChatGPT subscriptions do not include API usage.
6. Add names and church terminology to the glossary.
7. For warning-free phone access, create a free subdomain at [DuckDNS](https://www.duckdns.org), then enter the subdomain, DuckDNS token, and contact email under **Trusted phone certificate**. The app obtains a free Let's Encrypt certificate and renews it at launch when it has fewer than 30 days remaining.
8. Show the English listener QR. With a trusted certificate configured, phones open it without a certificate warning.
9. On the operator screen, select the soundboard, USB interface, or microphone input. The desktop app also offers **System output / loopback** to capture whatever Windows is currently playing. Choose Russian source and English target, then start the broadcast.

If a human interpreter will use a phone, choose the target language under **Phone interpreter** and create an interpreter QR. The link is valid for eight hours, can be exchanged once, and authorizes that phone to publish only the selected channel. The interpreter opens it, chooses the phone microphone, and taps **Start broadcast**. No administrator PIN is shared with the interpreter.

The API key and PIN are never returned to listener browsers. API keys are encrypted with the operating system's secure storage and only short-lived operator sessions may publish media or captions.

## Pre-service checks

- SFU status reads **ready** in Admin.
- The selected IP belongs to the church Wi-Fi adapter, not VPN/VMware/Hyper-V.
- A listener phone can open the displayed listener hostname on the church Wi-Fi.
- The source meter moves without clipping.
- Translation quality has been checked for names, Bible books, numbers, and quotations.
- A human interpreter is ready to take over.

## Load test

With the desktop app running:

```powershell
$env:LINGUA_FRANCA_URL='https://127.0.0.1:4173'
$env:LINGUA_FRANCA_CLIENTS='25'
npm run test:load
```

This verifies signaling concurrency. It does not replace a real Wi-Fi test with 20–50 phones and live audio.

## Troubleshooting

- **Worker missing or wrong format:** remove only `node_modules`, then run `npm ci` locally on Windows.
- **Phones cannot connect:** confirm the Windows network is Private, the firewall rules exist, and the displayed IP is correct.
- **Certificate warning:** the app is still using its self-signed fallback. Complete **Trusted phone certificate** setup in Admin; a public CA cannot issue a trusted certificate directly for a private `192.168.x.x`/`10.x.x.x` address.
- **Trusted hostname does not open:** confirm the phone is on the same Wi-Fi, DuckDNS resolves to the computer's current LAN address, and TCP 4173 is allowed through Windows Firewall.
- **No microphone labels:** tap the refresh button next to the input selector and allow microphone access. Some phones expose only the system-default input.
- **A speaker or virtual-cable playback endpoint is missing:** Windows exposes playback and recording endpoints separately. Select **System output / loopback** for the current Windows playback mix, or select the virtual cable's recording endpoint (usually named “Output”) as the microphone input.
- **Human interpreter cannot start:** create a new interpreter QR; links are single-use and expire after eight hours. Confirm the certificate status says **trusted** on phones and the SFU status says **ready**.
- **OpenAI unavailable:** switch to Human mode immediately; use text fallback only as a secondary option.
