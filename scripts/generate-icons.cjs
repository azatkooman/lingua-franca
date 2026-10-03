/**
 * Builds every icon and brand image from the SVG sources in branding/.
 *
 *   npm run icons
 *
 * Runs inside Electron so Chromium does the rasterising: each size is drawn from the vector,
 * not scaled down from one big bitmap, which keeps small icons sharp. The ICO, ICNS and BMP
 * containers are written by hand below, so no image tooling needs installing.
 *
 * Outputs:
 *   build/icon.ico, build/icon.icns, build/icon.png        app and installer icon (electron-builder)
 *   build/installerSidebar.bmp, uninstallerSidebar.bmp,    Windows installer artwork
 *   build/installerHeader.bmp
 *   public/favicon.svg, favicon.ico, apple-touch-icon.png, browser tab and phone home screen
 *   public/icon-192.png, icon-512.png, icon-maskable-512.png
 *   docs/branding/banner.png, docs/branding/social-preview.png   README and GitHub link preview
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = (name) => fs.readFileSync(path.join(root, 'branding', name), 'utf8');
const out = (...parts) => {
    const file = path.join(root, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
};

const APP_ICON = source('app-icon.svg');
const APP_ICON_SMALL = source('app-icon-small.svg');
const LOGO_MARK = source('logo-mark.svg');
const FONT = fs.readFileSync(path.join(root, 'src', 'assets', 'fonts', 'outfit-latin.woff2')).toString('base64');

const COLORS = { bg: '#0d0f17', surface: '#1a1d2d', violet: '#8b5cf6', violetDeep: '#7c3aed', text: '#f8fafc', muted: '#94a3b8' };

/* ------------------------------------------------------------------ SVG compositions */

// Drops the XML wrapper so a source can be nested inside another SVG.
const inner = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const viewBoxOf = (svg) => /viewBox="([^"]+)"/.exec(svg)[1];
const nest = (svg, x, y, size) =>
    `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${viewBoxOf(svg)}">${inner(svg)}</svg>`;

// Apple's icon grid: an 824 px tile centred in 1024 with transparent margin and a soft shadow.
// Without the margin a macOS dock icon looks oversized next to every other app.
const macIcon = (svg) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><filter id="mac-shadow" x="-10%" y="-10%" width="120%" height="125%">
    <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/>
  </filter></defs>
  <g filter="url(#mac-shadow)">${nest(svg, 41.14, 41.14, 941.71)}</g>
</svg>`;

// Android and PWA "maskable" icon: full-bleed square, the bubbles kept inside the central safe
// circle, because the phone crops the corners to its own shape.
const maskableIcon = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="mk-bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#a78bfa"/><stop offset="0.55" stop-color="#7c3aed"/><stop offset="1" stop-color="#4c1d95"/>
  </linearGradient></defs>
  <rect width="512" height="512" fill="url(#mk-bg)"/>
  ${nest(appIconGlyphOnly(), 92, 92, 328)}
</svg>`;

// The app icon's bubbles without its tile, for placing on the maskable background.
const appIconGlyphOnly = () => APP_ICON
    .replace(/<rect x="32" y="32"[^>]*\/>/, '')
    .replace(/viewBox="0 0 512 512"/, 'viewBox="84 88 344 344"');

const fontStyle = `<style>@font-face{font-family:'Outfit';src:url(data:font/woff2;base64,${FONT}) format('woff2');font-weight:300 700;}
  text{font-family:'Outfit',sans-serif}</style>`;

const glow = (id, color, opacity) => `<radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${opacity}"/>
  <stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;

const wordmark = (x, y, size, anchor = 'start', franca = COLORS.violet, lingua = COLORS.text) =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="700" letter-spacing="${-size * 0.02}" text-anchor="${anchor}">
      <tspan fill="${lingua}">Lingua</tspan><tspan fill="${franca}">Franca</tspan></text>`;

// GitHub link preview (Settings > Social preview), 1280 x 640.
const socialPreview = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640">
  <defs>${fontStyle}${glow('sp-v', COLORS.violet, 0.35)}${glow('sp-g', '#10b981', 0.18)}</defs>
  <rect width="1280" height="640" fill="${COLORS.bg}"/>
  <circle cx="290" cy="320" r="420" fill="url(#sp-v)"/>
  <circle cx="1120" cy="620" r="360" fill="url(#sp-g)"/>
  ${nest(LOGO_MARK, 120, 170, 300)}
  ${wordmark(480, 318, 104)}
  <text x="484" y="384" font-size="38" font-weight="400" fill="#cbd5e1">Real-time interpretation for any event</text>
  <text x="484" y="448" font-size="25" font-weight="400" fill="${COLORS.muted}">Human or AI interpreters&#160;&#160;·&#160;&#160;Listeners join by QR code&#160;&#160;·&#160;&#160;Local Wi-Fi</text>
</svg>`;

// README header, 1280 x 320.
const banner = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 320">
  <defs>${fontStyle}${glow('bn-v', COLORS.violet, 0.32)}${glow('bn-g', '#10b981', 0.14)}</defs>
  <rect width="1280" height="320" rx="28" fill="${COLORS.bg}"/>
  <circle cx="190" cy="160" r="300" fill="url(#bn-v)"/>
  <circle cx="1180" cy="320" r="260" fill="url(#bn-g)"/>
  ${nest(LOGO_MARK, 84, 60, 200)}
  ${wordmark(330, 168, 88)}
  <text x="334" y="226" font-size="32" font-weight="400" fill="#cbd5e1">Real-time interpretation for any event</text>
</svg>`;

// Windows installer welcome and finish pages: the tall image on the left, 164 x 314.
const installerSidebar = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 164 314">
  <defs>${fontStyle}
    <linearGradient id="sb-bg" x1="0" y1="0" x2="0" y2="314" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#241a46"/><stop offset="0.55" stop-color="${COLORS.surface}"/><stop offset="1" stop-color="${COLORS.bg}"/>
    </linearGradient>${glow('sb-v', COLORS.violet, 0.35)}</defs>
  <rect width="164" height="314" fill="url(#sb-bg)"/>
  <circle cx="82" cy="112" r="90" fill="url(#sb-v)"/>
  ${nest(LOGO_MARK, 30, 60, 104)}
  <text x="82" y="214" font-size="25" font-weight="700" text-anchor="middle" fill="${COLORS.text}">Lingua</text>
  <text x="82" y="242" font-size="25" font-weight="700" text-anchor="middle" fill="${COLORS.violet}">Franca</text>
  <text x="82" y="276" font-size="11.5" font-weight="400" text-anchor="middle" fill="${COLORS.muted}">Live interpretation</text>
  <text x="82" y="292" font-size="11.5" font-weight="400" text-anchor="middle" fill="${COLORS.muted}">for any event</text>
</svg>`;

// Windows installer page header: sits top-right on the installer's white header strip, 150 x 57.
const installerHeader = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 57">
  <defs>${fontStyle}</defs>
  <rect width="150" height="57" fill="#ffffff"/>
  ${nest(APP_ICON, 8, 8.5, 40)}
  <text x="54" y="26" font-size="16" font-weight="700" fill="${COLORS.bg}">Lingua</text>
  <text x="54" y="44" font-size="16" font-weight="700" fill="${COLORS.violetDeep}">Franca</text>
</svg>`;

/* ------------------------------------------------------------------ container formats */

// ICO with PNG-compressed entries (supported by Windows since Vista, including the shell).
function writeIco(file, images) {
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach(({ size, png }, index) => {
        const entry = 6 + 16 * index;
        header.writeUInt8(size >= 256 ? 0 : size, entry);
        header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
        header.writeUInt8(0, entry + 2);
        header.writeUInt8(0, entry + 3);
        header.writeUInt16LE(1, entry + 4);
        header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(png.length, entry + 8);
        header.writeUInt32LE(offset, entry + 12);
        offset += png.length;
    });
    fs.writeFileSync(file, Buffer.concat([header, ...images.map((image) => image.png)]));
}

// ICNS with PNG entries for every size macOS asks for, including the @2x variants.
function writeIcns(file, entries) {
    const chunks = entries.map(({ type, png }) => {
        const head = Buffer.alloc(8);
        head.write(type, 0, 'ascii');
        head.writeUInt32BE(png.length + 8, 4);
        return Buffer.concat([head, png]);
    });
    const head = Buffer.alloc(8);
    head.write('icns', 0, 'ascii');
    head.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
    fs.writeFileSync(file, Buffer.concat([head, ...chunks]));
}

// 24-bit BMP, which is what the NSIS installer pages accept.
function writeBmp(file, width, height, rgba) {
    const rowSize = Math.ceil((width * 3) / 4) * 4;
    const pixels = Buffer.alloc(rowSize * height);
    for (let y = 0; y < height; y += 1) {
        const target = (height - 1 - y) * rowSize;
        for (let x = 0; x < width; x += 1) {
            const sourceIndex = (y * width + x) * 4;
            pixels[target + x * 3] = rgba[sourceIndex + 2];
            pixels[target + x * 3 + 1] = rgba[sourceIndex + 1];
            pixels[target + x * 3 + 2] = rgba[sourceIndex];
        }
    }
    const header = Buffer.alloc(54);
    header.write('BM', 0, 'ascii');
    header.writeUInt32LE(54 + pixels.length, 2);
    header.writeUInt32LE(54, 10);
    header.writeUInt32LE(40, 14);
    header.writeInt32LE(width, 18);
    header.writeInt32LE(height, 22);
    header.writeUInt16LE(1, 26);
    header.writeUInt16LE(24, 28);
    header.writeUInt32LE(pixels.length, 34);
    header.writeInt32LE(2835, 38);
    header.writeInt32LE(2835, 42);
    fs.writeFileSync(file, Buffer.concat([header, pixels]));
}

/* ------------------------------------------------------------------ rendering */

let page;

// Draws an SVG at an exact pixel size. The root gets explicit width and height so Chromium
// rasterises the vector at that size instead of scaling a default-size bitmap.
async function render(svg, width, height = width, { raw = false } = {}) {
    const sized = svg.replace(/<svg\b/, `<svg width="${width}" height="${height}"`);
    const result = await page.webContents.executeJavaScript(`(async () => {
        const image = new Image();
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(sized)});
        await image.decode();
        // Embedded fonts can finish loading just after decode; give them a moment.
        await new Promise((resolve) => setTimeout(resolve, 150));
        const canvas = document.createElement('canvas');
        canvas.width = ${width}; canvas.height = ${height};
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0, ${width}, ${height});
        return ${raw}
            ? Array.from(context.getImageData(0, 0, ${width}, ${height}).data)
            : canvas.toDataURL('image/png');
    })()`);
    return raw ? Uint8Array.from(result) : Buffer.from(result.split(',')[1], 'base64');
}

// Below 48 px the simplified icon reads better than the full two-bubble design.
const iconFor = (size) => (size <= 40 ? APP_ICON_SMALL : APP_ICON);

async function generate() {
    const written = [];
    const save = (file, data) => { fs.writeFileSync(file, data); written.push(path.relative(root, file).split(path.sep).join('/')); };

    // Windows app, taskbar and installer icon.
    const icoSizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
    const ico = [];
    for (const size of icoSizes) ico.push({ size, png: await render(iconFor(size), size) });
    writeIco(out('build', 'icon.ico'), ico);
    written.push('build/icon.ico');

    // macOS app icon on Apple's grid.
    const icnsTypes = [
        ['icp4', 16], ['icp5', 32], ['ic11', 32], ['icp6', 64], ['ic12', 64], ['ic07', 128],
        ['ic08', 256], ['ic13', 256], ['ic09', 512], ['ic14', 512], ['ic10', 1024],
    ];
    const icns = [];
    for (const [type, size] of icnsTypes) icns.push({ type, png: await render(macIcon(size <= 32 ? APP_ICON_SMALL : APP_ICON), size) });
    writeIcns(out('build', 'icon.icns'), icns);
    written.push('build/icon.icns');

    // Linux, and the fallback electron-builder uses when an exact format is missing.
    save(out('build', 'icon.png'), await render(APP_ICON, 1024));

    // Windows installer artwork.
    writeBmp(out('build', 'installerSidebar.bmp'), 164, 314, await render(installerSidebar(), 164, 314, { raw: true }));
    fs.copyFileSync(out('build', 'installerSidebar.bmp'), out('build', 'uninstallerSidebar.bmp'));
    writeBmp(out('build', 'installerHeader.bmp'), 150, 57, await render(installerHeader(), 150, 57, { raw: true }));
    written.push('build/installerSidebar.bmp', 'build/uninstallerSidebar.bmp', 'build/installerHeader.bmp');

    // Browser tab and phone home screen.
    fs.copyFileSync(path.join(root, 'branding', 'app-icon-small.svg'), out('public', 'favicon.svg'));
    written.push('public/favicon.svg');
    const favicon = [];
    for (const size of [16, 32, 48]) favicon.push({ size, png: await render(iconFor(size), size) });
    writeIco(out('public', 'favicon.ico'), favicon);
    written.push('public/favicon.ico');
    save(out('public', 'apple-touch-icon.png'), await render(maskableIcon(), 180));
    save(out('public', 'icon-192.png'), await render(APP_ICON, 192));
    save(out('public', 'icon-512.png'), await render(APP_ICON, 512));
    save(out('public', 'icon-maskable-512.png'), await render(maskableIcon(), 512));

    // README header and GitHub link preview.
    save(out('docs', 'branding', 'banner.png'), await render(banner(), 1280, 320));
    save(out('docs', 'branding', 'social-preview.png'), await render(socialPreview(), 1280, 640));

    return written;
}

app.whenReady().then(async () => {
    page = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await page.loadURL('data:text/html,<!doctype html><title>icons</title>');
    const written = await generate();
    console.log(`Wrote ${written.length} files:\n  ${written.join('\n  ')}`);
    app.quit();
}).catch((error) => {
    console.error(error);
    app.exit(1);
});
