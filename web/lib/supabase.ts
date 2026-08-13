import { createClient, SupabaseClient } from '@supabase/supabase-js';
import path from 'path';
import { config as loadEnv } from 'dotenv';

// Root .env is the base; the more specific files override it.
//
// override:true is load bearing. dotenv does not overwrite an already-set key
// by default, so the root .env used to win outright and pointing
// web/.env.local at the dev project did nothing at all: local next dev and
// next build kept hitting production no matter what that file said. The values
// were read and silently discarded, which is the worst shape for this to fail
// in, because the file looks correct.
//
// .env.local is loaded LAST on purpose. It must beat .env, which is the
// convention everywhere else, and loading it earlier would leave the same
// precedence trap one file further down.
//
// All three are no-ops on Vercel: the Root Directory is web, so ../.env is
// never uploaded and neither .env file is committed. The platform supplies
// process.env directly there.
loadEnv({ path: path.join(process.cwd(), '..', '.env') });
loadEnv({ path: path.join(process.cwd(), '.env'), override: true });
loadEnv({ path: path.join(process.cwd(), '.env.local'), override: true });

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_KEY are required in flizy/.env');
  }
  client = createClient(url, key);
  return client;
}

export function getSiteConfig() {
  return {
    botWhatsAppNumber: process.env.BOT_WHATSAPP_NUMBER || '',
    siteUrl: (process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://flizy.app').replace(
      /\/$/,
      ''
    ),
    linkCodeTtlMs: Number(process.env.LINK_CODE_TTL_MS || 10 * 60 * 1000),
    telegramBotUsername: (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
  };
}
