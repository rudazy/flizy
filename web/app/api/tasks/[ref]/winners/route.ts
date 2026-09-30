import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../../lib/apiError';
import { finalizeWinners, markWinnersNotified } from '../../../../../lib/tasks';
import { notifyAllChannels } from '../../../../../lib/notifyChannels';
import { getSiteConfig } from '../../../../../lib/supabase';

const ROUTE = 'POST /api/tasks/[ref]/winners';

/**
 * Publish the winners and complete the task.
 *
 * The write happens first and the announcement second, deliberately. A failure to
 * tell somebody they won is recoverable; a task left half-finished because a
 * message failed is not.
 */
export async function POST(req: Request, ctx: { params: { ref: string } }) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const ref = Number(ctx.params.ref);
    if (!Number.isInteger(ref) || ref <= 0) {
      return NextResponse.json({ error: 'Task not found.' }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const picks = Array.isArray(body.winners) ? body.winners : [];
    const result = await finalizeWinners(
      accountId,
      ref,
      picks.map((p: { submissionId?: unknown; place?: unknown; rewardNote?: unknown }) => ({
        submissionId: String(p?.submissionId || ''),
        place: Number(p?.place || 0),
        rewardNote: p?.rewardNote ? String(p.rewardNote) : '',
      }))
    );

    // Plain prose and an absolute URL, no {{cmd:}} markers: this path writes to
    // the outbox directly and drainOutbox sends the stored body untouched, so a
    // marker would arrive literally. notifyAllChannels refuses one outright.
    const base = String(getSiteConfig().siteUrl || '').replace(/\/+$/, '');
    const told: string[] = [];
    for (const winner of result.notify) {
      const queued = await notifyAllChannels(
        winner.accountId,
        [
          'You won.',
          '',
          `Flizy task #${result.taskRef}, place ${winner.place}.`,
          `Your entry: submission #${winner.submissionRef}`,
          '',
          `${base}/tasks/${result.taskRef}`,
        ].join('\n')
      );
      if (queued > 0) told.push(winner.accountId);
    }
    await markWinnersNotified(result.taskRef, told);

    return NextResponse.json({ ok: true, winners: result.notify.length, notified: told.length });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}
