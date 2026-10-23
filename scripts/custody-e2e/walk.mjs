/**
 * Drives the real Secure your wallet section of Account > Security in Chrome,
 * with Chrome's virtual authenticator standing in for a phone's passkey. Clicks
 * Add a passkey, types the password, Make a passkey, then Sign with your
 * passkey, and fails on any error the page shows.
 *
 * Needs the dev server on http://localhost:3100 started with pin-env.cjs (see
 * README.md) and E2E_CHROME set to a Chrome or Chromium executable.
 *
 * Run: node scripts/custody-e2e/walk.mjs
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const puppeteer = createRequire(path.join(ROOT, 'package.json'))('puppeteer');
const state = JSON.parse(fs.readFileSync(path.join(HERE, 'state.json'), 'utf8'));
const BASE = 'http://localhost:3100';
const CHROME = process.env.E2E_CHROME;
if (!CHROME || !fs.existsSync(CHROME)) throw new Error('set E2E_CHROME to a Chrome or Chromium executable');

// The first dev compile of the dashboard can take minutes.
const browser = await puppeteer.launch({ executablePath: CHROME, protocolTimeout: 600000 });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 1400, deviceScaleFactor: 2 });

  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.setCookie({ name: 'flizy_session', value: state.token, domain: 'localhost', path: '/', httpOnly: true });

  const WAIT = { timeout: 300000 };
  const clickButton = async (label) => {
    await page.waitForFunction((x) => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === x && !b.disabled), WAIT, label);
    await page.evaluate((x) => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === x && !b.disabled).click(), label);
  };
  const failIfAlert = async () => {
    const alert = await page.evaluate(() => document.querySelector('[role="alert"]')?.innerText || '');
    if (alert) throw new Error('the page showed an error: ' + alert);
  };

  await page.goto(`${BASE}/dashboard/account?s=security`, { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.waitForFunction(() => document.body.innerText.toLowerCase().includes('secure your wallet'), WAIT);
  console.log('section shown');
  await page.screenshot({ path: path.join(HERE, '1-start.png'), fullPage: true });

  await clickButton('Add a passkey');
  await page.waitForSelector('input[placeholder="Account password"]', WAIT);
  await page.type('input[placeholder="Account password"]', state.password);
  await clickButton('Make a passkey');
  await page.waitForFunction(() => document.body.innerText.includes('One passkey on your wallet') || document.querySelector('[role="alert"]'), WAIT);
  await failIfAlert();
  console.log('step 1 done: passkey on the wallet');

  await clickButton('Sign with your passkey');
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Sign again') || document.querySelector('[role="alert"]'),
    WAIT
  );
  await failIfAlert();
  console.log('step 2 done: permissions signed');
  await page.screenshot({ path: path.join(HERE, '2-done.png'), fullPage: true });

  const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  console.log('virtual authenticator: credentials', creds.credentials.length, 'sign count', creds.credentials[0]?.signCount);
  const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  console.log(scrollWidth > innerWidth ? `FAIL horizontal scroll ${scrollWidth} > ${innerWidth}` : 'no horizontal scroll at 430px');
} finally {
  await browser.close();
}
