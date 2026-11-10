import { migrate } from './ledger/migrate.js';

export function legacyBoot() {
  return migrate({ dryRun: true });
}
