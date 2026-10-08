'use client';

import { useParams } from 'next/navigation';
import { AppPage } from '../../../../components/AppSection';
import { ProjectWorkspace } from '../../../../components/ProjectWorkspace';

/** A project's workspace, inside the app shell so the bottom nav stays. */
export default function ProjectWorkspacePage() {
  const params = useParams<{ handle: string }>();
  const handle = String(params?.handle || '');
  return (
    <AppPage>
      <ProjectWorkspace handle={handle} />
    </AppPage>
  );
}
