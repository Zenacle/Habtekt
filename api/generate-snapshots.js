import { generateSnapshotsForDate } from '../src/utils/snapshotGenerator.js';

export default async function handler(req, res) {
  // Support manual trigger with a specific date query parameter (e.g. ?date=2026-06-23)
  // or fall back to calculating the completed active day automatically.
  const { date } = req.query;
  
  try {
    const results = await generateSnapshotsForDate(date);
    return res.status(200).json({
      success: true,
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
