/**
 * Explore, Tasks: every tab, chip and slide opens something, and the artwork
 * the page points at is there. New task: the four steps never send more than
 * the server accepts, each step is checked before the next, the unbuilt
 * controls say Coming soon, and the live preview opens on tap.
 *
 * The page is a client component that needs a browser to render, so this reads
 * its source and the files it depends on, the same way test/walletHistorySlide
 * does for the bottom bar.
 *
 * Run: node --test test/exploreTasksUi.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const PAGE = read('app/dashboard/explore/page.tsx');

/** Width and height from a PNG header. */
function pngSize(rel) {
  const b = fs.readFileSync(path.join(WEB, rel));
  assert.equal(b.toString('hex', 0, 8), '89504e470d0a1a0a', `${rel} is not a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe('Explore Tasks artwork', () => {
  it('ships both images the page renders, at the size it draws them from', () => {
    for (const [rel, size] of [
      ['public/explore/tasks-hero.png', [338, 394]],
      ['public/explore/tasks-empty.png', [300, 235]],
    ]) {
      assert.deepEqual(pngSize(rel), size, rel);
      assert.ok(PAGE.includes(rel.replace('public', '')), `${rel} is not referenced by the page`);
    }
  });
});

describe('every control opens something', () => {
  it('has Live, Ended and My tasks, each selectable', () => {
    assert.match(PAGE, /label="Live" active=\{list === 'live'\} onClick=\{\(\) => setList\('live'\)\}/);
    assert.match(PAGE, /label="Ended" active=\{list === 'ended'\} onClick=\{\(\) => setList\('ended'\)\}/);
    assert.match(PAGE, /label="My tasks" active=\{list === 'mine'\} onClick=\{\(\) => setList\('mine'\)\}/);
    assert.match(PAGE, /list === 'mine' \? <ComingSoonPanel what="My tasks" \/>/);
  });

  it('lets every category chip be chosen, and the rest open Coming soon', () => {
    for (const label of ['All', 'Airdrop', 'Social', 'On-chain', 'Content', 'Partner']) {
      assert.match(PAGE, new RegExp(`label: '${label}'`), `${label} chip is missing`);
    }
    assert.match(PAGE, /onClick=\{\(\) => setCategory\(c\.id\)\}/);
    assert.match(PAGE, /category !== 'all' \? \(\s*<ComingSoonPanel/);
  });

  it('opens each of the four hero slides from its dot', () => {
    assert.match(PAGE, /const HERO_SLIDES = 4;/);
    assert.match(PAGE, /onClick=\{\(\) => setSlide\(i\)\}/);
    assert.match(PAGE, /slide === 0 \?/);
  });
});

describe('small controls keep a 44px tap area', () => {
  const css = read('app/globals.css');

  it('defines the tap-area classes', () => {
    assert.match(css, /\.hit-44::after \{\s*width: max\(100%, 44px\);\s*height: max\(100%, 44px\);/);
    assert.match(css, /\.hit-y-44::after \{\s*width: 100%;\s*height: max\(100%, 44px\);/);
  });

  it('uses them on the controls drawn under 44px', () => {
    assert.ok((PAGE.match(/hit-y-44/g) || []).length >= 7, 'Explore controls lost their tap area');
    assert.match(read('components/AppTopBar.tsx'), /hit-44 flex h-\[34px\] w-\[34px\]/);
    assert.match(read('components/AppSection.tsx'), /hit-y-44 flex h-\[35px\]/);
  });
});

describe('New task page', () => {
  const NEW = read('app/dashboard/explore/new/page.tsx');
  const TASKS = read('lib/tasks.ts');

  it('never lets the form send more than the server accepts', () => {
    const title = Number(NEW.match(/const TITLE_MAX = (\d+);/)[1]);
    const description = Number(NEW.match(/const DESCRIPTION_MAX = (\d+);/)[1]);
    const serverTitle = Number(TASKS.match(/title\.length > (\d+)\) throw new ClientError\('Title must be/)[1]);
    const serverDescription = Number(TASKS.match(/description\.length > (\d+)\) throw new ClientError\('Description is too long/)[1]);
    assert.ok(title <= serverTitle, `title ${title} > server ${serverTitle}`);
    assert.ok(description <= serverDescription, `description ${description} > server ${serverDescription}`);
    assert.match(NEW, /maxLength=\{TITLE_MAX\}/);
    assert.match(NEW, /maxLength=\{DESCRIPTION_MAX\}/);
  });

  it('marks the controls that are not built yet as coming soon instead of doing nothing', () => {
    assert.match(NEW, /onHelp=\{\(\) => comingSoon\('Help'\)\}/);
    assert.match(NEW, /onClick=\{\(\) => comingSoon\('More requirements'\)\}/);
    assert.match(NEW, /onClick=\{\(\) => comingSoon\('Distribution'\)\}/);
    // There is no participant cap, so this is a statement, not a control that
    // is waiting to be built.
    assert.match(NEW, /No participant cap\./);
    assert.doesNotMatch(NEW, /comingSoon\('Entry limit'\)/);
    // Points has no server support, so its chip must not choose a reward kind.
    assert.match(NEW, /\{ label: 'Points', kind: null \}/);
    assert.match(NEW, /if \(!chip\.kind\) \{\s*comingSoon\(chip\.label\);\s*return;/);
  });

  it('only offers reward kinds the server accepts', () => {
    const server = TASKS.match(/const REWARD_KINDS = new Set\(\[([^\]]+)\]\)/)[1];
    const chips = NEW.match(/const REWARD_CHIPS = \[([\s\S]*?)\] as const;/)[1];
    for (const [, kind] of chips.matchAll(/kind: '([a-z_]+)'/g)) {
      assert.ok(server.includes(`'${kind}'`), `${kind} is not a reward kind the server accepts`);
    }
  });

  it('runs four steps, each checked before the next, with Back on every step after the first', () => {
    assert.match(NEW, /const STEPS = \['Details', 'Reward', 'Rules', 'Review'\] as const;/);
    assert.match(NEW, /const problem = problemWith\(step\);\s*if \(problem\) \{\s*setError\(problem\);\s*return;/);
    assert.match(NEW, /\{step > 1 \? \(\s*<button\s+type="button"\s+onClick=\{\(\) => goTo\(step - 1\)\}/);
    // Publishing re-checks every step, since an earlier one can be reopened.
    assert.match(NEW, /for \(const n of \[1, 2, 3\]\) \{\s*const problem = problemWith\(n\);/);
  });

  it('only sends link kinds the database allows', () => {
    const sql = fs.readFileSync(
      path.join(__dirname, '..', 'supabase', 'migrations', '20260925010000_tasks.sql'),
      'utf8'
    );
    const allowed = sql.match(/task_links_kind_check check \(kind in \(([^)]+)\)\)/)[1];
    for (const kind of ['website', 'custom']) {
      assert.ok(allowed.includes(`'${kind}'`), `${kind} is not an allowed link kind`);
    }
    assert.match(NEW, /kind: links\.length \? 'custom' : 'website'/);
  });

  it('sends someone with no project to create one, rather than a dead card', () => {
    assert.match(NEW, /if \(!projects\.length\) \{\s*router\.push\('\/dashboard\/account\?s=projects'\);/);
  });

  it('has a live preview on every step that starts closed and shows the steps reached so far', () => {
    assert.match(NEW, /const \[previewOpen, setPreviewOpen\] = useState\(false\);/);
    assert.match(NEW, /onClick=\{\(\) => setPreviewOpen\(\(open\) => !open\)\}/);
    assert.match(NEW, /aria-expanded=\{previewOpen\}/);
    assert.match(
      NEW,
      /\{previewOpen \? \(\s*<div id="task-preview"[^>]*>\s*<Summary groups=\{summary\.filter\(\(g\) => g\.step <= step\)\} \/>\s*<TaskCard preview task=\{previewOf\(\)\} \/>/
    );
    // Outside every step block, so no step renders without it.
    const preview = NEW.indexOf('aria-controls="task-preview"');
    assert.ok(preview > NEW.lastIndexOf('{step === 4 ? ('), 'the live preview is inside a single step');
  });

  it('renders the preview card as a plain card, not a link to a task that does not exist', () => {
    const card = read('components/TaskCard.tsx');
    assert.match(card, /if \(preview\) \{\s*return <div className="card overflow-hidden p-0">\{body\}<\/div>;/);
  });
});
