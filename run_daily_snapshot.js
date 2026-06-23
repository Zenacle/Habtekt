import { generateSnapshotsForDate } from './src/utils/snapshotGenerator.js';

// Extract optional date from arguments (e.g. node run_daily_snapshot.js 2026-06-23)
const dateArg = process.argv.slice(2).find(arg => /^\d{4}-\d{2}-\d{2}$/.test(arg));

generateSnapshotsForDate(dateArg)
  .then((results) => {
    console.log('[INFO] Finished running daily snapshot script.');
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[FATAL] Script failed with error:', err);
    process.exit(1);
  });
