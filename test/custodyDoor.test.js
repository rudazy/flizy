/**
 * Flagged Privy door. Off with no public app id. No server wallet, no secret,
 * and no claim that the account is already non-custodial.
 *
 * Run: node --test test/custodyDoor.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const SOURCES = [
  'web/lib/custodyDoor.ts',
  'web/components/CustodyDoor.tsx',
  'web/app/login/page.tsx',
  'web/app/login/LoginForm.tsx',
];

describe('custody door flag', () => {
  let door;
  let policy;
  const previous = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  before(async () => {
    door = await import('../web/lib/custodyDoor.ts');
    policy = await import('../web/lib/contentSecurityPolicy.mjs');
  });

  after(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;
    else process.env.NEXT_PUBLIC_PRIVY_APP_ID = previous;
  });

  it('stays off unless the public app id is a plain token', () => {
    for (const value of [undefined, null, '', '   ', 'short', 'bad id', 'https://evil.example', 'id.with.dots']) {
      assert.equal(door.custodyDoorAppId(value), '');
      assert.equal(door.custodyDoorEnabled(value), false);
      assert.equal(policy.privyDoorRequested(value), false);
    }
    assert.equal(door.custodyDoorAppId('clabc1234567'), 'clabc1234567');
    assert.equal(door.custodyDoorEnabled('clabc1234567'), true);
    assert.equal(policy.privyDoorRequested('clabc1234567'), true);
  });

  it('reads the public env and ignores a blank one', () => {
    delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;
    assert.equal(door.custodyDoorEnabled(), false);
    process.env.NEXT_PUBLIC_PRIVY_APP_ID = '  ';
    assert.equal(door.custodyDoorEnabled(), false);
    process.env.NEXT_PUBLIC_PRIVY_APP_ID = 'clabc1234567';
    assert.equal(door.custodyDoorAppId(), 'clabc1234567');
  });

  it('keeps the password form reachable and refuses an off-site next', () => {
    assert.equal(door.passwordLoginHref(null), '/login?door=password');
    assert.equal(door.passwordLoginHref('/dashboard'), '/login?door=password');
    assert.equal(
      door.passwordLoginHref('/dashboard/account'),
      '/login?next=%2Fdashboard%2Faccount&door=password'
    );
    assert.equal(door.passwordLoginHref('https://evil.example'), '/login?door=password');
    assert.equal(door.passwordLoginHref('//evil.example'), '/login?door=password');
    assert.equal(door.custodyDoorHref('/dashboard'), '/login');
    assert.equal(door.custodyDoorHref('https://evil.example'), '/login');
    assert.equal(
      door.custodyDoorHref('/dashboard/account?s=pin'),
      '/login?next=%2Fdashboard%2Faccount%3Fs%3Dpin'
    );
  });

  it('uses the public GIWA Sepolia endpoint and does not read a keyed RPC', () => {
    assert.equal(door.CUSTODY_DOOR_CHAIN.id, 91342);
    assert.equal(door.CUSTODY_DOOR_CHAIN.rpcUrl, 'https://sepolia-rpc.giwa.io');
    assert.doesNotMatch(read('web/lib/custodyDoor.ts'), /process\.env\.GIWA_RPC|PRIVY_APP_SECRET|PRIVY_AUTH_KEY/);
  });

  it('does not claim the account is already non-custodial', () => {
    const copy = JSON.stringify(door.CUSTODY_DOOR_COPY);
    assert.doesNotMatch(copy, /non-custodial/i);
    assert.doesNotMatch(copy, /you own your keys/i);
    assert.doesNotMatch(copy, /your control/i);
    assert.doesNotMatch(copy, /you control your keys/i);
    assert.doesNotMatch(copy, /own your assets/i);
    assert.doesNotMatch(copy, /truly own/i);
    assert.doesNotMatch(copy, /connect your existing wallet/i);
    assert.doesNotMatch(copy, /continue with a wallet/i);
    assert.match(copy, /not your Flizy account yet/);
    assert.match(copy, /Continue as guest/);
    assert.match(copy, /Continue with a passkey/);
    assert.match(copy, /Continue with email/);
    assert.match(copy, /This is not a Flizy account/);
    assert.doesNotMatch(copy, /\u2014/);
  });

  it('treats only a Privy guest as guest mode', () => {
    assert.equal(door.custodyDoorIsGuest(null), false);
    assert.equal(door.custodyDoorIsGuest({}), false);
    assert.equal(door.custodyDoorIsGuest({ isGuest: false }), false);
    assert.equal(door.custodyDoorIsGuest({ isGuest: true }), true);
  });
});

describe('custody door source', () => {
  it('keeps the password form, and the client never names a server wallet', () => {
    const page = read('web/app/login/page.tsx');
    const door = read('web/components/CustodyDoor.tsx');
    assert.match(page, /<LoginForm/);
    assert.match(page, /searchParams\?\.door === 'password'/);
    assert.match(door, /createOnLogin: 'users-without-wallets'/);
    assert.match(door, /Coming soon/);
    assert.doesNotMatch(door, /createGuestAccount|useGuestAccounts/);
    assert.doesNotMatch(door, /login\(/);
    assert.match(door, /loginMethods: \['passkey', 'email', 'google'\]/);
    assert.doesNotMatch(door, /loginMethods:[^\n]*wallet/);
    assert.doesNotMatch(door, /Continue with a wallet|connect your existing wallet/i);
    assert.doesNotMatch(door, /getEthereumProvider|eth_sendTransaction|\/api\/auth/);
    assert.match(door, /'passkey'/);
    assert.match(door, /'email'/);
    assert.match(door, /'google'/);
    assert.match(door, /#f7d043/);
    assert.match(door, /CUSTODY_DOOR_CHAIN\.rpcUrl/);
    assert.match(read('web/lib/custodyDoor.ts'), /https:\/\/sepolia-rpc\.giwa\.io/);
    const joined = SOURCES.map(read).join('\n');
    assert.doesNotMatch(joined, /PRIVY_APP_SECRET|PRIVY_AUTH_KEY|\/v1\/wallets|api\.privy\.io/);
    assert.doesNotMatch(joined, /non-custodial/i);
    assert.doesNotMatch(joined, /you own your keys/i);
    assert.doesNotMatch(joined, /\u2014/);
  });
});

describe('custody door policy', () => {
  let policy;

  before(async () => {
    policy = await import('../web/lib/contentSecurityPolicy.mjs');
  });

  it('leaves the policy unchanged when the door is off', () => {
    const header = policy.contentSecurityPolicy({ dev: false, dsn: '' });
    assert.doesNotMatch(header, /privy|walletconnect|walletlink/i);
    assert.equal(
      policy.permissionsPolicy(),
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
    );
  });

  it('names only the hosts this door uses when the door is on', () => {
    const header = policy.contentSecurityPolicy({ dev: false, dsn: '', privy: true });
    for (const host of [
      'https://auth.privy.io',
      'https://*.rpc.privy.systems',
      'https://sepolia-rpc.giwa.io',
    ]) {
      assert.ok(header.includes(host), host);
    }
    assert.match(header, /frame-src https:\/\/auth\.privy\.io/);
    assert.doesNotMatch(header, /walletconnect|walletlink/i);
    assert.doesNotMatch(header, /script-src[^;]*privy/);
    assert.doesNotMatch(header, /challenges\.cloudflare\.com|oauth\.telegram\.org|api\.relay\.link/);
    const permissions = policy.permissionsPolicy({ privy: true });
    assert.match(permissions, /publickey-credentials-get=\(self "https:\/\/auth\.privy\.io"\)/);
    assert.match(permissions, /publickey-credentials-create=\(self "https:\/\/auth\.privy\.io"\)/);
  });
});
