/**
 * One-time backfill migration script: backfill_daily_snapshots.js
 * 
 * Aggregates historical appliance readings by 6 AM IST day boundaries,
 * calculates daily energy metrics, computes progressive TNEB costs,
 * and populates daily_device_snapshots & daily_energy_snapshots tables.
 * 
 * Usage:
 *   1. Dry Run (Preview calculations without database changes):
 *      node backfill_daily_snapshots.js
 * 
 *   2. Commit (Deletes existing snapshots and inserts new ones):
 *      node backfill_daily_snapshots.js --commit
 * 
 *   Note: Bypassing RLS requires a service role key. You can specify it as:
 *      SUPABASE_SERVICE_ROLE_KEY=your_key node backfill_daily_snapshots.js --commit
 *      or
 *      node backfill_daily_snapshots.js --commit your_key
 */

import { createClient } from '@supabase/supabase-js';
import { calculateTNEBBill } from './src/utils/tariff.js';

// Configuration
const SUPABASE_URL = 'https://llmyvutkvrxnhzkptbar.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsbXl2dXRrdnJ4bmh6a3B0YmFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMDAwNjAsImV4cCI6MjA4OTc3NjA2MH0.F2GfOp4k_giCXoc0pMNAI4myoRNyIWooI7sdxSqEqDs';

// Check args and env variables
const commitMode = process.argv.includes('--commit');
let serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

// Extract service role key from command line if not in env
const otherArgs = process.argv.slice(2).filter(arg => arg !== '--commit');
if (otherArgs.length > 0 && !serviceRoleKey) {
  serviceRoleKey = otherArgs[0];
}

const supabaseKey = serviceRoleKey || SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, supabaseKey, {
  auth: { persistSession: false }
});

// Helper: Convert Date to YYYY-MM-DD string in local/wall time
function toLocalISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// TNEB domestic tariff slab configurations for TN_OLD_2025 and TN_NEW_2026
const TARIFFS = {
  TN_OLD_2025: {
    below500: [
      { num: 1, min: 1,   max: 100, rate: 0 },
      { num: 2, min: 101, max: 200, rate: 0 },
      { num: 3, min: 201, max: 400, rate: 4.70 },
      { num: 4, min: 401, max: 500, rate: 6.30 }
    ],
    above500: [
      { num: 1, min: 1,    max: 100,   rate: 0 },
      { num: 2, min: 101,  max: 400,   rate: 4.70 },
      { num: 3, min: 401,  max: 500,   rate: 6.30 },
      { num: 4, min: 501,  max: 600,   rate: 8.40 },
      { num: 5, min: 601,  max: 800,   rate: 9.45 },
      { num: 6, min: 801,  max: 1000,  rate: 10.50 },
      { num: 7, min: 1001, max: 99999, rate: 11.55 }
    ]
  },
  TN_NEW_2026: {
    below500: [
      { num: 1, min: 1,   max: 100, rate: 0 },
      { num: 2, min: 101, max: 200, rate: 0 },
      { num: 3, min: 201, max: 400, rate: 4.70 },
      { num: 4, min: 401, max: 500, rate: 6.30 }
    ],
    above500: [
      { num: 1, min: 1,    max: 100,   rate: 0 },
      { num: 2, min: 101,  max: 400,   rate: 4.70 },
      { num: 3, min: 401,  max: 500,   rate: 6.30 },
      { num: 4, min: 501,  max: 600,   rate: 8.40 },
      { num: 5, min: 601,  max: 800,   rate: 9.45 },
      { num: 6, min: 801,  max: 1000,  rate: 10.50 },
      { num: 7, min: 1001, max: 99999, rate: 11.55 }
    ]
  }
};

/**
 * Calculates progressive cost for an increment of units consumed,
 * without retroactively recalculating previous units at higher slab rates.
 */
function calculateIncrementalCost(prevUnits, currUnits, tariffVersion) {
  if (currUnits <= prevUnits) return 0;
  
  const tariff = TARIFFS[tariffVersion] || TARIFFS.TN_NEW_2026;
  let totalCost = 0;
  
  // Segment 1: units <= 500
  if (prevUnits < 500) {
    const segStart = prevUnits;
    const segEnd = Math.min(currUnits, 500);
    if (segEnd > segStart) {
      for (const slab of tariff.below500) {
        const slabBoundaryStart = slab.min - 1;
        const slabBoundaryEnd = slab.max;
        
        const overlapStart = Math.max(segStart, slabBoundaryStart);
        const overlapEnd = Math.min(segEnd, slabBoundaryEnd);
        
        if (overlapEnd > overlapStart) {
          totalCost += (overlapEnd - overlapStart) * slab.rate;
        }
      }
    }
  }
  
  // Segment 2: units > 500
  if (currUnits > 500) {
    const segStart = Math.max(prevUnits, 500);
    const segEnd = currUnits;
    if (segEnd > segStart) {
      for (const slab of tariff.above500) {
        const slabBoundaryStart = slab.min - 1;
        const slabBoundaryEnd = slab.max;
        
        const overlapStart = Math.max(segStart, slabBoundaryStart);
        const overlapEnd = Math.min(segEnd, slabBoundaryEnd);
        
        if (overlapEnd > overlapStart) {
          totalCost += (overlapEnd - overlapStart) * slab.rate;
        }
      }
    }
  }
  
  return totalCost;
}


function getSlabName(cumulativeEstimatedUnits) {
  if (cumulativeEstimatedUnits <= 100) return 'Free';
  if (cumulativeEstimatedUnits <= 200) return 'Slab 2';
  if (cumulativeEstimatedUnits <= 400) return 'Slab 3';
  if (cumulativeEstimatedUnits <= 500) return 'Slab 4';
  if (cumulativeEstimatedUnits <= 600) return 'Above 500';
  if (cumulativeEstimatedUnits <= 800) return 'Above 600';
  if (cumulativeEstimatedUnits <= 1000) return 'Above 800';
  return 'Above 1000';
}

// Helper: Convert ISO date string to IST Date string (YYYY-MM-DD) with 6 AM boundary
function getActiveISTDateStr(isoStr) {
  const d = new Date(isoStr);
  const istDate = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  if (istDate.getHours() < 6) {
    istDate.setDate(istDate.getDate() - 1);
  }
  return toLocalISO(istDate);
}

// Helper: Get active IST day for the current instant
function getActiveISTDay() {
  const now = new Date();
  const istTimeMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  const adjustedDate = new Date(istTimeMs - (6 * 60 * 60 * 1000));
  const y = adjustedDate.getUTCFullYear();
  const m = String(adjustedDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(adjustedDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Helper: Get dates in range inclusive
function getDatesInRange(startStr, endStr) {
  const dates = [];
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  const current = new Date(start);
  while (current <= end) {
    dates.push(toLocalISO(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// Helper: Add months to date string
function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dateDay = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dateDay}`;
}

// Helper: Get initial cycle dates (fallback when no DB billing cycle is found)
function getInitialCycleDates(currentDateStr) {
  const now = new Date(currentDateStr + 'T00:00:00');
  let year = now.getFullYear();
  let month = now.getMonth();
  
  if (now.getDate() < 28) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  
  if (month % 2 !== 0) {
    month -= 1;
    if (month < 0) {
      month = 10;
      year -= 1;
    }
  }
  
  const cycleStart = `${year}-${String(month + 1).padStart(2, '0')}-28`;
  const cycleEnd = addMonths(cycleStart, 2);
  return { cycleStart, cycleEnd };
}

// Helper: Bulk insert in batches to avoid payload limits
async function bulkInsert(table, rows) {
  const BATCH_SIZE = 100;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).insert(batch);
    if (error) {
      throw new Error(`Error inserting into ${table} (batch starting at ${i}): ${error.message}`);
    }
  }
}

async function runBackfill() {
  console.log('--- Habtekt Daily Snapshot Backfill Script ---');
  console.log(`Mode: ${commitMode ? 'COMMIT (Writes to Database)' : 'DRY RUN (Preview calculations only)'}`);
  if (serviceRoleKey) {
    console.log('Client: Authenticated with service_role key (RLS bypass enabled)');
  } else {
    console.log('Client: Using anonymous key (Note: Writes might fail due to RLS policies without service_role key)');
  }

  // 1. Fetch all appliance readings
  console.log('\nStep 1: Fetching appliance readings...');
  const { data: readings, error: readingsErr } = await supabase
    .from('appliance_readings')
    .select('*')
    .order('session_start', { ascending: true });

  if (readingsErr) {
    console.error('Failed to fetch appliance readings:', readingsErr.message);
    process.exit(1);
  }
  console.log(`Fetched ${readings.length} total appliance readings.`);

  console.log('\nFetching devices table...');
  let { data: devices, error: devicesErr } = await supabase
    .from('devices')
    .select(`
      id,
      device_name,
      device_type,
      floor,
      room
    `);

  const STATIC_DEVICES = [
    {
      id: 'ea0b66d3-0d00-4a70-8b87-cab8908d9e38',
      device_name: 'AC - 1st Floor',
      device_type: 'ac',
      floor: '1st Floor',
      room: 'Bedroom'
    },
    {
      id: 'a2814a9c-b2ca-4607-9ce9-acf311548440',
      device_name: 'Heater - GF',
      device_type: 'geyser',
      floor: 'Ground Floor',
      room: 'Bathroom'
    },
    {
      id: '3b896f6f-0e7f-44ff-acd3-33d82ef11aa7',
      device_name: 'AC - GF',
      device_type: 'ac',
      floor: 'Ground Floor',
      room: 'Living Room'
    },
    {
      id: 'ff320fc1-0cbd-4af4-9dcc-98711ce67bde',
      device_name: 'Water Pump',
      device_type: 'pump',
      floor: 'Ground Floor',
      room: 'Utility'
    },
    {
      id: '2ec92fd0-d62f-49a2-86e9-a5dafbb5bc6a',
      device_name: 'Heater - 1st Floor',
      device_type: 'geyser',
      floor: '1st Floor',
      room: 'Bathroom'
    }
  ];

  if (devicesErr) {
    console.warn('Warning: Failed to fetch devices from DB:', devicesErr.message, '. Falling back to static devices map.');
    devices = STATIC_DEVICES;
  }
  const deviceMap = new Map(
    devices.map(d => [d.id, d])
  );


  if (readings.length === 0) {
    console.log('No readings found to backfill.');
    process.exit(0);
  }

  // Group readings by household_id
  const readingsByHousehold = {};
  for (const r of readings) {
    if (!readingsByHousehold[r.household_id]) {
      readingsByHousehold[r.household_id] = [];
    }
    readingsByHousehold[r.household_id].push(r);
  }

  const householdIds = Object.keys(readingsByHousehold);
  console.log(`Found ${householdIds.length} unique household(s) in readings.`);

  // Process each household
  for (const householdId of householdIds) {
    console.log(`\n--------------------------------------------------`);
    console.log(`Processing Household: ${householdId}`);
    console.log(`--------------------------------------------------`);

    const householdReadings = readingsByHousehold[householdId];

    // 2. Fetch daily reports to get coverage ratios
    console.log('Fetching daily reports to match coverage ratios...');
    const { data: dailyReports, error: reportsErr } = await supabase
      .from('daily_reports')
      .select('report_date, coverage_ratio')
      .eq('household_id', householdId);

    if (reportsErr) {
      console.warn(`Warning: Failed to fetch daily reports for ${householdId}: ${reportsErr.message}. Defaulting all coverages to 0.6.`);
    }
    const reportsMap = new Map((dailyReports || []).map(r => [r.report_date, r.coverage_ratio]));

    // 3. Fetch billing cycles for cost aggregation
    console.log('Fetching billing cycle summaries...');
    const { data: billingCycles, error: cyclesErr } = await supabase
      .from('billing_cycle_summary')
      .select('*')
      .eq('household_id', householdId)
      .order('cycle_start', { ascending: true });

    if (cyclesErr) {
      console.warn(`Warning: Failed to fetch billing cycles for ${householdId}: ${cyclesErr.message}. Will calculate cycle boundaries dynamically.`);
    }
    const dbCycles = billingCycles || [];

    // Identify active date range
    const readingDates = householdReadings.map(r => getActiveISTDateStr(r.session_start));
    const minDateStr = readingDates[0];
    const maxDateStr = readingDates[readingDates.length - 1];
    console.log(`Household readings span active dates: ${minDateStr} to ${maxDateStr}`);

    // Determine all cycles we need to process
    const cyclesToProcess = [];
    let currentDate = new Date(minDateStr + 'T00:00:00');
    const endDate = new Date(maxDateStr + 'T00:00:00');

    while (currentDate <= endDate) {
      const curDateStr = toLocalISO(currentDate);
      // Find if database has this cycle
      let cycle = dbCycles.find(c => c.cycle_start <= curDateStr && c.cycle_end > curDateStr);
      let start, end;
      if (cycle) {
        start = cycle.cycle_start;
        end = cycle.cycle_end;
      } else {
        const dates = getInitialCycleDates(curDateStr);
        start = dates.cycleStart;
        end = dates.cycleEnd;
      }

      const key = `${start}_${end}`;
      if (!cyclesToProcess.some(c => c.key === key)) {
        cyclesToProcess.push({ key, start, end });
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    console.log(`Cycles to process for household:`, cyclesToProcess.map(c => c.key));

    // Group household readings by active day and device
    const readingsByDayAndDevice = {};
    for (const r of householdReadings) {
      const day = getActiveISTDateStr(r.session_start);
      if (!readingsByDayAndDevice[day]) {
        readingsByDayAndDevice[day] = {};
      }
      if (!readingsByDayAndDevice[day][r.device_id]) {
        readingsByDayAndDevice[day][r.device_id] = 0;
      }
      readingsByDayAndDevice[day][r.device_id] += parseFloat(r.kwh_consumed || 0);
    }

    const activeISTDayStr = getActiveISTDay();
    const energySnapshots = [];
    const deviceSnapshots = [];
    const comparisonLogs = [];

    // Calculate snapshots cycle-by-cycle to compute progressive cumulative costs correctly
    for (const cycle of cyclesToProcess) {
      let lastDateStr;
      if (cycle.end <= activeISTDayStr) {
        // Cycle has ended. Generate up to cycle.end - 1 day
        const endDate = new Date(cycle.end + 'T00:00:00Z');
        endDate.setUTCDate(endDate.getUTCDate() - 1);
        lastDateStr = endDate.toISOString().slice(0, 10);
      } else {
        // Cycle is ongoing. Generate up to the day BEFORE activeISTDayStr (so we never generate snapshot for current active day)
        const activeDate = new Date(activeISTDayStr + 'T00:00:00Z');
        activeDate.setUTCDate(activeDate.getUTCDate() - 1);
        lastDateStr = activeDate.toISOString().slice(0, 10);
      }
      const cycleDates = getDatesInRange(cycle.start, lastDateStr);
      
      const cycleDaysData = [];
      for (const dateStr of cycleDates) {
        const dayReadings = readingsByDayAndDevice[dateStr] || {};
        const totalMeasuredKwh = Object.values(dayReadings).reduce((a, b) => a + b, 0);
        const coverageRatio = reportsMap.has(dateStr) ? reportsMap.get(dateStr) : 0.6;
        const estimatedKwh = coverageRatio > 0 ? totalMeasuredKwh / coverageRatio : totalMeasuredKwh;

        cycleDaysData.push({
          dateStr,
          totalMeasuredKwh,
          coverageRatio,
          estimatedKwh,
          deviceReadings: dayReadings
        });
      }

      // Sort chronologically and compute progressive costs
      cycleDaysData.sort((a, b) => a.dateStr.localeCompare(b.dateStr));
      let cumulativeEstimated = 0;
      const tariffVersion = cycle.start < '2026-05-28' ? 'TN_OLD_2025' : 'TN_NEW_2026';

      for (const day of cycleDaysData) {
        const dateStr = day.dateStr;
        const prevCumulative = cumulativeEstimated;
        cumulativeEstimated += day.estimatedKwh;
        
        // Calculate cost ONLY for today's units progressively using the active tariff version
        const dailyCost = calculateIncrementalCost(prevCumulative, cumulativeEstimated, tariffVersion);

        day.dailyCost = dailyCost;

        const slabName = getSlabName(cumulativeEstimated);

        if (dateStr >= '2026-05-15' && dateStr <= '2026-05-18') {
          comparisonLogs.push({
            date: dateStr,
            prevCumulative,
            todayEstimated: day.estimatedKwh,
            currCumulative: cumulativeEstimated,
            cost: dailyCost,
            slabName: slabName
          });
        }

        // 1. Calculate Daily Session Metrics
        const daySessions = householdReadings.filter(
          r => getActiveISTDateStr(r.session_start) === dateStr
        );
        const totalSessions = daySessions.length;
        const totalDurationMinutes = daySessions.reduce(
          (sum, s) => sum + (s.duration_minutes || 0),
          0
        );

        // Guardrail: Ensure snapshot cannot be written with measured_kwh = 0 while source readings exist
        const totalSourceKwh = daySessions.reduce(
          (sum, s) => sum + parseFloat(s.kwh_consumed || 0),
          0
        );
        if (day.totalMeasuredKwh === 0 && totalSourceKwh > 0) {
          const errorMsg = `[ERROR] Data Integrity Violation: Snapshot for ${dateStr} has measured_kwh = 0, but ${daySessions.length} source readings exist in appliance_readings with total kWh = ${totalSourceKwh}!`;
          console.error(errorMsg);
          throw new Error(errorMsg);
        }

        // 2. Generate Period Start and Period End (Timezone safe UTC shift)
        const periodStart = `${dateStr}T00:30:00.000Z`;
        const nextDate = new Date(dateStr + 'T00:00:00Z');
        nextDate.setUTCDate(nextDate.getUTCDate() + 1);
        const nextDateStr = nextDate.toISOString().slice(0, 10);
        const periodEnd = `${nextDateStr}T00:29:59.999Z`;

        // Energy snapshot
        energySnapshots.push({
          household_id: householdId,
          snapshot_date: dateStr,
          period_start: periodStart,
          period_end: periodEnd,
          measured_kwh: day.totalMeasuredKwh,
          estimated_kwh: day.estimatedKwh,
          cost: parseFloat(dailyCost.toFixed(4)),
          total_sessions: totalSessions,
          total_duration_minutes: totalDurationMinutes,
          tariff_version: tariffVersion,
          slab_name: slabName
        });

        // Device snapshots (only insert if device has measured kWh > 0)
        for (const [deviceId, devMeasuredKwh] of Object.entries(day.deviceReadings)) {
          if (devMeasuredKwh > 0) {
            const devCost = day.totalMeasuredKwh > 0 ? (devMeasuredKwh / day.totalMeasuredKwh) * dailyCost : 0;
            const deviceSessions = daySessions.filter(s => s.device_id === deviceId);
            const deviceSessionCount = deviceSessions.length;
            const deviceDuration = deviceSessions.reduce(
              (sum, s) => sum + (s.duration_minutes || 0),
              0
            );

            const deviceInfo = deviceMap.get(deviceId);
            deviceSnapshots.push({
              household_id: householdId,
              device_id: deviceId,
              device_name: deviceInfo?.device_name ?? 'Unknown Device',
              device_type: deviceInfo?.device_type ?? null,
              floor: deviceInfo?.floor ?? null,
              room: deviceInfo?.room ?? null,
              snapshot_date: dateStr,
              period_start: periodStart,
              period_end: periodEnd,
              measured_kwh: parseFloat(devMeasuredKwh.toFixed(4)),
              total_sessions: deviceSessionCount,
              total_duration_minutes: deviceDuration,
              cost: parseFloat(devCost.toFixed(4)),
              tariff_version: tariffVersion,
              slab_name: slabName
            });
          }
        }
      }
    }

    console.log(`Calculated:`);
    console.log(`  - ${energySnapshots.length} energy snapshots`);
    console.log(`  - ${deviceSnapshots.length} device snapshots`);

    console.log('\n--- Validation Sample Check ---');
    if (energySnapshots.length > 0) {
      console.log('First Energy Snapshot:', energySnapshots[0]);
    }
    if (deviceSnapshots.length > 0) {
      console.log('First Device Snapshot:', deviceSnapshots[0]);
    }

    console.log('\n--- May 15-18 Comparison Output (Old vs New Cost Formula) ---');
    comparisonLogs.sort((a, b) => a.date.localeCompare(b.date));
    for (const log of comparisonLogs) {
      const oldBillPrev = calculateTNEBBill(log.prevCumulative);
      const oldBillCurr = calculateTNEBBill(log.currCumulative);
      const oldDiff = oldBillCurr - oldBillPrev;
      
      console.log(`\nDate: ${log.date}`);
      console.log(`  previous cumulative estimated: ${log.prevCumulative.toFixed(4)} kWh`);
      console.log(`  current cumulative estimated:  ${log.currCumulative.toFixed(4)} kWh`);
      console.log(`  bill(previous cumulative):     ₹${oldBillPrev.toFixed(4)}`);
      console.log(`  bill(current cumulative):      ₹${oldBillCurr.toFixed(4)}`);
      console.log(`  difference (old cost formula): ₹${oldDiff.toFixed(4)}`);
      console.log(`  new daily cost (incremental):  ₹${log.cost.toFixed(4)}`);
      console.log(`  slab_name:                     ${log.slabName}`);
    }

    console.log('\n--- Slab Crossover Sample Output (May 15-18) ---');
    console.log('snapshot_date | estimated_kwh | cumulative_units | slab_name');
    console.log('------------------------------------------------------------');
    for (const log of comparisonLogs) {
      console.log(`${log.date}    | ${log.todayEstimated.toFixed(4).padStart(13)} | ${log.currCumulative.toFixed(4).padStart(16)} | ${log.slabName}`);
    }


    if (commitMode) {
      console.log('Writing calculated snapshots to the database...');

      // Delete existing snapshots for this household
      console.log('Deleting existing energy snapshots for this household...');
      const { error: delEnergyErr } = await supabase
        .from('daily_energy_snapshots')
        .delete()
        .eq('household_id', householdId);
      if (delEnergyErr) {
        console.error('Failed to delete existing daily_energy_snapshots:', delEnergyErr.message);
        process.exit(1);
      }

      console.log('Deleting existing device snapshots for this household...');
      const { error: delDeviceErr } = await supabase
        .from('daily_device_snapshots')
        .delete()
        .eq('household_id', householdId);
      if (delDeviceErr) {
        console.error('Failed to delete existing daily_device_snapshots:', delDeviceErr.message);
        process.exit(1);
      }

      // Bulk insert new snapshots
      console.log('Inserting new energy snapshots...');
      await bulkInsert('daily_energy_snapshots', energySnapshots);

      console.log('Inserting new device snapshots...');
      await bulkInsert('daily_device_snapshots', deviceSnapshots);

      console.log('Database writes completed successfully!');
    } else {
      console.log('\n[Dry Run Summary]');
      console.log(`- Would delete existing snapshots for household ${householdId}`);
      console.log(`- Would insert ${energySnapshots.length} daily_energy_snapshots`);
      console.log(`- Would insert ${deviceSnapshots.length} daily_device_snapshots`);
      
      const nonZero = energySnapshots.filter(e => e.cost > 0);
      if (nonZero.length > 0) {
        console.log(`- Found ${nonZero.length} days with non-zero calculated cost (due to slab/progressive usage rules).`);
        console.log('  Sample non-zero energy snapshot:', nonZero[0]);
      }
    }
  }

  console.log('\n--- Backfill Process Finished ---');
}

runBackfill().catch(err => {
  console.error('Unhandled error in migration script:', err);
  process.exit(1);
});
