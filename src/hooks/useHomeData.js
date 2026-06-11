import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getSlabs } from '../utils/tariff'

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

// ── Hook ──────────────────────────────────────────────────────────────────────

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
      // If a selectedDate is passed (Energy page navigating history), use it
      // directly; otherwise derive from the 6 AM boundary rule.
      const currentDateStr = selectedDate ?? getActiveDateStr()

      // ── 2. Live-window boundaries ─────────────────────────────────────────
      // Daily window: activeDate 6 AM IST → now (always live)
      const windowStart = dayWindowStart(currentDateStr)  // Mon 00:30 UTC
      const windowEnd   = new Date()                       // right now

      // ── 3. Weekly window ──────────────────────────────────────────────────
      const { weekStart, weekEnd, monday, nextMonday } = getWeekWindow(currentDateStr)
      const weekStartReportStr = toLocalISO(monday)
      // Include Mon → Sun in daily_reports (nextMonday - 1 day = Sunday)
      const weekEndReportStr   = toLocalISO(new Date(nextMonday.getTime() - 24 * 60 * 60 * 1000))

      // ── 4. Rolling 14-day window (for device-name pre-fetch map) ─────────
      const rollingStartDate = new Date(`${currentDateStr}T00:00:00+05:30`)
      rollingStartDate.setDate(rollingStartDate.getDate() - 13)
      const rollingStartStr = toLocalISO(rollingStartDate)
      const rollingEndStr   = currentDateStr

      // ── 5. Parallel Queries ───────────────────────────────────────────────
      const [
        todayReportResult,
        weeklyHistoryResult,
        billingCycleResult,
        dailySessionsResult,    // live sessions inside the 6AM→now window
        allLastCompletedResult,
        allOpenSessionsResult,
        weeklySessionsResult,   // sessions inside Mon 6AM → Mon 6AM window
        rollingReportsResult,   // 14-day rolling reports for device-name map
      ] = await Promise.all([
        // Today's finalized report (may not exist yet if before midnight batch)
        supabase
          .from('daily_reports')
          .select('*')
          .eq('household_id', householdId)
          .eq('report_date', currentDateStr)
          .maybeSingle(),

        // Weekly daily_reports: Mon → Sun of current week
        supabase
          .from('daily_reports')
          .select('*')
          .eq('household_id', householdId)
          .gte('report_date', weekStartReportStr)
          .lte('report_date', weekEndReportStr)
          .order('report_date', { ascending: true }),

        // Billing cycle summary
        supabase
          .from('billing_cycle_summary')
          .select('*')
          .eq('household_id', householdId)
          .lte('cycle_start', currentDateStr)
          .gt('cycle_end', currentDateStr)
          .maybeSingle(),

        // Live sessions: active-day 6 AM IST → now (always fetch — daily window)
        supabase
          .from('appliance_readings')
          .select('*')
          .eq('household_id', householdId)
          .gte('session_start', windowStart.toISOString())
          .lte('session_start', windowEnd.toISOString()),

        // All last-completed sessions per device (for device metadata)
        supabase
          .from('appliance_readings')
          .select('*')
          .eq('household_id', householdId)
          .not('session_end', 'is', null)
          .order('device_id')
          .order('session_start', { ascending: false }),

        // Currently open sessions
        supabase
          .from('appliance_readings')
          .select('*')
          .eq('household_id', householdId)
          .is('session_end', null)
          .order('device_id')
          .order('session_start', { ascending: false }),

        // Weekly sessions: Mon 6AM IST (inclusive) → next Mon 6AM IST (exclusive)
        supabase
          .from('appliance_readings')
          .select('*')
          .eq('household_id', householdId)
          .gte('session_start', weekStart.toISOString())
          .lt('session_start', weekEnd.toISOString())
          .order('session_start', { ascending: false }),

        // 14-day rolling reports for building device-name map
        supabase
          .from('daily_reports')
          .select('*')
          .eq('household_id', householdId)
          .gte('report_date', rollingStartStr)
          .lte('report_date', rollingEndStr)
          .order('report_date', { ascending: true }),
      ])

      // ── 6. Build device-name map from all available reports ──────────────
      const deviceNameMap = {}
      const fillMeta = (bd) => {
        const devs = bd.today || bd.by_device || bd.by_type || {}
        Object.entries(devs).forEach(([id, d]) => {
          if (!deviceNameMap[id]) deviceNameMap[id] = { name: d.name, type: d.type }
        })
      }
      rollingReportsResult.data?.forEach(r => {
        try { fillMeta(typeof r.device_type_breakdown === 'string' ? JSON.parse(r.device_type_breakdown) : (r.device_type_breakdown || {})) } catch (e) {}
      })
      weeklyHistoryResult.data?.forEach(r => {
        try { fillMeta(typeof r.device_type_breakdown === 'string' ? JSON.parse(r.device_type_breakdown) : (r.device_type_breakdown || {})) } catch (e) {}
      })
      if (todayReportResult.data) {
        try { fillMeta(typeof todayReportResult.data.device_type_breakdown === 'string' ? JSON.parse(todayReportResult.data.device_type_breakdown) : todayReportResult.data.device_type_breakdown) } catch (e) {}
      }

      // Sessions by device (used for weekData per device)
      const sessionsByDevice = {}
      if (weeklySessionsResult.data) {
        weeklySessionsResult.data.forEach(s => {
          if (!sessionsByDevice[s.device_id]) sessionsByDevice[s.device_id] = []
          if (sessionsByDevice[s.device_id].length < 15) sessionsByDevice[s.device_id].push(s)
        })
      }

      const allLastCompleted = {}
      if (allLastCompletedResult.data) {
        allLastCompletedResult.data.forEach(s => { if (!allLastCompleted[s.device_id]) allLastCompleted[s.device_id] = s })
      }
      const allOpenSessions = {}
      if (allOpenSessionsResult.data) {
        allOpenSessionsResult.data.forEach(s => { if (!allOpenSessions[s.device_id]) allOpenSessions[s.device_id] = s })
      }

      // ── Billing Cycle Rollover and Dynamic Aggregation ─────────────────────
      let activeCycle = billingCycleResult.data
      const isExpired = activeCycle && currentDateStr >= activeCycle.cycle_end

      if (isExpired || !activeCycle) {
        // Fetch the latest cycle overall to do rollover or find initial dates
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

        // Only insert if it is a new/future cycle not in the database yet
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

      // Fetch daily reports in the active cycle to calculate accumulated kWh dynamically
      const cycleReportsResult = activeCycle?.cycle_start
        ? await supabase
            .from('daily_reports')
            .select('*')
            .eq('household_id', householdId)
            .gte('report_date', activeCycle.cycle_start)
            .lte('report_date', currentDateStr)
        : { data: [] }

      const cycleReports = cycleReportsResult.data || []
      const kwhAccumulated = cycleReports.reduce((sum, r) => sum + parseFloat(r.total_kwh || 0), 0)

      // ── 7. Aggregation per view mode ──────────────────────────────────────
      let devices = []
      let liveTodayKwh = 0   // measured kWh from live session window
      let weeklyKwh = 0      // measured kWh for the whole week
      let displayKwh = 0
      let totalHomeSessions = 0

      // ── Daily ─────────────────────────────────────────────────────────────
      if (viewMode === 'Daily') {
        const aggregated = {}
        const finalReport = todayReportResult.data

        // Seed from finalized report (if exists)
        if (finalReport) {
          const bd = typeof finalReport.device_type_breakdown === 'string'
            ? JSON.parse(finalReport.device_type_breakdown)
            : finalReport.device_type_breakdown
          const devs = bd.today || bd.by_device || bd.by_type || {}
          Object.entries(devs).forEach(([id, d]) => {
            const resolvedName = deviceNameMap[id]?.name || d.name
            if (!resolvedName || resolvedName === id) return
            aggregated[id] = {
              device_id: id, name: resolvedName, type: d.type || 'others',
              kwh: parseFloat(d.kwh || 0), minutes: parseInt(d.minutes || 0, 10),
              session_count: parseInt(d.sessions || 0, 10)
            }
          })
          totalHomeSessions = parseInt(finalReport.total_sessions || 0, 10)
        }

        // Overlay live sessions (6 AM IST → now) — always, since window is always live
        if (dailySessionsResult.data) {
          dailySessionsResult.data.forEach(s => {
            const id = s.device_id
            const resolvedName = deviceNameMap[id]?.name
            if (!resolvedName || resolvedName === id) return
            if (!aggregated[id]) aggregated[id] = {
              device_id: id, name: resolvedName, type: deviceNameMap[id]?.type || 'others',
              kwh: 0, minutes: 0, session_count: 0
            }
            aggregated[id].kwh += parseFloat(s.kwh_consumed || 0)
            aggregated[id].minutes += parseInt(s.duration_minutes || 0, 10)
            aggregated[id].session_count += 1
          })
          totalHomeSessions = dailySessionsResult.data.length
        }

        devices = Object.values(aggregated)
          .filter(d => d.kwh > 0.001 || d.minutes > 0)
          .sort((a, b) => b.kwh - a.kwh)

        liveTodayKwh = devices.reduce((s, d) => s + d.kwh, 0)
        displayKwh = liveTodayKwh

      // ── Weekly ────────────────────────────────────────────────────────────
      } else if (viewMode === 'Weekly') {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        const weekTemplate = []
        for (let i = 0; i < 7; i++) {
          const d = new Date(monday)
          d.setDate(monday.getDate() + i)
          weekTemplate.push({ date: toLocalISO(d), day: dayNames[d.getDay()], kwh: 0, mins: 0 })
        }

        const aggregated = {}
        if (weeklySessionsResult.data) {
          weeklySessionsResult.data.forEach(s => {
            const istDate = toISTDate(s.session_start)
            const id = s.device_id
            const resolvedName = deviceNameMap[id]?.name
            if (!resolvedName || resolvedName === id) return
            if (!aggregated[id]) {
              aggregated[id] = {
                device_id: id, name: resolvedName, type: deviceNameMap[id]?.type || 'others',
                kwh: 0, minutes: 0, session_count: 0, sessions: sessionsByDevice[id] || [],
                weekData: JSON.parse(JSON.stringify(weekTemplate))
              }
            }
            const kwh = parseFloat(s.kwh_consumed || 0)
            const mins = parseInt(s.duration_minutes || 0, 10)
            aggregated[id].kwh += kwh
            aggregated[id].minutes += mins
            aggregated[id].session_count += 1
            const bar = aggregated[id].weekData.find(w => w.date === istDate)
            if (bar) { bar.kwh += kwh; bar.mins += mins }
          })
        }

        // Weekly kWh = sum of daily reports for the week + any live sessions today not yet in a report
        weeklyKwh = (weeklyHistoryResult.data || []).reduce((s, r) => s + parseFloat(r.total_kwh || 0), 0)
        // If today's report isn't finalized yet, add live session kWh
        if (!todayReportResult.data && dailySessionsResult.data) {
          weeklyKwh += dailySessionsResult.data.reduce((s, x) => s + parseFloat(x.kwh_consumed || 0), 0)
        }

        displayKwh = weeklyKwh
        totalHomeSessions = Object.values(aggregated).reduce((s, d) => s + d.session_count, 0)
        devices = Object.values(aggregated).filter(d => d.kwh > 0.01 || d.minutes > 0).sort((a, b) => b.kwh - a.kwh)

      // ── Billing Cycle ─────────────────────────────────────────────────────
      } else if (viewMode === 'Billing Cycle') {
        const billingAggregated = {}
        let bSessions = 0
        cycleReports.forEach(report => {
          bSessions += parseInt(report.total_sessions || 0, 10)
          let bd = {}
          try { bd = typeof report.device_type_breakdown === 'string' ? JSON.parse(report.device_type_breakdown) : (report.device_type_breakdown || {}) } catch (e) { return }
          const devs = bd.today || bd.by_device || bd.by_type || {}
          Object.entries(devs).forEach(([id, d]) => {
            const resolvedName = deviceNameMap[id]?.name || d.name
            if (!resolvedName || resolvedName === id) return
            if (!billingAggregated[id]) billingAggregated[id] = { device_id: id, name: resolvedName, type: d.type || 'others', kwh: 0, minutes: 0, session_count: 0 }
            billingAggregated[id].kwh += parseFloat(d.kwh || 0)
            billingAggregated[id].minutes += parseInt(d.minutes || 0, 10)
            billingAggregated[id].session_count += parseInt(d.sessions || 0, 10)
          })
        })

        devices = Object.values(billingAggregated)
          .filter(d => d.kwh > 0.01 && d.type !== 'geyser')
          .sort((a, b) => b.kwh - a.kwh)
          .slice(0, 3)
        displayKwh = kwhAccumulated
        totalHomeSessions = bSessions
      }

      // ── 8. Attach metadata to each device ────────────────────────────────
      devices.forEach(d => {
        d.totalKwh = d.kwh
        d.totalSessions = d.session_count
        d.totalMins = d.minutes
        d.lastCompleted = allLastCompleted[d.device_id] || null
        d.openSession = allOpenSessions[d.device_id] || null
        if (d.openSession) d.is_currently_active = true
      })

      // ── 9. Misc derived values ────────────────────────────────────────────
      const latestReport = todayReportResult.data || weeklyHistoryResult.data?.[weeklyHistoryResult.data.length - 1]
      let weather = null
      try { weather = typeof latestReport?.weather_context === 'string' ? JSON.parse(latestReport.weather_context) : (latestReport?.weather_context ?? null) } catch (e) {}

      const kwhEstimated   = kwhAccumulated * 1.67

      // Fix: est. full home is per-mode, not always billing cycle
      const estimatedFullHomeKwh =
        viewMode === 'Daily'        ? liveTodayKwh / 0.6 :
        viewMode === 'Weekly'       ? weeklyKwh / 0.6 :
                                      kwhAccumulated / 0.6

      // ── Rolling 7-day average (reuses already-fetched rollingReportsResult) ──
      // Reverse so index 0 = most-recent day
      const allRollingReports     = [...(rollingReportsResult.data ?? [])].reverse()
      const reportsExcludingToday = allRollingReports.filter(r => r.report_date !== currentDateStr)

      // Filter out zero/away days so they don't pull the average down
      const nonZeroLast7 = reportsExcludingToday
        .slice(0, 7)
        .filter(r => parseFloat(r.total_kwh ?? 0) > 0)

      // Require ≥3 data points for a meaningful average; return 0 → no badge shown
      const avg7DayKwh = nonZeroLast7.length >= 3
        ? nonZeroLast7.reduce((s, r) => s + parseFloat(r.total_kwh ?? 0), 0) / nonZeroLast7.length
        : 0

      // Last week total (days 8–14 before today)
      const lastWeekKwh = reportsExcludingToday
        .slice(7, 14)
        .reduce((s, r) => s + parseFloat(r.total_kwh ?? 0), 0)

      const belowThreshold = avg7DayKwh > 0 ? avg7DayKwh * 0.75 : 0
      const aboveThreshold = avg7DayKwh > 0 ? avg7DayKwh * 1.25 : 0

      // Billing-cycle daily average
      const _cycleStartDate  = new Date(activeCycle?.cycle_start ?? currentDateStr)
      const _todayDateForAvg = new Date(currentDateStr)
      const _daysElapsed     = Math.max(1, Math.ceil((_todayDateForAvg - _cycleStartDate) / (1000 * 60 * 60 * 24)))
      const cycleDailyAvg    = _daysElapsed > 0 ? kwhAccumulated / _daysElapsed : 0

      console.log('[useHomeData] avg7Day:', avg7DayKwh.toFixed(2),
        'below:', belowThreshold.toFixed(2), 'above:', aboveThreshold.toFixed(2))

      // ── 10. Slab Calculation (TNEB) ───────────────────────────────────────
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

      const slabStatus  = generateSlabStatus(kwhAccumulated, kwhEstimated)
      const currentSlab = slabStatus.find(s => s.active)

      // ── 11. Billing cycle display window ──────────────────────────────────
      const cycleEndDate   = activeCycle?.cycle_end ? new Date(activeCycle.cycle_end) : null
      const nowForCycle    = new Date()
      const cycleDisplayEnd = (cycleEndDate && nowForCycle < cycleEndDate) ? nowForCycle : cycleEndDate
      const cycleDaysLeft   = cycleEndDate
        ? Math.max(0, Math.ceil((cycleEndDate - nowForCycle) / (1000 * 60 * 60 * 24)))
        : 0

      // ── 12. Set data ──────────────────────────────────────────────────────
      setData({
        today: {
          total_kwh: displayKwh,
          live_kwh: liveTodayKwh,
          live_sessions: dailySessionsResult.data?.length ?? 0,
          session_count: totalHomeSessions,
          devices,
          // Open sessions = those in the live daily window with no end time
          open_sessions: (dailySessionsResult.data || [])
            .filter(s => !s.session_end)
            .map(s => ({
              device_id: s.device_id,
              name: deviceNameMap[s.device_id]?.name || s.device_id,
              started_ist: new Date(s.session_start).toLocaleTimeString('en-IN', {
                hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata'
              })
            })),
          estimated_full_home_kwh: estimatedFullHomeKwh,
          estimated_cost_inr: 0,
          report_date: currentDateStr,
          as_of_ist: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
          // Rolling-average badge fields
          avg_7day_kwh:    parseFloat(avg7DayKwh.toFixed(2)),
          last_week_kwh:   parseFloat(lastWeekKwh.toFixed(2)),
          cycle_daily_avg: parseFloat(cycleDailyAvg.toFixed(2)),
          below_threshold: parseFloat(belowThreshold.toFixed(2)),
          above_threshold: parseFloat(aboveThreshold.toFixed(2)),
        },
        billing: {
          kwh_accumulated: kwhAccumulated,
          kwh_estimated: kwhEstimated,
          cycle_start: activeCycle?.cycle_start,
          cycle_end: activeCycle?.cycle_end,
          cycle_display_end: cycleDisplayEnd,
          cycle_days_left: cycleDaysLeft,
          slab_status: slabStatus,
          current_slab_name: currentSlab?.name,
          current_slab_rate: currentSlab?.rate
        },
        // Week window exposed so Home.jsx can render the correct label
        weekWindow: { monday, nextMonday },
        weather,
        report: latestReport,
        history: weeklyHistoryResult.data || []
      })

    } catch (err) {
      setError(err)
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  return { data, loading, error, refetch: fetchAll }
}