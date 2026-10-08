/**
 * The project workspace screens, read from source: the Projects list opens the
 * in-app workspace with the picture, the workspace offers New task for that
 * project, and the migration holds the database side of the rules.
 *
 * Run: node --test test/projectWorkspaceUi.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('project workspace screens', () => {
  it('opens the in-app workspace from the Projects list, with the picture', () => {
    const list = read('web/components/AccountProjects.tsx');
    assert.match(list, /href=\{`\/dashboard\/projects\/\$\{encodeURIComponent\(project\.handle\)\}`\}/);
    assert.match(list, /<ProjectAvatar name=\{project\.name\} image=\{project\.image\}/);
    assert.doesNotMatch(list, /href=\{`\/project\/\$\{encodeURIComponent\(project\.handle\)\}`\}/);
  });

  it('counts only owned projects against the five-project ceiling', () => {
    assert.match(read('web/components/AccountProjects.tsx'), /projects\.filter\(\(p\) => p\.role === 'owner'\)\.length/);
  });

  it('offers New task for this project, held back at the live cap', () => {
    // The page itself is ProjectPage, shared with the public page.
    const page = read('web/components/ProjectPage.tsx');
    assert.match(page, /href=\{`\/dashboard\/explore\/new\?project=\$\{encodeURIComponent\(data\.id\)\}`\}/);
    assert.match(page, /const atCap = live\.length >= data\.liveCap;/);
    assert.match(page, /<Leaderboard board=\{data\.leaderboard\} \/>/);
    assert.match(read('web/components/ProjectWorkspace.tsx'), /<ProjectPage\s+mode="workspace"/);
  });

  it('shows member controls to the owner only', () => {
    const ws = read('web/components/ProjectWorkspace.tsx');
    assert.match(ws, /\{isOwner \? \(\s*<form/);
    assert.match(ws, /\{isOwner && m\.role === 'member' \? \(/);
  });

  it('offers a member Leave on their own row only', () => {
    const ws = read('web/components/ProjectWorkspace.tsx');
    assert.match(ws, /!isOwner && m\.role === 'member' && m\.username === self \? \(/);
  });

  it('draws a stored picture only from a data URL', () => {
    assert.match(read('web/components/ProjectAvatar.tsx'), /image && image\.startsWith\('data:image\/'\)/);
  });

  it('shows XP only on a project task in the create form', () => {
    const form = read('web/app/dashboard/explore/new/page.tsx');
    assert.match(form, /\{createAs !== 'personal' \? \(\s*<div className="mt-\[7px\]/);
    assert.match(form, /xpReward: createAs !== 'personal' && xp \? Number\(xp\) : null,/);
  });
});

describe('project workspace migration', () => {
  const sql = read('supabase/migrations/20261009120000_project_workspace.sql');

  it('is additive and idempotent', () => {
    assert.doesNotMatch(sql, /drop table|drop column|truncate/i);
    assert.match(sql, /create table if not exists public\.project_members/);
    assert.match(sql, /drop trigger if exists tasks_project_live_cap on public\.tasks;/);
    assert.match(sql, /add column if not exists xp_reward integer/);
  });

  it('keeps the new table and function away from anon and authenticated', () => {
    assert.match(sql, /revoke all on table public\.project_members from anon, authenticated;/);
    assert.match(sql, /revoke all on function public\.project_xp_leaderboard\(uuid, integer\) from anon, authenticated;/);
  });

  it('caps live tasks per project under a row lock, with FZ102', () => {
    assert.match(sql, /for update;/);
    assert.match(sql, /if live_count >= 5 then/);
    assert.match(sql, /errcode = 'FZ102'/);
  });

  it('refuses anything but a PNG, JPEG or WebP data URL as a picture', () => {
    assert.match(sql, /\^data:image\/\(webp\|png\|jpeg\);base64,/);
  });

  it('fails loudly when a piece is missing', () => {
    for (const piece of ['projects.image', 'public.project_members', 'tasks.xp_reward', 'task_winners.xp']) {
      assert.match(sql, new RegExp(`raise exception '${piece.replace('.', '\\.')} is missing'`));
    }
  });
});
