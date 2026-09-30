'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppTopBar } from '../../../../components/AppTopBar';
import { AppPage, AppSection } from '../../../../components/AppSection';
import { TaskCard, type TaskCardData } from '../../../../components/TaskCard';
import { useDashboard } from '../../../../components/DashboardProvider';

/**
 * Create a task.
 *
 * One page rather than a wizard. Every field fits on one screen, and a wizard
 * would mean one chance per step to lose what somebody typed.
 *
 * Any signed-in account. The API is what decides, and this page says so rather
 * than presenting a form that cannot be submitted.
 */

type Project = { id: string; handle: string; name: string };

const REWARD_KINDS = [
  ['crypto', 'Crypto'],
  ['wl', 'Whitelist spots'],
  ['nft', 'NFT'],
  ['token', 'Token'],
  ['product', 'Product or access'],
  ['custom', 'Something else'],
] as const;

const REQUIREMENT_KINDS = [
  ['x_post', 'An X post'],
  ['link', 'A link'],
  ['text', 'Written text'],
] as const;

export default function NewTaskPage() {
  const router = useRouter();
  const search = useSearchParams();
  const { data } = useDashboard();
  const username = data?.account?.username || '';

  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [createAs, setCreateAs] = useState<string>('personal');

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [rewardKind, setRewardKind] = useState<string>('crypto');
  const [rewardDisplay, setRewardDisplay] = useState('');
  const [rewardAsset, setRewardAsset] = useState('');
  const [winnersCount, setWinnersCount] = useState('1');
  const [endsAt, setEndsAt] = useState('');
  const [requirementKind, setRequirementKind] = useState<string>('x_post');
  const [requirementLabel, setRequirementLabel] = useState('');
  const [links, setLinks] = useState<Array<{ kind: string; label: string; url: string }>>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/projects');
        const body = await res.json();
        if (cancelled) return;
        // The reported capability, not the status code. This route answers 200
        // to any signed-in account, so reading ok as permission put the whole
        // form in front of people whose submit would be refused.
        if (res.ok && body?.canCreate === true) {
          setAllowed(true);
          const rows = (body?.projects || []) as Project[];
          setProjects(rows);
          const wanted = search.get('project');
          if (wanted && rows.some((p) => p.id === wanted)) setCreateAs(wanted);
        } else {
          setAllowed(false);
        }
      } catch {
        if (!cancelled) setAllowed(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [search]);

  function previewOf(): TaskCardData {
    const project = projects.find((p) => p.id === createAs);
    const ends = endsAt ? new Date(endsAt).getTime() : NaN;
    return {
      ref: 0,
      title: title.trim(),
      rewardDisplay: rewardDisplay.trim(),
      winnersCount: Math.max(1, Number(winnersCount) || 1),
      participants: 0,
      endsAt: Number.isFinite(ends) ? new Date(ends).toISOString() : new Date(Date.now() + 86400000).toISOString(),
      state: 'live',
      creator: project
        ? { kind: 'project', name: project.name, handle: project.handle }
        : { kind: 'personal', name: username ? `@${username}` : 'You', handle: username || null },
    };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          description,
          rewardKind,
          rewardDisplay,
          rewardAsset: rewardAsset || null,
          winnersCount: Number(winnersCount),
          // A local datetime-local value carries no zone, so it is converted here
          // rather than sent as typed. The database stores an instant.
          endsAt: endsAt ? new Date(endsAt).toISOString() : '',
          projectId: createAs === 'personal' ? null : createAs,
          requirements: [
            { kind: requirementKind, label: requirementLabel.trim() || defaultLabel(requirementKind) },
          ],
          links,
        }),
      });
      const body = await res.json();
      if (body?.ok) router.push(`/tasks/${body.ref}`);
      else setError(body?.error || 'Could not publish that.');
    } catch {
      setError('Could not publish that. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (allowed === null) {
    return (
      <AppPage>
        <AppTopBar title="New task" />
        <p className="text-sm text-muted">Loading...</p>
      </AppPage>
    );
  }

  if (!allowed) {
    return (
      <AppPage>
        <AppTopBar title="New task" />
        <AppSection title="Sign in required">
          <p className="m-0 text-sm text-muted">
            Sign in with the account you want to publish as, then come back.
          </p>
        </AppSection>
      </AppPage>
    );
  }

  return (
    <AppPage>
      <AppTopBar title="New task" />

      <form onSubmit={onSubmit} className="grid gap-4">
        <AppSection title="Create as">
          <div className="grid gap-2">
            <label className="flex items-center gap-2 text-sm text-paper">
              <input
                type="radio"
                name="createAs"
                checked={createAs === 'personal'}
                onChange={() => setCreateAs('personal')}
              />
              <span>
                Personal
                {username ? <span className="ml-2 font-mono text-xs text-muted">@{username}</span> : null}
              </span>
            </label>
            {projects.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm text-paper">
                <input
                  type="radio"
                  name="createAs"
                  checked={createAs === p.id}
                  onChange={() => setCreateAs(p.id)}
                />
                <span>
                  {p.name} <span className="font-mono text-xs text-muted">project/{p.handle}</span>
                </span>
              </label>
            ))}
            <p className="m-0 text-xs text-muted">
              A personal task is shown under your username. A project task is shown
              under the project.{' '}
              <Link href="/dashboard/account?s=projects" className="text-lime no-underline hover:underline">
                Create a project on Account
              </Link>
              .
            </p>
          </div>
        </AppSection>

        <AppSection title="Basic information">
          <div className="grid gap-3">
            <div>
              <label className="label" htmlFor="t-title">
                Title
              </label>
              <input
                id="t-title"
                className="input"
                placeholder="Create an X post about Flizy"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={140}
              />
            </div>
            <div>
              <label className="label" htmlFor="t-desc">
                Description
              </label>
              <textarea
                id="t-desc"
                className="input"
                rows={5}
                placeholder="What you want done, and what a good entry looks like."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
          </div>
        </AppSection>

        <AppSection title="Requirements">
          <div className="grid gap-3">
            <div>
              <label className="label" htmlFor="t-reqkind">
                Type
              </label>
              <select
                id="t-reqkind"
                className="input"
                value={requirementKind}
                onChange={(e) => setRequirementKind(e.target.value)}
              >
                {REQUIREMENT_KINDS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="t-reqlabel">
                What to tell them
              </label>
              <input
                id="t-reqlabel"
                className="input"
                placeholder={defaultLabel(requirementKind)}
                value={requirementLabel}
                onChange={(e) => setRequirementLabel(e.target.value)}
              />
            </div>
          </div>
        </AppSection>

        <AppSection title="Reward">
          <div className="grid gap-3">
            <div>
              <label className="label" htmlFor="t-rewardkind">
                Type
              </label>
              <select
                id="t-rewardkind"
                className="input"
                value={rewardKind}
                onChange={(e) => setRewardKind(e.target.value)}
              >
                {REWARD_KINDS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="t-reward">
                As people will see it
              </label>
              <input
                id="t-reward"
                className="input"
                placeholder="$100 USDC"
                value={rewardDisplay}
                onChange={(e) => setRewardDisplay(e.target.value)}
                required
              />
            </div>
            {rewardKind === 'crypto' ? (
              <div>
                <label className="label" htmlFor="t-asset">
                  Asset
                </label>
                <input
                  id="t-asset"
                  className="input"
                  placeholder="USDC"
                  value={rewardAsset}
                  onChange={(e) => setRewardAsset(e.target.value)}
                />
                <p className="mt-2 text-xs text-muted">
                  Nothing is held yet, so the task page will say this reward is a
                  commitment rather than secured. Paying winners is manual for now.
                </p>
              </div>
            ) : null}
            <div>
              <label className="label" htmlFor="t-winners">
                Winners
              </label>
              <input
                id="t-winners"
                className="input"
                type="number"
                min={1}
                max={100}
                value={winnersCount}
                onChange={(e) => setWinnersCount(e.target.value)}
                required
              />
            </div>
          </div>
        </AppSection>

        <AppSection title="Deadline" helper="Shown to everyone in their own timezone">
          <div>
            <label className="label" htmlFor="t-ends">
              Closes at
            </label>
            <input
              id="t-ends"
              className="input"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              required
            />
          </div>
        </AppSection>

        <AppSection title="References" helper="Optional, and you can add more later">
          <LinkEditor links={links} onChange={setLinks} />
        </AppSection>

        {title.trim() && rewardDisplay.trim() ? (
          <AppSection title="Preview" helper="The card people see before they open the task">
            <TaskCard preview task={previewOf()} />
          </AppSection>
        ) : null}

        {error ? <p className="alert alert-error m-0">{error}</p> : null}

        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Publishing...' : 'Publish task'}
        </button>
      </form>
    </AppPage>
  );
}

function defaultLabel(kind: string): string {
  if (kind === 'x_post') return 'Submit the link to your post';
  if (kind === 'link') return 'Submit a link';
  return 'Write your entry';
}

function LinkEditor({
  links,
  onChange,
}: {
  links: Array<{ kind: string; label: string; url: string }>;
  onChange: (next: Array<{ kind: string; label: string; url: string }>) => void;
}) {
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');

  return (
    <div className="grid gap-3">
      {links.length ? (
        <ul className="m-0 grid list-none gap-1 p-0 text-sm">
          {links.map((l, i) => (
            <li key={`${l.url}-${i}`} className="flex items-center justify-between gap-3">
              <span className="min-w-0 break-all text-muted">
                {l.label} <span className="font-mono text-xs">{l.url}</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost text-sm"
                onClick={() => onChange(links.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <input
          className="input"
          placeholder="Website"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          aria-label="Link label"
        />
        <input
          className="input font-mono"
          placeholder="https://..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Link URL"
        />
      </div>
      <button
        type="button"
        className="btn btn-ghost w-fit"
        disabled={!label.trim() || !/^https:\/\//i.test(url.trim())}
        onClick={() => {
          onChange([...links, { kind: 'custom', label: label.trim(), url: url.trim() }]);
          setLabel('');
          setUrl('');
        }}
      >
        + Add link
      </button>
    </div>
  );
}
