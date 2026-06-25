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

const DEVICE_METADATA_MAP = {
  'ea0b66d3-0d00-4a70-8b87-cab8908d9e38': { floor: '1st Floor', room: 'Bedroom' },
  '3b896f6f-0e7f-44ff-acd3-33d82ef11aa7': { floor: 'Ground Floor', room: 'Living Room' },
  'ff320fc1-0cbd-4af4-9dcc-98711ce67bde': { floor: 'Ground Floor', room: 'Utility' },
  '2ec92fd0-d62f-49a2-86e9-a5dafbb5bc6a': { floor: '1st Floor', room: 'Bathroom' },
  'a2814a9c-b2ca-4607-9ce9-acf311548440': { floor: 'Ground Floor', room: 'Bathroom' }
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

// ── IST helpers ───────────────────────────────────────────────────────────────

// Returns a YYYY-MM-DD string representing the "active day" in IST,
// where a day starts at 6:00 AM IST (not midnight).
// e.g. May 18 03:00 IST → returns '2026-05-17'
//      May 18 07:00 IST → returns '2026-05-18'
export function getActiveDateStr() {
  const now = new Date()
  const istTimeMs = now.getTime() + (5.5 * 60 * 60 * 1000)
  const adjustedDate = new Date(istTimeMs - (6 * 60 * 60 * 1000))
  const y = adjustedDate.getUTCFullYear()
  const m = String(adjustedDate.getUTCMonth() + 1).padStart(2, '0')
  const d = String(adjustedDate.getUTCDate()).padStart(2, '0')
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
      // ── 0. Wait for Supabase session to initialize (prevent race condition on first load) ──
      const { data: { session: activeSession }, error: sessionError } = await supabase.auth.getSession()
      console.log('[DEBUG] Supabase auth session initialization check:', { hasSession: !!activeSession, sessionError })

      // ── 1. Compute active date (respects 6 AM IST boundary) ──────────────
      const currentDateStr = selectedDate ?? getActiveDateStr()
      const activeDayStr = getActiveDateStr()
      const isToday = currentDateStr === activeDayStr

      // ── 2. Get billing cycles for the household first ───────────────────
      const { data: cycles, error: cyclesErr } = await supabase
        .from('billing_cycle_summary')
        .select('*')
        .eq('household_id', householdId)
        .order('cycle_start', { ascending: false })

      if (cyclesErr) {
        console.error('[ERROR] billing_cycle_summary query encountered error:', cyclesErr)
      } else {
        console.log('[DEBUG] billing_cycle_summary query count:', cycles?.length || 0)
      }

      const allCycles = cycles || []
      let activeCycle = allCycles.find(c => currentDateStr >= c.cycle_start && currentDateStr < c.cycle_end) || null

      if (!activeCycle) {
        console.log('[DEBUG] No active billing cycle found in database for current date. Calculating local fallback cycle in memory.');
        const { data: latestCycle, error: latestCycleErr } = await supabase
          .from('billing_cycle_summary')
          .select('*')
          .eq('household_id', householdId)
          .order('cycle_end', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (latestCycleErr) {
          console.error('[ERROR] latest billing_cycle_summary query encountered error:', latestCycleErr)
        }

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

        activeCycle = {
          id: 'temp-fallback-cycle',
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

      let minDate = [activeCycle.cycle_start, weekStartReportStr, rollingStartStr].sort()[0]
      let maxDate = [currentDateStr, weekEndReportStr, activeCycle?.cycle_end || currentDateStr].sort().reverse()[0]

      const selectedYear = new Date(currentDateStr + 'T00:00:00').getFullYear()
      const yearStart = `${selectedYear}-01-01`
      const yearEnd   = `${selectedYear}-12-31`

      if (viewMode === 'Yearly') {
        if (yearStart < minDate) minDate = yearStart
        if (yearEnd > maxDate) maxDate = yearEnd
      }

      // ── 4. Parallel Queries ───────────────────────────────────────────────
      const [
        todayReportResult,
        energySnapshotsResult,
        deviceSnapshotsResult,
        allLastCompletedResult,
        allOpenSessionsResult,
        readingsForMetaResult,
        weeklyHistoryResult,
        todayReadingsResult,
        devicesResult
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

        isToday
          ? supabase
              .from('appliance_readings')
              .select('*')
              .eq('household_id', householdId)
              .not('session_end', 'is', null)
              .order('device_id')
              .order('session_start', { ascending: false })
          : Promise.resolve({ data: [] }),

        isToday
          ? supabase
              .from('appliance_readings')
              .select('*')
              .eq('household_id', householdId)
              .is('session_end', null)
              .order('device_id')
              .order('session_start', { ascending: false })
          : Promise.resolve({ data: [] }),

        isToday
          ? supabase
              .from('appliance_readings')
              .select('device_id')
              .eq('household_id', householdId)
          : Promise.resolve({ data: [] }),

        supabase
          .from('daily_reports')
          .select('*')
          .eq('household_id', householdId)
          .gte('report_date', weekStartReportStr)
          .lte('report_date', weekEndReportStr)
          .order('report_date', { ascending: true }),

        isToday
          ? supabase
              .from('appliance_readings')
              .select('*')
              .eq('household_id', householdId)
              .gte('session_start', dayWindowStart(currentDateStr).toISOString())
          : Promise.resolve({ data: [] }),

        supabase
          .from('devices')
          .select('id, device_name, device_type, floor, room')
      ])

      // Detailed Logging for all queries
      console.log('[DEBUG] devices query result:', { data: devicesResult?.data, error: devicesResult?.error })
      console.log('[DEBUG] appliance_readings queries results:', {
        todayReadingsCount: todayReadingsResult?.data?.length,
        todayReadingsError: todayReadingsResult?.error,
        allLastCompletedCount: allLastCompletedResult?.data?.length,
        allLastCompletedError: allLastCompletedResult?.error,
        allOpenSessionsCount: allOpenSessionsResult?.data?.length,
        allOpenSessionsError: allOpenSessionsResult?.error,
        readingsForMetaCount: readingsForMetaResult?.data?.length,
        readingsForMetaError: readingsForMetaResult?.error
      })
      console.log('[DEBUG] daily_energy_snapshots query result:', { dataCount: energySnapshotsResult?.data?.length, error: energySnapshotsResult?.error })
      console.log('[DEBUG] daily_device_snapshots query result:', { dataCount: deviceSnapshotsResult?.data?.length, error: deviceSnapshotsResult?.error })
      console.log('[DEBUG] daily_reports queries results:', {
        todayReport: todayReportResult?.data,
        todayReportError: todayReportResult?.error,
        weeklyHistoryCount: weeklyHistoryResult?.data?.length,
        weeklyHistoryError: weeklyHistoryResult?.error
      })

      // ── 5. Build device-name map ──────────────────────────────────────────
      const devicesList = devicesResult?.data || []
      const devicesById = {}

      const STATIC_DEVICES_MAP = {
        'ea0b66d3-0d00-4a70-8b87-cab8908d9e38': {
          id: 'ea0b66d3-0d00-4a70-8b87-cab8908d9e38',
          device_name: 'AC - 1st Floor',
          device_type: 'ac',
          floor: '1st Floor',
          room: 'Bedroom'
        },
        'a2814a9c-b2ca-4607-9ce9-acf311548440': {
          id: 'a2814a9c-b2ca-4607-9ce9-acf311548440',
          device_name: 'Heater - GF',
          device_type: 'geyser',
          floor: 'Ground Floor',
          room: 'Bathroom'
        },
        '3b896f6f-0e7f-44ff-acd3-33d82ef11aa7': {
          id: '3b896f6f-0e7f-44ff-acd3-33d82ef11aa7',
          device_name: 'AC - GF',
          device_type: 'ac',
          floor: 'Ground Floor',
          room: 'Living Room'
        },
        'ff320fc1-0cbd-4af4-9dcc-98711ce67bde': {
          id: 'ff320fc1-0cbd-4af4-9dcc-98711ce67bde',
          device_name: 'Water Pump',
          device_type: 'pump',
          floor: 'Ground Floor',
          room: 'Utility'
        },
        '2ec92fd0-d62f-49a2-86e9-a5dafbb5bc6a': {
          id: '2ec92fd0-d62f-49a2-86e9-a5dafbb5bc6a',
          device_name: 'Heater - 1st Floor',
          device_type: 'geyser',
          floor: '1st Floor',
          room: 'Bathroom'
        }
      }

      Object.entries(STATIC_DEVICES_MAP).forEach(([id, dev]) => {
        devicesById[id] = dev
      })

      devicesList.forEach(d => {
        if (d && d.id) {
          devicesById[d.id] = d
        }
      })

      const deviceNameMap = {}
      const readingsForMeta = readingsForMetaResult?.data || []
      readingsForMeta.forEach(r => {
        if (r && r.device_id && !deviceNameMap[r.device_id]) {
          const dbDevice = devicesById[r.device_id]
          deviceNameMap[r.device_id] = {
            name: dbDevice?.device_name || dbDevice?.name || r.device_id,
            type: dbDevice?.device_type || 'others'
          }
        }
      })
      devicesList.forEach(d => {
        if (d && d.id) {
          if (!deviceNameMap[d.id]) {
            deviceNameMap[d.id] = {
              name: d.device_name || d.name || d.id,
              type: d.device_type || 'others'
            }
          }
        }
      })
      Object.entries(STATIC_DEVICES_MAP).forEach(([id, d]) => {
        if (!deviceNameMap[id]) {
          deviceNameMap[id] = {
            name: d.device_name,
            type: d.device_type
          }
        }
      })

      const energySnapshots = energySnapshotsResult?.data || []
      const deviceSnapshots = deviceSnapshotsResult?.data || []

      // ── 6. Live Calculations for today ───────────────────────────
      let todayMeasuredKwh = 0
      let todayEstimatedKwh = 0
      let todayCost = 0
      let todaySessionsCount = 0
      let todayDuration = 0
      let currCumulativeEstimated = 0
      let todayLiveDeviceSnapshots = []
      let todayLiveEnergySnapshot = null

      if (isToday) {
        const todayReadings = todayReadingsResult?.data || []
        todayMeasuredKwh = todayReadings.reduce((sum, r) => sum + parseFloat(r.kwh_consumed || 0), 0)
        const coverageRatio = todayReportResult?.data?.coverage_ratio ?? 0.6
        todayEstimatedKwh = coverageRatio > 0 ? todayMeasuredKwh / coverageRatio : todayMeasuredKwh
        todaySessionsCount = todayReadings.length
        todayDuration = todayReadings.reduce((sum, r) => sum + parseInt(r.duration_minutes || 0), 0)

        const pastCycleSnapshots = energySnapshots.filter(
          s => s && s.snapshot_date >= activeCycle.cycle_start && s.snapshot_date < currentDateStr
        )
        const prevCumulativeEstimated = pastCycleSnapshots.reduce(
          (sum, s) => sum + parseFloat(s.estimated_kwh || 0),
          0
        )
        currCumulativeEstimated = prevCumulativeEstimated + todayEstimatedKwh
        todayCost = calculateTNEBBill(currCumulativeEstimated) - calculateTNEBBill(prevCumulativeEstimated)

        const readingsByDevice = {}
        todayReadings.forEach(r => {
          if (r && r.device_id) {
            const id = r.device_id
            if (!readingsByDevice[id]) {
              readingsByDevice[id] = []
            }
            readingsByDevice[id].push(r)
          }
        })

        todayLiveDeviceSnapshots = Object.entries(readingsByDevice).map(([deviceId, devReadings]) => {
          const devMeasuredKwh = devReadings.reduce((sum, r) => sum + parseFloat(r.kwh_consumed || 0), 0)
          const devCost = todayMeasuredKwh > 0 ? (devMeasuredKwh / todayMeasuredKwh) * todayCost : 0
          const devDuration = devReadings.reduce((sum, r) => sum + parseInt(r.duration_minutes || 0), 0)

          const device = devicesById[deviceId] || { id: deviceId, device_name: undefined }
          const displayName = device.device_name || device.name || deviceId

          const info = deviceNameMap[deviceId] || {}
          const meta = DEVICE_METADATA_MAP[deviceId] || {}
          return {
            device_id: deviceId,
            device_name: displayName,
            device_type: device.device_type || devReadings[0]?.device_type || info.type || 'others',
            floor: device.floor || meta.floor || null,
            room: device.room || meta.room || null,
            measured_kwh: devMeasuredKwh,
            total_duration_minutes: devDuration,
            total_sessions: devReadings.length,
            cost: devCost,
            snapshot_date: currentDateStr,
            sessions: devReadings
          }
        })

        todayLiveEnergySnapshot = {
          snapshot_date: currentDateStr,
          measured_kwh: todayMeasuredKwh,
          estimated_kwh: todayEstimatedKwh,
          cost: todayCost,
          total_sessions: todaySessionsCount,
          total_duration_minutes: todayDuration,
          slab_name: getSlabName(currCumulativeEstimated),
          tariff_version: activeCycle.cycle_start < '2026-05-28' ? 'TN_OLD_2025' : 'TN_NEW_2026'
        }
      }

      // ── 7. Merge DB snapshots with live snapshots ────────────────────────
      let mergedEnergySnapshots = []
      let mergedDeviceSnapshots = []

      if (isToday) {
        mergedEnergySnapshots = [
          ...energySnapshots.filter(s => s.snapshot_date !== currentDateStr),
          todayLiveEnergySnapshot
        ]
        mergedDeviceSnapshots = [
          ...deviceSnapshots.filter(s => s.snapshot_date !== currentDateStr),
          ...todayLiveDeviceSnapshots
        ]
      } else {
        mergedEnergySnapshots = [...energySnapshots]
        mergedDeviceSnapshots = [...deviceSnapshots]
      }

      // Attach mock sessions for historical snapshots if not present
      mergedDeviceSnapshots.forEach(s => {
        if (!s.sessions) {
          s.sessions = [
            {
              session_start: `${s.snapshot_date}T06:00:00+05:30`,
              session_end: `${s.snapshot_date}T06:00:00+05:30`,
              duration_minutes: s.total_duration_minutes,
              kwh_consumed: s.measured_kwh,
              device_id: s.device_id,
              is_mock: true
            }
          ]
        }
      })

      // ── 8. Aggregate energy for selected period ──────────────────────────
      const yearlyEnergySnapshots = mergedEnergySnapshots.filter(
        s => s.snapshot_date >= yearStart && s.snapshot_date <= yearEnd
      )
      const yearlyMeasured = yearlyEnergySnapshots.reduce(
        (sum, s) => sum + Number(s.measured_kwh || 0),
        0
      )
      const yearlyCost = yearlyEnergySnapshots.reduce(
        (sum, s) => sum + Number(s.cost || 0),
        0
      )
      const yearlyDeviceSnapshots = mergedDeviceSnapshots.filter(
        s => s.snapshot_date >= yearStart && s.snapshot_date <= yearEnd
      )
      const latestReport = todayReportResult.data || null

      const dailyCosts = []
      mergedEnergySnapshots.forEach(s => {
        const isTodaySnapshot = s.snapshot_date === currentDateStr
        dailyCosts.push({
          report_date: s.snapshot_date,
          measured_kwh: parseFloat(s.measured_kwh || 0),
          estimated_kwh: parseFloat(s.estimated_kwh || 0),
          daily_cost: parseFloat(s.cost || 0),
          is_today: isTodaySnapshot,
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

      const selectedDaySnapshot = mergedEnergySnapshots.find(s => s.snapshot_date === currentDateStr) || {
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

      // ── 9. Aggregations per view mode ─────────────────────────────────────
      let displayKwh = 0
      let kwhAccumulated = 0
      let estimatedFullHomeKwh = 0
      let weeklyKwh = 0
      let weeklyCost = 0
      let billingCycleCost = 0
      let totalHomeSessions = 0
      let hasMoreDevices = false

      // Weekly Aggregation
      const weekDates = getDatesInRange(toLocalISO(monday), toLocalISO(new Date(nextMonday.getTime() - 24 * 60 * 60 * 1000)))
      const weekEnergySnapshots = mergedEnergySnapshots.filter(s => weekDates.includes(s.snapshot_date))
      const weeklyMeasured = weekEnergySnapshots.reduce((sum, s) => sum + parseFloat(s.measured_kwh || 0), 0)
      const weeklyEstimated = weekEnergySnapshots.reduce((sum, s) => sum + parseFloat(s.estimated_kwh || 0), 0)
      weeklyCost = weekEnergySnapshots.reduce((sum, s) => sum + parseFloat(s.cost || 0), 0)
      const weeklySessions = weekEnergySnapshots.reduce((sum, s) => sum + parseInt(s.total_sessions || 0), 0)

      // Billing Cycle Aggregation
      const cycleEnergySnapshots = mergedEnergySnapshots.filter(s => s.snapshot_date >= activeCycle.cycle_start && s.snapshot_date <= activeCycle.cycle_end)
      const billingMeasured = cycleEnergySnapshots.reduce((sum, s) => sum + parseFloat(s.measured_kwh || 0), 0)
      const billingEstimated = cycleEnergySnapshots.reduce((sum, s) => sum + parseFloat(s.estimated_kwh || 0), 0)
      billingCycleCost = cycleEnergySnapshots.reduce((sum, s) => sum + parseFloat(s.cost || 0), 0)
      const billingSessions = cycleEnergySnapshots.reduce((sum, s) => sum + parseInt(s.total_sessions || 0), 0)

      if (viewMode === 'Daily') {
        displayKwh = parseFloat(selectedDaySnapshot.measured_kwh || 0)
        estimatedFullHomeKwh = parseFloat(selectedDaySnapshot.estimated_kwh || 0)
        totalHomeSessions = parseInt(selectedDaySnapshot.total_sessions || 0)
      } else if (viewMode === 'Weekly') {
        displayKwh = weeklyMeasured
        weeklyKwh = weeklyMeasured
        estimatedFullHomeKwh = weeklyEstimated
        totalHomeSessions = weeklySessions
      } else if (viewMode === 'Yearly') {
        displayKwh = yearlyMeasured
        estimatedFullHomeKwh = yearlyEnergySnapshots.reduce((sum, s) => sum + Number(s.estimated_kwh || 0), 0)
        totalHomeSessions = yearlyEnergySnapshots.reduce((sum, s) => sum + Number(s.total_sessions || 0), 0)
      } else {
        // Billing Cycle
        displayKwh = billingMeasured
        kwhAccumulated = billingMeasured
        estimatedFullHomeKwh = billingEstimated
        totalHomeSessions = billingSessions
      }

      // ── 10. Aggregate devices for selected period ─────────────────────────
      let periodDeviceSnapshots = []
      if (viewMode === 'Daily') {
        periodDeviceSnapshots = mergedDeviceSnapshots.filter(s => s.snapshot_date === currentDateStr)
      } else if (viewMode === 'Weekly') {
        periodDeviceSnapshots = mergedDeviceSnapshots.filter(s => weekDates.includes(s.snapshot_date))
      } else if (viewMode === 'Yearly') {
        periodDeviceSnapshots = yearlyDeviceSnapshots
      } else {
        periodDeviceSnapshots = mergedDeviceSnapshots.filter(s => s.snapshot_date >= activeCycle.cycle_start && s.snapshot_date <= activeCycle.cycle_end)
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
            sessions: [],
            weekData: JSON.parse(JSON.stringify(weekTemplate))
          }
        }
        const kwhVal = parseFloat(s.measured_kwh || 0)
        const minsVal = parseInt(s.total_duration_minutes || 0)
        aggregatedDevices[id].kwh += kwhVal
        aggregatedDevices[id].minutes += minsVal
        aggregatedDevices[id].session_count += parseInt(s.total_sessions || 0)
        aggregatedDevices[id].cost += parseFloat(s.cost || 0)

        if (s.sessions) {
          aggregatedDevices[id].sessions.push(...s.sessions)
        }

        const bar = aggregatedDevices[id].weekData.find(w => w.date === s.snapshot_date)
        if (bar) {
          bar.kwh += kwhVal
          bar.mins += minsVal
        }
      }

      const devices = Object.values(aggregatedDevices)
        .sort((a, b) => b.kwh - a.kwh)

      hasMoreDevices = devices.length > 3

      const allLastCompleted = {}
      if (allLastCompletedResult?.data) {
        allLastCompletedResult.data.forEach(s => { 
          if (s && s.device_id && !allLastCompleted[s.device_id]) {
            allLastCompleted[s.device_id] = s 
          }
        })
      }
      const allOpenSessions = {}
      if (allOpenSessionsResult?.data) {
        allOpenSessionsResult.data.forEach(s => { 
          if (s && s.device_id && !allOpenSessions[s.device_id]) {
            allOpenSessions[s.device_id] = s 
          }
        })
      }

      devices.forEach(d => {
        d.totalKwh = d.kwh
        d.totalSessions = d.session_count
        d.totalMins = d.minutes
        d.lastCompleted = allLastCompleted[d.device_id] || null
        d.openSession = allOpenSessions[d.device_id] || null
        if (d.openSession) d.is_currently_active = true
      })

      // ── 11. Misc derived values ───────────────────────────────────────────
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

      // ── 12. Slab Calculation (TNEB) ──────────────────────────────────────
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

      // ── 13. Console Logs ───────────────────────────────────────────────
      console.log('selectedDate', currentDateStr)
      console.log('activeDay', activeDayStr)
      console.log('sourceUsed', isToday ? 'live' : 'snapshot')
      console.log('measuredValue', selectedDaySnapshot.measured_kwh || 0)
      console.log('deviceCount', periodDeviceSnapshots.filter(s => s.snapshot_date === currentDateStr).length)

      // ── 14. Set data ──────────────────────────────────────────────────────
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
              }),
              started_raw: s.session_start
            })),
          estimated_full_home_kwh: estimatedFullHomeKwh,
          daily_estimated_full_home_kwh: (dailyCosts.find(d => d.report_date === getActiveDateStr())?.estimated_kwh || 0),
          estimated_cost_inr: activeDayCost,
          daily_cost: activeDayCost,
          slab_name: selectedDaySnapshot.slab_name || 'Free',
          weekly_cost: weeklyCost,
          yearly_cost: yearlyCost,
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
        allCycles,
        weekWindow: { monday, nextMonday },
        weather,
        report: latestReport,
        history: weeklyHistoryResult.data || [],
        dailyCosts
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