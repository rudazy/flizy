'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppSection } from './AppSection';

/**
 * The projects this account manages.
 *
 * Creating one lives here, not on the task form. A person can have several.
 * The public page at /project/<handle> does not show this account.
 */

type Project = { id: string; handle: string; name: string; description: string };
type LinkDraft = { kind: string; label: string; url: string };

const LINK_KINDS: Array<[string, string]> = [
  ['website', 'Website'],
  ['x', 'X'],
  ['telegram', 'Telegram'],
  ['docs', 'Documentation'],
  ['github', 'GitHub'],
  ['custom', 'Other'],
];

export function AccountProjects() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [links, setLinks] = useState<LinkDraft[]>([]);
  const [linkKind, setLinkKind] = useState('website');
  const [linkLabel, setLinkLabel] = useState('Website');
  const [linkUrl, setLinkUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/projects');
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        const rows = res.ok && Array.isArray(body.projects) ? (body.projects as Project[]) : [];
        setProjects(rows);
        setOpen(rows.length === 0);
      } catch {
        if (!cancelled) setProjects([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function addLink() {
    const url = linkUrl.trim();
    if (!/^https:\/\//i.test(url) || links.length >= 20) return;
    const preset = LINK_KINDS.find((k) => k[0] === linkKind);
    setLinks((prev) => [
      ...prev,
      { kind: linkKind, label: linkLabel.trim() || preset?.[1] || 'Link', url },
    ]);
    setLinkUrl('');
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
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
          links,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.id) {
        setError(body?.error || 'Could not create that project.');
        return;
      }
      const created: Project = {
        id: String(body.id),
        handle: String(body.handle || handle.trim()),
        name: name.trim(),
        description: description.trim(),
      };
      setProjects((prev) => [...(prev ?? []), created]);
      setName('');
      setHandle('');
      setDescription('');
      setLinks([]);
      setOpen(false);
    } catch {
      setError('Could not create that project.');
    } finally {
      setBusy(false);
    }
  }

  if (projects === null) {
    return (
      <AppSection
        title="Projects"
        helper="Each project has its own public page and its own tasks. The page does not show your name."
      >
        <p className="text-sm text-muted">Loading...</p>
      </AppSection>
    );
  }

  return (
    <AppSection
      title="Projects"
      helper="Each project has its own public page and its own tasks. The page does not show your name."
      badge={projects.length ? String(projects.length) : undefined}
    >
      {projects.length === 0 ? (
        <p className="m-0 mb-4 text-sm text-muted">No projects yet. A task can still be personal.</p>
      ) : (
        <ul className="m-0 mb-4 grid list-none gap-2 p-0">
          {projects.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-ink/40 px-3 py-3"
            >
              <div className="min-w-0">
                <p className="m-0 font-sans text-sm tracking-wide text-paper">{p.name}</p>
                <p className="m-0 font-mono text-xs text-muted">project/{p.handle}</p>
              </div>
              <div className="flex gap-3 text-sm">
                <Link href={`/project/${p.handle}`} className="text-lime no-underline hover:underline">
                  Profile
                </Link>
                <Link
                  href={`/dashboard/explore/new?project=${p.id}`}
                  className="text-muted no-underline hover:text-paper"
                >
                  New task
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}

      {open ? (
        <form onSubmit={onCreate} className="grid gap-4">
          <div>
            <label className="label" htmlFor="project-name">
              Project name
            </label>
            <input
              id="project-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Flizy"
              maxLength={60}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="project-handle">
              Project handle
            </label>
            <input
              id="project-handle"
              className="input font-mono"
              value={handle}
              onChange={(e) => setHandle(e.target.value.toLowerCase())}
              placeholder="flizy"
              maxLength={24}
              required
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="mt-1.5 text-xs text-muted">
              Publicly project/{handle.trim() || 'handle'}. Not @
              {handle.trim() || 'handle'}: that form is a payment username.
            </p>
          </div>
          <div>
            <label className="label" htmlFor="project-description">
              Description
            </label>
            <textarea
              id="project-description"
              className="input"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Tell people what this project is about."
              maxLength={800}
            />
          </div>
          <div className="grid gap-2">
            <p className="label m-0">Links</p>
            {links.length ? (
              <ul className="m-0 grid list-none gap-1 p-0 text-sm">
                {links.map((l, i) => (
                  <li key={`${l.url}-${i}`} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-muted">
                      {l.label} <span className="font-mono text-xs">{l.url}</span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost shrink-0 text-sm"
                      onClick={() => setLinks(links.filter((_, j) => j !== i))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-3">
              <select
                className="input"
                value={linkKind}
                aria-label="Link type"
                onChange={(e) => {
                  const kind = e.target.value;
                  setLinkKind(kind);
                  const preset = LINK_KINDS.find((k) => k[0] === kind);
                  if (preset && preset[0] !== 'custom') setLinkLabel(preset[1]);
                }}
              >
                {LINK_KINDS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                className="input"
                value={linkLabel}
                onChange={(e) => setLinkLabel(e.target.value)}
                placeholder="Label"
                aria-label="Link label"
                maxLength={80}
              />
              <input
                className="input font-mono"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="https://"
                aria-label="Link URL"
              />
            </div>
            <button
              type="button"
              className="btn btn-ghost w-fit text-sm"
              disabled={!/^https:\/\//i.test(linkUrl.trim()) || links.length >= 20}
              onClick={addLink}
            >
              + Add link
            </button>
          </div>
          {error ? <p className="alert alert-error m-0">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || name.trim().length < 2 || handle.trim().length < 2}
            >
              {busy ? 'Creating...' : 'Create project'}
            </button>
            {projects.length ? (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <button type="button" className="btn btn-primary w-fit" onClick={() => setOpen(true)}>
          + New project
        </button>
      )}
    </AppSection>
  );
}
