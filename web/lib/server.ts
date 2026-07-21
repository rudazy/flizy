import path from 'path';
import { createRequire } from 'module';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: path.join(process.cwd(), '..', '.env') });
loadEnv({ path: path.join(process.cwd(), '.env') });

const require = createRequire(import.meta.url);
const rootLib = path.join(process.cwd(), '..', 'lib');

export function flizyRequire(name: string) {
  return require(path.join(rootLib, name));
}

export type AccountRow = {
  id: string;
  email?: string | null;
  display_name?: string | null;
  agent_wallet_address?: string | null;
  unlock_pin_hash?: string | null;
  is_admin?: boolean;
  balance_eth?: number | string;
};
