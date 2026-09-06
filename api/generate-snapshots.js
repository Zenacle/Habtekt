import { generateSnapshotsForDate } from '../src/utils/snapshotGenerator.js';

export default async function handler(req, res) {
  // Support manual trigger with specific date query parameter (e.g. ?date=2026-06-27),
  // date range parameters (?startDate=2026-06-27&endDate=2026-06-30),
  // or fall back to automatic watermark catch-up up to the latest completed active day.
  const { date, startDate, endDate } = req.query || {};

  let targetArg = 'auto';
  if (date) {
    targetArg = date;
  } else if (startDate && endDate) {
    targetArg = { startDate, endDate };
  }

  try {
    const results = await generateSnapshotsForDate(targetArg);
    const hasErrors = (results || []).some(r => r.status === 'error');

    return res.status(hasErrors ? 207 : 200).json({
      success: !hasErrors,
      message: 'Daily snapshot generation completed.',
      results
    });
  } catch (error) {
    console.error('[FATAL] Vercel Serverless Function encountered error:', error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
}
