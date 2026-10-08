/**
 * The project workspace rules, driven through web/lib/tasks.ts: who may publish
 * for a project and edit it, who may manage members, the five-live-task cap per
 * project, XP awarded to winners and the leaderboard it builds, and the
 * project picture check.
 *
 * The fake has no triggers or CHECK constraints, so the database side of these
 * rules (tasks_project_live_cap, projects_image_format) is not proven here;
 * this proves the application's own decisions.
 *
 * Run: node --test test/projectWorkspace.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

let T;
let fake;

before(async () => {
  T = await import('../web/lib/tasks.ts');
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const OWNER = 'acc-owner';
const MEMBER = 'acc-member';
const STRANGER = 'acc-stranger';
const FAN = 'acc-fan';
const PROJECT = 'p-1';

function seed() {
  fake = createFakeSupabase(
    {
      accounts: [
        { id: OWNER, username: 'owner', is_admin: false },
        { id: MEMBER, username: 'member', is_admin: false },
        { id: STRANGER, username: 'stranger', is_admin: false },
        { id: FAN, username: 'fan', is_admin: false },
      ],
      projects: [
        { id: PROJECT, owner_account_id: OWNER, handle: 'teamone', name: 'Team One', description: '', links: [], image: null },
      ],
      project_members: [{ id: 'm-1', project_id: PROJECT, account_id: MEMBER, created_at: '2026-10-01T00:00:00.000Z' }],
      tasks: [],
      task_requirements: [],
      task_links: [],
      task_submissions: [],
      task_winners: [],
      channel_identities: [],
      reserved_usernames: [],
    },
    { sequences: { tasks: 'ref' } }
  );
}

const c = () => fake.client;
const future = () => new Date(Date.now() + 3600e3).toISOString();
const table = (name) => fake.db.tables[name] || [];

function publish(accountId, overrides = {}) {
  return T.createTask(
    accountId,
    {
      title: 'Write a thread about wallets',
      description: 'Explain it plainly.',
      rewardKind: 'custom',
      rewardDisplay: '10 WL spots',
      winnersCount: 2,
      endsAt: future(),
      projectId: PROJECT,
      requirements: [{ kind: 'x_post', label: 'Submit the post URL' }],
      ...overrides,
    },
    c()
  );
}

function closeTask(ref) {
  table('tasks').find((t) => t.ref === ref).ends_at = new Date(Date.now() - 60e3).toISOString();
}

const dataUrl = (kind, bytes) => `data:image/${kind};base64,${Buffer.from(bytes).toString('base64')}`;
const PNG = dataUrl('png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2]);
const WEBP = dataUrl('webp', [...Buffer.from('RIFF'), 20, 0, 0, 0, ...Buffer.from('WEBPVP8 '), 1, 2]);

describe('who may act for a project', () => {
  beforeEach(seed);

  it('lets the owner and a member publish for it, and nobody else', async () => {
    await publish(OWNER);
    await publish(MEMBER);
    await assert.rejects(() => publish(STRANGER), { message: 'That project is not yours.' });
    assert.equal(table('tasks').length, 2);
  });

  it('gives the workspace to the owner and a member, and null to anyone else', async () => {
    const owner = await T.getProjectWorkspace(OWNER, 'teamone', c());
    const member = await T.getProjectWorkspace(MEMBER, 'teamone', c());
    assert.equal(owner.role, 'owner');
    assert.equal(member.role, 'member');
    assert.equal(await T.getProjectWorkspace(STRANGER, 'teamone', c()), null);
    assert.equal(await T.getProjectWorkspace(OWNER, 'nosuchproject', c()), null);
    assert.deepEqual(owner.members, [
      { username: 'owner', role: 'owner' },
      { username: 'member', role: 'member' },
    ]);
    assert.equal(Object.hasOwn(owner, 'owner_account_id'), false);
  });

  it('lists a joined project for the member, marked as such', async () => {
    const [row] = await T.listOwnProjects(MEMBER, c());
    assert.equal(row.handle, 'teamone');
    assert.equal(row.role, 'member');
    const [own] = await T.listOwnProjects(OWNER, c());
    assert.equal(own.role, 'owner');
  });

  it('lets the owner and a member edit details, and refuses a stranger', async () => {
    await T.updateProject(MEMBER, 'teamone', { description: 'Now with a description.' }, c());
    const saved = await T.updateProject(OWNER, 'teamone', { name: 'Team Two' }, c());
    assert.equal(saved.name, 'Team Two');
    assert.equal(table('projects')[0].description, 'Now with a description.');
    await assert.rejects(() => T.updateProject(STRANGER, 'teamone', { name: 'Taken' }, c()), {
      message: 'Project not found.',
    });
    assert.equal(table('projects')[0].handle, 'teamone');
  });

  it('applies the brand rule to a new name only', async () => {
    await assert.rejects(() => T.updateProject(MEMBER, 'teamone', { name: 'Flizy Rewards' }, c()), {
      message: 'Names and titles cannot use the Flizy name.',
    });
    table('projects')[0].name = 'Flizy';
    // Same name as stored: a member can still save other details.
    await T.updateProject(MEMBER, 'teamone', { name: 'Flizy', description: 'Edited.' }, c());
    assert.equal(table('projects')[0].description, 'Edited.');
  });

  it('lets only the owner add and remove members', async () => {
    await assert.rejects(() => T.addProjectMember(MEMBER, 'teamone', 'fan', c()), {
      message: 'Only the project owner can manage members.',
    });
    await assert.rejects(() => T.addProjectMember(STRANGER, 'teamone', 'fan', c()), { message: 'Project not found.' });

    const added = await T.addProjectMember(OWNER, 'teamone', '@fan', c());
    assert.deepEqual(added.map((m) => m.username), ['owner', 'member', 'fan']);
    await assert.rejects(() => T.addProjectMember(OWNER, 'teamone', 'owner', c()), {
      message: 'You already own this project.',
    });
    await assert.rejects(() => T.addProjectMember(OWNER, 'teamone', 'nobodyhere', c()), {
      message: 'No Flizy account has that username.',
    });

    await assert.rejects(() => T.removeProjectMember(MEMBER, 'teamone', 'fan', c()), {
      message: 'Only the project owner can manage members.',
    });
    const removed = await T.removeProjectMember(OWNER, 'teamone', 'member', c());
    assert.deepEqual(removed.map((m) => m.username), ['owner', 'fan']);
    await assert.rejects(() => publish(MEMBER), { message: 'That project is not yours.' });
  });

  it('lets a member leave, and nothing more', async () => {
    await T.addProjectMember(OWNER, 'teamone', 'fan', c());
    await assert.rejects(() => T.removeProjectMember(MEMBER, 'teamone', 'fan', c()), {
      message: 'Only the project owner can manage members.',
    });
    await assert.rejects(() => T.removeProjectMember(MEMBER, 'teamone', 'owner', c()), {
      message: 'Only the project owner can manage members.',
    });
    const left = await T.removeProjectMember(MEMBER, 'teamone', 'member', c());
    assert.deepEqual(left.map((m) => m.username), ['owner', 'fan']);
    assert.equal(await T.getProjectWorkspace(MEMBER, 'teamone', c()), null);
    assert.deepEqual(await T.listOwnProjects(MEMBER, c()), []);
    await assert.rejects(() => T.removeProjectMember(STRANGER, 'teamone', 'stranger', c()), {
      message: 'Project not found.',
    });
  });

  it('bounds how many projects one account can be added to', async () => {
    for (let i = 0; i < T.MAX_PROJECTS_JOINED_PER_ACCOUNT; i += 1) {
      table('project_members').push({ id: `m-f${i}`, project_id: `p-f${i}`, account_id: FAN });
    }
    await assert.rejects(() => T.addProjectMember(OWNER, 'teamone', 'fan', c()), {
      message: 'That account is on too many projects.',
    });
  });

  it('caps a project at its member limit', async () => {
    for (let i = 0; i < T.MAX_MEMBERS_PER_PROJECT - 1; i += 1) {
      table('project_members').push({ id: `m-x${i}`, project_id: PROJECT, account_id: `acc-x${i}` });
    }
    await assert.rejects(() => T.addProjectMember(OWNER, 'teamone', 'fan', c()), {
      message: `A project can have ${T.MAX_MEMBERS_PER_PROJECT} members.`,
    });
  });
});

describe('live tasks per project', () => {
  beforeEach(seed);

  it('refuses a sixth live task, and frees a slot when one ends', async () => {
    const refs = [];
    for (let i = 0; i < T.MAX_LIVE_TASKS_PER_PROJECT; i += 1) refs.push((await publish(i % 2 ? MEMBER : OWNER)).ref);
    await assert.rejects(() => publish(OWNER), /This project has 5 live tasks/);
    closeTask(refs[0]);
    await publish(OWNER);
    assert.equal(table('tasks').length, T.MAX_LIVE_TASKS_PER_PROJECT + 1);
  });

  it('does not count project tasks against the personal live ceiling', async () => {
    for (let i = 0; i < T.MAX_LIVE_TASKS_PER_ACCOUNT; i += 1) {
      table('tasks').push({
        id: `t-x${i}`,
        ref: 900 + i,
        creator_account_id: OWNER,
        project_id: `p-other${i}`,
        status: 'live',
        ends_at: future(),
        created_at: '2026-01-01T00:00:00.000Z',
      });
    }
    const { ref } = await publish(OWNER, { projectId: null });
    assert.ok(ref);
  });
});

describe('XP', () => {
  beforeEach(seed);

  it('is refused on a personal task and outside 1..100000', async () => {
    await assert.rejects(() => publish(OWNER, { projectId: null, xpReward: 50 }), {
      message: 'XP can only be set on a project task.',
    });
    for (const xpReward of [0, -5, 1.5, 100001, 'lots']) {
      await assert.rejects(() => publish(OWNER, { xpReward }), /XP must be a whole number/, String(xpReward));
    }
    assert.equal(table('tasks').length, 0);
  });

  it('goes to each winner, is kept when the task changes, and builds the leaderboard', async () => {
    const first = await publish(OWNER, { xpReward: 300 });
    const second = await publish(MEMBER, { xpReward: 100 });
    assert.equal(table('tasks')[0].xp_reward, 300);

    await T.submitToTask(FAN, first.ref, { url: 'https://x.com/fan/status/1111111111' }, c());
    await T.submitToTask(STRANGER, first.ref, { url: 'https://x.com/stranger/status/2222222222' }, c());
    await T.submitToTask(STRANGER, second.ref, { url: 'https://x.com/stranger/status/3333333333' }, c());
    closeTask(first.ref);
    closeTask(second.ref);

    const a = (await T.listSubmissionsForCreator(OWNER, first.ref, c())).submissions;
    await T.finalizeWinners(OWNER, first.ref, a.map((s, i) => ({ submissionId: s.id, place: i + 1 })), c());
    const b = (await T.listSubmissionsForCreator(MEMBER, second.ref, c())).submissions;
    await T.finalizeWinners(MEMBER, second.ref, [{ submissionId: b[0].id, place: 1 }], c());

    assert.deepEqual(table('task_winners').map((w) => w.xp), [300, 300, 100]);
    // A later change to the task does not rewrite what was awarded.
    table('tasks')[0].xp_reward = 5;

    const ws = await T.getProjectWorkspace(OWNER, 'teamone', c());
    assert.deepEqual(ws.leaderboard.entries, [
      { rank: 1, username: 'stranger', xp: 400, wins: 2 },
      { rank: 2, username: 'fan', xp: 300, wins: 1 },
    ]);
    assert.equal(ws.leaderboard.totalXp, 700);
    assert.equal(ws.leaderboard.earners, 2);
    assert.equal(ws.endedTasks.length, 2);
    assert.equal(ws.totalTasks, 2);

    const page = await T.getPublicProject('teamone', c());
    assert.equal(page.leaderboard.entries[0].username, 'stranger');
    assert.equal(page.viewerRole, null);
    const asMember = await T.getPublicProject('teamone', c(), { viewerAccountId: MEMBER });
    assert.equal(asMember.viewerRole, 'member');
  });

  it('awards nothing on a task without XP', async () => {
    const { ref } = await publish(OWNER);
    await T.submitToTask(FAN, ref, { url: 'https://x.com/fan/status/4444444444' }, c());
    closeTask(ref);
    const subs = (await T.listSubmissionsForCreator(OWNER, ref, c())).submissions;
    await T.finalizeWinners(OWNER, ref, [{ submissionId: subs[0].id, place: 1 }], c());
    assert.equal(table('task_winners')[0].xp, 0);
    const ws = await T.getProjectWorkspace(OWNER, 'teamone', c());
    assert.deepEqual(ws.leaderboard, { entries: [], totalXp: 0, earners: 0 });
  });
});

describe('project picture', () => {
  beforeEach(seed);

  it('accepts a PNG or WebP data URL whose bytes match', () => {
    assert.equal(T.checkedProjectImage(PNG), PNG);
    assert.equal(T.checkedProjectImage(WEBP), WEBP);
    assert.equal(T.checkedProjectImage(null), null);
    assert.equal(T.checkedProjectImage(''), null);
  });

  it('refuses SVG, a mislabelled file, bad base64 and an oversized picture', () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`;
    assert.throws(() => T.checkedProjectImage(svg), /PNG, JPEG or WebP/);
    assert.throws(() => T.checkedProjectImage('https://example.com/a.png'), /PNG, JPEG or WebP/);
    const html = dataUrl('png', Buffer.from('<html><script>x</script></html>'));
    assert.throws(() => T.checkedProjectImage(html), /not a picture/);
    assert.throws(() => T.checkedProjectImage('data:image/png;base64,@@@@'), /PNG, JPEG or WebP/);
    const huge = `data:image/png;base64,${'A'.repeat(T.PROJECT_IMAGE_MAX_CHARS)}`;
    assert.throws(() => T.checkedProjectImage(huge), /too large/);
  });

  it('is saved on create and on edit, and removed with null', async () => {
    const made = await T.createProject(OWNER, { handle: 'teamtwo', name: 'Team Two', image: WEBP }, c());
    assert.equal(made.image, WEBP);
    await T.updateProject(OWNER, 'teamone', { image: PNG }, c());
    assert.equal(table('projects')[0].image, PNG);
    await T.updateProject(OWNER, 'teamone', { image: null }, c());
    assert.equal(table('projects')[0].image, null);
    await assert.rejects(() => T.updateProject(OWNER, 'teamone', { image: 'data:image/gif;base64,R0lG' }, c()), /PNG, JPEG or WebP/);
  });
});
