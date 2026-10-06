'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useDashboard } from './DashboardProvider';
import { validateUsername } from '../lib/username';
import { publicMail } from '../lib/publicMail';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronRightIcon,
  EyeIcon,
  GlobeIcon,
  PeopleIcon,
  PlusIcon,
  ShieldCheckIcon,
  TrashIcon,
  XLogoIcon,
} from './ExploreIcons';

/**
 * Projects on the account.
 *
 * The public page is a brand. This list is the private workspace, and the
 * form writes only the columns a project has: name, handle, description,
 * and https links. The preview shows that page. A picture or a banner
 * chosen here stays on this screen.
 *
 * The screen shows team, standard, visibility, a picture, and a banner
 * because those are part of the layout. None of them is stored. Verified
 * stays unselected: Flizy confirms a project after the owner writes to
 * the contact mailbox. A task goes live when it is published and stays open
 * until the deadline on that task. There is no participant cap.
 */

type ProjectCard = {
  id: string;
  handle: string;
  name: string;
  description: string;
  activeTasks?: number;
};

type LinkDraft = { id: number; kind: string; url: string };

type HandleState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'blocked'; reason: string };

type StepCheck = 1 | 3 | 'all';

const NAME_MAX = 50;
const DESCRIPTION_MAX = 300;
/** Same ceiling the server enforces in MAX_PROJECTS_PER_ACCOUNT. */
const PROJECT_CAP = 5;

const LINK_KINDS: Array<[string, string]> = [
  ['website', 'Website'],
  ['x', 'X'],
  ['telegram', 'Telegram'],
  ['docs', 'Docs'],
  ['github', 'GitHub'],
  ['custom', 'Other'],
];

const LINK_LABEL: Record<string, string> = {
  website: 'Website',
  x: 'X',
  telegram: 'Telegram',
  docs: 'Docs',
  github: 'GitHub',
  custom: 'Link',
};

const STEPS = ['Details', 'Team', 'Links', 'Settings', 'Review'] as const;
const VERIFY_MAIL = `mailto:${publicMail('contact').address}?subject=${encodeURIComponent('Verify a Flizy project')}`;

function markLetters(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word));
  if (!words.length) return 'FZ';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function activeLine(count: number | undefined): string | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
  const n = Math.floor(count);
  if (n === 0) return 'No active tasks';
  if (n === 1) return '1 active task';
  return `${n} active tasks`;
}

function handleFormat(error: string): string {
  if (error.includes('at least 3')) return 'Use at least 3 characters.';
  if (error.includes('at most')) return 'Use at most 24 characters.';
  if (error.includes('required')) return 'Choose a project handle.';
  return 'Start with a letter. Use only letters and numbers.';
}

function linkIssue(rows: LinkDraft[]): string {
  let kept = 0;
  for (const row of rows) {
    const url = row.url.trim();
    if (!url) continue;
    if (!/^https:\/\//i.test(url)) return 'Links must start with https.';
    if (url.length > 2000) return 'That link is too long.';
    kept += 1;
  }
  if (kept > 20) return 'That is too many links.';
  return '';
}

function linksToSave(rows: LinkDraft[]): Array<{ kind: string; label: string; url: string }> {
  const out: Array<{ kind: string; label: string; url: string }> = [];
  for (const row of rows) {
    const url = row.url.trim();
    if (!/^https:\/\//i.test(url) || url.length > 2000) continue;
    out.push({ kind: row.kind, label: LINK_LABEL[row.kind] || 'Link', url });
    if (out.length >= 20) break;
  }
  return out;
}

function readProjects(body: unknown): { projects: ProjectCard[]; canCreate: boolean } | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as { projects?: unknown; canCreate?: unknown };
  if (!Array.isArray(record.projects)) return null;
  const projects: ProjectCard[] = [];
  for (const row of record.projects) {
    if (!row || typeof row !== 'object') continue;
    const item = row as {
      id?: unknown;
      handle?: unknown;
      name?: unknown;
      description?: unknown;
      activeTasks?: unknown;
    };
    if (typeof item.id !== 'string' || typeof item.handle !== 'string' || typeof item.name !== 'string') {
      continue;
    }
    projects.push({
      id: item.id,
      handle: item.handle,
      name: item.name,
      description: typeof item.description === 'string' ? item.description : '',
      activeTasks:
        typeof item.activeTasks === 'number' && Number.isFinite(item.activeTasks)
          ? item.activeTasks
          : undefined,
    });
  }
  return { projects, canCreate: record.canCreate === true };
}

export function AccountProjects() {
  const { data } = useDashboard();
  const username = data?.account.username || '';

  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);

  const [creating, setCreating] = useState(false);
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [links, setLinks] = useState<LinkDraft[]>([]);
  const [nextLinkId, setNextLinkId] = useState(1);
  const [handleState, setHandleState] = useState<HandleState>({ kind: 'idle' });
  const [teamNote, setTeamNote] = useState('');
  const [standardNote, setStandardNote] = useState('');
  const [visibilityNote, setVisibilityNote] = useState('');
  const [bannerUrl, setBannerUrl] = useState('');
  const [pictureUrl, setPictureUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/projects');
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        const parsed = res.ok ? readProjects(body) : null;
        if (!parsed) {
          setProjects([]);
          setCanCreate(false);
          setLoadError('Could not load projects.');
          return;
        }
        setProjects(parsed.projects);
        setCanCreate(parsed.canCreate);
        setLoadError('');
      } catch {
        if (!cancelled) {
          setProjects([]);
          setCanCreate(false);
          setLoadError('Could not load projects.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  useEffect(() => {
    const raw = handle.trim();
    if (!raw) {
      setHandleState({ kind: 'idle' });
      return;
    }
    const check = validateUsername(raw);
    if (!check.ok) {
      setHandleState({ kind: 'blocked', reason: handleFormat(check.error) });
      return;
    }
    setHandleState({ kind: 'checking' });
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/projects/handle?h=${encodeURIComponent(check.username)}`);
          const body = (await res.json().catch(() => ({}))) as {
            available?: unknown;
            handle?: unknown;
            reason?: unknown;
          };
          if (cancelled) return;
          if (res.ok && body.available === true && body.handle === check.username) {
            setHandleState({ kind: 'available' });
            return;
          }
          const reason =
            typeof body.reason === 'string' && body.reason
              ? body.reason
              : 'That username is not available. Please choose another.';
          setHandleState({
            kind: 'blocked',
            reason: res.ok ? reason : 'Could not check that handle.',
          });
        } catch {
          if (!cancelled) setHandleState({ kind: 'blocked', reason: 'Could not check that handle.' });
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [handle]);

  function detailIssue(): string {
    const nameTrim = name.trim();
    if (nameTrim.length < 2) return 'Project name must be at least 2 characters.';
    if (nameTrim.length > NAME_MAX) return `Project name must be at most ${NAME_MAX} characters.`;
    if (handleState.kind === 'idle') return 'Choose a project handle.';
    if (handleState.kind === 'checking') return 'Checking that handle.';
    if (handleState.kind === 'blocked') return handleState.reason;
    const desc = description.trim();
    if (!desc) return 'Add a short description.';
    if (desc.length > DESCRIPTION_MAX) return `Keep the description to ${DESCRIPTION_MAX} characters.`;
    return '';
  }

  function issueFor(which: StepCheck): { step: 1 | 3; message: string } | null {
    if (which === 1 || which === 'all') {
      const message = detailIssue();
      if (message) return { step: 1, message };
    }
    if (which === 3 || which === 'all') {
      const message = linkIssue(links);
      if (message) return { step: 3, message };
    }
    return null;
  }

  function dropPreview(url: string) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }

  function resetDraft() {
    setStep(1);
    setName('');
    setHandle('');
    setDescription('');
    setLinks([]);
    setTeamNote('');
    setStandardNote('');
    setVisibilityNote('');
    setError('');
    setHandleState({ kind: 'idle' });
    setBannerUrl((url) => {
      dropPreview(url);
      return '';
    });
    setPictureUrl((url) => {
      dropPreview(url);
      return '';
    });
  }

  function onPickImage(file: File | undefined, current: string, setUrl: (url: string) => void) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setError('Use a PNG, JPG, or WebP image.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Keep the image under 2 MB.');
      return;
    }
    dropPreview(current);
    setError('');
    setUrl(URL.createObjectURL(file));
  }

  function close() {
    resetDraft();
    setCreating(false);
    window.scrollTo({ top: 0 });
  }

  function go(n: number) {
    setError('');
    setStep(n);
    const desktop = window.matchMedia('(min-width: 1024px)').matches;
    if (desktop) {
      document.getElementById(`project-step-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    window.scrollTo({ top: 0 });
  }

  function showIssue(found: { step: 1 | 3; message: string }) {
    setError(found.message);
    const desktop = window.matchMedia('(min-width: 1024px)').matches;
    if (desktop) {
      document.getElementById(`project-step-${found.step}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    setStep(found.step);
    window.scrollTo({ top: 0 });
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          handle: handle.trim(),
          description: description.trim(),
          links: linksToSave(links),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: unknown;
        handle?: unknown;
        error?: unknown;
      };
      if (!res.ok || typeof body.id !== 'string') {
        setError(typeof body.error === 'string' ? body.error : 'Could not create that project.');
        return;
      }
      const created: ProjectCard = {
        id: body.id,
        handle: typeof body.handle === 'string' ? body.handle : handle.trim(),
        name: name.trim(),
        description: description.trim(),
        activeTasks: 0,
      };
      setProjects((prev) => [...(prev ?? []), created]);
      close();
    } catch {
      setError('Could not create that project.');
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const desktop = window.matchMedia('(min-width: 1024px)').matches;
    if (!desktop && step < 5) {
      const which: StepCheck | null = step === 1 ? 1 : step === 3 ? 3 : null;
      const found = which ? issueFor(which) : null;
      if (found) {
        setError(found.message);
        return;
      }
      setError('');
      setStep(step + 1);
      window.scrollTo({ top: 0 });
      return;
    }
    const found = issueFor('all');
    if (found) {
      showIssue(found);
      return;
    }
    void create();
  }

  if (projects === null) {
    return (
      <div className="w-full max-w-3xl">
        <p className="text-sm text-muted">Loading projects.</p>
      </div>
    );
  }

  if (!creating) {
    const atCap = projects.length >= PROJECT_CAP;
    const openCreate = () => {
      resetDraft();
      setCreating(true);
      window.scrollTo({ top: 0 });
    };
    return (
      <div className="w-full max-w-3xl">
        <section className="overflow-hidden rounded-[16px] border border-[#2a2b30] bg-[#101012]">
          <header className="relative px-4 pb-4 pt-5 sm:px-5">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-44 bg-[radial-gradient(ellipse_at_right,rgba(247,208,71,0.16),transparent_68%)]"
            />
            <div className="relative flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 font-mono text-[10px] uppercase tracking-[0.18em] text-sun">Workspace</p>
                <h2 className="m-0 mt-1.5 font-sans text-[22px] font-semibold tracking-wide text-paper">My Projects</h2>
                <p className="m-0 mt-1.5 max-w-sm text-sm leading-relaxed text-muted">
                  Each project has its own public page. The page does not show your name.
                </p>
              </div>
              <p className="m-0 shrink-0 pt-0.5 text-right">
                <span className="block font-sans text-lg font-semibold tabular-nums text-paper">{projects.length}</span>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">of {PROJECT_CAP}</span>
              </p>
            </div>
            {loadError || projects.length === 0 ? null : atCap ? (
              <p className="relative m-0 mt-3 text-sm text-muted">An account can have {PROJECT_CAP} projects.</p>
            ) : canCreate ? (
              <button type="button" className="btn btn-sun relative mt-4 min-h-[44px] gap-1.5" onClick={openCreate}>
                <PlusIcon size={15} />
                Create project
              </button>
            ) : (
              <p className="relative m-0 mt-3 text-sm text-muted">This account cannot create a project.</p>
            )}
          </header>

          {loadError ? (
            <div className="grid gap-3 border-t border-[#26262a] px-4 py-4 sm:px-5">
              <p className="alert alert-error m-0" role="alert">
                {loadError}
              </p>
              <button type="button" className="btn btn-ghost w-fit" onClick={() => setReload((n) => n + 1)}>
                Try again
              </button>
            </div>
          ) : projects.length === 0 ? (
            <div className="border-t border-[#26262a] px-4 py-8 sm:px-5">
              <div className="flex flex-col items-center text-center">
                <HeroMark compact />
                <p className="m-0 mt-3 font-sans text-base font-semibold tracking-wide text-paper">No projects yet</p>
                <p className="m-0 mt-1.5 max-w-xs text-sm leading-relaxed text-muted">
                  A task can still be personal.
                </p>
                {canCreate ? (
                  <button type="button" className="btn btn-sun mt-5 min-h-[44px] gap-1.5 px-5" onClick={openCreate}>
                    <PlusIcon size={15} />
                    Create project
                  </button>
                ) : (
                  <p className="m-0 mt-4 text-sm text-muted">This account cannot create a project.</p>
                )}
              </div>
            </div>
          ) : (
            <ul className="m-0 list-none p-0">
              {projects.map((project) => {
                const line = activeLine(project.activeTasks);
                return (
                  <li key={project.id} className="border-t border-[#26262a]">
                    <Link
                      href={`/project/${encodeURIComponent(project.handle)}`}
                      className="flex items-center gap-3 px-4 py-3.5 no-underline sm:px-5"
                    >
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-[#3a3424] bg-[#1c1812] font-sans text-sm font-semibold text-sun">
                        {markLetters(project.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-sans text-[15px] font-semibold text-paper">
                          {project.name}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[12px] text-muted">
                          project/{project.handle}
                        </span>
                        {line ? <span className="mt-1 block text-[12px] text-[#b7b1a8]">{line}</span> : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="rounded-[4px] bg-sun px-1.5 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide text-sun-ink">
                          Owner
                        </span>
                        <ChevronRightIcon size={16} className="text-[#6f6a62]" />
                      </span>
                    </Link>
                    <div className="px-4 sm:px-5">
                      <Link
                        href={`/dashboard/explore/new?project=${encodeURIComponent(project.id)}`}
                        className="inline-flex min-h-[44px] items-center gap-1.5 font-sans text-[13px] text-muted no-underline hover:text-paper"
                      >
                        <PlusIcon size={14} />
                        New task
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    );
  }

  const savedLinks = linksToSave(links);
  const shownHandle = handle.trim();

  return (
    <form onSubmit={onSubmit} className="grid w-full gap-6">
      <nav aria-label="Create project" className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <button type="button" onClick={close} className="hit-44 inline-flex items-center gap-1 hover:text-paper">
          <ArrowLeftIcon size={14} />
          Back
        </button>
        <span aria-hidden>/</span>
        <button type="button" onClick={close} className="hover:text-paper">
          Projects
        </button>
        <span aria-hidden>/</span>
        <span className="text-paper">Create project</span>
      </nav>

      <header className="relative overflow-hidden rounded-[16px] border border-[#2a2b30] bg-[#101012] px-5 py-6 sm:px-7 sm:py-7">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(ellipse_at_right,rgba(247,208,71,0.18),transparent_68%)]"
        />
        <div className="relative flex items-center justify-between gap-6">
          <div className="min-w-0">
            <p className="m-0 font-mono text-[10px] uppercase tracking-[0.18em] text-sun">New project</p>
            <h1 className="m-0 mt-2 font-sans text-3xl font-semibold tracking-wide text-paper sm:text-4xl">
              Create a Project
            </h1>
            <p className="m-0 mt-2 max-w-lg text-sm leading-relaxed text-muted sm:text-base">
              Launch your project page, create tasks, and grow your community.
            </p>
          </div>
          <HeroMark />
        </div>
      </header>

      <ol className="m-0 flex list-none items-center p-0" aria-label="Steps">
        {STEPS.map((label, index) => {
          const n = index + 1;
          const current = n === step;
          return (
            <li key={label} className={`flex min-w-0 items-center ${index < STEPS.length - 1 ? 'flex-1' : ''}`}>
              <button
                type="button"
                onClick={() => go(n)}
                aria-current={current ? 'step' : undefined}
                aria-label={label}
                className="hit-44 flex items-center gap-2"
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-sans text-xs font-semibold ${
                    current
                      ? 'bg-sun text-sun-ink'
                      : 'border border-border text-muted'
                  }`}
                >
                  {n}
                </span>
                <span className={`hidden font-sans text-sm lg:inline ${current ? 'text-sun' : 'text-muted'}`}>
                  {label}
                </span>
              </button>
              {index < STEPS.length - 1 ? <span aria-hidden className="mx-1 h-px min-w-[12px] flex-1 bg-border sm:mx-2" /> : null}
            </li>
          );
        })}
      </ol>
      <p className="m-0 -mt-3 text-center font-sans text-sm text-sun lg:hidden">{STEPS[step - 1]}</p>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(300px,400px)]">
        <div className="grid gap-4">
          <section
            id="project-step-1"
            className={`scroll-mt-24 rounded-[16px] border border-[#2a2b30] bg-[#101012] p-5 ${
              step === 1 ? '' : 'hidden lg:block'
            }`}
          >
            <SectionHeading n={1} title="Basic information" subtitle="Tell us about your project." />
            <div className="grid gap-4">
              <div>
                <FieldLabel htmlFor="project-name" extra={<Counter value={name.length} max={NAME_MAX} />}>
                  Project name <Required />
                </FieldLabel>
                <input
                  id="project-name"
                  className="input"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value.slice(0, NAME_MAX));
                    setError('');
                  }}
                  placeholder="Project name"
                  maxLength={NAME_MAX}
                  autoComplete="off"
                />
              </div>
              <div>
                <FieldLabel htmlFor="project-handle">
                  Project handle <Required />
                </FieldLabel>
                <div className="relative">
                  <input
                    id="project-handle"
                    className="input pr-28 font-mono"
                    value={handle}
                    onChange={(e) => {
                      setHandle(e.target.value.replace(/^@+/, '').toLowerCase().slice(0, 24));
                      setError('');
                    }}
                    placeholder="handle"
                    maxLength={24}
                    autoCapitalize="off"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={handleState.kind === 'blocked'}
                    aria-describedby="project-handle-status"
                  />
                  {handleState.kind === 'available' ? (
                    <span className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1 font-sans text-xs text-sun">
                      <CheckIcon size={14} />
                      Available
                    </span>
                  ) : handleState.kind === 'checking' ? (
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-sans text-xs text-muted">
                      Checking
                    </span>
                  ) : null}
                </div>
                <p id="project-handle-status" className="m-0 mt-1.5 text-xs text-muted" aria-live="polite">
                  {handleState.kind === 'blocked' ? (
                    <span className="mb-1 block text-[#e0b070]">{handleState.reason}</span>
                  ) : null}
                  Your project link:{' '}
                  <span className="font-mono text-sun">flizy.app/project/{shownHandle || 'handle'}</span>
                </p>
              </div>
              <div>
                <FieldLabel
                  htmlFor="project-description"
                  extra={<Counter value={description.length} max={DESCRIPTION_MAX} />}
                >
                  Description <Required />
                </FieldLabel>
                <textarea
                  id="project-description"
                  className="input min-h-[96px] resize-y"
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value.slice(0, DESCRIPTION_MAX));
                    setError('');
                  }}
                  placeholder="What this project is, in a sentence or two."
                  maxLength={DESCRIPTION_MAX}
                  rows={4}
                />
              </div>
              <AppearanceFields
                bannerUrl={bannerUrl}
                pictureUrl={pictureUrl}
                mark={markLetters(name)}
                onBanner={(file) => onPickImage(file, bannerUrl, setBannerUrl)}
                onPicture={(file) => onPickImage(file, pictureUrl, setPictureUrl)}
              />
            </div>
          </section>

          <section
            id="project-step-2"
            className={`scroll-mt-24 rounded-[16px] border border-[#2a2b30] bg-[#101012] p-5 ${
              step === 2 ? '' : 'hidden lg:block'
            }`}
          >
            <SectionHeading
              n={2}
              title="Project team"
              subtitle="You are the only manager. Invites are not open yet."
              action={
                <button
                  type="button"
                  className="btn btn-sun min-h-[44px] shrink-0 gap-1.5 px-3 text-sm"
                  onClick={() => setTeamNote('Invites are not open yet. You are the only manager.')}
                >
                  <PlusIcon size={14} />
                  Add member
                </button>
              }
            />
            <div className="flex items-center gap-3 rounded-md border border-border px-3 py-3">
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-sun bg-sun-wash font-sans text-sm font-semibold text-sun"
                aria-hidden
              >
                {username ? username.slice(0, 1).toUpperCase() : 'Y'}
              </span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-sm text-paper">
                    {username ? `@${username}` : 'This account'}
                  </span>
                  <span className="rounded-[4px] bg-sun px-1.5 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide text-sun-ink">
                    Owner
                  </span>
                </span>
                <span className="mt-0.5 block text-xs text-muted">Full access. Manage everything.</span>
              </span>
            </div>
            {username ? null : (
              <p className="m-0 mt-3 text-xs text-muted">
                Set a username on Profile. The public page will not show it.
              </p>
            )}
            {teamNote ? <p className="m-0 mt-3 text-sm text-[#e0b070]">{teamNote}</p> : null}
          </section>

          <section
            id="project-step-3"
            className={`scroll-mt-24 rounded-[16px] border border-[#2a2b30] bg-[#101012] p-5 ${
              step === 3 ? '' : 'hidden lg:block'
            }`}
          >
            <SectionHeading
              n={3}
              title="Project links"
              subtitle="Add your project's important links. Optional."
              action={
                <button
                  type="button"
                  className="btn btn-sun min-h-[44px] shrink-0 gap-1.5 px-3 text-sm"
                  disabled={links.length >= 20}
                  onClick={() => {
                    setLinks((prev) => [...prev, { id: nextLinkId, kind: 'website', url: '' }]);
                    setNextLinkId((n) => n + 1);
                    setError('');
                  }}
                >
                  <PlusIcon size={14} />
                  Add link
                </button>
              }
            />
            {links.length === 0 ? (
              <p className="m-0 text-sm text-muted">No links yet. An empty row is not saved.</p>
            ) : (
              <ul className="m-0 grid list-none gap-2 p-0">
                {links.map((row) => (
                  <li key={row.id} className="grid grid-cols-[auto_minmax(0,1fr)_44px] items-center gap-2">
                    <span className="text-muted">{linkKindIcon(row.kind)}</span>
                    <div className="grid min-w-0 gap-2 sm:grid-cols-[132px_minmax(0,1fr)]">
                      <select
                        className="input"
                        aria-label="Link type"
                        value={row.kind}
                        onChange={(e) => {
                          const kind = e.target.value;
                          setLinks((prev) => prev.map((item) => (item.id === row.id ? { ...item, kind } : item)));
                        }}
                      >
                        {LINK_KINDS.map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <input
                        className="input font-mono"
                        value={row.url}
                        aria-label="Link URL"
                        placeholder="https://"
                        maxLength={2000}
                        onChange={(e) => {
                          const url = e.target.value;
                          setLinks((prev) => prev.map((item) => (item.id === row.id ? { ...item, url } : item)));
                          setError('');
                        }}
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </div>
                    <button
                      type="button"
                      className="hit-44 flex h-11 w-11 items-center justify-center rounded-[4px] border border-border text-muted hover:text-paper"
                      aria-label="Remove link"
                      onClick={() => {
                        setLinks((prev) => prev.filter((item) => item.id !== row.id));
                        setError('');
                      }}
                    >
                      <TrashIcon size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div
            id="project-step-4"
            className={`scroll-mt-24 gap-4 ${step === 4 ? 'grid' : 'hidden lg:grid'}`}
          >
            <section className="rounded-[16px] border border-[#2a2b30] bg-[#101012] p-5">
              <SectionHeading n={4} title="Project standard" subtitle="Standard is what publishes today." />
              <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Project standard">
                <button
                  type="button"
                  role="radio"
                  aria-checked="true"
                  onClick={() => setStandardNote('')}
                  className="rounded-md border border-sun bg-sun-wash p-4 text-left"
                >
                  <span className="flex items-start gap-3">
                    <span className="mt-0.5 text-sun">
                      <StarIcon />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-sans text-sm font-semibold text-paper">Standard</span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted">
                        Perfect for most projects. Create tasks, grow your community, and publish them on Explore.
                      </span>
                    </span>
                    <RadioDot on />
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked="false"
                  onClick={() =>
                    setStandardNote(
                      'Verified means Flizy has checked this project against Flizy requirements. Contact the team. This project stays Standard until Flizy confirms it.'
                    )
                  }
                  className="rounded-md border border-border p-4 text-left hover:border-[#3a322a]"
                >
                  <span className="flex items-start gap-3">
                    <span className="mt-0.5 text-muted">
                      <ShieldCheckIcon size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-sans text-sm font-semibold text-paper">Verified</span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted">
                        Flizy verifies a project that meets Flizy requirements. Contact the team. The badge is added
                        after Flizy confirms it.
                      </span>
                    </span>
                    <RadioDot on={false} />
                  </span>
                </button>
              </div>
              {standardNote ? (
                <div className="mt-3 grid gap-2">
                  <p className="m-0 text-sm text-[#e0b070]">{standardNote}</p>
                  <a
                    href={VERIFY_MAIL}
                    className="inline-flex min-h-[44px] w-fit items-center font-sans text-sm text-sun no-underline hover:underline"
                  >
                    Contact Flizy
                  </a>
                </div>
              ) : (
                <a
                  href={VERIFY_MAIL}
                  className="mt-3 inline-flex min-h-[44px] w-fit items-center font-sans text-sm text-muted no-underline hover:text-paper"
                >
                  Contact Flizy about verification
                </a>
              )}
            </section>

            <section className="rounded-[16px] border border-[#2a2b30] bg-[#101012] p-5">
              <h3 className="m-0 font-sans text-base font-semibold tracking-wide text-paper">Tasks</h3>
              <p className="m-0 mt-1 text-sm text-muted">Nothing on this card is saved.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-[12px] border border-[#2a2b30] bg-[#0c0c0e] p-4">
                  <p className="m-0 font-sans text-sm font-semibold text-paper">Goes live</p>
                  <p className="m-0 mt-1 text-sm leading-relaxed text-muted">
                    A task goes live when you publish it, and it stays open until the deadline on that task.
                  </p>
                </div>
                <div className="rounded-[12px] border border-[#2a2b30] bg-[#0c0c0e] p-4">
                  <p className="m-0 font-sans text-sm font-semibold text-paper">Participants</p>
                  <p className="m-0 mt-1 text-sm leading-relaxed text-muted">There is no participant cap.</p>
                </div>
              </div>
            </section>

            <section className="rounded-[16px] border border-[#2a2b30] bg-[#101012] p-5">
              <SectionHeading n={5} title="Visibility and privacy" subtitle="A project page is public." />
              <HeldSwitch
                on
                label="Make project public"
                detail="A project page is public."
                icon={<EyeIcon size={16} />}
                onHold={() => setVisibilityNote('A project page is public. That stays on.')}
              />
              <HeldSwitch
                on
                label="Show on Explore"
                detail="Your tasks can appear on Explore."
                icon={<GlobeIcon size={16} />}
                onHold={() =>
                  setVisibilityNote('There is no project directory. Tasks from this project can appear on Explore.')
                }
              />
              <HeldSwitch
                on={false}
                label="Allow anyone to create tasks"
                detail="Only you can create tasks."
                icon={<PeopleIcon size={16} />}
                onHold={() => setVisibilityNote('Only you can create tasks for this project.')}
              />
              {visibilityNote ? <p className="m-0 mt-2 text-sm text-[#e0b070]">{visibilityNote}</p> : null}
            </section>
          </div>
        </div>

        <aside
          id="project-step-5"
          className={`scroll-mt-24 ${step === 5 ? 'block' : 'hidden'} lg:sticky lg:top-24 lg:block`}
        >
          <LivePreview
            name={name}
            handle={shownHandle}
            description={description}
            links={savedLinks}
            bannerUrl={bannerUrl}
            pictureUrl={pictureUrl}
          />
        </aside>
      </div>

      {error ? (
        <p className="alert alert-error m-0" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-ghost min-h-[44px]" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sun min-h-[44px] flex-1 gap-2" disabled={busy}>
          {busy ? (
            'Creating...'
          ) : (
            <>
              <span className="hidden lg:inline">Create project</span>
              <span className="lg:hidden">{step < 5 ? 'Continue' : 'Create project'}</span>
              {step < 5 ? (
                <span className="inline-flex lg:hidden" aria-hidden>
                  <ArrowRightIcon size={16} />
                </span>
              ) : null}
            </>
          )}
        </button>
      </div>
    </form>
  );
}

function SectionHeading({
  n,
  title,
  subtitle,
  action,
}: {
  n: number;
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sun font-sans text-xs font-semibold text-sun-ink">
          {n}
        </span>
        <span className="min-w-0">
          <h2 className="m-0 font-sans text-base font-semibold tracking-wide text-paper">{title}</h2>
          <p className="m-0 mt-0.5 text-sm leading-relaxed text-muted">{subtitle}</p>
        </span>
      </div>
      {action}
    </div>
  );
}

function FieldLabel({
  htmlFor,
  extra,
  children,
}: {
  htmlFor: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="font-sans text-sm font-medium text-paper">
        {children}
      </label>
      {extra}
    </div>
  );
}

function Required() {
  return <span className="text-sun">*</span>;
}

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span className="font-mono text-xs text-muted" aria-live="polite">
      {value}/{max}
    </span>
  );
}

function RadioDot({ on }: { on: boolean }) {
  return (
    <span
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
        on ? 'border-sun' : 'border-[#5c564c]'
      }`}
      aria-hidden
    >
      {on ? <span className="h-2 w-2 rounded-full bg-sun" /> : null}
    </span>
  );
}

function HeldSwitch({
  on,
  label,
  detail,
  icon,
  onHold,
}: {
  on: boolean;
  label: string;
  detail: string;
  icon: ReactNode;
  onHold: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-border py-3 first:border-t-0 first:pt-0">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] border border-border text-sun">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-sans text-sm text-paper">{label}</span>
        <span className="block text-xs leading-relaxed text-muted">{detail}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onHold}
        className="hit-44 relative h-[22px] w-10 shrink-0"
      >
        <span className={`absolute inset-0 rounded-full ${on ? 'bg-sun' : 'bg-[#3a3a3e]'}`} />
        <span
          className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-paper ${on ? 'left-5' : 'left-[2px]'}`}
        />
      </button>
    </div>
  );
}

function AppearanceFields({
  bannerUrl,
  pictureUrl,
  mark,
  onBanner,
  onPicture,
}: {
  bannerUrl: string;
  pictureUrl: string;
  mark: string;
  onBanner: (file: File | undefined) => void;
  onPicture: (file: File | undefined) => void;
}) {
  return (
    <div className="grid gap-3">
      <div>
        <p className="m-0 font-sans text-sm font-semibold text-paper">Picture and banner</p>
        <p className="m-0 mt-1 text-xs leading-relaxed text-muted">
          PNG, JPG, or WebP, under 2 MB. Shown on this preview. Not saved with the project yet, so the public page
          still uses the mark.
        </p>
      </div>
      <div className="overflow-hidden rounded-[14px] border border-[#2a2b30] bg-[#0c0c0e]">
        <div className="relative h-28 bg-[radial-gradient(ellipse_at_right,rgba(247,208,71,0.2),transparent_62%)]">
          {bannerUrl.startsWith('blob:') ? (
            <img src={bannerUrl} alt="Project banner preview" className="h-full w-full object-cover" />
          ) : null}
          <ImagePick label="Add banner" onFile={onBanner} className="absolute bottom-3 right-3" />
        </div>
        <div className="flex items-end gap-3 px-4 pb-4">
          <div className="-mt-8 flex h-16 w-16 items-center justify-center overflow-hidden rounded-[14px] border border-[#3a3424] bg-[#1c1812] font-sans text-lg font-semibold text-sun">
            {pictureUrl.startsWith('blob:') ? (
              <img src={pictureUrl} alt="Project picture preview" className="h-full w-full object-cover" />
            ) : (
              mark
            )}
          </div>
          <ImagePick label="Add picture" onFile={onPicture} />
        </div>
      </div>
    </div>
  );
}

function ImagePick({
  label,
  onFile,
  className = '',
}: {
  label: string;
  onFile: (file: File | undefined) => void;
  className?: string;
}) {
  return (
    <label className={`inline-flex min-h-[44px] cursor-pointer items-center rounded-[4px] border border-[#3a3424] bg-[#101012]/90 px-3 font-sans text-sm text-paper ${className}`}>
      {label}
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </label>
  );
}

function LivePreview({
  name,
  handle,
  description,
  links,
  bannerUrl,
  pictureUrl,
}: {
  name: string;
  handle: string;
  description: string;
  links: Array<{ kind: string; label: string; url: string }>;
  bannerUrl: string;
  pictureUrl: string;
}) {
  const title = name.trim();
  const path = handle.trim();
  const about = description.trim();
  return (
    <div className="rounded-[16px] border border-[#2a2b30] bg-[#101012] p-5">
      <h2 className="m-0 font-sans text-sm font-semibold tracking-wide text-paper">Live preview</h2>
      <p className="m-0 mt-1 text-xs text-muted">
        The public page shows the name, the project link, the description, and the https links.
      </p>
      <div className="mt-4 overflow-hidden rounded-[14px] border border-[#2a2b30] bg-ink">
        <div className="relative h-24 bg-[radial-gradient(ellipse_at_right,rgba(247,208,71,0.16),transparent_64%)]">
          {bannerUrl.startsWith('blob:') ? (
            <img src={bannerUrl} alt="" className="h-full w-full object-cover" />
          ) : null}
        </div>
        <div className="px-4 pb-4">
          <div className="-mt-7 flex h-14 w-14 items-center justify-center overflow-hidden rounded-[12px] border border-[#3a3424] bg-[#1c1812] font-sans text-lg font-semibold text-sun">
            {pictureUrl.startsWith('blob:') ? (
              <img src={pictureUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              markLetters(title)
            )}
          </div>
          <p className={`m-0 mt-3 font-sans text-xl tracking-wide ${title ? 'text-paper' : 'text-muted'}`}>
            {title || 'Project name'}
          </p>
          <p className="m-0 mt-1 font-mono text-xs text-muted">project/{path || 'handle'}</p>
          {about ? <p className="m-0 mt-3 text-sm leading-relaxed text-muted">{about}</p> : null}
          {links.length ? (
            <ul className="m-0 mt-3 flex list-none flex-wrap gap-x-4 gap-y-2 p-0">
              {links.map((link, index) => (
                <li key={`${link.kind}-${link.url}-${index}`}>
                  <a
                    className="text-sm text-lime no-underline hover:underline"
                    href={link.url}
                    target="_blank"
                    rel="noreferrer noopener nofollow"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-4 grid grid-cols-2 gap-1 rounded-md border border-border p-1 text-center font-sans text-sm">
            <span className="rounded-[4px] bg-lime/10 py-1.5 text-lime">Tasks</span>
            <span className="py-1.5 text-muted">Activity</span>
          </div>
          <p className="m-0 mt-3 text-sm text-muted">No tasks yet.</p>
        </div>
      </div>
      <p className="m-0 mt-3 text-xs leading-relaxed text-muted">
        The page shows this name, the project link, the description, and any https links. It does not show your name.
        A picture, a banner, and a verified badge are not saved on that page yet.
      </p>
    </div>
  );
}

function linkKindIcon(kind: string) {
  if (kind === 'x') return <XLogoIcon size={16} />;
  if (kind === 'telegram') return <PlaneIcon />;
  if (kind === 'docs') return <BookOpenIcon size={16} />;
  return <GlobeIcon size={16} />;
}

function PlaneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path strokeWidth="1.7" strokeLinejoin="round" d="M21 4 3.5 10.5l6.2 2.3L17 7.5l-5.2 7.1 2.2 6.1L21 4z" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M12 3.2 14.4 8.8l6.1.6-4.6 4 1.4 6-5.3-3.2-5.3 3.2 1.4-6-4.6-4 6.1-.6L12 3.2z"
      />
    </svg>
  );
}

function HeroMark({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      viewBox="0 0 160 108"
      className={compact ? 'h-14 w-[84px]' : 'h-[72px] w-[108px] shrink-0 sm:h-24 sm:w-36'}
      aria-hidden
    >
      <ellipse cx="86" cy="58" rx="62" ry="18" fill="none" stroke="#f7d047" strokeOpacity="0.28" />
      <ellipse cx="86" cy="58" rx="40" ry="11" fill="none" stroke="#f7d047" strokeOpacity="0.16" />
      <path d="M86 22 122 40 86 58 50 40Z" fill="#f7d047" />
      <path d="M86 58 122 40 122 74 86 92Z" fill="#c4893f" />
      <path d="M86 58 50 40 50 74 86 92Z" fill="#a86b3c" />
    </svg>
  );
}
