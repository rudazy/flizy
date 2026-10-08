'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useDashboard } from './DashboardProvider';
import { validateUsername } from '../lib/username';
import { publicMail } from '../lib/publicMail';
import { VerifiedBadge } from './VerifiedBadge';
import { ProjectAvatar, projectLetters } from './ProjectAvatar';
import { shrinkProjectBanner, shrinkProjectImage } from '../lib/projectImage';
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
  TasksIcon,
  TrashIcon,
  XLogoIcon,
} from './ExploreIcons';

/**
 * Projects on the account.
 *
 * The public page is a brand. This slide is the private list: the projects
 * this account owns or was added to, each opening its workspace at
 * /dashboard/projects/<handle>, then Create a Project in five steps, one step
 * at a time at every width. The form writes the columns a project has: name,
 * handle, description, https links, the picture and the banner.
 *
 * The picture (256x256) and the banner (1200x630) are shrunk in the browser
 * to data URLs, because the image policy allows `data:` and not `blob:`, and
 * saved with the project. Team, standard and visibility are part of the layout
 * and are not stored; members are added from the workspace once the project
 * exists. Verified stays unselected:
 * Flizy confirms a project after the owner writes to the contact mailbox. A
 * task goes live when it is published and stays open until the deadline on
 * that task. There is no participant cap.
 *
 * The handle field carries a link mark, not `@`, which is a payment username.
 */

type ProjectCard = {
  id: string;
  handle: string;
  name: string;
  description: string;
  verified?: boolean;
  image?: string | null;
  role: 'owner' | 'member';
  activeTasks?: number;
  totalTasks?: number;
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

export const LINK_KINDS: Array<[string, string]> = [
  ['website', 'Website'],
  ['x', 'X'],
  ['telegram', 'Telegram'],
  ['docs', 'Docs'],
  ['github', 'GitHub'],
  ['custom', 'Other'],
];

export const LINK_LABEL: Record<string, string> = {
  website: 'Website',
  x: 'X',
  telegram: 'Telegram',
  docs: 'Docs',
  github: 'GitHub',
  custom: 'Link',
};

const STEPS = ['Details', 'Team', 'Links', 'Settings', 'Review'] as const;
const VERIFY_MAIL = `mailto:${publicMail('contact').address}?subject=${encodeURIComponent('Verify a Flizy project')}`;

const FEATURES = [
  { kind: 'page', title: 'Custom page', line: 'Your brand, your rules' },
  { kind: 'tasks', title: 'Create tasks', line: 'Engage your community' },
  { kind: 'activity', title: 'Track activity', line: 'See your impact' },
] as const;

/** Surfaces on this slide: a near-black lift, a hairline, small corners. */
const CARD = 'rounded-[8px] border border-[#232323] bg-[#101010]';
const INSET = 'rounded-[6px] border border-[#272727] bg-[#131313]';
const FIELD =
  'w-full rounded-[4px] border border-[#383838] bg-[#0d0d0d] font-sans text-[9.5px] text-[#f5f5f5] outline-none transition-colors placeholder:text-[#858585] focus:border-sun/70';
const SMALL_BUTTON =
  'hit-y-44 inline-flex h-[26px] shrink-0 items-center gap-[5px] rounded-[5px] border border-[#8a7128] px-[9px] font-sans text-[9px] font-medium text-sun transition-colors hover:border-sun disabled:cursor-not-allowed disabled:opacity-50';

/** Warm light from the top right, under the illustration. */
const HERO_BG =
  'radial-gradient(110% 140% at 100% 0%, rgba(70, 50, 16, 0.8) 0%, rgba(40, 30, 12, 0.45) 40%, rgba(11, 11, 11, 0) 80%), #0b0b0b';
/**
 * The hero art keeps to the right edge. On a narrow phone it slides partly past
 * that edge and fades over a longer stretch, so the text never sits on its
 * bright part.
 */
const WORKSPACE_ART =
  'pointer-events-none absolute right-[-28px] top-0 h-[162px] w-[187px] select-none [mask-image:linear-gradient(90deg,transparent,#000_42%)] min-[380px]:right-[-12px] min-[380px]:[mask-image:linear-gradient(90deg,transparent,#000_34%)] min-[420px]:right-0 min-[420px]:[mask-image:linear-gradient(90deg,transparent,#000_22%)]';
const CREATE_ART =
  'pointer-events-none absolute right-[-30px] top-0 h-[117px] w-[172px] select-none [mask-image:linear-gradient(90deg,transparent,#000_38%)] min-[380px]:right-[-14px] min-[380px]:[mask-image:linear-gradient(90deg,transparent,#000_30%)] min-[420px]:right-0 min-[420px]:[mask-image:linear-gradient(90deg,transparent,#000_22%)]';
const EMPTY_ART =
  'pointer-events-none h-[150px] w-[240px] select-none [mask-image:radial-gradient(closest-side,#000_74%,transparent)]';

function activeLine(count: number | undefined, total?: number): string | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
  const n = Math.floor(count);
  const live = n === 0 ? 'No active tasks' : n === 1 ? '1 active task' : `${n} active tasks`;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return live;
  return `${live} · ${total} ${total === 1 ? 'task' : 'tasks'} in all`;
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
      verified?: unknown;
      image?: unknown;
      role?: unknown;
      activeTasks?: unknown;
      totalTasks?: unknown;
    };
    if (typeof item.id !== 'string' || typeof item.handle !== 'string' || typeof item.name !== 'string') {
      continue;
    }
    projects.push({
      id: item.id,
      handle: item.handle,
      name: item.name,
      description: typeof item.description === 'string' ? item.description : '',
      verified: item.verified === true,
      image: typeof item.image === 'string' ? item.image : null,
      role: item.role === 'member' ? 'member' : 'owner',
      totalTasks: typeof item.totalTasks === 'number' && Number.isFinite(item.totalTasks) ? item.totalTasks : undefined,
      activeTasks:
        typeof item.activeTasks === 'number' && Number.isFinite(item.activeTasks)
          ? item.activeTasks
          : undefined,
    });
  }
  return { projects, canCreate: record.canCreate === true };
}

function isPreview(url: string): boolean {
  return url.startsWith('data:image/');
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
  /** Bumped on every reset, so an image read that finishes late is dropped. */
  const draftRef = useRef(0);
  /** Set when a failed create moves to another step, so the error is scrolled to. */
  const revealError = useRef(false);

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

  useEffect(() => {
    if (!revealError.current || !error) return;
    revealError.current = false;
    document.getElementById('project-form-error')?.scrollIntoView({ block: 'center' });
  }, [error, step]);

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

  function resetDraft() {
    draftRef.current += 1;
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
    setBannerUrl('');
    setPictureUrl('');
  }

  /** Both images are saved, so each is shrunk to its stored size now, not at submit. */
  async function onPickImage(file: File | undefined, which: 'picture' | 'banner') {
    if (!file) return;
    const draft = draftRef.current;
    try {
      const url = which === 'banner' ? await shrinkProjectBanner(file) : await shrinkProjectImage(file);
      if (draft !== draftRef.current) return;
      setError('');
      if (which === 'banner') setBannerUrl(url);
      else setPictureUrl(url);
    } catch (err) {
      if (draft === draftRef.current) setError(err instanceof Error ? err.message : 'Could not read that image.');
    }
  }

  function openCreate() {
    resetDraft();
    setCreating(true);
    window.scrollTo({ top: 0 });
  }

  function close() {
    resetDraft();
    setCreating(false);
    window.scrollTo({ top: 0 });
  }

  function go(n: number) {
    setError('');
    setStep(n);
    window.scrollTo({ top: 0 });
  }

  function showIssue(found: { step: 1 | 3; message: string }) {
    revealError.current = true;
    setError(found.message);
    setStep(found.step);
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
          image: isPreview(pictureUrl) ? pictureUrl : null,
          banner: isPreview(bannerUrl) ? bannerUrl : null,
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
        image: isPreview(pictureUrl) ? pictureUrl : null,
        role: 'owner',
        activeTasks: 0,
        totalTasks: 0,
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
    if (step < STEPS.length) {
      const which: StepCheck | null = step === 1 ? 1 : step === 3 ? 3 : null;
      const found = which ? issueFor(which) : null;
      if (found) {
        setError(found.message);
        return;
      }
      go(step + 1);
      return;
    }
    const found = issueFor('all');
    if (found) {
      showIssue(found);
      return;
    }
    void create();
  }

  if (!creating) {
    const owned = projects === null ? null : projects.filter((p) => p.role === 'owner').length;
    const atCap = (owned ?? 0) >= PROJECT_CAP;
    return (
      <div className="grid w-full gap-[13px]">
        <WorkspaceHero count={owned} />
        {projects === null ? (
          <p className="m-0 px-[2px] font-sans text-[10px] text-[#8f8f8f]">Loading projects.</p>
        ) : loadError ? (
          <section className={`${CARD} grid justify-items-start gap-[10px] p-[13px]`}>
            <p className="m-0 font-sans text-[10px] text-[#e0b070]" role="alert">
              {loadError}
            </p>
            <button
              type="button"
              className="hit-y-44 h-[30px] rounded-[5px] border border-[#383838] px-[12px] font-sans text-[10px] text-[#f5f5f5] transition-colors hover:border-[#4c4c4c]"
              onClick={() => setReload((n) => n + 1)}
            >
              Try again
            </button>
          </section>
        ) : projects.length === 0 ? (
          <EmptyProjects canCreate={canCreate} onCreate={openCreate} />
        ) : (
          <section className={CARD}>
            <ul className="m-0 list-none p-0">
              {projects.map((project) => {
                const line = activeLine(project.activeTasks, project.totalTasks);
                return (
                  <li key={project.id} className="border-b border-[#1f1f1f]">
                    <Link
                      href={`/dashboard/projects/${encodeURIComponent(project.handle)}`}
                      className="flex items-center gap-[11px] px-[13px] pb-[6px] pt-[13px] no-underline"
                    >
                      <ProjectAvatar name={project.name} image={project.image} size={42} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-[5px]">
                          <span className="truncate font-sans text-[12px] font-semibold text-[#f5f5f5]">
                            {project.name}
                          </span>
                          {project.verified ? <VerifiedBadge size={12} /> : null}
                        </span>
                        <span className="mt-[2px] block truncate font-mono text-[9.5px] text-[#8f8f8f]">
                          project/{project.handle}
                        </span>
                        {line ? (
                          <span className="mt-[2px] block font-sans text-[9.5px] text-[#a9a9a9]">{line}</span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-[8px]">
                        {project.role === 'owner' ? <OwnerBadge /> : <MemberBadge />}
                        <ChevronRightIcon size={13} className="text-[#6f6f6f]" />
                      </span>
                    </Link>
                    <div className="pb-[4px] pl-[66px] pr-[13px]">
                      <Link
                        href={`/dashboard/explore/new?project=${encodeURIComponent(project.id)}`}
                        className="hit-y-44 inline-flex h-[32px] items-center gap-[5px] font-sans text-[9.5px] text-[#8f8f8f] no-underline transition-colors hover:text-[#f5f5f5]"
                      >
                        <PlusIcon size={10} />
                        New task
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex justify-center px-[13px] pb-[16px] pt-[16px]">
              {atCap ? (
                <p className="m-0 font-sans text-[10px] text-[#8f8f8f]">An account can have {PROJECT_CAP} projects.</p>
              ) : canCreate ? (
                <CreateProjectButton onClick={openCreate} />
              ) : (
                <p className="m-0 font-sans text-[10px] text-[#8f8f8f]">This account cannot create a project.</p>
              )}
            </div>
          </section>
        )}
      </div>
    );
  }

  const savedLinks = linksToSave(links);
  const shownHandle = handle.trim();

  return (
    <form onSubmit={onSubmit} noValidate className="grid w-full">
      <nav aria-label="Breadcrumb" className="-mt-[5px] flex h-[18px] items-center font-sans text-[11px] leading-none">
        <button
          type="button"
          onClick={close}
          className="hit-y-44 inline-flex items-center gap-[6px] text-[#7c7c7c] transition-colors hover:text-[#f5f5f5]"
        >
          <ArrowLeftIcon size={13} />
          Back
        </button>
        <span aria-hidden className="mx-[9.5px] text-[#5f5f5f]">
          /
        </span>
        <button type="button" onClick={close} className="hit-y-44 text-[#7c7c7c] transition-colors hover:text-[#f5f5f5]">
          Projects
        </button>
        <span aria-hidden className="mx-[9.5px] text-[#5f5f5f]">
          /
        </span>
        <span className="text-[#f5f5f5]" aria-current="page">
          Create project
        </span>
      </nav>

      <header
        className="relative mt-[12.5px] h-[119px] overflow-hidden rounded-[8px] border border-[#242424]"
        style={{ background: HERO_BG }}
      >
        <Image
          src="/projects/create-hero.webp"
          alt=""
          width={172}
          height={117}
          unoptimized
          priority
          className={CREATE_ART}
        />
        <div className="relative px-[17px] pt-[16px]">
          <p className="m-0 font-sans text-[8px] font-medium uppercase leading-none tracking-[0.15em] text-sun">
            New project
          </p>
          <h2 className="m-0 mt-[11px] font-sans text-[26px] font-bold leading-none text-[#f5f5f5]">
            Create a <span className="text-sun">Project</span>
          </h2>
          <p className="m-0 mt-[8px] max-w-[222px] font-sans text-[11px] leading-[14px] text-[#9a9a9a]">
            Launch your project page, create tasks, and grow your community.
          </p>
        </div>
      </header>

      <Stepper step={step} onGo={go} />

      <div className="grid gap-[8px]">
        {step === 1 ? (
          <>
            <SectionCard n={1} title="Basic information" subtitle="Tell us about your project.">
              <div className="mt-[11.5px] grid px-[2.5px]">
                <FieldLabel htmlFor="project-name" extra={<Counter value={name.length} max={NAME_MAX} />}>
                  Project name <Required />
                </FieldLabel>
                <div className="relative mt-[5px]">
                  <FieldIcon>
                    <CubeIcon size={16} />
                  </FieldIcon>
                  <input
                    id="project-name"
                    className={`${FIELD} h-[30px] pl-[37px] pr-[10px]`}
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value.slice(0, NAME_MAX));
                      setError('');
                    }}
                    placeholder="Enter project name"
                    maxLength={NAME_MAX}
                    autoComplete="off"
                  />
                </div>

                <div className="mt-[11px]">
                  <FieldLabel htmlFor="project-handle">
                    Project handle <Required />
                  </FieldLabel>
                </div>
                <div className="relative mt-[5px]">
                  <FieldIcon>
                    <ChainIcon size={14} />
                  </FieldIcon>
                  <input
                    id="project-handle"
                    className={`${FIELD} h-[30px] pl-[37px] pr-[78px]`}
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
                    <span className="pointer-events-none absolute right-[11px] top-1/2 flex -translate-y-1/2 items-center gap-[4px] font-sans text-[9.5px] text-[#2fd27a]">
                      <span className="flex h-[10px] w-[10px] items-center justify-center rounded-full bg-[#2fd27a] text-[#0b0b0b]">
                        <CheckIcon size={7} strokeWidth={3.2} />
                      </span>
                      Available
                    </span>
                  ) : handleState.kind === 'checking' ? (
                    <span className="pointer-events-none absolute right-[11px] top-1/2 -translate-y-1/2 font-sans text-[9.5px] text-[#8f8f8f]">
                      Checking
                    </span>
                  ) : null}
                </div>
                <p
                  id="project-handle-status"
                  className="m-0 mt-[4px] font-sans text-[9.5px] leading-[13px] text-[#8f8f8f]"
                  aria-live="polite"
                >
                  {handleState.kind === 'blocked' ? (
                    <span className="mb-[2px] block text-[#e0b070]">{handleState.reason}</span>
                  ) : null}
                  Your project link:{' '}
                  <span className="font-mono text-[8.5px] text-sun">
                    flizy.app/project/{shownHandle || 'handle'}
                  </span>
                </p>

                <div className="mt-[11.5px]">
                  <FieldLabel
                    htmlFor="project-description"
                    extra={<Counter value={description.length} max={DESCRIPTION_MAX} />}
                  >
                    Description <Required />
                  </FieldLabel>
                </div>
                <div className="relative mt-[5px]">
                  <span className="pointer-events-none absolute left-[10px] top-[9px] text-[#8f8f8f]">
                    <DocIcon />
                  </span>
                  <textarea
                    id="project-description"
                    className={`${FIELD} block h-[56px] resize-none py-[8px] pl-[37px] pr-[10px] leading-[14px]`}
                    value={description}
                    onChange={(e) => {
                      setDescription(e.target.value.slice(0, DESCRIPTION_MAX));
                      setError('');
                    }}
                    placeholder="What this project is, in a sentence or two."
                    maxLength={DESCRIPTION_MAX}
                    rows={3}
                  />
                </div>
              </div>
            </SectionCard>

            <SectionCard
              n={2}
              title="Picture and banner"
              subtitle="Both are saved with the project and shown on its page."
              tight
            >
              <div className="mt-[9.5px] grid gap-[6.5px] min-[420px]:grid-cols-[174.5fr_205fr]">
                <div className={`${INSET} px-[10px] pb-[8.5px] pt-[9px]`}>
                  <p className="m-0 font-sans text-[9.5px] leading-[12px] text-[#f5f5f5]">Profile picture</p>
                  <p className="m-0 mt-[1.5px] font-sans text-[8.5px] leading-[11px] text-[#8f8f8f]">Square image (1:1)</p>
                  <div className="mt-[5px] flex items-center gap-[7px]">
                    <div className="h-[69px] w-[69px] shrink-0 overflow-hidden rounded-[7px] border border-[#6b5a35] bg-[#14110b]">
                      {isPreview(pictureUrl) ? (
                        <img src={pictureUrl} alt="Project picture preview" className="h-full w-full object-cover" />
                      ) : (
                        <Image
                          src="/projects/picture-placeholder.webp"
                          alt=""
                          width={67}
                          height={67}
                          unoptimized
                          className="h-full w-full select-none"
                        />
                      )}
                    </div>
                    <ImageDrop
                      title="Upload image"
                      onFile={(file) => void onPickImage(file, 'picture')}
                    />
                  </div>
                </div>
                <div className={`${INSET} px-[10px] pb-[8.5px] pt-[9px]`}>
                  <p className="m-0 font-sans text-[9.5px] leading-[12px] text-[#f5f5f5]">Banner image</p>
                  <p className="m-0 mt-[1.5px] font-sans text-[8.5px] leading-[11px] text-[#8f8f8f]">Cropped to 1200 by 630</p>
                  <div className="mt-[5px] flex items-center gap-[5.5px]">
                    <div className="h-[72.5px] min-w-0 flex-1 overflow-hidden rounded-[5px] border border-[#3d3c3a] bg-[#14110b]">
                      {isPreview(bannerUrl) ? (
                        <img src={bannerUrl} alt="Project banner preview" className="h-full w-full object-cover" />
                      ) : (
                        <Image
                          src="/projects/banner-placeholder.webp"
                          alt=""
                          width={99}
                          height={71}
                          unoptimized
                          className="h-full w-full select-none object-cover"
                        />
                      )}
                    </div>
                    <ImageDrop
                      title="Upload banner"
                      onFile={(file) => void onPickImage(file, 'banner')}
                    />
                  </div>
                </div>
              </div>
            </SectionCard>
          </>
        ) : null}

        {step === 2 ? (
          <SectionCard
            n={1}
            title="Project team"
            subtitle="You are the only manager. Invites are not open yet."
            action={
              <button
                type="button"
                className={SMALL_BUTTON}
                onClick={() => setTeamNote('Invites are not open yet. You are the only manager.')}
              >
                <PlusIcon size={10} />
                Add member
              </button>
            }
          >
            <div className={`${INSET} mt-[12px] flex items-center gap-[10px] px-[10px] py-[9px]`}>
              <span
                className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-sun bg-sun-wash font-sans text-[11px] font-semibold text-sun"
                aria-hidden
              >
                {username ? username.slice(0, 1).toUpperCase() : 'Y'}
              </span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-[6px]">
                  <span className="truncate font-mono text-[10px] text-[#f5f5f5]">
                    {username ? `@${username}` : 'This account'}
                  </span>
                  <OwnerBadge />
                </span>
                <span className="mt-[2px] block font-sans text-[8.5px] text-[#8f8f8f]">
                  Full access. Manage everything.
                </span>
              </span>
            </div>
            {username ? null : (
              <p className="m-0 mt-[10px] font-sans text-[9.5px] text-[#8f8f8f]">
                Set a username on Profile. The public page will not show it.
              </p>
            )}
            {teamNote ? <p className="m-0 mt-[10px] font-sans text-[9.5px] text-[#e0b070]">{teamNote}</p> : null}
          </SectionCard>
        ) : null}

        {step === 3 ? (
          <SectionCard
            n={1}
            title="Project links"
            subtitle="Add your project's important links. Optional."
            action={
              <button
                type="button"
                className={SMALL_BUTTON}
                disabled={links.length >= 20}
                onClick={() => {
                  setLinks((prev) => [...prev, { id: nextLinkId, kind: 'website', url: '' }]);
                  setNextLinkId((n) => n + 1);
                  setError('');
                }}
              >
                <PlusIcon size={10} />
                Add link
              </button>
            }
          >
            {links.length === 0 ? (
              <p className="m-0 mt-[12px] font-sans text-[9.5px] text-[#8f8f8f]">
                No links yet. An empty row is not saved.
              </p>
            ) : (
              <ul className="m-0 mt-[12px] grid list-none gap-[8px] p-0">
                {links.map((row) => (
                  <li key={row.id} className="grid grid-cols-[14px_minmax(0,1fr)_30px] items-center gap-[7px]">
                    <span className="text-[#8f8f8f]">{linkKindIcon(row.kind)}</span>
                    <div className="grid min-w-0 gap-[6px] min-[420px]:grid-cols-[92px_minmax(0,1fr)]">
                      <select
                        className={`${FIELD} h-[30px] px-[8px] [color-scheme:dark]`}
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
                        className={`${FIELD} h-[30px] px-[10px] font-mono`}
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
                      className="hit-44 flex h-[30px] w-[30px] items-center justify-center rounded-[4px] border border-[#383838] text-[#8f8f8f] transition-colors hover:text-[#f5f5f5]"
                      aria-label="Remove link"
                      onClick={() => {
                        setLinks((prev) => prev.filter((item) => item.id !== row.id));
                        setError('');
                      }}
                    >
                      <TrashIcon size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        ) : null}

        {step === 4 ? (
          <>
            <SectionCard n={1} title="Project standard" subtitle="Standard is what publishes today.">
              <div
                className="mt-[12px] grid gap-[6.5px] min-[420px]:grid-cols-2"
                role="radiogroup"
                aria-label="Project standard"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked="true"
                  onClick={() => setStandardNote('')}
                  className="rounded-[6px] border border-sun bg-sun-wash p-[10px] text-left"
                >
                  <span className="flex items-start gap-[8px]">
                    <span className="mt-[1px] text-sun">
                      <StarIcon />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-sans text-[10px] font-semibold text-[#f5f5f5]">Standard</span>
                      <span className="mt-[3px] block font-sans text-[8.5px] leading-[12px] text-[#8f8f8f]">
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
                  className={`${INSET} p-[10px] text-left transition-colors hover:border-[#3b3b3b]`}
                >
                  <span className="flex items-start gap-[8px]">
                    <span className="mt-[1px] text-[#8f8f8f]">
                      <ShieldCheckIcon size={13} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-sans text-[10px] font-semibold text-[#f5f5f5]">Verified</span>
                      <span className="mt-[3px] block font-sans text-[8.5px] leading-[12px] text-[#8f8f8f]">
                        Flizy verifies a project that meets Flizy requirements. Contact the team. The badge is added
                        after Flizy confirms it.
                      </span>
                    </span>
                    <RadioDot on={false} />
                  </span>
                </button>
              </div>
              {standardNote ? (
                <div className="mt-[10px] grid justify-items-start gap-[4px]">
                  <p className="m-0 font-sans text-[9.5px] leading-[13px] text-[#e0b070]">{standardNote}</p>
                  <a
                    href={VERIFY_MAIL}
                    className="hit-y-44 inline-flex h-[24px] items-center font-sans text-[9.5px] text-sun no-underline hover:underline"
                  >
                    Contact Flizy
                  </a>
                </div>
              ) : (
                <a
                  href={VERIFY_MAIL}
                  className="hit-y-44 mt-[6px] inline-flex h-[24px] items-center font-sans text-[9.5px] text-[#8f8f8f] no-underline transition-colors hover:text-[#f5f5f5]"
                >
                  Contact Flizy about verification
                </a>
              )}
            </SectionCard>

            <SectionCard n={2} title="Tasks" subtitle="Nothing on this card is saved.">
              <div className="mt-[12px] grid gap-[6.5px] min-[420px]:grid-cols-2">
                <div className={`${INSET} p-[10px]`}>
                  <p className="m-0 font-sans text-[10px] font-semibold text-[#f5f5f5]">Goes live</p>
                  <p className="m-0 mt-[3px] font-sans text-[8.5px] leading-[12px] text-[#8f8f8f]">
                    A task goes live when you publish it, and it stays open until the deadline on that task.
                  </p>
                </div>
                <div className={`${INSET} p-[10px]`}>
                  <p className="m-0 font-sans text-[10px] font-semibold text-[#f5f5f5]">Participants</p>
                  <p className="m-0 mt-[3px] font-sans text-[8.5px] leading-[12px] text-[#8f8f8f]">
                    There is no participant cap.
                  </p>
                </div>
              </div>
            </SectionCard>

            <SectionCard n={3} title="Visibility and privacy" subtitle="A project page is public.">
              <div className="mt-[6px]">
                <HeldSwitch
                  on
                  label="Make project public"
                  detail="A project page is public."
                  icon={<EyeIcon size={13} />}
                  onHold={() => setVisibilityNote('A project page is public. That stays on.')}
                />
                <HeldSwitch
                  on
                  label="Show on Explore"
                  detail="Your tasks can appear on Explore."
                  icon={<GlobeIcon size={13} />}
                  onHold={() =>
                    setVisibilityNote('There is no project directory. Tasks from this project can appear on Explore.')
                  }
                />
                <HeldSwitch
                  on={false}
                  label="Allow anyone to create tasks"
                  detail="Only you can create tasks."
                  icon={<PeopleIcon size={13} />}
                  onHold={() => setVisibilityNote('Only you can create tasks for this project.')}
                />
              </div>
              {visibilityNote ? (
                <p className="m-0 mt-[4px] font-sans text-[9.5px] text-[#e0b070]">{visibilityNote}</p>
              ) : null}
            </SectionCard>
          </>
        ) : null}

        {step === 5 ? (
          <SectionCard
            n={1}
            title="Live preview"
            subtitle="The public page shows the name, the project link, the description, and the https links."
          >
            <LivePreview
              name={name}
              handle={shownHandle}
              description={description}
              links={savedLinks}
              bannerUrl={bannerUrl}
              pictureUrl={pictureUrl}
            />
          </SectionCard>
        ) : null}
      </div>

      {error ? (
        <p
          id="project-form-error"
          className="m-0 mt-[8px] rounded-[6px] border border-[#5a3f1a] bg-[#1a130a] px-[12px] py-[8px] font-sans text-[10px] leading-[14px] text-[#e0b070]"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <div className="mt-[8.5px] flex gap-[9.5px]">
        <button
          type="button"
          onClick={close}
          disabled={busy}
          className="hit-y-44 h-[34.5px] w-[120.5px] shrink-0 rounded-[5px] border border-[#8a7128] bg-transparent font-sans text-[10px] text-[#f5f5f5] transition-colors hover:border-sun disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="btn-sun hit-y-44 h-[34px] min-w-0 flex-1 gap-[10px] rounded-[5px] font-sans text-[10px] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            'Creating...'
          ) : step < STEPS.length ? (
            <>
              Continue
              <ArrowRightIcon size={12} strokeWidth={2.3} />
            </>
          ) : (
            'Create project'
          )}
        </button>
      </div>
    </form>
  );
}

function WorkspaceHero({ count }: { count: number | null }) {
  return (
    <section
      className="relative h-[164px] overflow-hidden rounded-[8px] border border-[#242424]"
      style={{ background: HERO_BG }}
    >
      <Image
        src="/projects/workspace-hero.webp"
        alt=""
        width={187}
        height={162}
        unoptimized
        priority
        className={WORKSPACE_ART}
      />
      {count === null ? null : (
        <p className="absolute right-[17px] top-[17px] m-0 font-sans text-[10.5px] leading-none text-[#f5f5f5]">
          <span className="font-bold">{count}</span> of {PROJECT_CAP}
        </p>
      )}
      <div className="relative px-[17px] pt-[20px]">
        <p className="m-0 font-sans text-[9.5px] font-medium uppercase leading-none tracking-[0.12em] text-sun">
          Workspace
        </p>
        <h2 className="m-0 mt-[15px] font-sans text-[27px] font-bold leading-none text-[#f5f5f5]">
          My <span className="text-sun">Projects</span>
        </h2>
        <p className="m-0 mt-[8.5px] max-w-[206px] font-sans text-[12px] leading-[17.5px] text-[#9a9a9a]">
          Create and manage multiple projects. Each project has its own public page and does not show your name.
        </p>
      </div>
    </section>
  );
}

function EmptyProjects({ canCreate, onCreate }: { canCreate: boolean; onCreate: () => void }) {
  return (
    <section className={`${CARD} overflow-hidden`}>
      <div className="flex flex-col items-center px-[17px] pt-[21px] text-center">
        <Image
          src="/projects/workspace-empty.webp"
          alt=""
          width={240}
          height={150}
          unoptimized
          loading="eager"
          className={EMPTY_ART}
        />
        <h3 className="m-0 mt-[6px] font-sans text-[19px] font-bold leading-none text-[#f5f5f5]">No projects yet</h3>
        <p className="m-0 mt-[11.5px] max-w-[250px] font-sans text-[13px] leading-[18.5px] text-[#9a9a9a]">
          Launch your first project page to create tasks and grow your community.
        </p>
        {canCreate ? (
          <CreateProjectButton onClick={onCreate} className="mt-[14px]" />
        ) : (
          <p className="m-0 mt-[14px] font-sans text-[10px] text-[#8f8f8f]">This account cannot create a project.</p>
        )}
      </div>
      <div className="mx-[17px] mt-[21px] border-t border-[#1f1f1f]" />
      <ul className="m-0 grid list-none grid-cols-3 p-0 pb-[14.5px] pt-[17px]">
        {FEATURES.map((feature, index) => (
          <li
            key={feature.kind}
            className={`flex min-w-0 flex-col items-center px-[4px] pb-[6px] text-center ${
              index ? 'border-l border-[#202020]' : ''
            }`}
          >
            <span className="flex h-[42px] w-[42px] items-center justify-center rounded-[6px] border border-[#262626] bg-[#131313] text-sun">
              {feature.kind === 'page' ? (
                <ChainIcon size={20} />
              ) : feature.kind === 'tasks' ? (
                <TasksIcon size={24} strokeWidth={1.7} />
              ) : (
                <BarsIcon size={26} />
              )}
            </span>
            <span className="mt-[7px] font-sans text-[11px] font-semibold leading-[13px] text-[#f5f5f5]">
              {feature.title}
            </span>
            <span className="mt-[3.5px] font-sans text-[10px] leading-[12px] text-[#8f8f8f]">{feature.line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The label sits in the middle; the plus hangs off its left and the arrow keeps to the right edge. */
function CreateProjectButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`btn-sun relative h-[47px] w-[230px] max-w-full rounded-[6px] font-sans text-[13px] ${className}`}
    >
      <span className="relative">
        <span className="absolute right-full top-1/2 mr-[8px] flex -translate-y-1/2" aria-hidden>
          <PlusIcon size={21} strokeWidth={1.7} />
        </span>
        <span className="font-bold">Create project</span>
      </span>
      <span className="absolute right-[15.5px] top-1/2 flex -translate-y-1/2" aria-hidden>
        <ArrowRightIcon size={22} strokeWidth={1.65} />
      </span>
    </button>
  );
}

function Stepper({ step, onGo }: { step: number; onGo: (n: number) => void }) {
  return (
    <ol aria-label="Steps" className="m-0 mt-[13.5px] flex list-none items-start px-[24px] pb-[24px] pt-0">
      {STEPS.map((label, index) => {
        const n = index + 1;
        const current = n === step;
        const done = n < step;
        const last = index === STEPS.length - 1;
        const line = done
          ? 'rgba(247, 208, 71, 0.75)'
          : current
            ? 'linear-gradient(90deg, rgba(247, 208, 71, 0.75) 0 50%, rgba(247, 208, 71, 0.14) 50% 100%)'
            : '#202020';
        return (
          <li key={label} className={`flex items-center ${last ? '' : 'flex-1'}`}>
            <button
              type="button"
              onClick={() => onGo(n)}
              aria-current={current ? 'step' : undefined}
              aria-label={`${label}, step ${n} of ${STEPS.length}`}
              className={`hit-44 relative flex h-[21px] w-[21px] shrink-0 items-center justify-center rounded-full font-sans text-[10px] leading-none ${
                current
                  ? 'bg-sun font-semibold text-sun-ink shadow-[0_0_12px_rgba(247,208,71,0.35)]'
                  : done
                    ? 'border border-sun bg-[#141414] text-sun'
                    : 'border border-[#4f4f4f] bg-[#141414] text-[#cfcfcf]'
              }`}
            >
              {n}
              <span
                className={`pointer-events-none absolute left-1/2 top-[25px] -translate-x-1/2 whitespace-nowrap font-sans text-[9.5px] leading-none ${
                  current ? 'font-medium text-sun' : 'font-normal text-[#8f8f8f]'
                }`}
                aria-hidden
              >
                {label}
              </span>
            </button>
            {last ? null : <span aria-hidden className="mx-[9px] h-px flex-1" style={{ background: line }} />}
          </li>
        );
      })}
    </ol>
  );
}

function SectionCard({
  n,
  title,
  subtitle,
  action,
  tight = false,
  children,
}: {
  n: number;
  title: string;
  subtitle: string;
  action?: ReactNode;
  /** Less room under the content, for a card that ends in its own inset boxes. */
  tight?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`${CARD} px-[13px] pt-[8.5px] ${tight ? 'pb-[6px]' : 'pb-[10.5px]'}`}>
      <div className="flex items-center gap-[14.5px]">
        <span className="flex h-[25px] w-[25px] shrink-0 items-center justify-center rounded-full bg-sun font-sans text-[12px] font-semibold text-sun-ink">
          {n}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="m-0 font-sans text-[11px] font-semibold leading-[14px] text-[#f5f5f5]">{title}</h3>
          <p className="m-0 mt-[2.5px] font-sans text-[9.5px] leading-[13px] text-[#8f8f8f]">{subtitle}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
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
    <div className="flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="font-sans text-[10.25px] font-medium leading-[13px] text-[#f5f5f5]">
        {children}
      </label>
      {extra}
    </div>
  );
}

function FieldIcon({ children }: { children: ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-[10.5px] top-1/2 -translate-y-1/2 text-[#c8c8c8]">
      {children}
    </span>
  );
}

function Required() {
  return <span className="text-sun">*</span>;
}

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span className="font-mono text-[10px] leading-[13px] text-[#9d9d9d]" aria-live="polite">
      {value}/{max}
    </span>
  );
}

function OwnerBadge() {
  return (
    <span className="rounded-[3px] bg-sun px-[5px] py-[1.5px] font-sans text-[7.5px] font-semibold uppercase tracking-wide text-sun-ink">
      Owner
    </span>
  );
}

function MemberBadge() {
  return (
    <span className="rounded-[3px] border border-[#8a7128] px-[5px] py-[1px] font-sans text-[7.5px] font-semibold uppercase tracking-wide text-sun">
      Member
    </span>
  );
}

function ImageDrop({ title, onFile }: { title: string; onFile: (file: File | undefined) => void }) {
  return (
    <label className="flex h-[76.5px] w-[77px] shrink-0 cursor-pointer flex-col items-center rounded-[6px] border border-dashed border-[#2e2e2e] bg-[#0d0d0d] px-[3px] pt-[11px] text-center transition-colors focus-within:border-sun/70 hover:border-[#4d4d4d]">
      <span className="text-[#d4d4d4]">
        <UploadIcon />
      </span>
      <span className="mt-[7.5px] font-sans text-[8.5px] leading-[11px] text-[#ececec]">{title}</span>
      <span className="mt-[4.5px] font-sans text-[7px] leading-[9px] text-[#8f8f8f]">
        PNG, JPG or WebP
        <br />
        Max 8 MB
      </span>
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

function RadioDot({ on }: { on: boolean }) {
  return (
    <span
      className={`mt-[1px] flex h-[12px] w-[12px] shrink-0 items-center justify-center rounded-full border ${
        on ? 'border-sun' : 'border-[#5c5c5c]'
      }`}
      aria-hidden
    >
      {on ? <span className="h-[6px] w-[6px] rounded-full bg-sun" /> : null}
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
    <div className="flex items-center gap-[10px] border-t border-[#1f1f1f] py-[9px] first:border-t-0">
      <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[5px] border border-[#262626] bg-[#131313] text-sun">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-sans text-[10px] text-[#f5f5f5]">{label}</span>
        <span className="mt-[1px] block font-sans text-[8.5px] text-[#8f8f8f]">{detail}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={onHold}
        className="hit-44 relative h-[17px] w-[30px] shrink-0"
      >
        <span className={`absolute inset-0 rounded-full ${on ? 'bg-sun' : 'bg-[#3b3b3b]'}`} />
        <span
          className={`absolute top-[2px] h-[13px] w-[13px] rounded-full bg-[#f5f5f5] ${on ? 'left-[15px]' : 'left-[2px]'}`}
        />
      </button>
    </div>
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
    <>
      <div className="mt-[12px] overflow-hidden rounded-[6px] border border-[#272727] bg-[#0b0b0b]">
        <div className="h-[64px] bg-[radial-gradient(ellipse_at_right,rgba(247,208,71,0.16),transparent_64%)]">
          {isPreview(bannerUrl) ? (
            <img src={bannerUrl} alt="" className="h-full w-full object-cover" />
          ) : null}
        </div>
        <div className="px-[12px] pb-[12px]">
          <div className="relative -mt-[22px] flex h-[44px] w-[44px] items-center justify-center overflow-hidden rounded-[8px] border border-border bg-surface font-sans text-[14px] font-semibold tracking-wide text-paper">
            {isPreview(pictureUrl) ? (
              <img src={pictureUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              projectLetters(title)
            )}
          </div>
          <p className={`m-0 mt-[8px] font-sans text-[14px] font-semibold ${title ? 'text-[#f5f5f5]' : 'text-[#8f8f8f]'}`}>
            {title || 'Project name'}
          </p>
          <p className="m-0 mt-[2px] font-mono text-[9px] text-[#8f8f8f]">project/{path || 'handle'}</p>
          {about ? (
            <p className="m-0 mt-[8px] font-sans text-[9.5px] leading-[13.5px] text-[#8f8f8f]">{about}</p>
          ) : null}
          {links.length ? (
            <ul className="m-0 mt-[8px] flex list-none flex-wrap gap-x-[12px] gap-y-[6px] p-0">
              {links.map((link, index) => (
                <li key={`${link.kind}-${link.url}-${index}`}>
                  <a
                    className="font-sans text-[9.5px] text-lime no-underline hover:underline"
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
          <div className="mt-[12px] grid grid-cols-2 gap-[3px] rounded-[5px] border border-[#272727] p-[3px] text-center font-sans text-[9.5px]">
            <span className="rounded-[3px] bg-lime/10 py-[5px] text-lime">Tasks</span>
            <span className="py-[5px] text-[#8f8f8f]">Activity</span>
          </div>
          <p className="m-0 mt-[8px] font-sans text-[9.5px] text-[#8f8f8f]">No tasks yet.</p>
        </div>
      </div>
      <p className="m-0 mt-[10px] font-sans text-[8.5px] leading-[12px] text-[#8f8f8f]">
        The page shows this name, the project link, the description, and any https links. It does not show your name.
        The page shows the picture and the banner. A verified badge appears once Flizy verifies the project.
      </p>
    </>
  );
}

function linkKindIcon(kind: string) {
  if (kind === 'x') return <XLogoIcon size={14} />;
  if (kind === 'telegram') return <PlaneIcon />;
  if (kind === 'docs') return <BookOpenIcon size={14} />;
  return <GlobeIcon size={14} />;
}

function PlaneIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path strokeWidth="1.7" strokeLinejoin="round" d="M21 4 3.5 10.5l6.2 2.3L17 7.5l-5.2 7.1 2.2 6.1L21 4z" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M12 3.2 14.4 8.8l6.1.6-4.6 4 1.4 6-5.3-3.2-5.3 3.2 1.4-6-4.6-4 6.1-.6L12 3.2z"
      />
    </svg>
  );
}

function CubeIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
      <path d="M12 2.8 20.5 7.4v9.2L12 21.2l-8.5-4.6V7.4L12 2.8z" />
      <path d="M3.8 7.6 12 12l8.2-4.4M12 12v9" />
    </svg>
  );
}

function ChainIcon({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg width="13" height="15.6" viewBox="0 0 20 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
      <path d="M12.5 2H4.5A2 2 0 0 0 2.5 4v16a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7l-5-5z" />
      <path d="M12.5 2v5h5M6.5 13h7M6.5 17h7" strokeLinecap="round" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 15V3.5M7 8.5l5-5 5 5" />
      <path d="M3.5 14.5v4a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4" />
    </svg>
  );
}

function BarsIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="4" y="13" width="4" height="8" rx="1.6" />
      <rect x="10" y="5" width="4" height="16" rx="1.6" />
      <rect x="16" y="9.5" width="4" height="11.5" rx="1.6" />
    </svg>
  );
}
