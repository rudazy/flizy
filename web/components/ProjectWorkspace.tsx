'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDashboard } from './DashboardProvider';
import type { ProjectLink, ProjectMember, ProjectWorkspace as Workspace } from '../lib/tasks';
import { shrinkProjectBanner, shrinkProjectImage } from '../lib/projectImage';
import { ProjectAvatar } from './ProjectAvatar';
import { ProjectPage } from './ProjectPage';
import { LINK_KINDS, LINK_LABEL } from './AccountProjects';
import { ArrowLeftIcon, CloseIcon, PeopleIcon, PlusIcon, TrashIcon, UserPlusIcon } from './ExploreIcons';

/**
 * One project's workspace, inside the app. It loads the project for its owner
 * or a member and draws it with the same ProjectPage the public page uses, and
 * adds what only the team has: the edit sheet and the team controls in About.
 */

const CARD = 'rounded-[14px] border border-[#232323] bg-[#101010]';
/** Width is left to each use: a fixed-width control next to a full one cannot carry w-full too. */
const FIELD_BOX =
  'rounded-[6px] border border-[#383838] bg-[#0d0d0d] px-3 font-sans text-sm text-[#f5f5f5] outline-none transition-colors placeholder:text-[#858585] focus:border-sun/70';
const FIELD = `w-full ${FIELD_BOX}`;
const GHOST_BUTTON =
  'hit-y-44 inline-flex h-10 items-center justify-center gap-2 rounded-[6px] border border-[#383838] px-4 font-sans text-sm text-[#f5f5f5] no-underline transition-colors hover:border-[#5a5a5a] disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON =
  'hit-y-44 inline-flex h-10 items-center justify-center gap-2 rounded-[6px] bg-sun px-4 font-sans text-sm font-semibold text-sun-ink no-underline transition-opacity hover:opacity-90';

const NAME_MAX = 60;
const DESCRIPTION_MAX = 300;

export function ProjectWorkspace({ handle }: { handle: string }) {
  const router = useRouter();
  const { data } = useDashboard();
  const self = data?.account.username || '';
  const [project, setProject] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState('');
  const [missing, setMissing] = useState(false);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/projects/workspace/${encodeURIComponent(handle)}`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.status === 404) {
          setMissing(true);
          return;
        }
        if (!res.ok || !body || typeof body.id !== 'string') {
          setLoadError('Could not load this project.');
          return;
        }
        setLoadError('');
        setProject(body as Workspace);
      } catch {
        if (!cancelled) setLoadError('Could not load this project.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handle, reload]);

  const back = (
    <Link
      href="/dashboard/account?s=projects"
      className="hit-y-44 inline-flex w-fit items-center gap-1.5 font-sans text-sm text-[#a9a9a9] no-underline transition-colors hover:text-[#f5f5f5]"
    >
      <ArrowLeftIcon size={14} />
      Projects
    </Link>
  );

  if (missing) {
    return (
      <div className="grid gap-4">
        {back}
        <section className={`${CARD} p-5`}>
          <p className="m-0 font-sans text-base text-[#f5f5f5]">Project not found.</p>
          <p className="m-0 mt-1 text-sm text-muted">It does not exist, or this account is not on it.</p>
        </section>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="grid gap-4">
        {back}
        {loadError ? (
          <section className={`${CARD} grid justify-items-start gap-3 p-5`}>
            <p className="m-0 text-sm text-[#e0b070]" role="alert">
              {loadError}
            </p>
            <button type="button" className={GHOST_BUTTON} onClick={() => setReload((n) => n + 1)}>
              Try again
            </button>
          </section>
        ) : (
          <WorkspaceSkeleton />
        )}
      </div>
    );
  }

  return (
    <>
      <ProjectPage
        mode="workspace"
        onEdit={() => setEditing(true)}
        data={{
          id: project.id,
          handle: project.handle,
          name: project.name,
          description: project.description,
          verified: project.verified,
          image: project.image,
          banner: project.banner,
          createdAt: project.createdAt,
          links: project.links,
          role: project.role,
          stats: project.stats,
          tasks: [...project.liveTasks, ...project.endedTasks],
          leaderboard: project.leaderboard,
          recentRewards: project.recentRewards,
          activity: project.activity,
          liveCap: project.liveCap,
        }}
        teamSlot={
          <Members
            handle={project.handle}
            members={project.members}
            isOwner={project.role === 'owner'}
            self={self}
            onChange={(members) => setProject({ ...project, members })}
            onLeft={() => router.push('/dashboard/account?s=projects')}
          />
        }
      />
      {editing ? (
        <EditSheet
          project={project}
          onCancel={() => setEditing(false)}
          onSaved={(saved) => {
            setProject({ ...project, ...saved });
            setEditing(false);
          }}
        />
      ) : null}
    </>
  );
}

function Members({
  handle,
  members,
  isOwner,
  self,
  onChange,
  onLeft,
}: {
  handle: string;
  members: ProjectMember[];
  isOwner: boolean;
  /** The signed-in username, so a member is offered Leave on their own row. */
  self: string;
  onChange: (members: ProjectMember[]) => void;
  onLeft: () => void;
}) {
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function change(method: 'POST' | 'DELETE', name: string) {
    if (busy) return;
    setBusy(`${method}:${name}`);
    setError('');
    try {
      const res = await fetch(`/api/projects/workspace/${encodeURIComponent(handle)}/members`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name }),
      });
      const body = (await res.json().catch(() => ({}))) as { members?: unknown; error?: unknown };
      if (!res.ok || !Array.isArray(body.members)) {
        setError(typeof body.error === 'string' ? body.error : 'Could not update the team.');
        return;
      }
      if (method === 'DELETE' && !isOwner && name === self) {
        onLeft();
        return;
      }
      onChange(body.members as ProjectMember[]);
      if (method === 'POST') setUsername('');
    } catch {
      setError('Could not update the team.');
    } finally {
      setBusy('');
    }
  }

  return (
    <section className={CARD}>
      <h3 className="m-0 flex items-center gap-2.5 border-b border-[#1c1c1c] px-4 py-3.5 font-sans text-base font-semibold text-[#f5f5f5]">
        <PeopleIcon size={16} className="text-sun" />
        Team
      </h3>
      {isOwner ? (
        <form
          className="flex gap-2 border-b border-[#1c1c1c] p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const name = username.trim().replace(/^@/, '');
            if (name) void change('POST', name);
          }}
        >
          <label htmlFor="member-username" className="sr-only">
            Username to add
          </label>
          <input
            id="member-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="@username"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={25}
            className={`${FIELD} h-10 flex-1`}
          />
          <button type="submit" className={PRIMARY_BUTTON} disabled={Boolean(busy) || !username.trim()}>
            <UserPlusIcon size={14} />
            Add
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="m-0 px-4 pt-3 text-sm text-[#e0b070]" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="m-0 list-none p-0">
        {members.map((m) => (
          <li key={m.username} className="flex items-center gap-3 border-b border-[#1c1c1c] px-4 py-3 last:border-b-0">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-sun/40 bg-sun-wash font-sans text-sm font-semibold text-sun">
              {m.username.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate font-sans text-sm text-[#f5f5f5]">@{m.username}</span>
            <span className="font-sans text-[10px] font-semibold uppercase tracking-wide text-[#8f8f8f]">
              {m.role === 'owner' ? 'Owner' : 'Member'}
            </span>
            {isOwner && m.role === 'member' ? (
              <button
                type="button"
                onClick={() => void change('DELETE', m.username)}
                disabled={Boolean(busy)}
                className="hit-y-44 inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-[#8f8f8f] transition-colors hover:text-[#f87171] disabled:opacity-50"
                aria-label={`Remove @${m.username}`}
              >
                <TrashIcon size={14} />
              </button>
            ) : !isOwner && m.role === 'member' && m.username === self ? (
              <button
                type="button"
                onClick={() => void change('DELETE', m.username)}
                disabled={Boolean(busy)}
                className="hit-y-44 inline-flex h-8 items-center rounded-[6px] border border-[#383838] px-3 font-sans text-xs text-[#f5f5f5] transition-colors hover:border-[#f87171]/60 hover:text-[#f87171] disabled:opacity-50"
              >
                Leave
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="m-0 flex items-center gap-1.5 border-t border-[#1c1c1c] px-4 py-3 text-xs text-muted">
        <PeopleIcon size={12} />
        Members can publish tasks for this project and edit its details. A member can leave at any time.
      </p>
    </section>
  );
}

type LinkRow = { id: number; kind: string; url: string };

function EditSheet({
  project,
  onCancel,
  onSaved,
}: {
  project: Workspace;
  onCancel: () => void;
  onSaved: (saved: {
    name: string;
    description: string;
    links: ProjectLink[];
    image: string | null;
    banner: string | null;
  }) => void;
}) {
  const titleId = useId();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [image, setImage] = useState<string | null>(project.image);
  const [banner, setBanner] = useState<string | null>(project.banner);
  const bannerRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<LinkRow[]>(() =>
    project.links.map((l, i) => ({ id: i + 1, kind: l.kind, url: l.url }))
  );
  const nextId = useRef(project.links.length + 1);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  async function pick(file: File | undefined, which: 'image' | 'banner') {
    if (!file) return;
    try {
      if (which === 'banner') setBanner(await shrinkProjectBanner(file));
      else setImage(await shrinkProjectImage(file));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that image.');
    }
  }

  async function save() {
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > NAME_MAX) {
      setError(`Project name must be 2 to ${NAME_MAX} characters.`);
      return;
    }
    if (description.trim().length > DESCRIPTION_MAX) {
      setError(`Keep the description to ${DESCRIPTION_MAX} characters.`);
      return;
    }
    const links: ProjectLink[] = [];
    for (const row of rows) {
      const url = row.url.trim();
      if (!url) continue;
      if (!/^https:\/\//i.test(url)) {
        setError('Links must start with https.');
        return;
      }
      links.push({ kind: row.kind, label: LINK_LABEL[row.kind] || 'Link', url });
    }

    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/workspace/${encodeURIComponent(project.handle)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmed, description: description.trim(), links, image, banner }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: unknown;
        name?: unknown;
        image?: unknown;
        banner?: unknown;
      };
      if (!res.ok) {
        setError(typeof body.error === 'string' ? body.error : 'Could not save the project.');
        return;
      }
      onSaved({
        name: typeof body.name === 'string' ? body.name : trimmed,
        description: description.trim(),
        links,
        image: typeof body.image === 'string' ? body.image : null,
        banner: typeof body.banner === 'string' ? body.banner : null,
      });
    } catch {
      setError('Could not save the project.');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-[2px] sm:items-center"
      role="presentation"
      onClick={() => !busy && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92dvh] w-full max-w-[480px] overflow-y-auto rounded-t-[20px] border border-b-0 border-[#3a2a1c] bg-[#101011] px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-4 shadow-[0_-20px_60px_rgba(0,0,0,0.6)] sm:rounded-[20px] sm:border-b"
      >
        <div className="mx-auto mb-4 h-[4px] w-[38px] rounded-full bg-[#2c2d33] sm:hidden" aria-hidden />
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="m-0 font-sans text-lg font-bold text-white">
            Edit project
          </h2>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="hit-y-44 inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-[#a9a9a9] hover:text-white"
            aria-label="Close"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="mt-4 flex items-center gap-4">
          <ProjectAvatar name={name || project.name} image={image} size={72} />
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-2">
              <button type="button" className={GHOST_BUTTON} onClick={() => fileRef.current?.click()} disabled={busy}>
                {image ? 'Change picture' : 'Add picture'}
              </button>
              {image ? (
                <button type="button" className={GHOST_BUTTON} onClick={() => setImage(null)} disabled={busy}>
                  Remove
                </button>
              ) : null}
            </div>
            <p className="m-0 text-xs text-muted">PNG, JPG or WebP. Cropped to a square.</p>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              void pick(e.target.files?.[0], 'image');
              e.target.value = '';
            }}
          />
        </div>

        <p className="m-0 mt-5 font-sans text-xs text-[#a9a9a9]">Banner</p>
        <div className="mt-1.5 overflow-hidden rounded-[10px] border border-[#2e2e2e] bg-[#0d0d0d]">
          {banner ? (
            <img src={banner} alt="Project banner preview" className="aspect-[1200/630] w-full object-cover" />
          ) : (
            <div className="flex aspect-[1200/630] w-full items-center justify-center text-xs text-muted">No banner</div>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className={GHOST_BUTTON} onClick={() => bannerRef.current?.click()} disabled={busy}>
            {banner ? 'Change banner' : 'Add banner'}
          </button>
          {banner ? (
            <button type="button" className={GHOST_BUTTON} onClick={() => setBanner(null)} disabled={busy}>
              Remove
            </button>
          ) : null}
          <span className="text-xs text-muted">Shown beside your project name. Cropped to 1200 by 630.</span>
        </div>
        <input
          ref={bannerRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            void pick(e.target.files?.[0], 'banner');
            e.target.value = '';
          }}
        />

        <label className="mt-5 block font-sans text-xs text-[#a9a9a9]" htmlFor="edit-project-name">
          Name
        </label>
        <input
          id="edit-project-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={NAME_MAX}
          className={`${FIELD} mt-1.5 h-11`}
        />

        <label className="mt-4 block font-sans text-xs text-[#a9a9a9]" htmlFor="edit-project-description">
          Description
        </label>
        <textarea
          id="edit-project-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={DESCRIPTION_MAX}
          rows={4}
          className={`${FIELD} mt-1.5 resize-none py-2.5 leading-relaxed`}
        />
        <p className="m-0 mt-1 text-right font-mono text-[11px] text-[#6f6f6f]">
          {description.length}/{DESCRIPTION_MAX}
        </p>

        <p className="m-0 mt-2 font-sans text-xs text-[#a9a9a9]">Links</p>
        <div className="mt-1.5 grid gap-2">
          {rows.map((row) => (
            <div key={row.id} className="flex gap-2">
              <select
                aria-label="Link type"
                value={row.kind}
                onChange={(e) => setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, kind: e.target.value } : r)))}
                className={`${FIELD_BOX} h-10 w-[112px] shrink-0 px-2`}
              >
                {LINK_KINDS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                aria-label="Link address"
                value={row.url}
                onChange={(e) => setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, url: e.target.value } : r)))}
                placeholder="https://"
                inputMode="url"
                className={`${FIELD} h-10 min-w-0 flex-1`}
              />
              <button
                type="button"
                onClick={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                className="hit-y-44 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] border border-[#2e2e2e] text-[#8f8f8f] hover:text-[#f5f5f5]"
                aria-label="Remove link"
              >
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
          {rows.length < 20 ? (
            <button
              type="button"
              onClick={() => {
                const id = nextId.current++;
                setRows((prev) => [...prev, { id, kind: 'website', url: '' }]);
              }}
              className="hit-y-44 inline-flex h-9 w-fit items-center gap-1.5 font-sans text-sm text-sun"
            >
              <PlusIcon size={13} />
              Add link
            </button>
          ) : null}
        </div>

        <p className="m-0 mt-4 text-xs text-muted">
          The handle project/{project.handle} stays the same, so links people already shared keep working.
        </p>

        {error ? (
          <p className="m-0 mt-3 text-sm text-[#e0b070]" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" className={GHOST_BUTTON} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={PRIMARY_BUTTON} onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function WorkspaceSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading project">
      <div className={`${CARD} h-[150px] animate-pulse`} />
      <div className="grid grid-cols-2 gap-2 min-[520px]:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${CARD} h-[78px] animate-pulse`} />
        ))}
      </div>
      <div className={`${CARD} h-[220px] animate-pulse`} />
    </div>
  );
}
