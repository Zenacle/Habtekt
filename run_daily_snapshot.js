import './loadEnv.js';
import { generateSnapshotsForDate } from './src/utils/snapshotGenerator.js';

// Extract optional date or date range from CLI arguments
const dateArgs = process.argv.slice(2).filter(arg => /^\d{4}-\d{2}-\d{2}$/.test(arg));

let targetArg = 'auto';

if (dateArgs.length === 1) {
  targetArg = dateArgs[0];
} else if (dateArgs.length >= 2) {
  targetArg = { startDate: dateArgs[0], endDate: dateArgs[1] };
}

generateSnapshotsForDate(targetArg)
  .then((results) => {
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[FATAL] Script failed with error:', err);
    process.exit(1);
  });
