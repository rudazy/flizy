import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPublicProject } from '../../../lib/tasks';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { pageMetadata } from '../../../lib/seo';
import { ProjectProfile } from '../../../components/ProjectProfile';
import { VerifiedBadge } from '../../../components/VerifiedBadge';
import { ProjectAvatar } from '../../../components/ProjectAvatar';

/**
 * Public project profile.
 *
 * The managing account is not shown. A reader of this page learns the project,
 * its links, the tasks it published and who earned XP from them. Not who sits
 * behind it. A signed-in owner or member is offered the workspace.
 */

export const dynamic = 'force-dynamic';

type Props = { params: { handle: string } };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const project = await getPublicProject(params.handle).catch(() => null);
  if (!project) {
    return pageMetadata({
      title: 'Project | Flizy',
      description: 'A Flizy project.',
      path: `/project/${params.handle}`,
      noindex: true,
    });
  }
  return pageMetadata({
    title: `${project.name} | Flizy`,
    description: project.description || `Tasks published by ${project.name}.`,
    path: `/project/${project.handle}`,
  });
}

export default async function ProjectPage({ params }: Props) {
  const viewerAccountId = await getAccountIdFromCookie().catch(() => null);
  const project = await getPublicProject(params.handle, undefined, { viewerAccountId }).catch(() => null);
  if (!project) notFound();

  return (
    <div className="mx-auto grid w-full max-w-lg gap-8">
      <header className="grid gap-4">
        <div className="flex items-start justify-between gap-4">
          <ProjectAvatar name={project.name} image={project.image} size={72} />
          {project.viewerRole ? (
            <Link
              href={`/dashboard/projects/${encodeURIComponent(project.handle)}`}
              className="inline-flex h-10 items-center rounded-[6px] border border-border px-4 font-sans text-sm text-paper no-underline transition-colors hover:border-lime/60"
            >
              Manage
            </Link>
          ) : null}
        </div>
        <div>
          <h1 className="m-0 flex items-center gap-2 font-sans text-3xl tracking-wide text-paper">
            <span className="min-w-0 break-words">{project.name}</span>
            {project.verified ? <VerifiedBadge size={22} /> : null}
          </h1>
          <p className="m-0 mt-1 font-mono text-sm text-muted">project/{project.handle}</p>
        </div>
        {project.description ? (
          <p className="m-0 text-sm leading-relaxed text-muted">{project.description}</p>
        ) : null}
        {project.links.length ? (
          <ul className="m-0 flex flex-wrap gap-x-4 gap-y-2 p-0">
            {project.links.map((link) => (
              <li key={link.url} className="list-none">
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
      </header>

      <ProjectProfile tasks={project.tasks} activity={project.activity} leaderboard={project.leaderboard} />

      <Link href="/" className="text-xs uppercase tracking-[0.18em] text-muted no-underline hover:text-paper">
        Flizy
      </Link>
    </div>
  );
}
