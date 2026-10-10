/**
 * The words and tones a task's category and level are shown with, shared by the
 * Explore card and the public task page so the two never disagree.
 *
 * Keys match TASK_CATEGORIES and TASK_LEVELS in lib/tasks.ts. An unknown value
 * has no entry, and the caller shows nothing for it.
 */

export const CATEGORY_LABELS: Record<string, string> = {
  social: 'Social',
  onchain: 'On-chain',
  community: 'Community',
  content: 'Content',
};

export const LEVEL_LABELS: Record<string, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

/** Border, fill and text for a level chip. Green, gold and amber: easy to hard. */
export const LEVEL_TONES: Record<string, string> = {
  beginner: 'border-[#1f5a38] bg-[#0d1a12] text-[#4ade80]',
  intermediate: 'border-[#5a4a1c] bg-[#1b170b] text-sun',
  advanced: 'border-[#6a3a1c] bg-[#1d120a] text-[#f0a35c]',
};

/** What the participant hands in, by requirement kind. */
export const REQUIREMENT_ACTIONS: Record<string, string> = {
  x_post: 'Submit your X post link',
  link: 'Submit a link',
  text: 'Submit a written answer',
};
