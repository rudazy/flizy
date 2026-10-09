/**
 * Token logos: FLZ and every listed token carry one, wherever a token is drawn.
 *
 * A logo is matched by contract whenever one is known, so a token someone
 * deploys under the name IZY never borrows IZY's art in a wallet.
 *
 * Run: node --test test/tokenLogos.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { LISTED_TOKENS } = require('../lib/listedTokens');

const FLZ = '0x308be8f71DA695f18E70D2243a446e1fD1566BA6';
const LOOKALIKE = '0x2222222222222222222222222222222222222222';

let logos;
before(async () => {
  logos = await import('../web/lib/tokenLogos.ts');
});

describe('logo files', () => {
  it('ship for FLZ and every listed token, under web/public', () => {
    for (const src of [logos.FLZ_LOGO, ...LISTED_TOKENS.map((t) => t.logo)]) {
      assert.match(src, /^\/tokens\/[a-z]+\.(svg|webp)$/);
      assert.ok(fs.existsSync(path.join(ROOT, 'web', 'public', src)), src);
    }
  });

  it('use no blue: the SVG marks stay in the gold and neutral palette', () => {
    for (const src of [logos.FLZ_LOGO, ...LISTED_TOKENS.map((t) => t.logo)].filter((s) => s.endsWith('.svg'))) {
      const svg = read(path.join('web', 'public', src));
      assert.doesNotMatch(svg, /<script|href=|xlink/i, src);
      for (const hex of svg.match(/#[0-9a-f]{6}/gi) || []) {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        assert.ok(!(b > r && b > g), `${src} uses a blue colour ${hex}`);
      }
    }
  });

  it('keep DCAT as a small WebP', () => {
    const file = fs.readFileSync(path.join(ROOT, 'web', 'public', 'tokens', 'dcat.webp'));
    assert.equal(file.toString('ascii', 0, 4), 'RIFF');
    assert.equal(file.toString('ascii', 8, 12), 'WEBP');
    assert.ok(file.length < 20000, String(file.length));
  });
});

describe('tokenLogo', () => {
  it('finds FLZ and listed tokens by symbol, in any casing', () => {
    assert.equal(logos.tokenLogo('flz'), logos.FLZ_LOGO);
    for (const token of LISTED_TOKENS) assert.equal(logos.tokenLogo(token.symbol.toLowerCase()), token.logo);
    assert.equal(logos.tokenLogo('ETH'), null);
    assert.equal(logos.tokenLogo(''), null);
  });

  it('matches by contract when one is given, and never by the symbol then', () => {
    assert.equal(logos.tokenLogo('anything', FLZ.toLowerCase()), logos.FLZ_LOGO);
    for (const token of LISTED_TOKENS) assert.equal(logos.tokenLogo(null, token.address.toLowerCase()), token.logo);
    assert.equal(logos.tokenLogo('IZY', LOOKALIKE), null);
    assert.equal(logos.tokenLogo('FLZ', LOOKALIKE), null);
  });
});

describe('where tokens are drawn', () => {
  it('uses the logo in Explore, Home, the swap picker, the wallet and the token page', () => {
    assert.match(read('web/components/ExploreTokens.tsx'), /const src = tokenLogo\(symbol\);/);
    assert.match(read('web/components/TrendingTokens.tsx'), /const src = tokenLogo\(symbol\);/);
    assert.match(read('web/app/dashboard/swap/page.tsx'), /const src = tokenLogo\(token\);/);
    // The wallet passes the contract, so a look-alike symbol gets no logo.
    assert.match(read('web/components/WalletBalances.tsx'), /const logoSrc = tokenLogo\(t\.symbol, t\.address\);/);
    const detail = read('web/components/TokenDetail.tsx');
    assert.match(detail, /const logoSrc = profile\?\.logo \|\| \(listed \? tokenLogo\('FLZ'\) : contract \? tokenLogo\(null, contract\) : null\);/);
    assert.match(detail, /logo=\{logoSrc\}/);
  });
});

describe('Home trending strip', () => {
  it('slides the chips in a loop, pausing on hover and focus', () => {
    const card = read('web/components/TrendingTokens.tsx');
    assert.match(card, /<div className="token-marquee flex w-max">/);
    assert.match(card, /<div className="token-marquee-copy flex gap-\[5px\] pr-\[5px\]" aria-hidden>/);
    assert.match(card, /tabIndex=\{copy \? -1 : undefined\}\n\s*aria-hidden=\{copy \|\| undefined\}/);
    const css = read('web/app/globals.css');
    assert.match(css, /@keyframes tokenMarquee \{\s*from \{\s*transform: translateX\(0\);\s*\}\s*to \{\s*transform: translateX\(-50%\);/);
    assert.match(css, /\.token-marquee:hover,\n\.token-marquee:focus-within \{\n\s*animation-play-state: paused;/);
  });

  it('stops sliding for reduced motion and drops the copy', () => {
    const css = read('web/app/globals.css');
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.match(block, /\.token-marquee \{\s*animation: none;/);
    assert.match(block, /\.token-marquee-copy \{\s*display: none;/);
  });
});
