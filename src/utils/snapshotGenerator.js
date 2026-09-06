import { createClient } from '@supabase/supabase-js';
import { sendDailyReport } from './reportDelivery.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://llmyvutkvrxnhzkptbar.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY is required for daily processing backend tasks but is missing.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function getTipText(topDev) {
  if (!topDev) {
    return "Your overall energy consumption is normal today. Try running heavy appliances during off-peak hours.";
  }
  const type = (topDev.device_type || '').toLowerCase();
  const name = (topDev.device_name || '').toLowerCase();

  if (type === 'ac' || name.includes('ac')) {
    return `AC usage is high today (${(topDev.total_duration_minutes / 60).toFixed(1)} hrs). Recommend increasing AC temperature by 1°C to save energy.`;
  } else if (type === 'geyser' || type === 'heater' || name.includes('heater') || name.includes('geyser')) {
    return `Water heater usage is high today (${topDev.total_duration_minutes} mins). Recommend lowering thermostat or reducing usage time.`;
  } else if (type === 'pump' || name.includes('pump')) {
    return `Water pump runtime is unusually long today (${topDev.total_duration_minutes} mins). Recommend checking for pipe leakage or tank overflow.`;
  } else {
    return `${topDev.device_name || 'Heavy appliances'} consumed the most energy today (${topDev.measured_kwh} kWh). Try optimizing its schedule.`;
  }
}

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

function getNextSlabRate(currentAccumulated, tariffVersion) {
  const tariff = TARIFFS[tariffVersion] || TARIFFS.TN_NEW_2026;
  const list = currentAccumulated > 500 ? tariff.above500 : tariff.below500;
  const nextSlab = list.find(s => s.min > currentAccumulated);
  return nextSlab ? nextSlab.rate : null;
}

function formatReportDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

function generateWhatsAppMessage({
  ownerName,
  snapshotDate,
  energySnapshot,
  deviceSnapshots,
  devicesStillOn,
  activeCycle,
  cycle_measured_kwh_before,
  cycle_measured_kwh_after,
  cycle_estimated_before,
  cycle_estimated_after,
  slab_crossing_units,
  slab_crossing_date,
  days_of_reports,
  tipText
}) {
  const formattedDate = formatReportDate(snapshotDate);
  const cycleStartFormatted = formatReportDate(activeCycle.cycle_start);
  const cycleEndFormatted = formatReportDate(activeCycle.cycle_end);

  const d = new Date(snapshotDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  const yesterdayFormatted = formatReportDate(d.toISOString().slice(0, 10));

  let msg = `Good morning ${ownerName}! Here's your home report for ${formattedDate} (06:00 am – 06:00 am) ☀️\n\n`;
  msg += `*⚡ Measured: ${energySnapshot.measured_kwh.toFixed(2)} units  |  Est. full home: ~${energySnapshot.estimated_kwh.toFixed(2)} units*\n\n`;
  msg += `*${formattedDate} Breakdown*\n`;

  for (const ds of deviceSnapshots) {
    const namePart = (ds.device_name || 'Unknown').padEnd(22, ' ');
    const mins = parseInt(ds.total_duration_minutes || 0, 10);
    const durationStr = mins >= 60 
      ? `${Math.floor(mins / 60)}h ${mins % 60}min` 
      : `${mins}min`;
    const durationPart = durationStr.padEnd(12, ' ');
    const kwhPart = `${ds.measured_kwh.toFixed(2)} units`.padEnd(12, ' ');
    msg += `${namePart} ${durationPart} |  ${kwhPart} |  ₹${Math.round(ds.cost || 0)}\n`;
  }
  msg += `\n`;

  if (devicesStillOn && devicesStillOn.length > 0) {
    for (const dev of devicesStillOn) {
      msg += `⚠️ ${dev.name} has been running since ${dev.started_ist} and is still on — data in tomorrow's report.\n`;
    }
    msg += `\n`;
  }

  msg += `*📅 Billing Cycle: ${cycleStartFormatted} – ${cycleEndFormatted}*\n`;
  const labelBefore = `Cycle so far (Till ${yesterdayFormatted}):`;
  const labelAfter = `Adding today's report (${formattedDate}):`;
  msg += `${labelBefore.padEnd(32, ' ')} ${cycle_measured_kwh_before.toFixed(2)} units  |  ~${cycle_estimated_before.toFixed(2)} units est.\n`;
  msg += `${labelAfter.padEnd(32, ' ')} ${cycle_measured_kwh_after.toFixed(2)} units  |  ~${cycle_estimated_after.toFixed(2)} units est.\n\n`;

  if (slab_crossing_units) {
    const pace = days_of_reports > 0 ? (cycle_measured_kwh_after / days_of_reports) : 1.0;
    const unitsRemaining = slab_crossing_units - cycle_measured_kwh_after;
    
    msg += `*⚠️ Slab alert*\n`;
    const isFree = (energySnapshot.slab_name || '').toLowerCase().includes('free') || energySnapshot.cost === 0;
    const currentSlabStr = isFree ? 'free slab' : (energySnapshot.slab_name || 'current slab').toLowerCase();
    msg += `Currently in ${currentSlabStr}. ${unitsRemaining.toFixed(1)} units away from the next slab.\n`;
    msg += `At your current pace (~${pace.toFixed(1)} units/day) you'll cross ${slab_crossing_units} units around ${slab_crossing_date}.\n`;

    const nextRate = getNextSlabRate(cycle_measured_kwh_after, energySnapshot.tariff_version);
    if (nextRate !== null) {
      if (isFree) {
        msg += `Charges begin at ₹${nextRate.toFixed(2)}/unit after that.\n`;
      } else {
        msg += `Rates increase to ₹${nextRate.toFixed(2)}/unit after that.\n`;
      }
    }
    msg += `\n`;
  }

  msg += `*💡 Tip*\n`;
  msg += `${tipText}\n\n`;
  msg += `👉 See full details in the Zenacle app`;

  return msg;
}

function calculateIncrementalCost(prevUnits, currUnits, tariffVersion) {
  if (currUnits <= prevUnits) return 0;
  
  const tariff = TARIFFS[tariffVersion] || TARIFFS.TN_NEW_2026;
  let totalCost = 0;
  
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

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dateDay = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dateDay}`;
}

function getNextDateStr(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function getInitialCycleDates(currentDateStr) {
  const now = new Date(currentDateStr + 'T00:00:00Z');
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  
  if (now.getUTCDate() < 28) {
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

export function getCompletedActiveDayStr() {
  const now = new Date();
  const istTimeMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  const adjustedDate = new Date(istTimeMs - (6 * 60 * 60 * 1000));
  adjustedDate.setUTCDate(adjustedDate.getUTCDate() - 1);
  const y = adjustedDate.getUTCFullYear();
  const m = String(adjustedDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(adjustedDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Main export for generating energy snapshots and daily reports.
 * 
 * Supports:
 * - Single date string (e.g. '2026-06-27')
 * - Range object or array (e.g. { startDate: '2026-06-27', endDate: '2026-06-30' })
 * - Automatic catch-up mode when targetDateArg is undefined/null/'auto'
 */
export async function generateSnapshotsForDate(targetDateArg) {
  console.log(`[INFO] [SCHEDULER_START] Triggered with argument: ${JSON.stringify(targetDateArg || 'auto')}`);

  // 1. Fetch all households from billing_cycle_summary
  const { data: cycles, error: cyclesErr } = await supabase
    .from('billing_cycle_summary')
    .select('household_id');

  if (cyclesErr) {
    console.error(`[ERROR] [SCHEDULER_INIT] Failed to fetch households: ${cyclesErr.message}`);
    throw new Error(`Failed to fetch households from cycles: ${cyclesErr.message}`);
  }

  const householdIds = [...new Set((cycles || []).map(c => c.household_id))];
  console.log(`[INFO] [SCHEDULER_INIT] Found ${householdIds.length} households to evaluate.`);

  const completedActiveDay = getCompletedActiveDayStr();
  const allResults = [];

  for (const householdId of householdIds) {
    console.log(`[INFO] [HOUSEHOLD_START] Household: ${householdId}`);

    // Determine target dates list for this household
    let datesToProcess = [];

    if (targetDateArg && targetDateArg !== 'auto') {
      if (typeof targetDateArg === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(targetDateArg)) {
        datesToProcess = [targetDateArg];
      } else if (typeof targetDateArg === 'object' && targetDateArg.startDate && targetDateArg.endDate) {
        let curr = targetDateArg.startDate;
        while (curr <= targetDateArg.endDate) {
          datesToProcess.push(curr);
          curr = getNextDateStr(curr);
        }
      } else if (Array.isArray(targetDateArg)) {
        datesToProcess = targetDateArg;
      }
    }

    // Automatic Catch-Up Mode: Detect latest snapshot date & process missing dates up to completedActiveDay
    if (datesToProcess.length === 0) {
      const { data: maxSnap, error: maxSnapErr } = await supabase
        .from('daily_energy_snapshots')
        .select('snapshot_date')
        .eq('household_id', householdId)
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (maxSnapErr) {
        console.error(`[ERROR] [HOUSEHOLD ${householdId}] Failed to query latest snapshot date: ${maxSnapErr.message}`);
        allResults.push({ householdId, status: 'error', error: maxSnapErr.message });
        continue;
      }

      let startDate;
      if (maxSnap && maxSnap.snapshot_date) {
        startDate = getNextDateStr(maxSnap.snapshot_date);
        console.log(`[INFO] [HOUSEHOLD ${householdId}] Latest existing snapshot date is ${maxSnap.snapshot_date}. Catching up from ${startDate}.`);
      } else {
        // Query earliest raw reading
        const { data: minReading } = await supabase
          .from('appliance_readings')
          .select('session_start')
          .eq('household_id', householdId)
          .order('session_start', { ascending: true })
          .limit(1)
          .maybeSingle();

        if (minReading && minReading.session_start) {
          const d = new Date(minReading.session_start);
          const adj = new Date(d.getTime() - (30 * 60 * 1000));
          startDate = adj.toISOString().slice(0, 10);
        } else {
          startDate = completedActiveDay;
        }
        console.log(`[INFO] [HOUSEHOLD ${householdId}] No existing snapshots. Starting from ${startDate}.`);
      }

      let curr = startDate;
      while (curr <= completedActiveDay) {
        datesToProcess.push(curr);
        curr = getNextDateStr(curr);
      }

      if (datesToProcess.length === 0) {
        console.log(`[INFO] [HOUSEHOLD ${householdId}] All snapshots are up to date through ${completedActiveDay}.`);
        allResults.push({ householdId, status: 'up_to_date', latestDate: maxSnap?.snapshot_date || completedActiveDay });
        continue;
      }

      console.log(`[INFO] [HOUSEHOLD ${householdId}] Queued ${datesToProcess.length} missing date(s) for automatic catch-up: ${datesToProcess[0]} to ${datesToProcess[datesToProcess.length - 1]}`);
    }

    // Process dates sequentially
    for (const snapshotDate of datesToProcess) {
      console.log(`[INFO] [PROCESSING_DATE] Household: ${householdId} | Snapshot Date: ${snapshotDate}`);
      let energySnapshot = null;
      let deviceSnapshots = [];
      let activeCycle = null;

      // 1. Idempotency check
      const { data: existingSnapshot, error: checkErr } = await supabase
        .from('daily_energy_snapshots')
        .select('*')
        .eq('household_id', householdId)
        .eq('snapshot_date', snapshotDate)
        .maybeSingle();

      if (checkErr) {
        console.error(`[ERROR] [EXISTING_CHECK_FAILED] Household ${householdId} Date ${snapshotDate}: ${checkErr.message}`);
        allResults.push({ householdId, snapshotDate, status: 'error', error: checkErr.message });
        continue;
      }

      if (existingSnapshot) {
        console.log(`[INFO] [EXISTING_SNAPSHOT_FOUND] Household ${householdId} Date ${snapshotDate}: Record exists (${existingSnapshot.measured_kwh} kWh). Skipping creation.`);
        energySnapshot = existingSnapshot;

        const { data: existingDevices, error: devErr } = await supabase
          .from('daily_device_snapshots')
          .select('*')
          .eq('household_id', householdId)
          .eq('snapshot_date', snapshotDate);

        if (devErr) {
          console.error(`[ERROR] [EXISTING_DEVICES_FAILED] Household ${householdId} Date ${snapshotDate}: ${devErr.message}`);
        }
        deviceSnapshots = existingDevices || [];
      } else {
        // 2. Billing cycle maintenance & creation
        let currentStart, currentEnd;
        try {
          const { data: latestCycle, error: latestCycleErr } = await supabase
            .from('billing_cycle_summary')
            .select('*')
            .eq('household_id', householdId)
            .order('cycle_end', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (latestCycleErr) {
            console.error(`[ERROR] [CYCLE_LOOKUP_FAILED] Household ${householdId}: ${latestCycleErr.message}`);
            allResults.push({ householdId, snapshotDate, status: 'error', error: latestCycleErr.message });
            continue;
          }

          if (latestCycle) {
            if (snapshotDate >= latestCycle.cycle_end) {
              currentStart = latestCycle.cycle_end;
              currentEnd = addMonths(currentStart, 2);
              while (snapshotDate >= currentEnd) {
                currentStart = currentEnd;
                currentEnd = addMonths(currentStart, 2);
              }
            } else if (snapshotDate >= latestCycle.cycle_start) {
              activeCycle = latestCycle;
              currentStart = latestCycle.cycle_start;
              currentEnd = latestCycle.cycle_end;
            } else {
              const { data: allCycles } = await supabase
                .from('billing_cycle_summary')
                .select('*')
                .eq('household_id', householdId);

              activeCycle = (allCycles || []).find(c => snapshotDate >= c.cycle_start && snapshotDate < c.cycle_end);
              if (activeCycle) {
                currentStart = activeCycle.cycle_start;
                currentEnd = activeCycle.cycle_end;
              } else {
                const dates = getInitialCycleDates(snapshotDate);
                currentStart = dates.cycleStart;
                currentEnd = dates.cycleEnd;
              }
            }
          } else {
            const dates = getInitialCycleDates(snapshotDate);
            currentStart = dates.cycleStart;
            currentEnd = dates.cycleEnd;
          }

          if (!activeCycle) {
            const { data: existingCycle } = await supabase
              .from('billing_cycle_summary')
              .select('*')
              .eq('household_id', householdId)
              .eq('cycle_start', currentStart)
              .eq('cycle_end', currentEnd)
              .maybeSingle();

            if (existingCycle) {
              activeCycle = existingCycle;
            } else {
              const newCycle = {
                household_id: householdId,
                cycle_start: currentStart,
                cycle_end: currentEnd,
                kwh_accumulated: 0,
                last_reading_at: null,
                slab_alert_threshold: 400,
                slab_alert_sent: false,
                cycle_locked: false,
                source_kwh_breakdown: null
              };

              console.log(`[INFO] [CYCLE_CREATE] Household ${householdId}: Creating new billing cycle ${currentStart} to ${currentEnd}`);
              const { data: inserted, error: insertError } = await supabase
                .from('billing_cycle_summary')
                .insert(newCycle)
                .select()
                .maybeSingle();

              if (insertError) {
                console.error(`[ERROR] [CYCLE_INSERT_FAILED] Household ${householdId}: ${insertError.message}`);
                allResults.push({ householdId, snapshotDate, status: 'error', error: insertError.message });
                continue;
              }
              activeCycle = inserted;
            }
          }
        } catch (cycleProcessErr) {
          console.error(`[ERROR] [CYCLE_MAINTENANCE_EXCEPTION] Household ${householdId}: ${cycleProcessErr.message}`);
          allResults.push({ householdId, snapshotDate, status: 'error', error: cycleProcessErr.message });
          continue;
        }

        const cycleStart = activeCycle.cycle_start;
        const cycleEnd = activeCycle.cycle_end;

        // 3. Query past cumulative snapshots in cycle
        const { data: pastSnapshots, error: pastErr } = await supabase
          .from('daily_energy_snapshots')
          .select('estimated_kwh')
          .eq('household_id', householdId)
          .gte('snapshot_date', cycleStart)
          .lt('snapshot_date', snapshotDate);

        if (pastErr) {
          console.error(`[ERROR] [PAST_SNAPSHOTS_FAILED] Household ${householdId}: ${pastErr.message}`);
          allResults.push({ householdId, snapshotDate, status: 'error', error: pastErr.message });
          continue;
        }

        const prevCumulative = (pastSnapshots || []).reduce((sum, s) => sum + parseFloat(s.estimated_kwh || 0), 0);

        const periodStart = `${snapshotDate}T00:30:00.000Z`;
        const nextDateStr = getNextDateStr(snapshotDate);
        const periodEnd = `${nextDateStr}T00:30:00.000Z`;

        // 4. Query appliance readings
        const { data: readings, error: readingsErr } = await supabase
          .from('appliance_readings')
          .select('*')
          .eq('household_id', householdId)
          .gte('session_start', periodStart)
          .lt('session_start', periodEnd);

        if (readingsErr) {
          console.error(`[ERROR] [READINGS_QUERY_FAILED] Household ${householdId} Date ${snapshotDate}: ${readingsErr.message}`);
          allResults.push({ householdId, snapshotDate, status: 'error', error: readingsErr.message });
          continue;
        }

        const readingsCount = (readings || []).length;
        console.log(`[INFO] [READINGS_FOUND] Household ${householdId} Date ${snapshotDate}: ${readingsCount} raw session(s) retrieved.`);

        const { data: dailyReport } = await supabase
          .from('daily_reports')
          .select('coverage_ratio')
          .eq('household_id', householdId)
          .eq('report_date', snapshotDate)
          .maybeSingle();

        const coverageRatio = dailyReport?.coverage_ratio ?? 0.6;
        const totalMeasuredKwh = (readings || []).reduce((sum, r) => sum + parseFloat(r.kwh_consumed || 0), 0);
        const estimatedKwh = coverageRatio > 0 ? totalMeasuredKwh / coverageRatio : totalMeasuredKwh;
        const cumulativeEstimated = prevCumulative + estimatedKwh;

        const tariffVersion = cycleStart < '2026-05-28' ? 'TN_OLD_2025' : 'TN_NEW_2026';
        const dailyCost = calculateIncrementalCost(prevCumulative, cumulativeEstimated, tariffVersion);
        const slabName = getSlabName(cumulativeEstimated);

        const totalSessions = readingsCount;
        const totalDurationMinutes = (readings || []).reduce((sum, r) => sum + (r.duration_minutes || 0), 0);

        if (totalMeasuredKwh === 0 && totalSessions > 0) {
          const errorMsg = `Data Integrity Violation: Snapshot for ${snapshotDate} has measured_kwh = 0, but ${totalSessions} source readings exist in appliance_readings!`;
          console.error(`[ERROR] [DATA_INTEGRITY_VIOLATION] ${errorMsg}`);
          allResults.push({ householdId, snapshotDate, status: 'error', error: errorMsg });
          continue;
        }

        energySnapshot = {
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

        // Group readings by device
        const readingsByDevice = {};
        for (const r of readings || []) {
          if (!readingsByDevice[r.device_id]) {
            readingsByDevice[r.device_id] = [];
          }
          readingsByDevice[r.device_id].push(r);
        }

        const { data: devicesList } = await supabase
          .from('devices')
          .select('id, device_name, device_type, floor, room');

        const deviceMap = new Map((devicesList || []).map(d => [d.id, d]));
        const STATIC_DEVICES = {
          'ea0b66d3-0d00-4a70-8b87-cab8908d9e38': { device_name: 'AC - 1st Floor', device_type: 'ac', floor: '1st Floor', room: 'Bedroom' },
          'a2814a9c-b2ca-4607-9ce9-acf311548440': { device_name: 'Heater - GF', device_type: 'geyser', floor: 'Ground Floor', room: 'Bathroom' },
          '3b896f6f-0e7f-44ff-acd3-33d82ef11aa7': { device_name: 'AC - GF', device_type: 'ac', floor: 'Ground Floor', room: 'Living Room' },
          'ff320fc1-0cbd-4af4-9dcc-98711ce67bde': { device_name: 'Water Pump', device_type: 'pump', floor: 'Ground Floor', room: 'Utility' },
          '2ec92fd0-d62f-49a2-86e9-a5dafbb5bc6a': { device_name: 'Heater - 1st Floor', device_type: 'geyser', floor: '1st Floor', room: 'Bathroom' }
        };

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

        // 5. Insert snapshots
        const { error: insEnergyErr } = await supabase
          .from('daily_energy_snapshots')
          .insert([energySnapshot]);

        if (insEnergyErr) {
          console.error(`[ERROR] [ENERGY_SNAPSHOT_INSERT_FAILED] Household ${householdId} Date ${snapshotDate}: ${insEnergyErr.message}`);
          allResults.push({ householdId, snapshotDate, status: 'error', error: insEnergyErr.message });
          continue;
        }

        if (deviceSnapshots.length > 0) {
          const { error: insDeviceErr } = await supabase
            .from('daily_device_snapshots')
            .insert(deviceSnapshots);

          if (insDeviceErr) {
            console.error(`[ERROR] [DEVICE_SNAPSHOT_INSERT_FAILED] Household ${householdId} Date ${snapshotDate}: ${insDeviceErr.message}`);
            allResults.push({ householdId, snapshotDate, status: 'error', error: insDeviceErr.message });
            continue;
          }
        }
        console.log(`[INFO] [SNAPSHOT_INSERT_SUCCESS] Household ${householdId} Date ${snapshotDate}: Inserted daily energy snapshot & ${deviceSnapshots.length} device snapshots.`);
      }

      // Locate active cycle for cycle recalculation
      if (!activeCycle) {
        const { data: latestCycle } = await supabase
          .from('billing_cycle_summary')
          .select('*')
          .eq('household_id', householdId)
          .order('cycle_end', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latestCycle) {
          if (snapshotDate >= latestCycle.cycle_start && snapshotDate < latestCycle.cycle_end) {
            activeCycle = latestCycle;
          } else {
            const { data: allCycles } = await supabase
              .from('billing_cycle_summary')
              .select('*')
              .eq('household_id', householdId);

            activeCycle = (allCycles || []).find(c => snapshotDate >= c.cycle_start && snapshotDate < c.cycle_end) || latestCycle;
          }
        }
      }

      // 6. Recalculate and update billing_cycle_summary
      if (activeCycle) {
        const cycleStart = activeCycle.cycle_start;
        const cycleEnd = activeCycle.cycle_end;
        const periodEnd = `${cycleEnd}T00:30:00.000Z`;

        try {
          const { data: cycleSnapshots } = await supabase
            .from('daily_energy_snapshots')
            .select('measured_kwh')
            .eq('household_id', householdId)
            .gte('snapshot_date', cycleStart)
            .lt('snapshot_date', cycleEnd);

          const kwh_accumulated = (cycleSnapshots || []).reduce((sum, s) => sum + parseFloat(s.measured_kwh || 0), 0);

          const { data: cycleDeviceSnapshots } = await supabase
            .from('daily_device_snapshots')
            .select('device_id, measured_kwh')
            .eq('household_id', householdId)
            .gte('snapshot_date', cycleStart)
            .lt('snapshot_date', cycleEnd);

          const source_kwh_breakdown = {};
          for (const ds of cycleDeviceSnapshots || []) {
            source_kwh_breakdown[ds.device_id] = parseFloat(((source_kwh_breakdown[ds.device_id] || 0) + parseFloat(ds.measured_kwh || 0)).toFixed(4));
          }

          const { data: latestReading } = await supabase
            .from('appliance_readings')
            .select('session_start, session_end')
            .eq('household_id', householdId)
            .gte('session_start', `${cycleStart}T00:30:00.000Z`)
            .lt('session_start', periodEnd)
            .order('session_start', { ascending: false })
            .limit(1)
            .maybeSingle();

          const last_reading_at = latestReading ? (latestReading.session_end || latestReading.session_start) : activeCycle.last_reading_at;

          const { error: updateCycleErr } = await supabase
            .from('billing_cycle_summary')
            .update({
              kwh_accumulated: parseFloat(kwh_accumulated.toFixed(4)),
              last_reading_at,
              source_kwh_breakdown
            })
            .eq('id', activeCycle.id);

          if (updateCycleErr) {
            console.error(`[ERROR] [BILLING_CYCLE_UPDATE_FAILED] Household ${householdId}: ${updateCycleErr.message}`);
          } else {
            console.log(`[INFO] [BILLING_CYCLE_UPDATE_SUCCESS] Household ${householdId}: Cycle (${cycleStart} to ${cycleEnd}) updated (Accumulated: ${kwh_accumulated.toFixed(4)} kWh).`);
          }
        } catch (recalcErr) {
          console.error(`[ERROR] [BILLING_CYCLE_EXCEPTION] Household ${householdId}: ${recalcErr.message}`);
        }
      }

      // 7. Enriched Daily Report Generation
      try {
        const { data: existingReport } = await supabase
          .from('daily_reports')
          .select('*')
          .eq('household_id', householdId)
          .eq('report_date', snapshotDate)
          .maybeSingle();

        const coverageRatio = existingReport?.coverage_ratio ?? 0.6;
        const periodStart = `${snapshotDate}T00:30:00.000Z`;
        const nextDateStr = getNextDateStr(snapshotDate);
        const periodEnd = `${nextDateStr}T00:30:00.000Z`;

        const { data: openReadings } = await supabase
          .from('appliance_readings')
          .select('*')
          .eq('household_id', householdId)
          .gte('session_start', periodStart)
          .lt('session_start', periodEnd)
          .is('session_end', null);

        const { data: devicesList } = await supabase
          .from('devices')
          .select('id, device_name, device_type, floor, room');

        const deviceMap = new Map((devicesList || []).map(d => [d.id, d]));
        const STATIC_DEVICES = {
          'ea0b66d3-0d00-4a70-8b87-cab8908d9e38': { device_name: 'AC - 1st Floor', device_type: 'ac', floor: '1st Floor', room: 'Bedroom' },
          'a2814a9c-b2ca-4607-9ce9-acf311548440': { device_name: 'Heater - GF', device_type: 'geyser', floor: 'Ground Floor', room: 'Bathroom' },
          '3b896f6f-0e7f-44ff-acd3-33d82ef11aa7': { device_name: 'AC - GF', device_type: 'ac', floor: 'Ground Floor', room: 'Living Room' },
          'ff320fc1-0cbd-4af4-9dcc-98711ce67bde': { device_name: 'Water Pump', device_type: 'pump', floor: 'Ground Floor', room: 'Utility' },
          '2ec92fd0-d62f-49a2-86e9-a5dafbb5bc6a': { device_name: 'Heater - 1st Floor', device_type: 'geyser', floor: '1st Floor', room: 'Bathroom' }
        };

        const formatISTTime = (utcStr) => {
          if (!utcStr) return '';
          const d = new Date(utcStr);
          const istDate = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
          let hours = istDate.getHours();
          const minutes = String(istDate.getMinutes()).padStart(2, '0');
          const ampm = hours >= 12 ? 'pm' : 'am';
          hours = hours % 12;
          hours = hours ? hours : 12;
          return `${hours}:${minutes} ${ampm}`;
        };

        const devices_still_on = (openReadings || []).map(r => {
          const deviceInfo = deviceMap.get(r.device_id) || STATIC_DEVICES[r.device_id] || {};
          return {
            name: deviceInfo.device_name || 'Unknown Device',
            device_id: r.device_id,
            session_id: r.id,
            started_ist: formatISTTime(r.session_start)
          };
        });

        let ownerName = 'Zenacle User';
        let householdObj = null;
        try {
          const { data: hData } = await supabase
            .from('households')
            .select('id, property_name, city, state, latitude, longitude, owner_id')
            .eq('id', householdId)
            .maybeSingle();

          if (hData) {
            householdObj = hData;
            if (householdObj.owner_id) {
              const { data: ownerUser } = await supabase
                .from('user')
                .select('full_name')
                .eq('id', householdObj.owner_id)
                .maybeSingle();

              if (ownerUser && ownerUser.full_name) {
                ownerName = ownerUser.full_name.split(' ')[0];
              }
            }
          }
        } catch (err) {
          console.warn(`[WARNING] Exception fetching household details:`, err.message);
        }

        // Fetch Weather Context safely with AbortController timeout (5s)
        let weather_context = null;
        let weather_has_incomplete = false;
        const lat = householdObj?.latitude;
        const lon = householdObj?.longitude;

        if (lat !== null && lat !== undefined && lon !== null && lon !== undefined) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          try {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${snapshotDate}&end_date=${snapshotDate}`;
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (res.ok) {
              const data = await res.json();
              const minTemp = data.daily?.temperature_2m_min?.[0];
              const maxTemp = data.daily?.temperature_2m_max?.[0];
              const avgTemp = minTemp !== undefined && maxTemp !== undefined ? parseFloat(((minTemp + maxTemp) / 2).toFixed(1)) : null;

              if (minTemp !== undefined && maxTemp !== undefined) {
                weather_context = {
                  location: {
                    property_name: householdObj.property_name || null,
                    city: householdObj.city || null,
                    state: householdObj.state || null,
                    latitude: lat,
                    longitude: lon
                  },
                  data_source: "open-meteo",
                  overnight_min_c: minTemp,
                  overnight_max_c: maxTemp,
                  report_period_avg_c: avgTemp,
                  generated_at: new Date().toISOString()
                };
              } else {
                weather_context = { status: "weather_api_incomplete" };
                weather_has_incomplete = true;
              }
            } else {
              weather_context = { status: "weather_api_failed" };
              weather_has_incomplete = true;
            }
          } catch (err) {
            clearTimeout(timeoutId);
            weather_context = { status: "weather_api_timeout" };
            weather_has_incomplete = true;
          }
        } else {
          weather_context = { status: "coordinates_missing" };
          weather_has_incomplete = true;
        }

        let topDev = null;
        for (const ds of deviceSnapshots) {
          if (!topDev || ds.measured_kwh > topDev.measured_kwh) {
            topDev = ds;
          }
        }

        const top_device_id = topDev ? topDev.device_id : null;
        const top_device_kwh = topDev ? parseFloat(topDev.measured_kwh.toFixed(4)) : null;
        const top_device_runtime_mins = topDev ? parseInt(topDev.total_duration_minutes || 0, 10) : null;

        const by_type = {};
        const by_device = {};
        for (const ds of deviceSnapshots) {
          const deviceInfo = deviceMap.get(ds.device_id) || STATIC_DEVICES[ds.device_id] || {};
          const devType = ds.device_type || deviceInfo.device_type || 'other';
          by_type[devType] = parseFloat(((by_type[devType] || 0) + parseFloat(ds.measured_kwh || 0)).toFixed(4));
          
          by_device[ds.device_id] = {
            kwh: parseFloat(ds.measured_kwh.toFixed(4)),
            cost: parseFloat((ds.cost || 0).toFixed(4)),
            name: ds.device_name || deviceInfo.device_name || 'Unknown Device',
            type: devType,
            minutes: parseInt(ds.total_duration_minutes || 0, 10)
          };
        }

        const device_type_breakdown = { by_type, by_device };

        const cycleStart = activeCycle ? activeCycle.cycle_start : snapshotDate;
        const { data: cycleSnapshots } = await supabase
          .from('daily_energy_snapshots')
          .select('measured_kwh, estimated_kwh, snapshot_date')
          .eq('household_id', householdId)
          .gte('snapshot_date', cycleStart)
          .lte('snapshot_date', snapshotDate);

        const snapsList = cycleSnapshots || [];
        snapsList.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));

        const cycle_measured_kwh_after = parseFloat(snapsList.reduce((sum, s) => sum + parseFloat(s.measured_kwh || 0), 0).toFixed(4));
        const cycle_measured_kwh_before = parseFloat((cycle_measured_kwh_after - energySnapshot.measured_kwh).toFixed(4));

        const cycle_estimated_after = parseFloat(snapsList.reduce((sum, s) => sum + parseFloat(s.estimated_kwh || 0), 0).toFixed(4));
        const cycle_estimated_before = parseFloat((cycle_estimated_after - energySnapshot.estimated_kwh).toFixed(4));

        const days_of_reports = snapsList.length;

        let energy_vs_last_week = null;
        try {
          const dWeek = new Date(snapshotDate + 'T00:00:00Z');
          dWeek.setUTCDate(dWeek.getUTCDate() - 7);
          const lastWeekDateStr = dWeek.toISOString().slice(0, 10);

          const { data: lastWeekSnap } = await supabase
            .from('daily_energy_snapshots')
            .select('measured_kwh')
            .eq('household_id', householdId)
            .eq('snapshot_date', lastWeekDateStr)
            .maybeSingle();

          if (lastWeekSnap && lastWeekSnap.measured_kwh > 0) {
            const diff = energySnapshot.measured_kwh - lastWeekSnap.measured_kwh;
            energy_vs_last_week = parseFloat(((diff / lastWeekSnap.measured_kwh) * 100).toFixed(1));
          }
        } catch (err) {
          console.warn(`[WARNING] Exception calculating energy_vs_last_week:`, err.message);
        }

        let slab_crossing_units = null;
        let slab_crossing_date = null;
        const currentAccumulated = cycle_measured_kwh_after;

        if (currentAccumulated <= 100) slab_crossing_units = 100;
        else if (currentAccumulated <= 200) slab_crossing_units = 200;
        else if (currentAccumulated <= 400) slab_crossing_units = 400;
        else if (currentAccumulated <= 500) slab_crossing_units = 500;
        else if (currentAccumulated <= 600) slab_crossing_units = 600;
        else if (currentAccumulated <= 800) slab_crossing_units = 800;
        else if (currentAccumulated <= 1000) slab_crossing_units = 1000;

        if (slab_crossing_units) {
          const pace = days_of_reports > 0 ? (currentAccumulated / days_of_reports) : 1.0;
          const unitsRemaining = slab_crossing_units - currentAccumulated;
          const daysToCross = pace > 0 ? Math.ceil(unitsRemaining / pace) : 0;
          
          const crossDate = new Date(snapshotDate + 'T00:00:00Z');
          crossDate.setUTCDate(crossDate.getUTCDate() + daysToCross);
          const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          slab_crossing_date = `${crossDate.getUTCDate()} ${months[crossDate.getUTCMonth()]}`;
        }

        const tip_text = getTipText(topDev);
        const whatsapp_message = generateWhatsAppMessage({
          ownerName,
          snapshotDate,
          energySnapshot,
          deviceSnapshots,
          devicesStillOn: devices_still_on,
          activeCycle: activeCycle || { cycle_start: snapshotDate, cycle_end: snapshotDate },
          cycle_measured_kwh_before,
          cycle_measured_kwh_after,
          cycle_estimated_before,
          cycle_estimated_after,
          slab_crossing_units,
          slab_crossing_date,
          days_of_reports,
          tipText: tip_text
        });

        let has_incomplete_data = devices_still_on.length > 0 || coverageRatio < 1.0 || weather_has_incomplete;

        const reportRow = {
          household_id: householdId,
          report_date: snapshotDate,
          total_kwh: energySnapshot.measured_kwh,
          total_sessions: energySnapshot.total_sessions,
          top_device_id,
          top_device_kwh,
          top_device_runtime_mins,
          estimated_cost_inr: energySnapshot.cost,
          generated_at: new Date().toISOString(),
          window_start: energySnapshot.period_start,
          window_end: `${nextDateStr}T00:30:00.000Z`,
          cutoff_time: `${snapshotDate}T06:00:00.000Z`,
          device_type_breakdown,
          devices_still_on,
          has_incomplete_data,
          coverage_ratio: coverageRatio,
          estimated_full_home_kwh: energySnapshot.estimated_kwh,
          cycle_measured_kwh_before,
          cycle_measured_kwh_after,
          cycle_estimated_before,
          cycle_estimated_after,
          days_of_reports,
          whatsapp_message,
          tip_text,
          weather_context,
          slab_crossing_date,
          slab_crossing_units,
          energy_vs_last_week,
          energy_vs_benchmark: existingReport ? existingReport.energy_vs_benchmark : null,
          water_litres: existingReport ? existingReport.water_litres : null,
          water_source: existingReport ? existingReport.water_source : null,
          delivered_at: existingReport ? existingReport.delivered_at : null
        };

        let reportId = null;
        if (existingReport) {
          reportRow.delivery_status = existingReport.delivery_status || 'pending';
          const { error: updateReportErr } = await supabase
            .from('daily_reports')
            .update(reportRow)
            .eq('id', existingReport.id);

          if (updateReportErr) {
            console.error(`[ERROR] [DAILY_REPORT_UPDATE_FAILED] Household ${householdId} Date ${snapshotDate}: ${updateReportErr.message}`);
          } else {
            console.log(`[INFO] [DAILY_REPORT_UPDATE_SUCCESS] Household ${householdId} Date ${snapshotDate}: Daily report updated.`);
          }
          reportId = existingReport.id;
        } else {
          reportRow.delivery_status = 'pending';
          const { data: insertedData, error: insertReportErr } = await supabase
            .from('daily_reports')
            .insert([reportRow])
            .select('id')
            .single();

          if (insertReportErr) {
            console.error(`[ERROR] [DAILY_REPORT_INSERT_FAILED] Household ${householdId} Date ${snapshotDate}: ${insertReportErr.message}`);
          } else {
            console.log(`[INFO] [DAILY_REPORT_INSERT_SUCCESS] Household ${householdId} Date ${snapshotDate}: Daily report inserted.`);
            reportId = insertedData?.id;
          }
        }

        // Deliver report if ID exists (wrapped safely)
        if (reportId) {
          try {
            const deliveryResult = await sendDailyReport(reportId);
            const { message, payload, ...summary } = deliveryResult || {};
            console.log(`[INFO] [CRM_DELIVERY_RESPONSE] Household ${householdId} Date ${snapshotDate}:`, JSON.stringify(summary));
          } catch (delErr) {
            console.warn(`[WARNING] [CRM_DELIVERY_EXCEPTION] Household ${householdId} Date ${snapshotDate}: ${delErr.message}`);
          }
        }

        allResults.push({ householdId, snapshotDate, status: 'success', measuredKwh: energySnapshot.measured_kwh });
      } catch (reportGenErr) {
        console.error(`[ERROR] [REPORT_GEN_EXCEPTION] Household ${householdId} Date ${snapshotDate}: ${reportGenErr.message}`);
        allResults.push({ householdId, snapshotDate, status: 'error', error: reportGenErr.message });
      }
    }
  }

  console.log(`[INFO] [SCHEDULER_FINISH] Processing completed. Total task entries processed: ${allResults.length}`);
  return allResults;
}
