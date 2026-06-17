import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getSlabs, calculateTNEBBill } from '../utils/tariff'

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setMonth(d.getMonth() + months)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dateDay = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dateDay}`
}

function getInitialCycleDates(currentDateStr) {
  const now = new Date(currentDateStr + 'T00:00:00')
  let year = now.getFullYear()
  let month = now.getMonth()
  
  if (now.getDate() < 28) {
    month -= 1
    if (month < 0) {
      month = 11
      year -= 1
    }
  }
  
  if (month % 2 !== 0) {
    month -= 1
    if (month < 0) {
      month = 10
      year -= 1
    }
  }
  
  const cycleStart = `${year}-${String(month + 1).padStart(2, '0')}-28`
  const cycleEnd = addMonths(cycleStart, 2)
  return { cycleStart, cycleEnd }
}


// ── IST helpers ───────────────────────────────────────────────────────────────

// Returns a YYYY-MM-DD string representing the "active day" in IST,
// where a day starts at 6:00 AM IST (not midnight).
// e.g. May 18 03:00 IST → returns '2026-05-17'
//      May 18 07:00 IST → returns '2026-05-18'
function getActiveDateStr() {
  const now = new Date()
  // Interpret current wall-clock time in IST
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  // Before 6 AM IST → still the previous calendar day
  if (istNow.getHours() < 6) {
    istNow.setDate(istNow.getDate() - 1)
  }
  const y = istNow.getFullYear()
  const m = String(istNow.getMonth() + 1).padStart(2, '0')
  const d = String(istNow.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Convert any date to a local YYYY-MM-DD string (no timezone shift)
function toLocalISO(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// Convert an ISO timestamp string to its IST date (YYYY-MM-DD)
function toISTDate(iso) {
  if (!iso) return null
  const d = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  return toLocalISO(d)
}

// Returns the 6 AM IST boundary for a given YYYY-MM-DD date string as a UTC Date
// e.g. '2026-05-17' → May 17 00:30 UTC (= May 17 06:00 IST)
function dayWindowStart(dateStr) {
  return new Date(`${dateStr}T00:30:00Z`)
}

// ── Weekly window helpers ─────────────────────────────────────────────────────

// Given a YYYY-MM-DD active date string, returns the Mon 6AM→Mon 6AM window
function getWeekWindow(activeDateStr) {
  // Treat active date as 6 AM IST on that day
  const activeDate = new Date(`${activeDateStr}T06:00:00+05:30`)
  const day = activeDate.getDay() // 0=Sun, 1=Mon …
  const diff = day === 0 ? -6 : 1 - day   // roll back to Monday
  const monday = new Date(activeDate)
  monday.setDate(activeDate.getDate() + diff)
  monday.setHours(0, 0, 0, 0)

  // Monday 6:00 AM IST = Monday 00:30 UTC
  const weekStart = new Date(monday)
  weekStart.setUTCHours(0, 30, 0, 0)

  // Next Monday 6:00 AM IST
  const nextMonday = new Date(monday)
  nextMonday.setDate(monday.getDate() + 7)
  const weekEnd = new Date(nextMonday)
  weekEnd.setUTCHours(0, 30, 0, 0)

  return { weekStart, weekEnd, monday, nextMonday }
}

// ── Hook ───────────────────────────────────────────────────
export function useHomeData(householdId, viewMode = 'Daily', selectedDate = null) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!householdId) return
    fetchAll()
  }, [householdId, viewMode, selectedDate])

  async function fetchAll() {
    setLoading(true)
    setData(null)
    setError(null)

    try {
      // ── 1. Compute active date (respects 6 AM IST boundary) ──────────────
      const currentDateStr = selectedDate ?? getActiveDateStr()

      // ── 2. Get active billing cycle first ───────────────────────────────
      let { data: activeCycle } = await supabase
        .from('billing_cycle_summary')
        .select('*')
        .eq('household_id', householdId)
        .lte('cycle_start', currentDateStr)
        .gt('cycle_end', currentDateStr)
        .maybeSingle()

      const isExpired = activeCycle && currentDateStr >= activeCycle.cycle_end

      if (isExpired || !activeCycle) {
        const { data: latestCycle } = await supabase
          .from('billing_cycle_summary')
          .select('*')
          .eq('household_id', householdId)
          .order('cycle_end', { ascending: false })
          .limit(1)
          .maybeSingle()

        let currentStart, currentEnd
        if (latestCycle) {
          if (currentDateStr >= latestCycle.cycle_end) {
            currentStart = latestCycle.cycle_end
            currentEnd = addMonths(currentStart, 2)
            while (currentDateStr >= currentEnd) {
              currentStart = currentEnd
              currentEnd = addMonths(currentStart, 2)
            }
          } else {
            currentStart = latestCycle.cycle_start
            currentEnd = latestCycle.cycle_end
          }
        } else {
          const dates = getInitialCycleDates(currentDateStr)
          currentStart = dates.cycleStart
          currentEnd = dates.cycleEnd
        }

        const { data: existingCycle } = await supabase
          .from('billing_cycle_summary')
          .select('*')
          .eq('household_id', householdId)
          .eq('cycle_start', currentStart)
          .eq('cycle_end', currentEnd)
          .maybeSingle()

        if (existingCycle) {
          activeCycle = existingCycle
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
          }

          const { data: inserted, error: insertError } = await supabase
            .from('billing_cycle_summary')
            .insert(newCycle)
            .select()
            .single()

          if (!insertError && inserted) {
            activeCycle = inserted
          } else {
            console.error("Failed to insert new cycle:", insertError)
            activeCycle = { ...newCycle, id: 'temp-new-cycle' }
          }
        }
      }

      // ── 3. Date & Window Calculations using activeCycle dates ────────────
      const cycleStartIST = dayWindowStart(activeCycle.cycle_start)
      const windowStart = dayWindowStart(currentDateStr)
      const nextDay = new Date(windowStart)
      nextDay.setDate(nextDay.getDate() + 1)
      const now = new Date()
      const windowEnd = nextDay < now ? nextDay : now

      const { weekStart, weekEnd, monday, nextMonday } = getWeekWindow(currentDateStr)
      const weekStartReportStr = toLocalISO(monday)
      const weekEndReportStr   = toLocalISO(new Date(nextMonday.getTime() - 24 * 60 * 60 * 1000))

      const rollingStartDate = new Date(`${currentDateStr}T00:00:00+05:30`)
      rollingStartDate.setDate(rollingStartDate.getDate() - 13)
      const rollingStartStr = toLocalISO(rollingStartDate)

      const minDate = [activeCycle.cycle_start, weekStartReportStr, rollingStartStr].sort()[0]
      const maxDate = [currentDateStr, weekEndReportStr, activeCycle?.cycle_end || currentDateStr].sort().reverse()[0]

      // ── 4. Parallel Queries ───────────────────────────────────────────────
      const [
        todayReportResult,
        energySnapshotsResult,
        deviceSnapshotsResult,
        allLastCompletedResult,
        allOpenSessionsResult,
        readingsForMetaResult,
        weeklyHistoryResult
      ] = await Promise.all([
        supabase
          .from('daily_reports')
          .select('*')
          .eq('household_id', householdId)
          .eq('report_date', currentDateStr)
          .maybeSingle(),

        supabase
          .from('daily_energy_snapshots')
          .select('*')
          .eq('household_id', householdId)
          .gte('snapshot_date', minDate)
          .lte('snapshot_date', maxDate)
          .order('snapshot_date', { ascending: true }),

        supabase
          .from('daily_device_snapshots')
          .select('*')
          .eq('household_id', householdId)
          .gte('snapshot_date', minDate)
          .lte('snapshot_date', maxDate)
          .order('snapshot_date', { ascending: true }),

        supabase
          .from('appliance_readings')
          .select('*')
          .eq('household_id', householdId)
          .not('session_end', 'is', null)
          .order('device_id')
          .order('session_start', { ascending: false }),

        supabase
          .from('appliance_readings')
          .select('*')
          .eq('household_id', householdId)
          .is('session_end', null)
          .order('device_id')
          .order('session_start', { ascending: false }),

        supabase
          .from('appliance_readings')
          .select('device_id, device_name, device_type')
          .eq('household_id', householdId),

        supabase
          .from('daily_reports')
          .select('*')
          .eq('household_id', householdId)
          .gte('report_date', weekStartReportStr)
          .lte('report_date', weekEndReportStr)
          .order('report_date', { ascending: true })
      ])

      // ── 5. Build device-name map ──────────────────────────────────────────
      const deviceNameMap = {}
      const readingsForMeta = readingsForMetaResult.data || []
      readingsForMeta.forEach(r => {
        if (r.device_id && !deviceNameMap[r.device_id]) {
          deviceNameMap[r.device_id] = {
            name: r.device_name || r.device_id,
            type: r.device_type || 'others'
          }
        }
      })

      const energySnapshots = energySnapshotsResult.data || []
      const deviceSnapshots = deviceSnapshotsResult.data || []
      console.log('RAW SNAPSHOT DEVICES', deviceSnapshots)
      const latestReport = todayReportResult.data || null

      const hasSnapshot = energySnapshots.some(s => s.snapshot_date === currentDateStr)

      // ── 6. Construct dailyCosts from energySnapshots ─────────────────────
      const dailyCosts = []
      energySnapshots.forEach(s => {
        const isToday = s.snapshot_date === currentDateStr
        dailyCosts.push({
          report_date: s.snapshot_date,
          measured_kwh: parseFloat(s.measured_kwh || 0),
          estimated_kwh: parseFloat(s.estimated_kwh || 0),
          daily_cost: parseFloat(s.cost || 0),
          is_today: isToday,
          sessions: new Array(s.total_sessions || 0).fill({})
        })
      })

      const hasCurrentDate = dailyCosts.some(d => d.report_date === currentDateStr)
      if (!hasCurrentDate) {
        dailyCosts.push({
          report_date: currentDateStr,
          measured_kwh: 0,
          estimated_kwh: 0,
          daily_cost: 0,
          is_today: true,
          sessions: []
        })
      }

      const selectedDaySnapshot = energySnapshots.find(s => s.snapshot_date === currentDateStr) || {
        measured_kwh: 0,
        estimated_kwh: 0,
        cost: 0,
        total_sessions: 0,
        total_duration_minutes: 0,
        slab_name: 'Free',
        tariff_version: 'TN_NEW_2026'
      }
      const activeDayCost = parseFloat(selectedDaySnapshot.cost || 0)

      // Helper to generate a range of date strings (YYYY-MM-DD) inclusive
      function getDatesInRange(startStr, endStr) {
        const dates = []
        const start = new Date(startStr + 'T00:00:00')
        const end = new Date(endStr + 'T00:00:00')
        const current = new Date(start)
        while (current <= end) {
          dates.push(toLocalISO(current))
          current.setDate(current.getDate() + 1)
        }
        return dates
      }

      // ── 7. Aggregations per view mode ─────────────────────────────────────
      let displayKwh = 0
      let kwhAccumulated = 0
      let estimatedFullHomeKwh = 0
      let weeklyKwh = 0
      let weeklyCost = 0
      let billingCycleCost = 0
      let totalHomeSessions = 0
      let hasMoreDevices = false

      // 7a. Weekly Aggregation
      const weekDates = getDatesInRange(toLocalISO(monday), toLocalISO(new Date(nextMonday.getTime() - 24 * 60 * 60 * 1000)))
      const weekEnergySnapshots = energySnapshots.filter(s => weekDates.includes(s.snapshot_date))
      const weeklyMeasured = weekEnergySnapshots.reduce((sum, s) => sum + parseFloat(s.measured_kwh || 0), 0)
      const weeklyEstimated = weekEnergySnapshots.reduce((sum, s) => sum + parseFloat(s.estimated_kwh || 0), 0)
      weeklyCost = weekEnergySnapshots.reduce((sum, s) => sum + parseFloat(s.cost || 0), 0)
      const weeklySessions = weekEnergySnapshots.reduce((sum, s) => sum + parseInt(s.total_sessions || 0), 0)

      const periodEnergySnapshots = weekEnergySnapshots;
      console.log('WEEKLY SNAPSHOTS USED', {
        startDate: weekStart,
        endDate: currentDateStr,
        snapshots: periodEnergySnapshots.map(s => ({
          date: s.snapshot_date,
          kwh: s.measured_kwh
        })),
        total: periodEnergySnapshots.reduce(
          (sum, s) => sum + Number(s.measured_kwh || 0),
          0
        )
      })

      // 7b. Billing Cycle Aggregation
      const cycleEnergySnapshots = energySnapshots.filter(s => s.snapshot_date >= activeCycle.cycle_start && s.snapshot_date <= activeCycle.cycle_end)
      const billingMeasured = cycleEnergySnapshots.reduce((sum, s) => sum + parseFloat(s.measured_kwh || 0), 0)
      const billingEstimated = cycleEnergySnapshots.reduce((sum, s) => sum + parseFloat(s.estimated_kwh || 0), 0)
      billingCycleCost = cycleEnergySnapshots.reduce((sum, s) => sum + parseFloat(s.cost || 0), 0)
      const billingSessions = cycleEnergySnapshots.reduce((sum, s) => sum + parseInt(s.total_sessions || 0), 0)

      console.log('BILLING CYCLE SNAPSHOTS USED', {
        cycleStart: activeCycle?.cycle_start,
        cycleEnd: activeCycle?.cycle_end,
        selectedDate: currentDateStr,
        snapshotCount: cycleEnergySnapshots.length,
        totalMeasured: cycleEnergySnapshots.reduce(
          (sum, s) => sum + Number(s.measured_kwh || 0),
          0
        ),
        firstDate: cycleEnergySnapshots[0]?.snapshot_date,
        lastDate:
          cycleEnergySnapshots[cycleEnergySnapshots.length - 1]?.snapshot_date
      })

      if (viewMode === 'Daily') {
        displayKwh = parseFloat(selectedDaySnapshot.measured_kwh || 0)
        estimatedFullHomeKwh = parseFloat(selectedDaySnapshot.estimated_kwh || 0)
        totalHomeSessions = parseInt(selectedDaySnapshot.total_sessions || 0)
      } else if (viewMode === 'Weekly') {
        displayKwh = weeklyMeasured
        weeklyKwh = weeklyMeasured
        estimatedFullHomeKwh = weeklyEstimated
        totalHomeSessions = weeklySessions
      } else {
        // Billing Cycle
        displayKwh = billingMeasured
        kwhAccumulated = billingMeasured
        estimatedFullHomeKwh = billingEstimated
        totalHomeSessions = billingSessions
      }

      // ── 8. Aggregate devices for selected period ─────────────────────────
      let periodDeviceSnapshots = []
      if (viewMode === 'Daily') {
        if (hasSnapshot) {
          periodDeviceSnapshots = deviceSnapshots.filter(s => s.snapshot_date === currentDateStr)
        } else {
          periodDeviceSnapshots = []
        }
      } else if (viewMode === 'Weekly') {
        periodDeviceSnapshots = deviceSnapshots.filter(s => weekDates.includes(s.snapshot_date))
      } else {
        periodDeviceSnapshots = deviceSnapshots.filter(s => s.snapshot_date >= activeCycle.cycle_start && s.snapshot_date <= activeCycle.cycle_end)
      }

      const aggregatedDevices = {}
      const weekTemplate = []
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday)
        d.setDate(monday.getDate() + i)
        weekTemplate.push({ date: toLocalISO(d), day: dayNames[d.getDay()], kwh: 0, mins: 0 })
      }

      for (const s of periodDeviceSnapshots) {
        const id = s.device_id
        if (!aggregatedDevices[id]) {
          const metaName = s.device_name || deviceNameMap[id]?.name || id
          const metaType = s.device_type || deviceNameMap[id]?.type || 'others'
          aggregatedDevices[id] = {
            device_id: id,
            name: metaName,
            type: metaType,
            floor: s.floor || null,
            room: s.room || null,
            kwh: 0,
            minutes: 0,
            session_count: 0,
            cost: 0,
            weekData: JSON.parse(JSON.stringify(weekTemplate))
          }
        }
        const kwhVal = parseFloat(s.measured_kwh || 0)
        const minsVal = parseInt(s.total_duration_minutes || 0)
        aggregatedDevices[id].kwh += kwhVal
        aggregatedDevices[id].minutes += minsVal
        aggregatedDevices[id].session_count += parseInt(s.total_sessions || 0)
        aggregatedDevices[id].cost += parseFloat(s.cost || 0)

        const bar = aggregatedDevices[id].weekData.find(w => w.date === s.snapshot_date)
        if (bar) {
          bar.kwh += kwhVal
          bar.mins += minsVal
        }
      }

      const devices = Object.values(aggregatedDevices)
        .sort((a, b) => b.kwh - a.kwh)

      console.log('TEMPORARY LOGS:', {
        selectedDate: currentDateStr,
        currentDateStr,
        periodDeviceSnapshotsLength: periodDeviceSnapshots.length,
        devicesLength: devices.length,
        firstDeviceSnapshotRecord: periodDeviceSnapshots[0] || null
      });

      hasMoreDevices = devices.length > 3

      const allLastCompleted = {}
      if (allLastCompletedResult.data) {
        allLastCompletedResult.data.forEach(s => { if (!allLastCompleted[s.device_id]) allLastCompleted[s.device_id] = s })
      }
      const allOpenSessions = {}
      if (allOpenSessionsResult.data) {
        allOpenSessionsResult.data.forEach(s => { if (!allOpenSessions[s.device_id]) allOpenSessions[s.device_id] = s })
      }

      devices.forEach(d => {
        d.totalKwh = d.kwh
        d.totalSessions = d.session_count
        d.totalMins = d.minutes
        d.lastCompleted = allLastCompleted[d.device_id] || null
        d.openSession = allOpenSessions[d.device_id] || null
        if (d.openSession) d.is_currently_active = true
      })

      // ── 9. Misc derived values ───────────────────────────────────────────
      const historySnapshots = energySnapshots
        .filter(s => s.snapshot_date < currentDateStr)
        .sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date))

      const last7Days = historySnapshots.slice(0, 7)
      const nonZeroLast7 = last7Days.filter(s => parseFloat(s.measured_kwh || 0) > 0)
      const avg7DayKwh = nonZeroLast7.length >= 3
        ? nonZeroLast7.reduce((sum, s) => sum + parseFloat(s.measured_kwh || 0), 0) / nonZeroLast7.length
        : 0

      const lastWeekKwh = historySnapshots.slice(7, 14).reduce((sum, s) => sum + parseFloat(s.measured_kwh || 0), 0)

      const belowThreshold = avg7DayKwh > 0 ? avg7DayKwh * 0.75 : 0
      const aboveThreshold = avg7DayKwh > 0 ? avg7DayKwh * 1.25 : 0

      const _cycleStartDate  = new Date(activeCycle?.cycle_start ?? currentDateStr)
      const _todayDateForAvg = new Date(currentDateStr)
      const _daysElapsed     = Math.max(1, Math.ceil((_todayDateForAvg - _cycleStartDate) / (1000 * 60 * 60 * 24)))
      const cycleDailyAvg    = _daysElapsed > 0 ? billingMeasured / _daysElapsed : 0

      // ── 10. Slab Calculation (TNEB) ──────────────────────────────────────
      const kwhEstimated = billingEstimated
      const generateSlabStatus = (measured, estimated) => {
        const slabs = getSlabs(estimated)

        let currentSlabIdx = slabs.findIndex(s => estimated < s.max)
        if (currentSlabIdx === -1) currentSlabIdx = slabs.length - 1

        return slabs.map((s, idx) => {
          const prevLimit = idx === 0 ? 0 : slabs[idx - 1].max
          const slabMeasured = Math.max(0, Math.min(measured - prevLimit, s.max - prevLimit))
          const fillPct = Math.round((slabMeasured / (s.max - prevLimit)) * 100)
          const range = s.max >= 99999 ? `${s.min - 1}+` : `${s.min}–${s.max}`
          return {
            name: `Slab ${s.num}`,
            range,
            rate: s.label,
            limit: s.max,
            color: s.color,
            active: idx === currentSlabIdx,
            status: idx < currentSlabIdx ? 'Done ✓' : (idx === currentSlabIdx ? 'Now' : range),
            fillPct
          }
        })
      }

      const slabStatus  = generateSlabStatus(billingMeasured, billingEstimated)
      const currentSlab = slabStatus.find(s => s.active)

      const cycleEndDate   = activeCycle?.cycle_end ? new Date(activeCycle.cycle_end) : null
      const nowForCycle    = new Date()
      const cycleDisplayEnd = (cycleEndDate && nowForCycle < cycleEndDate) ? nowForCycle : cycleEndDate
      const cycleDaysLeft   = cycleEndDate
        ? Math.max(0, Math.ceil((cycleEndDate - nowForCycle) / (1000 * 60 * 60 * 24)))
        : 0

      let weather = null
      try { weather = typeof latestReport?.weather_context === 'string' ? JSON.parse(latestReport.weather_context) : (latestReport?.weather_context ?? null) } catch (e) {}

      // ── 11. Set data ──────────────────────────────────────────────────────
      console.log('FINAL WEEKLY MEASURED', weeklyMeasured)
      console.log('FINAL BILLING MEASURED', billingMeasured)
      console.log('FINAL DISPLAY KWH', displayKwh)
      console.log('RETURN DEVICES', devices);
      setData({
        today: {
          total_kwh: displayKwh,
          live_kwh: (dailyCosts.find(d => d.report_date === getActiveDateStr())?.measured_kwh || 0),
          live_sessions: (dailyCosts.find(d => d.report_date === getActiveDateStr())?.sessions?.length || 0),
          session_count: totalHomeSessions,
          devices,
          hasMoreDevices,
          open_sessions: (allOpenSessionsResult.data || [])
            .map(s => ({
              device_id: s.device_id,
              name: deviceNameMap[s.device_id]?.name || s.device_id,
              started_ist: new Date(s.session_start).toLocaleTimeString('en-IN', {
                hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata'
              })
            })),
          estimated_full_home_kwh: estimatedFullHomeKwh,
          daily_estimated_full_home_kwh: (dailyCosts.find(d => d.report_date === getActiveDateStr())?.estimated_kwh || 0),
          estimated_cost_inr: activeDayCost,
          daily_cost: activeDayCost,
          slab_name: selectedDaySnapshot.slab_name || 'Free',
          weekly_cost: weeklyCost,
          report_date: currentDateStr,
          as_of_ist: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
          avg_7day_kwh:    parseFloat(avg7DayKwh.toFixed(2)),
          last_week_kwh:   parseFloat(lastWeekKwh.toFixed(2)),
          cycle_daily_avg: parseFloat(cycleDailyAvg.toFixed(2)),
          below_threshold: parseFloat(belowThreshold.toFixed(2)),
          above_threshold: parseFloat(aboveThreshold.toFixed(2)),
        },
        billing: {
          kwh_accumulated: billingMeasured,
          kwh_estimated: billingEstimated,
          cycle_start: activeCycle?.cycle_start,
          cycle_end: activeCycle?.cycle_end,
          cycle_display_end: cycleDisplayEnd,
          cycle_days_left: cycleDaysLeft,
          slab_status: slabStatus,
          current_slab_name: currentSlab?.name || selectedDaySnapshot.slab_name || 'Free',
          current_slab_rate: currentSlab?.rate || 0,
          billing_cycle_cost: billingCycleCost
        },
        weekWindow: { monday, nextMonday },
        weather,
        report: latestReport,
        history: weeklyHistoryResult.data || [],
        dailyCosts
      })
      console.log('SETDATA TOTAL_KWH', displayKwh)

    } catch (err) {
      setError(err)
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return { data, loading, error, refetch: fetchAll }
}