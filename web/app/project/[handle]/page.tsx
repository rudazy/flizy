import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPublicProject } from '../../../lib/tasks';
import { pageMetadata } from '../../../lib/seo';
import { ProjectProfile } from '../../../components/ProjectProfile';

/**
 * Public project profile.
 *
 * The managing account is not loaded. A reader of this page learns the project,
 * its links, and the tasks it published. Not who sits behind it.
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
  const project = await getPublicProject(params.handle).catch(() => null);
  if (!project) notFound();

  return (
    <div className="mx-auto grid w-full max-w-lg gap-8">
      <header className="grid gap-4">
        <ProjectMark name={project.name} />
        <div>
          <h1 className="m-0 font-sans text-3xl tracking-wide text-paper">{project.name}</h1>
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

      <ProjectProfile tasks={project.tasks} activity={project.activity} />

      <Link href="/" className="text-xs uppercase tracking-[0.18em] text-muted no-underline hover:text-paper">
        Flizy
      </Link>
    </div>
  );
}

function ProjectMark({ name }: { name: string }) {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  const letters = !words.length
    ? 'FZ'
    : words.length === 1
      ? words[0].slice(0, 2).toUpperCase()
      : (words[0][0] + words[1][0]).toUpperCase();
  return (
    <div
      className="flex h-16 w-16 items-center justify-center rounded-md border border-border bg-surface font-sans text-xl font-semibold tracking-wide text-paper"
      aria-hidden
    >
      {letters}
    </div>
  );
}
