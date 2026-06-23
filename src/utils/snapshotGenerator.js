import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://llmyvutkvrxnhzkptbar.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsbXl2dXRrdnJ4bmh6a3B0YmFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMDAwNjAsImV4cCI6MjA4OTc3NjA2MH0.F2GfOp4k_giCXoc0pMNAI4myoRNyIWooI7sdxSqEqDs';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

const supabaseKey = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, supabaseKey, {
  auth: { persistSession: false }
});

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

function toLocalISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + months);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dateDay = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dateDay}`;
}

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

function getCompletedActiveDayStr() {
  const now = new Date();
  const istTimeMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  const adjustedDate = new Date(istTimeMs - (6 * 60 * 60 * 1000));
  adjustedDate.setDate(adjustedDate.getDate() - 1);
  const y = adjustedDate.getUTCFullYear();
  const m = String(adjustedDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(adjustedDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export async function generateSnapshotsForDate(targetDateStr) {
  const snapshotDate = targetDateStr || getCompletedActiveDayStr();
  console.log(`[INFO] Starting daily snapshot generation for date: ${snapshotDate}`);

  // Fetch unique households from billing_cycle_summary (safe from RLS policy recursion on households table)
  const { data: cycles, error: cyclesErr } = await supabase
    .from('billing_cycle_summary')
    .select('household_id');

  if (cyclesErr) {
    throw new Error(`Failed to fetch households from cycles: ${cyclesErr.message}`);
  }

  const householdIds = [...new Set((cycles || []).map(c => c.household_id))];
  console.log(`[INFO] Found ${householdIds.length} households to process.`);

  const results = [];

  for (const householdId of householdIds) {
    console.log(`[INFO] Processing household: ${householdId}`);

    // Check if snapshot already exists (idempotency check)
    const { data: existingSnapshot, error: checkErr } = await supabase
      .from('daily_energy_snapshots')
      .select('id')
      .eq('household_id', householdId)
      .eq('snapshot_date', snapshotDate)
      .maybeSingle();

    if (checkErr) {
      console.error(`[ERROR] Failed to check existing snapshot for ${householdId}:`, checkErr.message);
      results.push({ householdId, status: 'error', error: checkErr.message });
      continue;
    }

    if (existingSnapshot) {
      console.log(`[INFO] Snapshot already exists for date ${snapshotDate} and household ${householdId}. Skipping.`);
      results.push({ householdId, status: 'skipped', reason: 'Already exists' });
      continue;
    }

    // Determine the active billing cycle
    const { data: billingCycles, error: cycleErr } = await supabase
      .from('billing_cycle_summary')
      .select('*')
      .eq('household_id', householdId)
      .order('cycle_start', { ascending: true });

    if (cycleErr) {
      console.error(`[ERROR] Failed to fetch billing cycles:`, cycleErr.message);
      results.push({ householdId, status: 'error', error: cycleErr.message });
      continue;
    }

    let activeCycle = (billingCycles || []).find(c => c.cycle_start <= snapshotDate && c.cycle_end > snapshotDate);
    let cycleStart, cycleEnd;
    if (activeCycle) {
      cycleStart = activeCycle.cycle_start;
      cycleEnd = activeCycle.cycle_end;
    } else {
      const dates = getInitialCycleDates(snapshotDate);
      cycleStart = dates.cycleStart;
      cycleEnd = dates.cycleEnd;
    }

    // Retrieve previous snapshots in the cycle to calculate cumulative usage before snapshotDate
    const { data: pastSnapshots, error: pastErr } = await supabase
      .from('daily_energy_snapshots')
      .select('estimated_kwh')
      .eq('household_id', householdId)
      .gte('snapshot_date', cycleStart)
      .lt('snapshot_date', snapshotDate);

    if (pastErr) {
      console.error(`[ERROR] Failed to fetch past snapshots:`, pastErr.message);
      results.push({ householdId, status: 'error', error: pastErr.message });
      continue;
    }

    const prevCumulative = (pastSnapshots || []).reduce((sum, s) => sum + parseFloat(s.estimated_kwh || 0), 0);

    // Fetch appliance readings for snapshotDate (respecting 6 AM IST/00:30 UTC boundary)
    const periodStart = `${snapshotDate}T00:30:00.000Z`;
    const nextDate = new Date(snapshotDate + 'T00:00:00Z');
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const nextDateStr = nextDate.toISOString().slice(0, 10);
    const periodEnd = `${nextDateStr}T00:30:00.000Z`;

    const { data: readings, error: readingsErr } = await supabase
      .from('appliance_readings')
      .select('*')
      .eq('household_id', householdId)
      .gte('session_start', periodStart)
      .lt('session_start', periodEnd);

    if (readingsErr) {
      console.error(`[ERROR] Failed to fetch appliance readings:`, readingsErr.message);
      results.push({ householdId, status: 'error', error: readingsErr.message });
      continue;
    }

    // Fetch coverage ratio for snapshotDate from daily_reports
    const { data: dailyReport, error: reportErr } = await supabase
      .from('daily_reports')
      .select('coverage_ratio')
      .eq('household_id', householdId)
      .eq('report_date', snapshotDate)
      .maybeSingle();

    if (reportErr) {
      console.warn(`[WARNING] Failed to fetch daily report for ${snapshotDate}:`, reportErr.message);
    }

    const coverageRatio = dailyReport?.coverage_ratio ?? 0.6;

    // Group readings by device
    const readingsByDevice = {};
    for (const r of readings || []) {
      if (!readingsByDevice[r.device_id]) {
        readingsByDevice[r.device_id] = [];
      }
      readingsByDevice[r.device_id].push(r);
    }

    const totalMeasuredKwh = (readings || []).reduce((sum, r) => sum + parseFloat(r.kwh_consumed || 0), 0);
    const estimatedKwh = coverageRatio > 0 ? totalMeasuredKwh / coverageRatio : totalMeasuredKwh;
    const cumulativeEstimated = prevCumulative + estimatedKwh;

    // Calculate incremental cost using progressive tariff slabs
    const tariffVersion = cycleStart < '2026-05-28' ? 'TN_OLD_2025' : 'TN_NEW_2026';
    const dailyCost = calculateIncrementalCost(prevCumulative, cumulativeEstimated, tariffVersion);
    const slabName = getSlabName(cumulativeEstimated);

    const totalSessions = (readings || []).length;
    const totalDurationMinutes = (readings || []).reduce((sum, r) => sum + (r.duration_minutes || 0), 0);

    // Guardrail: Ensure snapshot cannot be written with measured_kwh = 0 while source readings exist
    if (totalMeasuredKwh === 0 && totalSessions > 0) {
      const errorMsg = `Data Integrity Violation: Snapshot for ${snapshotDate} has measured_kwh = 0, but ${totalSessions} source readings exist in appliance_readings!`;
      console.error(`[ERROR] ${errorMsg}`);
      results.push({ householdId, status: 'error', error: errorMsg });
      continue;
    }

    const energySnapshot = {
      household_id: householdId,
      snapshot_date: snapshotDate,
      period_start: periodStart,
      period_end: `${nextDateStr}T00:29:59.999Z`,
      measured_kwh: parseFloat(totalMeasuredKwh.toFixed(4)),
      estimated_kwh: parseFloat(estimatedKwh.toFixed(4)),
      cost: parseFloat(dailyCost.toFixed(4)),
      total_sessions: totalSessions,
      total_duration_minutes: totalDurationMinutes,
      tariff_version: tariffVersion,
      slab_name: slabName
    };

    // Fetch devices metadata
    const { data: devicesList, error: devicesErr } = await supabase
      .from('devices')
      .select('id, device_name, device_type, floor, room');

    if (devicesErr) {
      console.warn(`[WARNING] Failed to fetch devices list:`, devicesErr.message);
    }

    const deviceMap = new Map((devicesList || []).map(d => [d.id, d]));
    const STATIC_DEVICES = {
      'ea0b66d3-0d00-4a70-8b87-cab8908d9e38': { device_name: 'AC - 1st Floor', device_type: 'ac', floor: '1st Floor', room: 'Bedroom' },
      'a2814a9c-b2ca-4607-9ce9-acf311548440': { device_name: 'Heater - GF', device_type: 'geyser', floor: 'Ground Floor', room: 'Bathroom' },
      '3b896f6f-0e7f-44ff-acd3-33d82ef11aa7': { device_name: 'AC - GF', device_type: 'ac', floor: 'Ground Floor', room: 'Living Room' },
      'ff320fc1-0cbd-4af4-9dcc-98711ce67bde': { device_name: 'Water Pump', device_type: 'pump', floor: 'Ground Floor', room: 'Utility' },
      '2ec92fd0-d62f-49a2-86e9-a5dafbb5bc6a': { device_name: 'Heater - 1st Floor', device_type: 'geyser', floor: '1st Floor', room: 'Bathroom' }
    };

    const deviceSnapshots = [];
    for (const [deviceId, devReadings] of Object.entries(readingsByDevice)) {
      const devMeasuredKwh = devReadings.reduce((sum, r) => sum + parseFloat(r.kwh_consumed || 0), 0);
      if (devMeasuredKwh > 0) {
        const devCost = totalMeasuredKwh > 0 ? (devMeasuredKwh / totalMeasuredKwh) * dailyCost : 0;
        const deviceSessionCount = devReadings.length;
        const deviceDuration = devReadings.reduce((sum, r) => sum + (r.duration_minutes || 0), 0);
        
        const deviceInfo = deviceMap.get(deviceId) || STATIC_DEVICES[deviceId] || {};
        deviceSnapshots.push({
          household_id: householdId,
          device_id: deviceId,
          device_name: deviceInfo.device_name ?? 'Unknown Device',
          device_type: deviceInfo.device_type ?? null,
          floor: deviceInfo.floor ?? null,
          room: deviceInfo.room ?? null,
          snapshot_date: snapshotDate,
          period_start: periodStart,
          period_end: `${nextDateStr}T00:29:59.999Z`,
          measured_kwh: parseFloat(devMeasuredKwh.toFixed(4)),
          total_sessions: deviceSessionCount,
          total_duration_minutes: deviceDuration,
          cost: parseFloat(devCost.toFixed(4)),
          tariff_version: tariffVersion,
          slab_name: slabName
        });
      }
    }

    console.log(`[INFO] Inserting daily_energy_snapshot for household ${householdId}...`);
    const { error: insEnergyErr } = await supabase
      .from('daily_energy_snapshots')
      .insert([energySnapshot]);

    if (insEnergyErr) {
      console.error(`[ERROR] Failed to insert daily_energy_snapshot:`, insEnergyErr.message);
      results.push({ householdId, status: 'error', error: insEnergyErr.message });
      continue;
    }

    if (deviceSnapshots.length > 0) {
      console.log(`[INFO] Inserting ${deviceSnapshots.length} daily_device_snapshots for household ${householdId}...`);
      const { error: insDeviceErr } = await supabase
        .from('daily_device_snapshots')
        .insert(deviceSnapshots);

      if (insDeviceErr) {
        console.error(`[ERROR] Failed to insert daily_device_snapshots:`, insDeviceErr.message);
        results.push({ householdId, status: 'error', error: insDeviceErr.message });
        continue;
      }
    }

    console.log(`[INFO] Snapshot created successfully for date ${snapshotDate} and household ${householdId}.`);
    results.push({ householdId, status: 'success', snapshotDate });
  }

  return results;
}
