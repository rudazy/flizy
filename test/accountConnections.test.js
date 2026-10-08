/**
 * Account Chat, Platforms and Trusted slides: the gates they keep and the
 * colours they may use.
 *
 * Run: node --test test/accountConnections.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const CONNECT = read('components/AccountConnections.tsx');
const PLATFORMS = read('components/LinkedAccounts.tsx');
const PAGE = read('app/dashboard/account/page.tsx');

describe('Chat apps', () => {
  it('unlinking asks for the password in a form, so Enter submits it', () => {
    assert.match(CONNECT, /export function ConfirmPassword[\s\S]*?<form[\s\S]*?onSubmit=\{\(e\) => \{\s*e\.preventDefault\(\);\s*onSubmit\(\);/);
    assert.match(CONNECT, /disabled=\{busy \|\| !value\}/);
    assert.match(PAGE, /onConfirmUnlink=\{\(channel\) => void onUnlinkChat\(channel\)\}/);
  });

  it('starting a link still marks the app the page waits for', () => {
    assert.match(PAGE, /onStart=\{\(channel\) => \{\s*markAwaitingChatLink\(channel\);\s*setAwaitingChat\(channel\);/);
  });
});

describe('Platforms', () => {
  it('Link still starts OAuth, and X stays gated both ways', () => {
    assert.match(PLATFORMS, /href=\{p\.startHref\}/);
    assert.match(PLATFORMS, /<GhostButton disabled=\{busy \|\| p\.channel === 'x'\}/);
    assert.match(PLATFORMS, /disabled\s+title="X linking is temporarily unavailable"/);
  });
});

describe('Trusted wallets', () => {
  it('keeps the note on an address that came from chat', () => {
    assert.match(CONNECT, /This address came from a request in your chat app\. Check it matches who you meant to pay before saving\./);
    assert.match(PAGE, /fromChat=\{Boolean\(ticket\)\}/);
  });

  it('Save opens a sheet that asks for the password, then saves with it', () => {
    // A bad address is caught before the password is asked for.
    assert.match(CONNECT, /if \(!\/\^0x\[0-9a-fA-F\]\{40\}\$\/\.test\(cleanAddress\)\) \{[\s\S]*?return;\s*\}\s*setAddressProblem\(''\);\s*onSave\(\);/);
    assert.match(CONNECT, /\{confirmingSave \? \(\s*<WalletPasswordSheet\s*mode="save"/);
    // The chat-request warning is repeated where the password is given.
    assert.match(CONNECT, /\{saving && fromChat \? \(/);
    assert.match(PAGE, /onSave=\{onAddTrusted\}/);
    assert.match(PAGE, /const ok = await addTrusted\(\{ address: addr, label, password, ticket \}\);/);
    // No password field on the form any more.
    assert.doesNotMatch(PAGE, /onPassword=\{setPassword\}/);
  });

  it('Delete opens a sheet that asks for the password, then deletes that wallet', () => {
    assert.match(CONNECT, /onClick=\{\(\) => onRemove\(t\.address\)\}\s*aria-haspopup="dialog"/);
    assert.match(CONNECT, /\{removing \? \(\s*<WalletPasswordSheet\s*mode="delete"/);
    assert.match(CONNECT, /role="dialog"\s*aria-modal="true"/);
    assert.match(CONNECT, /if \(password && !busy\) onConfirm\(password\);/);
    assert.match(CONNECT, /disabled=\{busy \|\| !password\}/);
    assert.match(PAGE, /const ok = await removeTrusted\(removing, password\);/);
    // No page-level remove password left over from the old flow.
    assert.doesNotMatch(PAGE, /removePassword/);
  });

  it('the sheet renders on the body, so the phone bottom nav cannot cover its buttons', () => {
    assert.match(CONNECT, /export function PasswordSheet[\s\S]*?return createPortal\(/);
    assert.match(CONNECT, /function WalletPasswordSheet[\s\S]*?<PasswordSheet/);
    // The password field takes focus unless the caller opts out (password change starts on New password).
    assert.match(CONNECT, /focusPassword = true,/);
    assert.match(CONNECT, /autoFocus=\{focusPassword\} \/>/);
    assert.match(CONNECT, /<\/div>,\s*document\.body\s*\);/);
  });
});

describe('Look', () => {
  it('uses no blue: no blue hex, no blue Tailwind colour', () => {
    for (const [name, src] of [['AccountConnections', CONNECT], ['LinkedAccounts', PLATFORMS]]) {
      assert.doesNotMatch(src, /(text|bg|border)-(blue|sky|cyan|indigo|teal)-/, name);
      for (const m of src.matchAll(/#([0-9a-f]{6})\b/gi)) {
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
        assert.ok(!(b > r + 20 && b > g), `${name} ${m[0]} leans blue`);
      }
    }
  });

  it('the art and brand tiles ship with the site', () => {
    for (const f of ['chat-hero', 'platforms-hero', 'trusted-hero', 'tile-whatsapp', 'tile-telegram', 'tile-github', 'tile-discord', 'tile-x']) {
      const file = path.join(WEB, 'public', 'account', `${f}.webp`);
      assert.ok(fs.existsSync(file), f);
      assert.ok(fs.statSync(file).size < 40_000, `${f} is small`);
    }
  });
});
