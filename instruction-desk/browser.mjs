import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXT_PATH = path.resolve(__dirname, '../nanobrowser/dist');

export function getChromeUserDataDir() {
  if (process.platform === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Google',
      'Chrome',
      'User Data'
    );
  } else if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  return path.join(os.homedir(), '.config', 'google-chrome');
}

export function getChromeProfiles() {
  const chromeDir = getChromeUserDataDir();
  const localStatePath = path.join(chromeDir, 'Local State');
  const profiles = [
    {
      id: 'default-isolated',
      name: 'NaviQ Clean Browser (Isolated)',
      email: '',
      isDefault: false
    }
  ];

  if (fs.existsSync(localStatePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
      const cache = data.profile?.info_cache || {};
      for (const [key, info] of Object.entries(cache)) {
        profiles.push({
          id: key,
          name: info.name || key,
          email: info.user_name || '',
          avatar: info.avatar_icon || '',
          isDefault: key === 'Default'
        });
      }
    } catch (err) {
      console.warn('[browser] failed to parse Chrome Local State:', err);
    }
  }

  return profiles;
}

export function getNaviQProfilesDir() {
  const baseDir =
    process.env.APPDATA ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : path.join(os.homedir(), '.config'));
  return path.join(baseDir, 'NaviQ', 'chrome-profiles');
}

function seedProfileData(sourceProfileKey, targetUserDataDir) {
  const chromeDir = getChromeUserDataDir();
  const srcProfileDir = path.join(chromeDir, sourceProfileKey);
  const targetDefaultSubdir = path.join(targetUserDataDir, 'Default');

  if (!fs.existsSync(srcProfileDir)) return;

  fs.mkdirSync(targetDefaultSubdir, { recursive: true });

  // Copy Local State if not present
  const targetLocalState = path.join(targetUserDataDir, 'Local State');
  if (!fs.existsSync(targetLocalState)) {
    const srcLocalState = path.join(chromeDir, 'Local State');
    if (fs.existsSync(srcLocalState)) {
      try {
        fs.copyFileSync(srcLocalState, targetLocalState);
      } catch {}
    }
  }

  // Seed Preferences, Bookmarks, and search engines if not already present
  const seedFiles = ['Bookmarks', 'Preferences', 'Secure Preferences'];
  for (const f of seedFiles) {
    const targetFile = path.join(targetDefaultSubdir, f);
    if (!fs.existsSync(targetFile)) {
      const srcFile = path.join(srcProfileDir, f);
      if (fs.existsSync(srcFile)) {
        try {
          fs.copyFileSync(srcFile, targetFile);
        } catch {}
      }
    }
  }
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

  // 1. Check Chrome for Testing in ~/.cache/puppeteer/chrome
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

  // 2. Fall back to system Chrome
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser'
          ];
  const hit = candidates.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error('Chrome not found. Set the CHROME_PATH environment variable to your chrome.exe.');
  return hit;
}

let browserInstance = null;
let activeProfileId = 'default-isolated';

export async function launchBrowserWithExtension(profileId = 'default-isolated') {
  const chosenProfile = profileId || 'default-isolated';

  if (browserInstance?.connected) {
    if (activeProfileId === chosenProfile) {
      return browserInstance;
    }
    // Switch to selected profile: close active browser first
    await closeBrowser();
  }

  if (!fs.existsSync(EXT_PATH)) {
    throw new Error(`NaviQ extension build missing at ${EXT_PATH}. Run pnpm build in nanobrowser.`);
  }

  // Safe folder name for profile
  const safeProfileName = chosenProfile.replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetUserDataDir = path.join(getNaviQProfilesDir(), safeProfileName);
  fs.mkdirSync(targetUserDataDir, { recursive: true });

  if (chosenProfile !== 'default-isolated') {
    seedProfileData(chosenProfile, targetUserDataDir);
  }

  browserInstance = await puppeteer.launch({
    executablePath: findChrome(),
    userDataDir: targetUserDataDir,
    headless: false,
    defaultViewport: null,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--load-extension=${EXT_PATH}`,
      `--disable-extensions-except=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized'
    ]
  });

  activeProfileId = chosenProfile;

  browserInstance.on('disconnected', () => {
    browserInstance = null;
  });

  return browserInstance;
}

export function getActiveProfileId() {
  return activeProfileId;
}

export async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}
