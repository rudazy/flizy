/**
 * Account profile matches the phone layout and does not invent figures.
 *
 * Run: node --test test/accountProfileUi.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PROFILE = fs.readFileSync(path.join(__dirname, '../web/components/AccountProfile.tsx'), 'utf8');
const PAGE = fs.readFileSync(path.join(__dirname, '../web/app/dashboard/account/page.tsx'), 'utf8');

describe('account profile layout', () => {
  it('shows the sections from the account screen', () => {
    for (const label of [
      'Account Information',
      'Flizy Wallet',
      'Stats & Social',
      'Privacy & Visibility',
      'Change banner',
      'Deactivate account',
      'Show trading stats',
      'Show followers & following',
      'Show activity',
      'Two-factor authentication',
      'GIWA · Ethereum',
    ]) {
      assert.match(PROFILE, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.equal(PROFILE.includes('\u2014'), false);
    for (const title of ['Flizy Wallet', 'Stats & Social', 'Privacy & Visibility', 'Security']) {
      assert.match(PROFILE, new RegExp(`dropdown[\\s\\S]{0,180}title="${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    }
    const infoAt = PROFILE.indexOf('title="Account Information"');
    const backgroundAt = PROFILE.indexOf('<AccountBackground');
    assert.equal(PROFILE.slice(infoAt, backgroundAt).includes('dropdown'), false);
  });

  it('uses the account counts and leaves unknown figures blank', () => {
    assert.match(PAGE, /invites=\{data\.invite\?\.attributed \?\? 0\}/);
    assert.match(PAGE, /credits=\{data\.invite\?\.credits \?\? 0\}/);
    assert.doesNotMatch(PROFILE, /24\.8K|386|1,284|42\.6K|ludaluda/);
    // Volume, swaps, followers and following stay blank until their own read succeeds.
    assert.match(PROFILE, /value=\{stats \? volumeText\(stats\.volumeEth\) : '-'\} label="Total volume"/);
    assert.match(PROFILE, /value=\{stats \? String\(stats\.swaps\) : '-'\} label="Swaps"/);
    assert.match(PROFILE, /value=\{social \? String\(social\.followers\) : '-'\}/);
    assert.match(PROFILE, /value=\{social \? String\(social\.following\) : '-'\}/);
    assert.match(PROFILE, /label="Followers"/);
    assert.match(PROFILE, /label="Following"/);
    assert.doesNotMatch(PROFILE, /Followers' volume/);
  });

  it('keeps the other account tools and the public mailboxes', () => {
    assert.match(PAGE, /AppSlideNav/);
    assert.doesNotMatch(PAGE, /PublicMailList/);
    for (const label of ['Projects', 'Pay me', 'Country', 'Chat', 'Platforms', 'Trusted', 'PIN', 'Limits', 'Security']) {
      assert.match(PAGE, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    for (const id of ['country', 'chat', 'platforms', 'trusted', 'pin', 'limits', 'security']) {
      assert.match(PAGE, new RegExp(`id: '${id}'`));
      assert.match(PROFILE, new RegExp(`\\['${id}'`));
    }
    assert.doesNotMatch(PROFILE, /executeSwap|sendTransaction/);
  });

  it('does not offer follow on your own profile', () => {
    assert.doesNotMatch(PROFILE, /onSoon\('Follow'\)/);
    assert.doesNotMatch(PROFILE, />\s*Follow\s*</);
  });

  it('opens deactivate through the sheet and does not offer delete', () => {
    assert.doesNotMatch(PROFILE, /onSoon\('Delete account'\)/);
    assert.doesNotMatch(PROFILE, /Delete account/);
    assert.match(PROFILE, /onDeactivate/);
    assert.match(PAGE, /AccountClosureSheet/);
    assert.match(PAGE, /action: 'deactivate'/);
    assert.doesNotMatch(PAGE, /action: 'delete'/);
    const sheet = fs.readFileSync(
      path.join(__dirname, '../web/components/AccountClosureSheet.tsx'),
      'utf8'
    );
    assert.match(sheet, /Deactivate/);
    assert.doesNotMatch(sheet, /Proceed to delete/);
    assert.doesNotMatch(sheet, /Delete account/);
    assert.doesNotMatch(sheet, /cannot be restored/);
    assert.equal(sheet.includes('\u2014'), false);
    assert.doesNotMatch(sheet, /console\.(log|debug|info)/);
  });
});
