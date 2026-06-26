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

function getNextSlabRate(currentAccumulated, tariffVersion) {
  const tariff = TARIFFS[tariffVersion] || TARIFFS.TN_NEW_2026;
  const list = currentAccumulated > 500 ? tariff.above500 : tariff.below500;
  // Find the first slab whose min is greater than currentAccumulated
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
  console.log('[INFO] Scheduler Started');

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

    let energySnapshot = null;
    let deviceSnapshots = [];
    let activeCycle = null;

    // Check if snapshot already exists (idempotency check)
    const { data: existingSnapshot, error: checkErr } = await supabase
      .from('daily_energy_snapshots')
      .select('*')
      .eq('household_id', householdId)
      .eq('snapshot_date', snapshotDate)
      .maybeSingle();

    if (checkErr) {
      console.error(`[ERROR] Failed to check existing snapshot for ${householdId}:`, checkErr.message);
      results.push({ householdId, status: 'error', error: checkErr.message });
      continue;
    }

    if (existingSnapshot) {
      console.log(`[INFO] Snapshot already exists for date ${snapshotDate} and household ${householdId}. Reusing existing snapshots for validation and report.`);
      energySnapshot = existingSnapshot;

      const { data: existingDevices, error: devErr } = await supabase
        .from('daily_device_snapshots')
        .select('*')
        .eq('household_id', householdId)
        .eq('snapshot_date', snapshotDate);

      if (devErr) {
        console.error(`[ERROR] Failed to fetch existing device snapshots for ${householdId}:`, devErr.message);
        results.push({ householdId, status: 'error', error: devErr.message });
        continue;
      }
      deviceSnapshots = existingDevices || [];
      console.log('[INFO] Snapshot Generation Complete');

      // Locate active billing cycle
      try {
        const { data: latestCycle, error: latestCycleErr } = await supabase
          .from('billing_cycle_summary')
          .select('*')
          .eq('household_id', householdId)
          .order('cycle_end', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (latestCycleErr) {
          console.error(`[ERROR] Failed to fetch latest billing cycle:`, latestCycleErr.message);
          results.push({ householdId, status: 'error', error: latestCycleErr.message });
          continue;
        }

        if (latestCycle) {
          if (snapshotDate >= latestCycle.cycle_end) {
            const { data: allCycles, error: allCyclesErr } = await supabase
              .from('billing_cycle_summary')
              .select('*')
              .eq('household_id', householdId);

            if (allCyclesErr) {
              console.error(`[ERROR] Failed to fetch all billing cycles:`, allCyclesErr.message);
              results.push({ householdId, status: 'error', error: allCyclesErr.message });
              continue;
            }
            activeCycle = (allCycles || []).find(c => snapshotDate >= c.cycle_start && snapshotDate < c.cycle_end);
          } else if (snapshotDate >= latestCycle.cycle_start) {
            activeCycle = latestCycle;
          } else {
            const { data: allCycles, error: allCyclesErr } = await supabase
              .from('billing_cycle_summary')
              .select('*')
              .eq('household_id', householdId);

            if (allCyclesErr) {
              console.error(`[ERROR] Failed to fetch all billing cycles:`, allCyclesErr.message);
              results.push({ householdId, status: 'error', error: allCyclesErr.message });
              continue;
            }
            activeCycle = (allCycles || []).find(c => snapshotDate >= c.cycle_start && snapshotDate < c.cycle_end);
          }
        }
      } catch (cycleProcessErr) {
        console.error(`[ERROR] Exception occurred during cycle lookup:`, cycleProcessErr.message);
        results.push({ householdId, status: 'error', error: cycleProcessErr.message });
        continue;
      }
      console.log('[INFO] Billing Cycle Updated');

      if (activeCycle) {
        const cycleStart = activeCycle.cycle_start;
        const cycleEnd = activeCycle.cycle_end;
        const periodEnd = `${cycleEnd}T00:30:00.000Z`;

        try {
          console.log(`[INFO] Recalculating billing cycle values for household ${householdId} (existing snapshot)...`);
          const { data: cycleSnapshots, error: cycleSnapErr } = await supabase
            .from('daily_energy_snapshots')
            .select('measured_kwh')
            .eq('household_id', householdId)
            .gte('snapshot_date', cycleStart)
            .lt('snapshot_date', cycleEnd);

          if (cycleSnapErr) {
            console.error(`[ERROR] Failed to fetch cycle snapshots for recalculation:`, cycleSnapErr.message);
            results.push({ householdId, status: 'error', error: cycleSnapErr.message });
            continue;
          }

          const kwh_accumulated = (cycleSnapshots || []).reduce((sum, s) => sum + parseFloat(s.measured_kwh || 0), 0);

          const { data: cycleDeviceSnapshots, error: cycleDevSnapErr } = await supabase
            .from('daily_device_snapshots')
            .select('device_id, measured_kwh')
            .eq('household_id', householdId)
            .gte('snapshot_date', cycleStart)
            .lt('snapshot_date', cycleEnd);

          if (cycleDevSnapErr) {
            console.error(`[ERROR] Failed to fetch device snapshots for breakdown:`, cycleDevSnapErr.message);
            results.push({ householdId, status: 'error', error: cycleDevSnapErr.message });
            continue;
          }

          const source_kwh_breakdown = {};
          for (const ds of cycleDeviceSnapshots || []) {
            source_kwh_breakdown[ds.device_id] = parseFloat(((source_kwh_breakdown[ds.device_id] || 0) + parseFloat(ds.measured_kwh || 0)).toFixed(4));
          }

          const { data: latestReading, error: readErr } = await supabase
            .from('appliance_readings')
            .select('session_start, session_end')
            .eq('household_id', householdId)
            .gte('session_start', `${cycleStart}T00:30:00.000Z`)
            .lt('session_start', periodEnd)
            .order('session_start', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (readErr) {
            console.warn(`[WARNING] Failed to query latest reading for last_reading_at:`, readErr.message);
          }

          const last_reading_at = latestReading ? (latestReading.session_end || latestReading.session_start) : activeCycle.last_reading_at;

          console.log(`[INFO] Updating billing_cycle_summary for household ${householdId}...`);
          const { error: updateCycleErr } = await supabase
            .from('billing_cycle_summary')
            .update({
              kwh_accumulated: parseFloat(kwh_accumulated.toFixed(4)),
              last_reading_at,
              source_kwh_breakdown
            })
            .eq('id', activeCycle.id);

          if (updateCycleErr) {
            console.error(`[ERROR] Failed to update billing_cycle_summary:`, updateCycleErr.message);
            results.push({ householdId, status: 'error', error: updateCycleErr.message });
            continue;
          }

          console.log(`[INFO] Billing cycle summary updated successfully for household ${householdId} (existing snapshot).`);
        } catch (recalcErr) {
          console.error(`[ERROR] Exception during billing cycle recalculation (existing snapshot):`, recalcErr.message);
          results.push({ householdId, status: 'error', error: recalcErr.message });
          continue;
        }
      }
    } else {
      // 1. Locate or create active billing cycle
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
          console.error(`[ERROR] Failed to fetch latest billing cycle:`, latestCycleErr.message);
          results.push({ householdId, status: 'error', error: latestCycleErr.message });
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
            const { data: allCycles, error: allCyclesErr } = await supabase
              .from('billing_cycle_summary')
              .select('*')
              .eq('household_id', householdId);
            
            if (allCyclesErr) {
              console.error(`[ERROR] Failed to fetch all billing cycles:`, allCyclesErr.message);
              results.push({ householdId, status: 'error', error: allCyclesErr.message });
              continue;
            }

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
          const { data: existingCycle, error: existingCycleErr } = await supabase
            .from('billing_cycle_summary')
            .select('*')
            .eq('household_id', householdId)
            .eq('cycle_start', currentStart)
            .eq('cycle_end', currentEnd)
            .maybeSingle();

          if (existingCycleErr) {
            console.error(`[ERROR] Failed to check existing cycle:`, existingCycleErr.message);
            results.push({ householdId, status: 'error', error: existingCycleErr.message });
            continue;
          }

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

            console.log(`[INFO] Creating new billing cycle for household ${householdId}: ${currentStart} to ${currentEnd}`);
            const { data: inserted, error: insertError } = await supabase
              .from('billing_cycle_summary')
              .insert(newCycle)
              .select()
              .maybeSingle();

            if (insertError) {
              console.error(`[ERROR] Failed to insert new cycle:`, insertError.message);
              results.push({ householdId, status: 'error', error: insertError.message });
              continue;
            }
            activeCycle = inserted;
          }
        }
      } catch (cycleProcessErr) {
        console.error(`[ERROR] Exception occurred during cycle maintenance:`, cycleProcessErr.message);
        results.push({ householdId, status: 'error', error: cycleProcessErr.message });
        continue;
      }

      const cycleStart = activeCycle.cycle_start;
      const cycleEnd = activeCycle.cycle_end;

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

      const tariffVersion = cycleStart < '2026-05-28' ? 'TN_OLD_2025' : 'TN_NEW_2026';
      const dailyCost = calculateIncrementalCost(prevCumulative, cumulativeEstimated, tariffVersion);
      const slabName = getSlabName(cumulativeEstimated);

      const totalSessions = (readings || []).length;
      const totalDurationMinutes = (readings || []).reduce((sum, r) => sum + (r.duration_minutes || 0), 0);

      if (totalMeasuredKwh === 0 && totalSessions > 0) {
        const errorMsg = `Data Integrity Violation: Snapshot for ${snapshotDate} has measured_kwh = 0, but ${totalSessions} source readings exist in appliance_readings!`;
        console.error(`[ERROR] ${errorMsg}`);
        results.push({ householdId, status: 'error', error: errorMsg });
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
      console.log('[INFO] Snapshot Generation Complete');

      try {
        console.log(`[INFO] Recalculating billing cycle values for household ${householdId}...`);
        const { data: cycleSnapshots, error: cycleSnapErr } = await supabase
          .from('daily_energy_snapshots')
          .select('measured_kwh')
          .eq('household_id', householdId)
          .gte('snapshot_date', cycleStart)
          .lt('snapshot_date', cycleEnd);

        if (cycleSnapErr) {
          console.error(`[ERROR] Failed to fetch cycle snapshots for recalculation:`, cycleSnapErr.message);
          results.push({ householdId, status: 'error', error: cycleSnapErr.message });
          continue;
        }

        const kwh_accumulated = (cycleSnapshots || []).reduce((sum, s) => sum + parseFloat(s.measured_kwh || 0), 0);

        const { data: cycleDeviceSnapshots, error: cycleDevSnapErr } = await supabase
          .from('daily_device_snapshots')
          .select('device_id, measured_kwh')
          .eq('household_id', householdId)
          .gte('snapshot_date', cycleStart)
          .lt('snapshot_date', cycleEnd);

        if (cycleDevSnapErr) {
          console.error(`[ERROR] Failed to fetch device snapshots for breakdown:`, cycleDevSnapErr.message);
          results.push({ householdId, status: 'error', error: cycleDevSnapErr.message });
          continue;
        }

        const source_kwh_breakdown = {};
        for (const ds of cycleDeviceSnapshots || []) {
          source_kwh_breakdown[ds.device_id] = parseFloat(((source_kwh_breakdown[ds.device_id] || 0) + parseFloat(ds.measured_kwh || 0)).toFixed(4));
        }

        const { data: latestReading, error: readErr } = await supabase
          .from('appliance_readings')
          .select('session_start, session_end')
          .eq('household_id', householdId)
          .gte('session_start', `${cycleStart}T00:30:00.000Z`)
          .lt('session_start', periodEnd)
          .order('session_start', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (readErr) {
          console.warn(`[WARNING] Failed to query latest reading for last_reading_at:`, readErr.message);
        }

        const last_reading_at = latestReading ? (latestReading.session_end || latestReading.session_start) : activeCycle.last_reading_at;

        console.log(`[INFO] Updating billing_cycle_summary for household ${householdId}...`);
        const { error: updateCycleErr } = await supabase
          .from('billing_cycle_summary')
          .update({
            kwh_accumulated: parseFloat(kwh_accumulated.toFixed(4)),
            last_reading_at,
            source_kwh_breakdown
          })
          .eq('id', activeCycle.id);

        if (updateCycleErr) {
          console.error(`[ERROR] Failed to update billing_cycle_summary:`, updateCycleErr.message);
          results.push({ householdId, status: 'error', error: updateCycleErr.message });
          continue;
        }

        console.log(`[INFO] Billing cycle summary updated successfully for household ${householdId}.`);
      } catch (recalcErr) {
        console.error(`[ERROR] Exception during billing cycle recalculation:`, recalcErr.message);
        results.push({ householdId, status: 'error', error: recalcErr.message });
        continue;
      }
      console.log('[INFO] Billing Cycle Updated');
    }

    // ========================================================
    // NEW: SNAPSHOT INTEGRITY VALIDATION (Task 1)
    // ========================================================
    console.log(`[INFO] Validating snapshot integrity for household ${householdId}...`);
    const sumDeviceKwh = deviceSnapshots.reduce((sum, ds) => sum + parseFloat(ds.measured_kwh || 0), 0);
    const sumDeviceKwhFixed = parseFloat(sumDeviceKwh.toFixed(4));
    const energyKwhFixed = parseFloat(energySnapshot.measured_kwh.toFixed(4));

    const sumDeviceSessions = deviceSnapshots.reduce((sum, ds) => sum + parseInt(ds.total_sessions || 0, 10), 0);
    const sumDeviceDuration = deviceSnapshots.reduce((sum, ds) => sum + parseInt(ds.total_duration_minutes || 0, 10), 0);

    const isKwhValid = Math.abs(sumDeviceKwhFixed - energyKwhFixed) < 0.0001;
    const isSessionsValid = sumDeviceSessions <= energySnapshot.total_sessions;
    const isDurationValid = sumDeviceDuration <= energySnapshot.total_duration_minutes;

    if (sumDeviceSessions < energySnapshot.total_sessions) {
      console.log(`[INFO] Note: sumDeviceSessions (${sumDeviceSessions}) is less than energySnapshot.total_sessions (${energySnapshot.total_sessions}). This is expected because device snapshots are only created for devices with measured_kwh > 0.`);
    }
    if (sumDeviceDuration < energySnapshot.total_duration_minutes) {
      console.log(`[INFO] Note: sumDeviceDuration (${sumDeviceDuration} mins) is less than energySnapshot.total_duration_minutes (${energySnapshot.total_duration_minutes} mins). This is expected because device snapshots are only created for devices with measured_kwh > 0.`);
    }

    if (!isKwhValid || !isSessionsValid || !isDurationValid) {
      const errorDetail = `Validation failed: ` +
        `KWh match: ${isKwhValid} (Devices sum: ${sumDeviceKwhFixed} kWh, Energy snapshot: ${energyKwhFixed} kWh). ` +
        `Sessions match: ${isSessionsValid} (Devices sum: ${sumDeviceSessions}, Energy snapshot: ${energySnapshot.total_sessions}). ` +
        `Duration match: ${isDurationValid} (Devices sum: ${sumDeviceDuration} mins, Energy snapshot: ${energySnapshot.total_duration_minutes} mins).`;
      console.error(`[ERROR] Snapshot validation failed for household ${householdId} on date ${snapshotDate}: ${errorDetail}`);
      results.push({ householdId, status: 'error', error: `Snapshot Validation Failed: ${errorDetail}` });
      continue;
    }
    console.log(`[INFO] Snapshot validation passed for household ${householdId}.`);

    // ========================================================
    // ENRICHED DAILY REPORT GENERATION (Phase 3 Tasks)
    // ========================================================
    try {
      console.log(`[INFO] Checking for existing daily report for household ${householdId} and date ${snapshotDate}...`);
      const { data: existingReport, error: getReportErr } = await supabase
        .from('daily_reports')
        .select('*')
        .eq('household_id', householdId)
        .eq('report_date', snapshotDate)
        .maybeSingle();

      if (getReportErr) {
        console.warn(`[WARNING] Failed to query existing daily report:`, getReportErr.message);
      }

      const coverageRatio = existingReport?.coverage_ratio ?? 0.6;

      const periodStart = `${snapshotDate}T00:30:00.000Z`;
      const nextDate = new Date(snapshotDate + 'T00:00:00Z');
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      const nextDateStr = nextDate.toISOString().slice(0, 10);
      const periodEnd = `${nextDateStr}T00:30:00.000Z`;

      // Fetch open readings to populate devices_still_on
      const { data: openReadings, error: openReadingsErr } = await supabase
        .from('appliance_readings')
        .select('*')
        .eq('household_id', householdId)
        .gte('session_start', periodStart)
        .lt('session_start', periodEnd)
        .is('session_end', null);

      if (openReadingsErr) {
        console.warn(`[WARNING] Failed to query open readings:`, openReadingsErr.message);
      }

      // Fetch devices metadata for report names
      const { data: devicesList, error: devicesErr } = await supabase
        .from('devices')
        .select('id, device_name, device_type, floor, room');

      if (devicesErr) {
        console.warn(`[WARNING] Failed to fetch devices list for report:`, devicesErr.message);
      }

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

      // Task 1: Fetch household details (Owner name greeting fallback)
      let ownerName = 'Zenacle User';
      if (existingReport && existingReport.whatsapp_message) {
        const match = existingReport.whatsapp_message.match(/Good morning ([^!]+)!/);
        if (match) {
          ownerName = match[1];
        }
      }

      let householdObj = null;
      try {
        console.log(`[INFO]\nFetching household coordinates...\n\nHousehold:\n${householdId}`);
        const { data: hData, error: hError } = await supabase
          .from('households')
          .select('id, property_name, city, state, latitude, longitude, owner_id')
          .eq('id', householdId)
          .maybeSingle();

        if (hError) {
          console.warn(`[WARNING] Failed to fetch household details: ${hError.message}`);
        } else {
          householdObj = hData;
          if (householdObj && householdObj.owner_id) {
            const { data: ownerUser, error: ownerErr } = await supabase
              .from('user')
              .select('full_name')
              .eq('id', householdObj.owner_id)
              .maybeSingle();

            if (!ownerErr && ownerUser && ownerUser.full_name) {
              ownerName = ownerUser.full_name.split(' ')[0];
            }
          }
        }
      } catch (err) {
        console.warn(`[WARNING] Exception fetching household details:`, err.message);
      }

      let weather_context = null;
      let weather_has_incomplete = false;
      const lat = householdObj?.latitude;
      const lon = householdObj?.longitude;

      if (lat !== null && lat !== undefined && lon !== null && lon !== undefined) {
        const propName = householdObj.property_name || "Unknown Property";
        console.log(`[INFO]\nFetching household coordinates...\n\nHousehold:\n${propName}\n\nCoordinates:\n${lat}\n${lon}`);
        console.log(`[INFO]\nFetching weather from Open-Meteo...`);
        console.log(`[INFO] Fetching weather...`);
        
        let responseStatus = 'N/A';
        const startTime = Date.now();
        try {
          const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min&timezone=auto&start_date=${snapshotDate}&end_date=${snapshotDate}`;
          console.log(`Request URL: ${url}`);
          
          const res = await fetch(url);
          responseStatus = res.status;
          console.log(`HTTP status: ${res.status}`);
          
          if (!res.ok) {
            throw new Error(`Weather API returned status ${res.status}`);
          }
          const data = await res.json();
          console.log(`JSON parsed`);
          
          const minTemp = data.daily?.temperature_2m_min?.[0];
          const maxTemp = data.daily?.temperature_2m_max?.[0];
          const avgTemp = minTemp !== undefined && maxTemp !== undefined ? parseFloat(((minTemp + maxTemp) / 2).toFixed(1)) : null;

          const endTime = Date.now();
          console.log(`Response time: ${endTime - startTime}ms`);

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
            console.log(`[INFO]\nWeather stored successfully.`);
            console.log(`weather_context saved`);
          } else {
            throw new Error("Missing daily temperature data in API response");
          }
        } catch (err) {
          console.warn(`[WARNING]\nWeather API unavailable.\n\nScheduler continuing.`);
          console.warn(`exact failure reason: ${err.message.includes('status') ? 'HTTP Error' : (err.message.includes('JSON') ? 'JSON Parse Error' : (err.message.includes('temperature') ? 'Missing Data Error' : 'Network/Timeout Error'))}`);
          console.warn(`HTTP status: ${responseStatus}`);
          console.warn(`error message: ${err.message}`);
          console.warn(`stack: ${err.stack}`);
          weather_context = { status: "weather_api_failed" };
          weather_has_incomplete = true;
        }
      } else {
        console.warn(`[WARNING]\nHousehold coordinates missing.\nWeather generation skipped.`);
        weather_context = { status: "coordinates_missing" };
        weather_has_incomplete = true;
      }

      // Determine top device
      let topDev = null;
      for (const ds of deviceSnapshots) {
        if (!topDev || ds.measured_kwh > topDev.measured_kwh) {
          topDev = ds;
        }
      }

      const top_device_id = topDev ? topDev.device_id : null;
      const top_device_kwh = topDev ? parseFloat(topDev.measured_kwh.toFixed(4)) : null;
      const top_device_runtime_mins = topDev ? parseInt(topDev.total_duration_minutes || 0, 10) : null;

      // Device type breakdown object
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

      const device_type_breakdown = {
        by_type,
        by_device
      };

      const cycleStart = activeCycle.cycle_start;
      const cycleEnd = activeCycle.cycle_end;

      // Query all snapshots in the cycle up to snapshotDate
      const { data: cycleSnapshots, error: cycleSnapErr } = await supabase
        .from('daily_energy_snapshots')
        .select('measured_kwh, estimated_kwh, snapshot_date')
        .eq('household_id', householdId)
        .gte('snapshot_date', cycleStart)
        .lte('snapshot_date', snapshotDate);

      if (cycleSnapErr) {
        console.warn(`[WARNING] Failed to fetch cycle snapshots for report calculation:`, cycleSnapErr.message);
      }

      const snapsList = cycleSnapshots || [];
      snapsList.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));

      const cycle_measured_kwh_after = parseFloat(snapsList.reduce((sum, s) => sum + parseFloat(s.measured_kwh || 0), 0).toFixed(4));
      const cycle_measured_kwh_before = parseFloat((cycle_measured_kwh_after - energySnapshot.measured_kwh).toFixed(4));

      const cycle_estimated_after = parseFloat(snapsList.reduce((sum, s) => sum + parseFloat(s.estimated_kwh || 0), 0).toFixed(4));
      const cycle_estimated_before = parseFloat((cycle_estimated_after - energySnapshot.estimated_kwh).toFixed(4));

      const days_of_reports = snapsList.length;

      // Task 4: energy_vs_last_week
      let energy_vs_last_week = null;
      try {
        const dWeek = new Date(snapshotDate + 'T00:00:00Z');
        dWeek.setUTCDate(dWeek.getUTCDate() - 7);
        const lastWeekDateStr = dWeek.toISOString().slice(0, 10);

        const { data: lastWeekSnap, error: lastWeekErr } = await supabase
          .from('daily_energy_snapshots')
          .select('measured_kwh')
          .eq('household_id', householdId)
          .eq('snapshot_date', lastWeekDateStr)
          .maybeSingle();

        if (lastWeekErr) {
          console.warn(`[WARNING] Failed to fetch last week snapshot:`, lastWeekErr.message);
        } else if (lastWeekSnap && lastWeekSnap.measured_kwh > 0) {
          const diff = energySnapshot.measured_kwh - lastWeekSnap.measured_kwh;
          energy_vs_last_week = parseFloat(((diff / lastWeekSnap.measured_kwh) * 100).toFixed(1));
        }
      } catch (err) {
        console.warn(`[WARNING] Exception calculating energy_vs_last_week:`, err.message);
      }

      // Task 5: Slab alert crossing calculations
      let slab_crossing_units = null;
      let slab_crossing_date = null;

      const currentAccumulated = cycle_measured_kwh_after;
      if (currentAccumulated <= 100) {
        slab_crossing_units = 100;
      } else if (currentAccumulated <= 200) {
        slab_crossing_units = 200;
      } else if (currentAccumulated <= 400) {
        slab_crossing_units = 400;
      } else if (currentAccumulated <= 500) {
        slab_crossing_units = 500;
      } else if (currentAccumulated <= 600) {
        slab_crossing_units = 600;
      } else if (currentAccumulated <= 800) {
        slab_crossing_units = 800;
      } else if (currentAccumulated <= 1000) {
        slab_crossing_units = 1000;
      }

      if (slab_crossing_units) {
        const pace = days_of_reports > 0 ? (currentAccumulated / days_of_reports) : 1.0;
        const unitsRemaining = slab_crossing_units - currentAccumulated;
        const daysToCross = pace > 0 ? Math.ceil(unitsRemaining / pace) : 0;
        
        const crossDate = new Date(snapshotDate + 'T00:00:00Z');
        crossDate.setUTCDate(crossDate.getUTCDate() + daysToCross);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        slab_crossing_date = `${crossDate.getUTCDate()} ${months[crossDate.getUTCMonth()]}`;
      }

      // Task 2: Generate tip_text
      const tip_text = getTipText(topDev);

      // Task 3: Generate whatsapp_message
      const whatsapp_message = generateWhatsAppMessage({
        ownerName,
        snapshotDate,
        energySnapshot,
        deviceSnapshots,
        devicesStillOn: devices_still_on,
        activeCycle,
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

      // Task 7: Validation
      const validationErrors = [];
      if (reportRow.total_kwh !== energySnapshot.measured_kwh) {
        validationErrors.push(`total_kwh mismatch: report row (${reportRow.total_kwh}) vs energy snapshot (${energySnapshot.measured_kwh})`);
      }
      
      const maxDev = deviceSnapshots.reduce((max, ds) => (!max || ds.measured_kwh > max.measured_kwh) ? ds : max, null);
      if (maxDev) {
        if (reportRow.top_device_id !== maxDev.device_id || reportRow.top_device_kwh !== maxDev.measured_kwh) {
          validationErrors.push(`top device mismatch: report (${reportRow.top_device_id}, ${reportRow.top_device_kwh}) vs device snapshots (${maxDev.device_id}, ${maxDev.measured_kwh})`);
        }
      } else {
        if (reportRow.top_device_id !== null || reportRow.top_device_kwh !== 0) {
          validationErrors.push(`top device mismatch: expected null/0 but got (${reportRow.top_device_id}, ${reportRow.top_device_kwh})`);
        }
      }

      if (
        reportRow.cycle_measured_kwh_after !== cycle_measured_kwh_after ||
        reportRow.cycle_measured_kwh_before !== cycle_measured_kwh_before ||
        reportRow.cycle_estimated_after !== cycle_estimated_after ||
        reportRow.cycle_estimated_before !== cycle_estimated_before
      ) {
        validationErrors.push(`billing values mismatch`);
      }

      if (!reportRow.weather_context) {
        validationErrors.push(`weather context does not exist`);
      }
      if (!reportRow.tip_text) {
        validationErrors.push(`tip text does not exist`);
      }
      if (!reportRow.whatsapp_message) {
        validationErrors.push(`WhatsApp message does not exist`);
      }

      if (validationErrors.length > 0) {
        console.error(`[ERROR] Report validation failed for household ${householdId}:`, validationErrors.join('; '));
        reportRow.has_incomplete_data = true;
      } else {
        console.log(`[INFO] Report validation passed for household ${householdId}.`);
      }

      // Task 6: Preserve existing delivery_status unless inserting new
      let reportId = null;
      if (existingReport) {
        reportRow.delivery_status = existingReport.delivery_status || 'pending';
        
        console.log(`[INFO] Updating existing daily report for household ${householdId} on date ${snapshotDate}...`);
        const { error: updateReportErr } = await supabase
          .from('daily_reports')
          .update(reportRow)
          .eq('id', existingReport.id);

        if (updateReportErr) {
          console.error(`[ERROR] Failed to update daily_report:`, updateReportErr.message);
          results.push({ householdId, status: 'error', error: updateReportErr.message });
          continue;
        }
        console.log(`[INFO] Daily report updated successfully for household ${householdId}.`);
        reportId = existingReport.id;
      } else {
        reportRow.delivery_status = 'pending';

        console.log(`[INFO] Inserting new daily report for household ${householdId} on date ${snapshotDate}...`);
        const { data: insertedData, error: insertReportErr } = await supabase
          .from('daily_reports')
          .insert([reportRow])
          .select('id')
          .single();

        if (insertReportErr) {
          console.error(`[ERROR] Failed to insert daily_report:`, insertReportErr.message);
          results.push({ householdId, status: 'error', error: insertReportErr.message });
          continue;
        }
        console.log(`[INFO] Daily report inserted successfully for household ${householdId}.`);
        reportId = insertedData?.id;
      }
      console.log('[INFO] Daily Report Generated');

      // Invoke Delivery Layer
      if (reportId) {
        const deliveryResult = await sendDailyReport(reportId);
        const { message, payload, ...summary } = deliveryResult;
        console.log(`[INFO] Delivery Layer response:`, JSON.stringify(summary, null, 2));
      }

      console.log(`[INFO] Snapshot created successfully for date ${snapshotDate} and household ${householdId}.`);
      results.push({ householdId, status: 'success', snapshotDate });
    } catch (reportGenErr) {
      console.error(`[ERROR] Exception during daily report generation for household ${householdId}:`, reportGenErr.message);
      results.push({ householdId, status: 'error', error: reportGenErr.message });
      continue;
    }
  }
  console.log('[INFO] Scheduler Finished');

  return results;
}
