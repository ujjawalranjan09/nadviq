// Generates crisp SVG and PNG icons for NaviQ across all required dimensions.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  const puppeteerCache = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (fs.existsSync(puppeteerCache)) {
    const entries = fs.readdirSync(puppeteerCache);
    for (const entry of entries) {
      const candidates = [
        path.join(puppeteerCache, entry, 'chrome-win64', 'chrome.exe'),
        path.join(puppeteerCache, entry, 'chrome-win32', 'chrome.exe'),
        path.join(puppeteerCache, entry, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(puppeteerCache, entry, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(puppeteerCache, entry, 'chrome-linux64', 'chrome')
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      if (found) return found;
    }
  }

  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const hit = candidates.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error('Chrome not found');
  return hit;
}

const naviqSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="bgGlow" cx="50%" cy="30%" r="70%">
      <stop offset="0%" stop-color="#1e1b4b" />
      <stop offset="50%" stop-color="#0f172a" />
      <stop offset="100%" stop-color="#020617" />
    </radialGradient>
    <linearGradient id="neonGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="50%" stop-color="#818cf8" />
      <stop offset="100%" stop-color="#c084fc" />
    </linearGradient>
    <linearGradient id="needleGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f43f5e" />
      <stop offset="100%" stop-color="#fb7185" />
    </linearGradient>
    <linearGradient id="borderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.8" />
      <stop offset="50%" stop-color="#6366f1" stop-opacity="0.5" />
      <stop offset="100%" stop-color="#a855f7" stop-opacity="0.8" />
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="10" result="blur" />
      <feComposite in="SourceGraphic" in2="blur" operator="over" />
    </filter>
  </defs>

  <!-- Background squircle -->
  <rect x="24" y="24" width="464" height="464" rx="116" fill="url(#bgGlow)" stroke="url(#borderGrad)" stroke-width="8" />

  <!-- Outer Ring of Q -->
  <circle cx="248" cy="232" r="118" fill="none" stroke="url(#neonGrad)" stroke-width="32" stroke-linecap="round" filter="url(#glow)" />

  <!-- Inner Compass Rose / Navigation Core -->
  <!-- North needle -->
  <polygon points="248,140 262,220 248,232" fill="url(#needleGrad)" />
  <polygon points="248,140 234,220 248,232" fill="#be123c" />
  <!-- South needle -->
  <polygon points="248,324 262,244 248,232" fill="#94a3b8" />
  <polygon points="248,324 234,244 248,232" fill="#cbd5e1" />
  <!-- East needle -->
  <polygon points="340,232 260,246 248,232" fill="#94a3b8" />
  <polygon points="340,232 260,218 248,232" fill="#cbd5e1" />
  <!-- West needle -->
  <polygon points="156,232 236,246 248,232" fill="#94a3b8" />
  <polygon points="156,232 236,218 248,232" fill="#cbd5e1" />
  <!-- Center Pivot -->
  <circle cx="248" cy="232" r="14" fill="#ffffff" filter="url(#glow)" />

  <!-- Q Tail: Sleek Dynamic Navigation Arrow -->
  <path d="M 334 318 L 416 400" fill="none" stroke="url(#neonGrad)" stroke-width="36" stroke-linecap="round" filter="url(#glow)" />
  <path d="M 374 400 L 416 400 L 416 358" fill="none" stroke="url(#neonGrad)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)" />
</svg>
`;

const naviqLogoHorizontal = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 160" width="600" height="160">
  <defs>
    <linearGradient id="neonGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="50%" stop-color="#818cf8" />
      <stop offset="100%" stop-color="#c084fc" />
    </linearGradient>
  </defs>
  <!-- Mini Icon -->
  <g transform="translate(10, 10) scale(0.27)">
    <circle cx="248" cy="232" r="118" fill="none" stroke="url(#neonGrad)" stroke-width="34" stroke-linecap="round" />
    <polygon points="248,140 262,220 248,232" fill="#f43f5e" />
    <polygon points="248,140 234,220 248,232" fill="#be123c" />
    <polygon points="248,324 262,244 248,232" fill="#94a3b8" />
    <polygon points="248,324 234,244 248,232" fill="#cbd5e1" />
    <circle cx="248" cy="232" r="14" fill="#ffffff" />
    <path d="M 334 318 L 416 400" fill="none" stroke="url(#neonGrad)" stroke-width="36" stroke-linecap="round" />
    <path d="M 374 400 L 416 400 L 416 358" fill="none" stroke="url(#neonGrad)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round" />
  </g>
  <!-- NaviQ Brand Text -->
  <text x="160" y="94" font-family="system-ui, -apple-system, sans-serif" font-size="74" font-weight="800" fill="#ffffff" letter-spacing="-1">Navi<tspan fill="url(#neonGrad)">Q</tspan></text>
  <text x="164" y="128" font-family="system-ui, -apple-system, sans-serif" font-size="18" font-weight="500" fill="#94a3b8" letter-spacing="2">AI BROWSER ASSISTANT</text>
</svg>
`;

async function main() {
  const assetsDir = path.resolve(__dirname, '../assets');
  const extPublicDir = path.resolve(__dirname, '../../nanobrowser/public');
  const extBrandDir = path.resolve(extPublicDir, 'brand');

  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(extBrandDir, { recursive: true });

  fs.writeFileSync(path.join(assetsDir, 'icon.svg'), naviqSvg.trim());
  fs.writeFileSync(path.join(extBrandDir, 'logo.svg'), naviqLogoHorizontal.trim());

  console.log('Launching headless Chrome to rasterize icons...');
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  async function renderIcon(svgString, width, height, outPath) {
    const html = `<!doctype html>
      <html>
        <head>
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { background: transparent; width: ${width}px; height: ${height}px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
            svg { width: 100%; height: 100%; }
          </style>
        </head>
        <body>${svgString}</body>
      </html>`;
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: outPath, omitBackground: true });
    console.log(`Rendered: ${outPath} (${width}x${height})`);
  }

  // 1. Electron App Icons
  await renderIcon(naviqSvg, 256, 256, path.join(assetsDir, 'icon.png'));
  await renderIcon(naviqSvg, 32, 32, path.join(assetsDir, 'icon-32.png'));
  await renderIcon(naviqSvg, 128, 128, path.join(assetsDir, 'icon-128.png'));

  // 2. Extension Icons in nanobrowser/public
  await renderIcon(naviqSvg, 16, 16, path.join(extPublicDir, 'icon-16.png'));
  await renderIcon(naviqSvg, 32, 32, path.join(extPublicDir, 'icon-32.png'));
  await renderIcon(naviqSvg, 48, 48, path.join(extPublicDir, 'icon-48.png'));
  await renderIcon(naviqSvg, 128, 128, path.join(extPublicDir, 'icon-128.png'));

  // 3. Extension Brand Logos
  await renderIcon(naviqLogoHorizontal, 600, 160, path.join(extBrandDir, 'logo-horizontal.png'));

  await browser.close();
  console.log('All NaviQ icons successfully generated!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
