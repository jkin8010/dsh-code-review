export function migrate(options = {}) {
  const dryRun = Boolean(options.dryRun);
  if (dryRun) return { migrated: 0, dryRun };
  return { migrated: 1, dryRun };
}
