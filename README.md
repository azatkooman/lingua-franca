<p align="center"><img src="docs/branding/banner.png" alt="Lingua Franca: real-time interpretation for any event" width="840"></p>

# Lingua Franca

Local-network simultaneous interpretation for any kind of event: conferences, meetings, services, seminars and more. A Windows computer takes the audio from the mixer or a microphone, has it interpreted live (by a human interpreter, or by OpenAI for example from Russian into English), and broadcasts each language as its own audio channel to listeners, who join on their own phones by scanning a QR code.

## Modes

- **Human:** publishes an interpreter's microphone directly over the local WebRTC SFU.
- **OpenAI Realtime (AI):** sends the source track to `gpt-realtime-translate`, republishes the translated audio track through the local SFU, and sends synchronized captions. If the OpenAI connection drops, the app rebuilds it on its own for about two minutes; listeners hear silence instead of being disconnected while it does.

In AI mode the operator can also broadcast the original speech, with captions in the original language, on the source language's channel (**Also broadcast the original speech** on the broadcast screen, on by default). Listeners who speak that language can then follow along on their phones too.

OpenAI is the only translation provider. Human mode is the fallback if the internet or OpenAI is unavailable. (An earlier text fallback built on browser speech recognition plus Gemini or MyMemory was removed: speech recognition does not work inside the desktop app, and it needed the internet anyway. Settings from it, including any saved Gemini key, are deleted from the settings file on first launch.)

## Listener screen

Listeners scan the QR code, see the event name and dates, pick a language and tap **Tap to listen**. While listening:

- **Live captions** (AI channels): a scrolling transcript that follows the newest line and highlights it. Scrolling up to reread pauses it, and **Jump to latest** brings it back. A phone that joins late gets the last few sentences straight away.
- **Original text**: on translation channels, a second box under the translation with the speaker's own words, shown from the start and filled in as they speak. The listener can hide it. When AI mode also broadcasts the original speech, that channel is tagged **Original** in the list and its captions are labelled **Original speech**.
- **Text size**: the **A** button cycles medium, large and small.
- **Full screen**: a reading view with large text and a small bar for status, text size, mute and exit.
- **Switch language** with the tabs at the top, without going back.
- **Status**: Live, Waiting for the speaker, Connecting, or Reconnecting.
- **Sound**: mute, volume, a level meter, and Phone / Speaker output, under **Sound**.
- The screen is kept on while listening, on both links: the browser's wake lock on HTTPS, and on the plain link a tiny muted video that phones treat as playing ([NoSleep.js](https://github.com/richtr/NoSleep.js)). Text size, the original-text choice and the volume are remembered on each phone.

Every screen has a help button (a question mark) with the organiser's contacts (set in Admin, hidden when empty), the **RU / KK / EN** interface switch, and a light / dark / system theme switch. The Kazakh text has not yet been reviewed by a native speaker.

## Operator tools

**Live now** (top of Admin) refreshes every few seconds: each channel's state (off air, interpreter, AI translation or original, and for how long), whether it is muted or being recorded, how many phones are listening now and the most at once, and the total. When AI translation has run it also shows the time used and a rough cost, at OpenAI's prices of about $0.051 per minute for each translated language ($0.034 for the translation and $0.017 for transcribing the original speech). Your OpenAI bill has the exact amount.

**Recordings and transcripts** (in Admin):

- **Record the audio of every live channel** saves each broadcast as an `.opus` file on this computer: phone and desktop interpreters, every AI translation, and in AI mode the original speech, even when it is not broadcast on its own channel. In Human mode only the interpreter can be recorded, because the original speech does not go through the app. To record an unbroadcast original in AI mode, switch recording on before starting the broadcast. The server writes the audio as it arrives, so a crash or power cut loses at most a second, and a recording can be downloaded while it is still running. Pauses (a muted microphone) are kept as silence, so the file keeps real time. Expect about 10 to 30 MB per hour for each channel (about 11 MB for one hour of speech in testing). Off by default.
- **Save the captions as text** (on by default) writes every finished caption sentence to a text file per language per day, with the time of each sentence and the original under it.
- Files are listed by day with **Download** and **Delete**, and **Open folder** opens them in Explorer. They live in `%APPDATA%\lingua-franca\recordings`.

`.opus` files play in Windows Media Player, VLC, browsers, and on phones.

**Print a QR poster** (next to **Show listener QR**) makes one printable A4 page: the event name and dates, a heading in each language on the poster, an optional Wi-Fi QR code that joins the network when scanned, and a QR code for each language with "Scan to listen" in that language. The Wi-Fi name and password stay on the operator's device. In the desktop app, **Save as PDF** saves it straight to a file named after the event (for example `QR poster - Spring Forum.pdf`); **Print** opens the Windows print dialog. In a browser, choose **Save as PDF** in the print window.

## Windows x64 setup

Install Node.js LTS x64 and Visual Studio Build Tools with **Desktop development with C++**. Keep the project in a local Windows directory; never copy `node_modules` or `release` from a Mac.

```powershell
npm ci
npm run electron:build:win
```

The build preflight rejects ARM builds and non-Windows `mediasoup-worker` binaries. The installer is written to `release` and adds private-network firewall rules for **TCP 4173** (the secure web UI), **TCP 4175** (the plain listener link) and **UDP and TCP 10000** (media).

No local toolchain? Every push and pull request also builds the installer on GitHub Actions (see [Releases](#releases)).

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
2. Connect the mixer's line output to a USB audio interface on the computer. Send a speech-only mix (the speaker's microphone, not music or room sound).
3. Launch Lingua Franca and sign in as operator. The initial PIN is `1234`; change it immediately. A PIN may be 4 to 12 digits, and longer is meaningfully harder to guess. Repeated wrong entries lock the app out for progressively longer. Changing the PIN signs out every other operator session.
4. In Admin, select the physical network adapter if the automatic address is wrong, then press **Restart app**.
5. Add an OpenAI API key if using AI translation. ChatGPT subscriptions do not include API usage. OpenAI's realtime translation model does not accept a custom glossary, so check names and Bible books by ear before the service.
6. Under **Default language for phones**, choose the language phones start in (English, Russian or Kazakh). Each phone can still switch with RU / KK / EN.
   Under **Event**, enter the event name and dates; they are shown at the top of the home and listener screens. Under **Contact for listeners**, enter a name, phone, WhatsApp, Telegram or email for people who have no sound or a question. Leave every contact field empty to hide the help button.
7. Optional: listener phones need no certificate (see step 8), but interpreter phones and Admin on other devices use HTTPS. To remove the warning there too, create a free subdomain at [DuckDNS](https://www.duckdns.org), then enter the subdomain, DuckDNS token, and contact email under **Trusted phone certificate**. The app obtains a free Let's Encrypt certificate and renews it automatically once it has fewer than 30 days remaining. A still-valid certificate is reused rather than reissued, which keeps you clear of the CA's weekly duplicate-certificate limit.
8. Print a poster with **Print a QR poster**, or pick a channel under **Listener QR channel** and show its QR. Each channel has its own link. Without a trusted certificate the QR carries the **plain listener link** (`http://<computer address>:4175/listener?...`), which phones open straight away with no certificate warning, no DuckDNS and no internet. Once the DuckDNS certificate is set up, QR codes use the HTTPS link instead, which also opens without a warning and is fully secure. See [Listener link](#listener-link).
9. On the home screen, choose **Be an Interpreter** and sign in with the operator PIN (an interpreter phone uses its QR code instead). Select the mixer's USB interface or a microphone input. If the chosen input is missing (unplugged, or renamed by Windows), starting fails with a clear message instead of quietly using another microphone; if it stops mid-broadcast, the screen says so. The desktop app also offers **System output / loopback** to capture whatever Windows is currently playing. Choose **Human**, or **AI** with the source and target languages (Russian to English is preselected when those channels exist), then start the broadcast.
10. Press **Sign out** in Admin when the service is over, so the next person at the computer needs the PIN.

If a human interpreter will use a phone, choose the target channel under **Phone interpreter** and create an interpreter QR. The link is valid for eight hours, can be exchanged once, and authorizes that phone to publish only the selected channel. The interpreter opens it, chooses the phone microphone, and taps **Start broadcast**. No administrator PIN is shared with the interpreter. Repeated wrong codes are rate limited the same way the operator PIN is. **End all interpreter access** in Admin cuts every interpreter session and unused code at once, and disconnects any phone that is broadcasting.

A phone cannot start broadcasting on a channel that is already live, and cannot mute or end someone else's broadcast. The operator screen can take any channel over; the broadcaster it replaces is told and stops.

The API key and PIN are never returned to listener browsers. Listener devices receive only the channel list; network configuration and diagnostics require an operator session. API keys are encrypted with the operating system's secure storage and only short-lived operator sessions may publish media or captions.

Renaming a channel keeps its identity, so a rename mid-service will not interrupt a live broadcast. Deleting a channel stops its broadcast immediately.

## Listener link

A phone only trusts certificates for public domain names, and a `192.168.x.x` address cannot get one, so HTTPS links show a certificate warning on every phone. Listening does not need HTTPS: browsers require a secure page only for microphone access, which listeners never use. So listener phones get a plain-HTTP link on **TCP 4175**:

- It opens with no warning, needs no DuckDNS and works on Wi-Fi without internet.
- The audio is still encrypted: WebRTC always encrypts media (DTLS-SRTP). Only the page and the connection setup travel unencrypted on the venue Wi-Fi.
- It serves listening only. Every sign-in, interpreter-code and operator request is refused on that port, sockets from it can never broadcast, and `/admin` and `/interpreter` redirect to HTTPS before anything can be typed.
- The **Phone / Speaker** switch may not work there, because browsers keep audio-output selection for secure pages. Normal playback and volume are unaffected. The screen still stays on, using a silent video instead of the wake lock.

Interpreter phones and Admin stay on HTTPS (they need the microphone or a PIN). They show the certificate warning once per phone unless the DuckDNS certificate in step 7 is set up. The plain link's page and connection setup are not authenticated, so someone on the same Wi-Fi with the right tools could tamper with them; for that reason QR codes switch to HTTPS automatically once a trusted certificate is set up. Admin can choose either link under **Link for listener phones**. If TCP 4175 is taken by another program, the app still starts and Admin says so, and QR codes fall back to HTTPS.

## Pre-service checks

- If you want the audio afterwards, **Record the audio of every live channel** is on, and **Live now** shows **Recording** next to each live channel once it starts.

- SFU status reads **ready** in Admin, with no capacity warning.
- The selected IP belongs to the venue Wi-Fi adapter, not VPN/VMware/Hyper-V.
- A listener phone can open the listener QR link on the venue Wi-Fi.
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

An end-to-end check of the HTTP and signalling surface with Electron stubbed out. It binds ports 4173 and 4174, so close the app first. It covers the listener/operator data split, the host allowlist, PIN and interpreter-code rate limiting, ending interpreter access, signing out other sessions on a PIN change, and that renaming a channel preserves its identity. Set `LINGUA_FRANCA_WORKER_BIN` to `node_modules\mediasoup\worker\out\Release\mediasoup-worker.exe` to also check channel ownership, operator takeover, and recovery from a media-worker crash.

## Load test

With the desktop app running:

```powershell
$env:LINGUA_FRANCA_URL='https://127.0.0.1:4173'
$env:LINGUA_FRANCA_CLIENTS='60'
npm run test:load
```

Each simulated client connects and allocates a real listener transport, so this verifies both signalling concurrency and media-port capacity. It does not replace a real Wi-Fi test with 20–50 phones and live audio.

## Troubleshooting

- **Wi-Fi drops for a moment:** broadcasting phones and the operator's screen publish again, and listening phones reconnect, on their own once the link is back.

- **The app will not start:** it now reports the reason in the window and in an error dialog instead of failing silently. The usual cause is a second copy already running, or something else holding TCP 4173 or 4174. Only one instance can run at a time; launching again focuses the existing window.
- **Worker missing or wrong format:** remove only `node_modules`, then run `npm ci` locally on Windows.
- **Phones cannot connect:** confirm the Windows network is Private, the firewall rules exist for TCP 4173, TCP 4175 and UDP/TCP 10000, and the displayed IP is correct.
- **Certificate warning on listener phones:** make sure **Link for listener phones** in Admin is set to the plain link, then show the QR again.
- **Certificate warning on interpreter phones or Admin:** the app is still using its self-signed fallback. Complete **Trusted phone certificate** setup in Admin; a public CA cannot issue a trusted certificate directly for a private `192.168.x.x`/`10.x.x.x` address. To rehearse the setup without consuming the CA's weekly issuance budget, start the app with `LINGUA_FRANCA_ACME_STAGING=1` — staging certificates still show a warning on phones.
- **Trusted hostname does not open:** confirm the phone is on the same Wi-Fi, DuckDNS resolves to the computer's current LAN address, and TCP 4173 is allowed through Windows Firewall. The app re-points DuckDNS automatically if the computer's address changes while it is running.
- **No microphone labels:** tap the refresh button next to the input selector and allow microphone access. Some phones expose only the system-default input.
- **A speaker or virtual-cable playback endpoint is missing:** Windows exposes playback and recording endpoints separately. Select **System output / loopback** for the current Windows playback mix, or select the virtual cable's recording endpoint (usually named "Output") as the microphone input.
- **Human interpreter cannot start:** create a new interpreter QR; links are single-use and expire after eight hours. Confirm the certificate status says **trusted** on phones and the SFU status says **ready**. If the phone says the channel is already being broadcast, stop the other broadcast first.
- **A listener hears nothing on iPhone:** the listener must tap **Connect** on the phone itself; iOS only permits audio playback that begins from a tap.
- **Media engine stopped:** the worker restarts automatically; broadcasters resume publishing and listeners reconnect on their own. If Admin keeps reporting the SFU as unavailable, restart the app.
- **OpenAI unavailable:** the app retries a dropped connection for about two minutes and shows each attempt. If it gives up, switch to Human mode immediately.

## Branding

The mark is two speech bubbles: the original speech (white or violet) and the interpreted audio (green, with sound bars). Colors come from the app: violet `#8b5cf6`, green `#10b981`, navy `#0d0f17`. The type is Outfit.

The SVG sources live in `branding/`:

- `app-icon.svg`: the app icon at 48 px and up.
- `app-icon-small.svg`: a simplified icon for 16 to 40 px, also the browser favicon.
- `logo-mark.svg`: the bubbles alone, for dark backgrounds (in-app header, startup screen, banners).

After changing one, run `npm run icons`. It redraws every size from the vector and rewrites the Windows `.ico`, the macOS `.icns`, the installer images in `build/`, the favicons and phone icons in `public/`, and the banner and social preview in `docs/branding/`. Commit the results.

`docs/branding/social-preview.png` is the image GitHub shows when the repository link is shared. GitHub has no API for it: upload it under **Settings > General > Social preview**.

## Releases

Installers are not committed to the repository. The **Windows build** GitHub Actions workflow runs lint, the unit tests and the server smoke test, then packages the installer on every push to `main`, every pull request, and on demand (**Actions → Windows build → Run workflow**). Download it from the run's **Artifacts** section (`lingua-franca-windows-x64`) and publish it to GitHub Releases. The CI installer is unsigned, so Windows SmartScreen shows a warning on first run.

You can also build locally with `npm run electron:build:win` and publish the output from `release`.
