import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getPublicProject, MAX_LIVE_TASKS_PER_PROJECT } from '../../../lib/tasks';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { pageMetadata } from '../../../lib/seo';
import { ProjectPage } from '../../../components/ProjectPage';

/**
 * Public project profile.
 *
 * The managing account is not shown. A reader of this page learns the project,
 * its links, the tasks it published and who earned XP from them. Not who sits
 * behind it. A signed-in owner or member is offered the workspace, which draws
 * the same ProjectPage with the team's controls.
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

export default async function PublicProjectPage({ params }: Props) {
  const viewerAccountId = await getAccountIdFromCookie().catch(() => null);
  const project = await getPublicProject(params.handle, undefined, { viewerAccountId }).catch(() => null);
  if (!project) notFound();

  return (
    <div className="mx-auto w-full max-w-[1100px]">
      <ProjectPage
        mode="public"
        data={{
          handle: project.handle,
          name: project.name,
          description: project.description,
          verified: project.verified,
          image: project.image,
          banner: project.banner,
          createdAt: project.createdAt,
          links: project.links,
          role: project.viewerRole,
          stats: project.stats,
          tasks: project.tasks,
          leaderboard: project.leaderboard,
          recentRewards: project.recentRewards,
          activity: project.activity,
          liveCap: MAX_LIVE_TASKS_PER_PROJECT,
        }}
      />
    </div>
  );
}
