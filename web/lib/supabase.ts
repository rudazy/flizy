import { createClient, SupabaseClient } from '@supabase/supabase-js';
import path from 'path';
import { config as loadEnv } from 'dotenv';

// Load monorepo root .env then web/.env
loadEnv({ path: path.join(process.cwd(), '..', '.env') });
loadEnv({ path: path.join(process.cwd(), '.env.local') });
loadEnv({ path: path.join(process.cwd(), '.env') });

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
    siteUrl: (process.env.SITE_URL || 'http://localhost:3000').replace(/\/$/, ''),
    linkCodeTtlMs: Number(process.env.LINK_CODE_TTL_MS || 10 * 60 * 1000),
  };
}
