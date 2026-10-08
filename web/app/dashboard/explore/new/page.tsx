'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppPage } from '../../../../components/AppSection';
import { useDashboard } from '../../../../components/DashboardProvider';
import { useComingSoon } from '../../../../components/ComingSoon';
import { TaskCard, type TaskCardData } from '../../../../components/TaskCard';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarIcon,
  ChevronDownIcon,
  ClockIcon,
  ContentIcon,
  EyeIcon,
  HelpIcon,
  InfinityIcon,
  InfoIcon,
  ListIcon,
  OnchainIcon,
  PeopleIcon,
  PersonIcon,
  PlusIcon,
  TasksIcon,
  TokensIcon,
  TrashIcon,
  XLogoIcon,
} from '../../../../components/ExploreIcons';

/**
 * Create a task, in four steps: Details, Reward, Rules, Review.
 *
 * Only the current step is rendered, but every field lives in this page's
 * state, so going Back or tapping an earlier step never loses what was typed.
 * Each step checks its own fields before moving on, and the server checks all
 * of them again on publish.
 *
 * Any signed-in account. The API is what decides, and this page says so rather
 * than presenting a form that cannot be submitted.
 */

type Project = { id: string; handle: string; name: string; verified?: boolean };
type TaskLink = { kind: string; label: string; url: string };

/** Tighter than the server's own limits (140 and 8000), never looser. */
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 1000;

const STEPS = ['Details', 'Reward', 'Rules', 'Review'] as const;

const REQUIREMENT_KINDS = [
  ['x_post', 'Post on X'],
  ['link', 'Share a link'],
  ['text', 'Write text'],
] as const;

/**
 * The reward chips. USDC and FLZ are a crypto reward in that asset; Points has
 * no server support yet, so it opens Coming soon instead of choosing anything.
 */
const REWARD_CHIPS = [
  { label: 'USDC', kind: 'crypto', asset: 'USDC' },
  { label: 'FLZ', kind: 'crypto', asset: 'FLZ' },
  { label: 'Whitelist', kind: 'wl' },
  { label: 'NFT', kind: 'nft' },
  { label: 'Points', kind: null },
  { label: 'Custom', kind: 'custom' },
] as const;

/** Assets offered beside the amount of a crypto reward. */
const REWARD_ASSETS = ['USDC', 'FLZ', 'USDT', 'ETH'] as const;

const REWARD_PLACEHOLDERS: Record<string, string> = {
  wl: '50 whitelist spots',
  nft: '1 Genesis pass NFT',
  custom: 'Merch pack for each winner',
};

const WINNER_CHOICES = Array.from({ length: 100 }, (_, i) => i + 1);

export default function NewTaskPage() {
  const router = useRouter();
  const search = useSearchParams();
  const { data } = useDashboard();
  const username = data?.account?.username || '';
  const [comingSoon, comingSoonNote] = useComingSoon();

  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [createAs, setCreateAs] = useState<string>('personal');

  const [step, setStep] = useState(1);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [requirementKind, setRequirementKind] = useState<string>('x_post');
  const [requirementLabel, setRequirementLabel] = useState('');
  const [rewardKind, setRewardKind] = useState<string>('crypto');
  const [rewardAsset, setRewardAsset] = useState<string>('USDC');
  const [amount, setAmount] = useState('');
  const [rewardText, setRewardText] = useState('');
  const [endsAt, setEndsAt] = useState(defaultDeadline);
  const [winnersCount, setWinnersCount] = useState('1');
  const [links, setLinks] = useState<TaskLink[]>([]);

  const [previewOpen, setPreviewOpen] = useState(false);
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

  const crypto = rewardKind === 'crypto';
  const rewardDisplay = crypto ? (amount.trim() ? `${amount.trim()} ${rewardAsset}` : '') : rewardText.trim();
  const requirementName = REQUIREMENT_KINDS.find(([id]) => id === requirementKind)?.[1] || '';

  /** The card as it will appear on Explore, built from what is typed so far. */
  function previewOf(): TaskCardData {
    const project = projects.find((p) => p.id === createAs);
    const ends = endsAt ? new Date(endsAt).getTime() : NaN;
    return {
      ref: 0,
      title: title.trim() || 'Your task title',
      rewardDisplay: rewardDisplay || 'Reward',
      winnersCount: Math.max(1, Number(winnersCount) || 1),
      participants: 0,
      endsAt: Number.isFinite(ends) ? new Date(ends).toISOString() : new Date(Date.now() + 86400000).toISOString(),
      state: 'live',
      creator: project
        ? { kind: 'project', name: project.name, handle: project.handle, verified: project.verified }
        : { kind: 'personal', name: username ? `@${username}` : 'You', handle: username || null },
    };
  }

  /** What each step holds so far, for the live preview and the review. */
  const summary: SummaryGroup[] = [
    {
      step: 1,
      title: 'Details',
      rows: [
        ['Title', title.trim()],
        ['Description', description.trim()],
        ['Requirement', `${requirementName}: ${requirementLabel.trim() || defaultLabel(requirementKind)}`],
      ],
    },
    {
      step: 2,
      title: 'Reward',
      rows: [
        ['Reward', rewardDisplay],
        ['Paid to', 'The winners you pick'],
      ],
    },
    {
      step: 3,
      title: 'Rules',
      rows: [
        ['Deadline', formatDeadline(endsAt)],
        ['Winners', winnersCount],
        ['References', links.map((l) => l.label).join(', ') || 'None'],
      ],
    },
  ];

  /** Why this step cannot be left yet, or '' when it can. */
  function problemWith(n: number): string {
    if (n === 1) {
      if (title.trim().length < 3) return 'Give the task a title of at least 3 characters.';
    }
    if (n === 2) {
      if (crypto) {
        const value = Number(amount.trim());
        if (!/^\d+(\.\d+)?$/.test(amount.trim()) || !(value > 0)) return 'Enter the reward amount.';
      } else if (!rewardText.trim()) {
        return 'Say what the reward is.';
      }
    }
    if (n === 3) {
      const ends = endsAt ? new Date(endsAt).getTime() : NaN;
      if (!Number.isFinite(ends)) return 'Pick a deadline.';
      if (ends <= Date.now()) return 'The deadline must be in the future.';
    }
    return '';
  }

  function goTo(n: number) {
    setError('');
    setStep(n);
    window.scrollTo({ top: 0 });
  }

  function next() {
    const problem = problemWith(step);
    if (problem) {
      setError(problem);
      return;
    }
    goTo(step + 1);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (step < 4) {
      next();
      return;
    }
    // Every step again, in case one was left by tapping an earlier step.
    for (const n of [1, 2, 3]) {
      const problem = problemWith(n);
      if (problem) {
        goTo(n);
        setError(problem);
        return;
      }
    }
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
          rewardAsset: crypto ? rewardAsset : null,
          winnersCount: Number(winnersCount),
          // A local datetime-local value carries no zone, so it is converted here
          // rather than sent as typed. The database stores an instant.
          endsAt: new Date(endsAt).toISOString(),
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

  const personal = createAs === 'personal';
  const header = (
    <TaskHeader
      subtitle={personal ? 'Create a personal task for your community' : 'Create a project task for your community'}
      onHelp={() => comingSoon('Help')}
    />
  );

  if (allowed === null) {
    return (
      <AppPage>
        {header}
        <p className="font-sans text-sm text-[#9d9d9d]">Loading...</p>
        {comingSoonNote}
      </AppPage>
    );
  }

  if (!allowed) {
    return (
      <AppPage>
        {header}
        <FormCard
          icon={<PersonIcon size={12.5} />}
          title="Sign in required"
          subtitle="Sign in with the account you want to publish as, then come back."
        >
          {null}
        </FormCard>
        {comingSoonNote}
      </AppPage>
    );
  }

  function chooseProject() {
    if (!projects.length) {
      router.push('/dashboard/account?s=projects');
      return;
    }
    if (personal) setCreateAs(projects[0].id);
  }

  function chooseChip(chip: (typeof REWARD_CHIPS)[number]) {
    if (!chip.kind) {
      comingSoon(chip.label);
      return;
    }
    setRewardKind(chip.kind);
    if ('asset' in chip) setRewardAsset(chip.asset);
  }

  return (
    <AppPage>
      {header}

      <form onSubmit={onSubmit} noValidate className="!mt-0 grid w-full gap-[7.5px] px-[2.5px] sm:px-0">
        <div className="grid grid-cols-2 gap-[5px]" role="radiogroup" aria-label="Create as">
          <CreatorCard
            active={personal}
            title="Personal"
            line={username ? `@${username}` : 'Your account'}
            icon={<PersonIcon size={11.5} />}
            onSelect={() => setCreateAs('personal')}
          />
          <CreatorCard
            active={!personal}
            title="Project"
            line={personal ? 'Shown under your project' : projects.find((p) => p.id === createAs)?.name || ''}
            icon={<PeopleIcon size={11.5} />}
            onSelect={chooseProject}
          />
        </div>

        {!personal && projects.length > 1 ? (
          <SelectBox value={createAs} onChange={setCreateAs} label="Project" icon={<PeopleIcon size={11} />}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectBox>
        ) : null}

        <Stepper step={step} onBack={goTo} />

        {step === 1 ? (
          <>
            <FormCard icon={<ContentIcon size={12.5} />} title="Task details" subtitle="Give your task a clear title and description.">
              <div className="-mt-[2.5px] flex items-end justify-between">
                <FieldLabel htmlFor="t-title">Title</FieldLabel>
                <Counter value={title.length} max={TITLE_MAX} />
              </div>
              <input
                id="t-title"
                className={INPUT}
                placeholder="Create an X post about Flizy"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={TITLE_MAX}
              />
              <FieldLabel htmlFor="t-desc" className="mt-[5px]">
                Description
              </FieldLabel>
              <div className="relative">
                <textarea
                  id="t-desc"
                  className={`${FIELD} h-[49.5px] resize-none px-[8px] pb-[12px] pt-[6.5px] text-[8px]`}
                  placeholder="What you want participants to do, and what a good entry looks like."
                  value={description}
                  maxLength={DESCRIPTION_MAX}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <span className="pointer-events-none absolute bottom-[4px] right-[7px]">
                  <Counter value={description.length} max={DESCRIPTION_MAX} />
                </span>
              </div>
            </FormCard>

            <FormCard icon={<ListIcon size={12.5} />} title="Task requirements" subtitle="Choose the actions participants need to complete.">
              <div className="grid grid-cols-[1fr_1.05fr_20px] gap-[6.5px]">
                <SelectBox
                  id="t-reqkind"
                  label="Requirement"
                  value={requirementKind}
                  onChange={setRequirementKind}
                  icon={requirementIcon(requirementKind)}
                >
                  {REQUIREMENT_KINDS.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </SelectBox>
                <input
                  id="t-reqlabel"
                  aria-label="What to tell participants"
                  className={INPUT}
                  placeholder={defaultLabel(requirementKind)}
                  value={requirementLabel}
                  maxLength={200}
                  onChange={(e) => setRequirementLabel(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => {
                    setRequirementKind('x_post');
                    setRequirementLabel('');
                  }}
                  aria-label="Clear requirement"
                  className="hit-y-44 flex h-[22px] items-center justify-center rounded-[3.5px] border border-[#2c2e33] bg-[#0c0d0f] text-[#c9c9c9] hover:text-white"
                >
                  <TrashIcon size={10} />
                </button>
              </div>
              <button
                type="button"
                onClick={() => comingSoon('More requirements')}
                className="mt-[6.2px] flex h-[22px] w-full items-center gap-[10px] rounded-[3.5px] border border-[#2f2b1f] bg-[#121314] pl-[9px] pr-[9px] text-left font-sans text-[7.3px] text-[#e6e6e6] hover:text-white"
              >
                <PlusIcon size={10} strokeWidth={1.8} className="text-sun" />
                <span className="flex-1">Add another requirement</span>
                <ChevronDownIcon size={9} className="text-[#d9d9d9]" />
              </button>
            </FormCard>
          </>
        ) : null}

        {step === 2 ? (
          <FormCard icon={<TokensIcon size={12.5} />} title="Reward" subtitle="Choose what participants will receive for completing the task.">
            <div className="grid grid-cols-6 gap-[4.8px]" role="radiogroup" aria-label="Reward type">
              {REWARD_CHIPS.map((chip) => {
                const active = chip.kind === rewardKind && (!('asset' in chip) || chip.asset === rewardAsset);
                return (
                  <button
                    key={chip.label}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => chooseChip(chip)}
                    className={`hit-y-44 h-[22.5px] rounded-[4px] border font-sans text-[6.4px] ${
                      active
                        ? 'border-[#dcc95c] bg-[#1b170e] text-white'
                        : 'border-[#2d2e33] bg-[#121415] text-[#d2d2d2] hover:text-white'
                    }`}
                  >
                    {chip.label}
                  </button>
                );
              })}
            </div>
            <div className="mt-[5px] grid grid-cols-2 gap-x-[13px]">
              <div>
                <FieldLabel htmlFor="t-amount">{crypto ? 'Amount' : 'Reward'}</FieldLabel>
                {crypto ? (
                  <div className="relative">
                    <input
                      id="t-amount"
                      className={`${FIELD} h-[22px] pl-[8.7px] pr-[60px] text-[8px]`}
                      inputMode="decimal"
                      placeholder="100"
                      value={amount}
                      maxLength={20}
                      onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                    />
                    <select
                      aria-label="Asset"
                      value={rewardAsset}
                      onChange={(e) => setRewardAsset(e.target.value)}
                      className="absolute right-0 top-0 h-full w-[56px] appearance-none bg-transparent pl-[4px] pr-[18px] text-right font-sans text-[6.8px] text-[#e0e0e0] outline-none"
                    >
                      {REWARD_ASSETS.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                    <ChevronDownIcon
                      size={9}
                      className="pointer-events-none absolute right-[8px] top-1/2 -translate-y-1/2 text-[#d9d9d9]"
                    />
                  </div>
                ) : (
                  <input
                    id="t-amount"
                    className={INPUT}
                    placeholder={REWARD_PLACEHOLDERS[rewardKind] || ''}
                    value={rewardText}
                    maxLength={120}
                    onChange={(e) => setRewardText(e.target.value)}
                  />
                )}
              </div>
              <div>
                <FieldLabel>Distribution</FieldLabel>
                <FakeSelect onClick={() => comingSoon('Distribution')} label="Distribution, coming soon">
                  Winners
                </FakeSelect>
                <p className="m-0 mt-[5px] font-sans text-[5.8px] text-[#8f8f8f]">
                  The reward goes to the winners you pick.
                </p>
              </div>
            </div>
          </FormCard>
        ) : null}

        {step === 3 ? (
          <>
            <FormCard icon={<ClockIcon size={12.5} />} title="Rules & limits" subtitle="Live on publish. No participant cap.">
              <div className="-mt-[3px] grid grid-cols-[1.32fr_1fr_1.12fr] gap-x-[9.5px]">
                <div>
                  <FieldLabel htmlFor="t-ends" small>Deadline</FieldLabel>
                  <DateTimeBox id="t-ends" value={endsAt} onChange={setEndsAt} />
                </div>
                <div>
                  <FieldLabel htmlFor="t-winners" small>Number of winners</FieldLabel>
                  <SelectBox id="t-winners" value={winnersCount} onChange={setWinnersCount}>
                    {WINNER_CHOICES.map((n) => (
                      <option key={n} value={String(n)}>
                        {n}
                      </option>
                    ))}
                  </SelectBox>
                </div>
                <div>
                  <FieldLabel small>Participants</FieldLabel>
                  <div className="flex h-[22px] w-full items-center gap-[12px] rounded-[3.5px] border border-[#25272c] bg-[#0d0d0f] pl-[9px] pr-[9px] font-sans text-[7px] text-[#f0f0f0]">
                    <InfinityIcon size={11} />
                    <span className="flex-1 truncate">No limit</span>
                  </div>
                  <p className="m-0 mt-[5px] font-sans text-[5.8px] text-[#8f8f8f]">
                    No participant cap.
                  </p>
                </div>
              </div>
            </FormCard>

            <section className={`${CARD} flex gap-[10.5px]`}>
              <IconTile>
                <OnchainIcon size={12.5} />
              </IconTile>
              <div className="-mt-[2px] min-w-0 flex-1">
                <h2 className="m-0 font-sans text-[6.4px] font-semibold leading-[10px] text-white">
                  References <span className="font-normal text-[#d0d0d0]">(optional)</span>
                </h2>
                <p className="m-0 font-sans text-[5.9px] text-[#b5b5b5]">
                  Add helpful links, examples or resources.
                </p>
                <LinkEditor links={links} onChange={setLinks} />
              </div>
            </section>
          </>
        ) : null}

        {step === 4 ? (
          <FormCard icon={<TasksIcon size={12.5} />} title="Review" subtitle="Check everything before you publish.">
            <Summary groups={summary} onEdit={goTo} />
            <p className="m-0 mt-[8px] flex gap-[6px] rounded-[4px] border border-[#1f1f21] bg-[#141414] px-[8px] py-[6px] font-sans text-[6.6px] leading-[9px] text-[#b5b5b5]">
              <InfoIcon size={9} className="mt-px shrink-0 text-[#c9c9c9]" />
              Nothing is held yet, so this reward is a commitment rather than secured. Paying winners is manual for now.
            </p>
          </FormCard>
        ) : null}

        <section className={`${CARD} !p-0`}>
          <button
            type="button"
            onClick={() => setPreviewOpen((open) => !open)}
            aria-expanded={previewOpen}
            aria-controls="task-preview"
            className="flex w-full items-center justify-between gap-2 px-[8.7px] py-[7px] text-left"
          >
            <span className="flex min-w-0 items-center gap-[10.5px]">
              <IconTile>
                <EyeIcon size={12.5} />
              </IconTile>
              <span className="min-w-0">
                <span className="block truncate font-sans text-[8.8px] font-bold text-white">Live preview</span>
                <span className="block font-sans text-[7px] leading-[10px] text-[#b5b5b5]">
                  Everything so far, and how it will look on Explore.
                </span>
              </span>
            </span>
            <ChevronDownIcon
              size={11}
              className={`shrink-0 text-[#d9d9d9] transition-transform duration-200 ${previewOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {previewOpen ? (
            <div id="task-preview" className="grid gap-[8px] px-[8.7px] pb-[8.7px]">
              <Summary groups={summary.filter((g) => g.step <= step)} />
              <TaskCard preview task={previewOf()} />
            </div>
          ) : null}
        </section>

        {error ? (
          <p className="alert alert-error m-0" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-[3px] flex gap-[6px]">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => goTo(step - 1)}
              className="hit-y-44 flex h-[20.8px] w-[30%] items-center justify-center gap-[7px] rounded-[4px] border border-[#2d2e33] bg-[#111113] font-sans text-[7.7px] font-semibold text-[#e6e6e6] hover:text-white"
            >
              <ArrowLeftIcon size={10} />
              Back
            </button>
          ) : null}
          <button
            className="btn-sun hit-y-44 h-[20.8px] flex-1 gap-[8px] rounded-[4px] font-sans text-[7.7px] font-bold"
            type="submit"
            disabled={busy}
          >
            {step < 4 ? `Continue to ${STEPS[step].toLowerCase()}` : busy ? 'Publishing...' : 'Publish task'}
            {busy ? null : <ArrowRightIcon size={10} strokeWidth={2.2} />}
          </button>
        </div>
      </form>
      {comingSoonNote}
    </AppPage>
  );
}

const CARD = 'rounded-[5px] border border-[#1f1d19] bg-[#0f0f10] px-[8.7px] pb-[7.5px] pt-[7px]';

/** Border, fill and type of every text box; size and padding are set per box. */
const FIELD =
  'block w-full rounded-[3.5px] border border-[#25272c] bg-[#0d0d0f] font-sans text-[#f0f0f0] outline-none placeholder:text-[#8a8a8f] focus:border-sun/60';
const INPUT = `${FIELD} h-[22px] px-[8.7px] text-[8px]`;

function defaultLabel(kind: string): string {
  if (kind === 'x_post') return 'Submit the link to your post';
  if (kind === 'link') return 'Submit a link';
  return 'Write your entry';
}

function requirementIcon(kind: string): ReactNode {
  if (kind === 'x_post') return <XLogoIcon size={11} />;
  if (kind === 'link') return <OnchainIcon size={11} />;
  return <ContentIcon size={11} />;
}

/** A week out at 18:00 local, as a datetime-local value. */
function defaultDeadline(): string {
  const d = new Date(Date.now() + 7 * 86400000);
  d.setHours(18, 0, 0, 0);
  return toLocalInput(d);
}

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatDeadline(value: string): string {
  const d = value ? new Date(value) : null;
  if (!d || !Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** The page's own bar: back, title, help. The search and bell are not here. */
function TaskHeader({ subtitle, onHelp }: { subtitle: string; onHelp: () => void }) {
  return (
    <header className="sticky top-0 z-40 -mx-4 bg-ink/90 px-4 pb-[4px] pt-[max(0.55rem,env(safe-area-inset-top))] backdrop-blur-md sm:-mx-6 sm:px-0">
      <div className="flex items-center gap-[15px] px-[2.5px] sm:px-0">
        <Link
          href="/dashboard/explore"
          aria-label="Back to Explore"
          className="hit-44 flex h-[21.6px] w-[21.6px] shrink-0 items-center justify-center rounded-[4.5px] border border-[#2a2b30] bg-[#0f0f10] text-[#e6e6e6] no-underline hover:text-white"
        >
          <ArrowLeftIcon size={11} />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-sans text-[11.5px] font-bold leading-[13px] text-white">Create task</h1>
          <p className="truncate font-sans text-[7.6px] text-[#b5b5b5]">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={onHelp}
          aria-label="Help, coming soon"
          className="hit-44 flex h-[21.6px] w-[21.6px] shrink-0 items-center justify-center rounded-[4.5px] border border-[#2a2b30] bg-[#0f0f10] text-[#e6e6e6] hover:text-white"
        >
          <HelpIcon size={11.5} />
        </button>
      </div>
    </header>
  );
}

/**
 * Details, Reward, Rules, Review. A step already passed can be tapped to go
 * back to it; a step ahead cannot, since its checks have not run.
 */
function Stepper({ step, onBack }: { step: number; onBack: (n: number) => void }) {
  return (
    <ol className="m-0 flex list-none items-center justify-center p-0 py-[2px]" aria-label="Steps">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const current = n === step;
        const done = n < step;
        return (
          <li key={label} className="flex items-center">
            {i > 0 ? (
              <span
                aria-hidden
                className="mx-[9px] h-[1.2px] w-[29px]"
                style={{
                  background:
                    n <= step
                      ? '#d2a73d'
                      : n === step + 1
                        ? 'linear-gradient(90deg, #f7d047 0%, #b48b33 100%)'
                        : '#3f3f42',
                }}
              />
            ) : null}
            <button
              type="button"
              disabled={!done}
              onClick={() => onBack(n)}
              aria-current={current ? 'step' : undefined}
              aria-label={done ? `Back to ${label}` : label}
              className="-my-[6px] flex items-center gap-[8px] py-[6px] disabled:cursor-default"
            >
              <span
                className={`flex h-[15px] w-[15px] items-center justify-center rounded-full font-sans text-[6.8px] font-bold ${
                  current
                    ? 'bg-sun text-sun-ink'
                    : done
                      ? 'border border-sun text-sun'
                      : 'border border-[#5c5c60] text-[#d6d6d8]'
                }`}
              >
                {n}
              </span>
              <span
                className={`font-sans text-[6.5px] ${current ? 'font-semibold text-[#ffe668]' : done ? 'text-sun' : 'text-[#9d9d9f]'}`}
              >
                {label}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function CreatorCard({
  active,
  title,
  line,
  icon,
  onSelect,
}: {
  active: boolean;
  title: string;
  line: string;
  icon: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={`flex h-[33.7px] items-center gap-[16px] rounded-[4.5px] border pl-[16.5px] pr-[10px] text-left ${
        active ? 'border-[#d9c54f]' : 'border-[#23252a] bg-[#0d0e0e]'
      }`}
      style={active ? { background: 'linear-gradient(180deg, #17140a 0%, #1f1a0c 100%)' } : undefined}
    >
      <span className={active ? 'text-sun' : 'text-[#d1d1d3]'}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[7.5px] font-semibold leading-[10.5px] text-white">{title}</span>
        <span className="mt-[1px] block truncate font-sans text-[7px] text-[#c4c4c4]">{line}</span>
      </span>
    </button>
  );
}

function IconTile({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[4px] border border-[#2c2614] bg-[#1c180c] text-[#ffd84a]">
      {children}
    </span>
  );
}

function FormCard({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className={CARD}>
      <div className="mb-[8px] flex min-w-0 items-center gap-[12.5px]">
        <IconTile>{icon}</IconTile>
        <div className="min-w-0">
          <h2 className="m-0 truncate font-sans text-[8.3px] font-bold leading-[11px] text-white">{title}</h2>
          <p className="m-0 mt-[1px] font-sans text-[7.25px] leading-[9.5px] text-[#b5b5b5]">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/** `small` is for the three-across row under Rules, where full-size labels would not fit. */
function FieldLabel({
  htmlFor,
  className = '',
  small = false,
  children,
}: {
  htmlFor?: string;
  className?: string;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={`mb-[3.5px] block font-sans font-semibold leading-[9px] text-[#f0f0f0] ${small ? 'text-[5.8px]' : 'text-[7px]'} ${className}`}
    >
      {children}
    </label>
  );
}

function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span className="mb-[3.5px] font-sans text-[6.3px] text-[#a8a8a8]" aria-live="polite">
      {value}/{max}
    </span>
  );
}

/** A native select drawn as the boxed control, with an icon on the left. */
function SelectBox({
  id,
  value,
  onChange,
  icon,
  label,
  children,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  icon?: ReactNode;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      {icon ? (
        <span className="pointer-events-none absolute left-[9px] top-1/2 -translate-y-1/2 text-[#f0f0f0]">
          {icon}
        </span>
      ) : null}
      <select
        id={id}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`block h-[22px] w-full appearance-none rounded-[3.5px] border border-[#25272c] bg-[#0d0d0f] pr-[22px] font-sans text-[8px] text-[#f0f0f0] outline-none focus:border-sun/60 ${
          icon ? 'pl-[32px]' : 'pl-[10px]'
        }`}
      >
        {children}
      </select>
      <ChevronDownIcon
        size={9}
        className="pointer-events-none absolute right-[9px] top-1/2 -translate-y-1/2 text-[#d9d9d9]"
      />
    </div>
  );
}

/** Drawn like a select, for a setting that is not built yet: it opens Coming soon. */
function FakeSelect({
  onClick,
  label,
  icon,
  small = false,
  children,
}: {
  onClick: () => void;
  label: string;
  icon?: ReactNode;
  small?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`hit-y-44 flex h-[22px] w-full items-center gap-[12px] rounded-[3.5px] border border-[#25272c] bg-[#0d0d0f] pl-[9px] pr-[9px] text-left font-sans text-[#f0f0f0] ${small ? 'text-[7px]' : 'text-[8px]'}`}
    >
      {icon ? <span className="text-[#f0f0f0]">{icon}</span> : null}
      <span className="flex-1 truncate">{children}</span>
      <ChevronDownIcon size={9} className="text-[#d9d9d9]" />
    </button>
  );
}

/** The date and time picker, drawn as a select: the native picker opens on tap. */
function DateTimeBox({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <div className="pointer-events-none flex h-[22px] items-center gap-[12px] rounded-[3.5px] border border-[#25272c] bg-[#0d0d0f] pl-[8px] pr-[22px] font-sans text-[6.7px] text-[#f0f0f0]">
        <CalendarIcon size={10.5} className="shrink-0 text-[#d9d9d9]" />
        <span className="truncate">{formatDeadline(value) || 'Pick a date'}</span>
      </div>
      <ChevronDownIcon
        size={9}
        className="pointer-events-none absolute right-[9px] top-1/2 -translate-y-1/2 text-[#d9d9d9]"
      />
      <input
        id={id}
        type="datetime-local"
        value={value}
        min={toLocalInput(new Date())}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker?.();
          } catch {
            /* the browser opens its own picker on focus instead */
          }
        }}
        aria-label="Deadline"
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </div>
  );
}

function LinkEditor({ links, onChange }: { links: TaskLink[]; onChange: (next: TaskLink[]) => void }) {
  const [url, setUrl] = useState('');
  const valid = /^https:\/\/[^\s/]+\.[^\s]+$/i.test(url.trim());

  function add() {
    if (!valid) return;
    const clean = url.trim();
    // The label people see is the site's own name, so nothing else is asked for.
    const label = new URL(clean).hostname.replace(/^www\./, '').slice(0, 80);
    onChange([...links, { kind: links.length ? 'custom' : 'website', label, url: clean }]);
    setUrl('');
  }

  return (
    <div className="mt-[3px] grid gap-[5px]">
      <div className="flex gap-[5px]">
        <input
          className={`${FIELD} h-[19px] min-w-0 flex-1 px-[6.5px] text-[6.6px]`}
          placeholder="Website, docs, or any reference link..."
          aria-label="Link URL"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="hit-y-44 flex h-[19px] w-[52.4px] shrink-0 items-center justify-center gap-[6px] rounded-[3.5px] border border-[#2d2e33] bg-[#0f0f10] font-sans text-[6.6px] text-[#f0f0f0] disabled:opacity-60"
          disabled={!valid || links.length >= 20}
          onClick={add}
        >
          <PlusIcon size={8} strokeWidth={1.8} />
          Add link
        </button>
      </div>
      {links.length ? (
        <ul className="m-0 grid list-none gap-[4px] p-0">
          {links.map((l, i) => (
            <li key={`${l.url}-${i}`} className="flex items-center justify-between gap-2 font-sans text-[7.2px] text-[#d6d6d6]">
              <span className="min-w-0 truncate">{l.label}</span>
              <button
                type="button"
                className="shrink-0 text-[#9d9d9d] hover:text-white"
                onClick={() => onChange(links.filter((_, j) => j !== i))}
                aria-label={`Remove ${l.label}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

type SummaryGroup = { step: number; title: string; rows: Array<[string, string]> };

/**
 * What the steps hold, grouped by step. The live preview passes only
 * the steps reached so far; the review passes all three with Edit links.
 */
function Summary({ groups, onEdit }: { groups: SummaryGroup[]; onEdit?: (step: number) => void }) {
  return (
    <div className="grid gap-[6px]">
      {groups.map((g) => (
        <div key={g.step} className="rounded-[4px] border border-[#1f1f21] bg-[#0b0b0c] px-[8px] py-[6px]">
          <div className="mb-[3px] flex items-center justify-between">
            <h3 className="m-0 font-sans text-[7.4px] font-semibold text-sun">
              {g.step}. {g.title}
            </h3>
            {onEdit ? (
              <button
                type="button"
                onClick={() => onEdit(g.step)}
                className="font-sans text-[7px] text-[#d0d0d0] hover:text-white"
                aria-label={`Edit ${g.title}`}
              >
                Edit
              </button>
            ) : null}
          </div>
          <dl className="m-0 grid gap-[2px]">
            {g.rows.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[64px_1fr] gap-[6px] font-sans text-[7px] leading-[9.5px]">
                <dt className="text-[#9b9b9b]">{k}</dt>
                <dd className="m-0 min-w-0 break-words text-[#ececec]">{v || '-'}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}
