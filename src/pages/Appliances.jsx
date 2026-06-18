import React, { useState, useMemo, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import BottomNav from '../components/BottomNav'
import { calculateTNEBBill } from '../utils/tariff'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell
} from 'recharts'

// Hardcoded metadata mapping for the 5 unique devices in the DB
const DEVICES_METADATA = [
  {
    id: 'ea0b66d3-0d00-4a70-8b87-cab8908d9e38',
    name: 'AC — 1st Floor',
    type: 'ac',
    floor: '1st Floor',
    room: 'Bedroom',
    brand: 'LG',
    model: 'B18UYD',
    color: '#378ADD',
    bg: 'var(--Blbg)'
  },
  {
    id: '3b896f6f-0e7f-44ff-acd3-33d82ef11aa7',
    name: 'AC — Ground Floor',
    type: 'ac',
    floor: 'Ground Floor',
    room: 'Living Room',
    brand: 'Samsung',
    model: 'AR18CY3',
    color: '#378ADD',
    bg: 'var(--Blbg)'
  },
  {
    id: 'ff320fc1-0cbd-4af4-9dcc-98711ce67bde',
    name: 'Water Pump',
    type: 'pump',
    floor: 'Ground Floor',
    room: 'Utility',
    brand: 'Haier',
    model: 'WP-550',
    color: '#1D9E75',
    bg: 'var(--Gbg)'
  },
  {
    id: '2ec92fd0-d62f-49a2-86e9-a5dafbb5bc6a',
    name: 'Heater — 1st Floor',
    type: 'geyser',
    floor: '1st Floor',
    room: 'Bathroom',
    brand: 'Jaquar',
    model: 'Elena-15L',
    color: '#EF9F27',
    bg: 'var(--Abg)'
  },
  {
    id: 'a2814a9c-b2ca-4607-9ce9-acf311548440',
    name: 'Heater — Ground Floor',
    type: 'geyser',
    floor: 'Ground Floor',
    room: 'Bathroom',
    brand: 'Jaquar',
    model: 'Elena-10L',
    color: '#EF9F27',
    bg: 'var(--Abg)'
  }
]

const TYPE_ICONS = {
  ac: (c) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="2" y="5.5" width="16" height="9" rx="2.5" stroke={c} strokeWidth="1.5"/>
      <path d="M5 5.5V4.5a1 1 0 011-1h8a1 1 0 011 1v1" stroke={c} strokeWidth="1.5"/>
      <path d="M6.5 11h7" stroke={c} strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M6.5 14.5v2.5M13.5 14.5v2.5" stroke={c} strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  pump: (c) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path d="M10 2.5C10 2.5 5 8.5 5 13a5 5 0 0010 0c0-4.5-5-10.5-5-10.5Z" stroke={c} strokeWidth="1.5"/>
      <path d="M8 13.5c0-1.1.9-2 2-2" stroke={c} strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  ),
  geyser: (c) => (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="6" y="2" width="8" height="14" rx="3" stroke={c} strokeWidth="1.5"/>
      <path d="M10 8v4" stroke={c} strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M6 16h8" stroke={c} strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function fmt(mins) {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

function getActiveISTDateStr(isoStr) {
  const d = new Date(isoStr)
  const istDate = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  if (istDate.getHours() < 6) {
    istDate.setDate(istDate.getDate() - 1)
  }
  const y = istDate.getFullYear()
  const m = String(istDate.getMonth() + 1).padStart(2, '0')
  const day = String(istDate.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getDatesInRange(startStr, endStr) {
  const dates = []
  const start = new Date(startStr + 'T00:00:00')
  const end = new Date(endStr + 'T00:00:00')
  const current = new Date(start)
  while (current <= end) {
    const y = current.getFullYear()
    const m = String(current.getMonth() + 1).padStart(2, '0')
    const day = String(current.getDate()).padStart(2, '0')
    dates.push(`${y}-${m}-${day}`)
    current.setDate(current.getDate() + 1)
  }
  return dates
}

export default function Appliances() {
  const { household } = useAuth()
  const householdId = household?.id

  // Active IST date & calendar boundary todayStr
  const activeDateStr = useMemo(() => {
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
    return getActiveISTDateStr(nowIST.toISOString())
  }, [])

  const todayStr = useMemo(() => new Date().toISOString().split('T')[0], [])

  const [period, setPeriod] = useState('Today')
  const [selectedDateStr, setSelectedDateStr] = useState(activeDateStr)
  const [openId, setOpenId] = useState(null)
  
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [activeCycle, setActiveCycle] = useState(null)
  const [allCycles, setAllCycles] = useState([])
  const [dailyCostsMap, setDailyCostsMap] = useState({})
  const [allReadings, setAllReadings] = useState([])
  const [deviceSnapshots, setDeviceSnapshots] = useState([])

  const selectedYear = useMemo(() => {
    return new Date(selectedDateStr + 'T00:00:00').getFullYear()
  }, [selectedDateStr])

  useEffect(() => {
    if (!householdId) return
    
    async function loadAllData() {
      setLoading(true)
      try {
        // 1. Get billing cycles for the household
        const { data: cycles } = await supabase
          .from('billing_cycle_summary')
          .select('*')
          .eq('household_id', householdId)
          .order('cycle_start', { ascending: false })

        setAllCycles(cycles || [])

        // Find cycle containing selectedDateStr
        const cycle = cycles?.find(c => selectedDateStr >= c.cycle_start && selectedDateStr < c.cycle_end) || cycles?.[0] || null
        setActiveCycle(cycle)

        if (!cycle) {
          throw new Error('No billing cycle found.')
        }

        // Fetch selectedYear bounds
        const yearStartIST = `${selectedYear}-01-01T06:00:00+05:30`
        const yearEndIST = `${selectedYear + 1}-01-01T06:00:00+05:30`

        // 2. Fetch daily energy snapshots, readings, and device snapshots in parallel
        const [energySnapsRes, readingsRes, deviceSnapsRes] = await Promise.all([
          supabase
            .from('daily_energy_snapshots')
            .select('*')
            .eq('household_id', householdId)
            .gte('snapshot_date', `${selectedYear}-01-01`)
            .lte('snapshot_date', `${selectedYear}-12-31`),
          supabase
            .from('appliance_readings')
            .select('*')
            .eq('household_id', householdId)
            .gte('session_start', new Date(yearStartIST).toISOString())
            .lt('session_start', new Date(yearEndIST).toISOString()),
          supabase
            .from('daily_device_snapshots')
            .select('*')
            .eq('household_id', householdId)
            .gte('snapshot_date', `${selectedYear}-01-01`)
            .lte('snapshot_date', `${selectedYear}-12-31`)
        ])

        if (energySnapsRes.error) throw energySnapsRes.error
        if (readingsRes.error) throw readingsRes.error
        if (deviceSnapsRes.error) throw deviceSnapsRes.error

        const readings = readingsRes.data || []
        setAllReadings(readings)

        const energySnaps = energySnapsRes.data || []
        const deviceSnaps = deviceSnapsRes.data || []
        setDeviceSnapshots(deviceSnaps)

        // Compute incremental daily costs chronologically for each cycle in the calendar year
        const computedMap = {}
        
        ;(cycles || []).forEach(c => {
          const cycleStart = c.cycle_start
          const cycleEnd = c.cycle_end
          
          // Last date is exclusive of cycleEnd
          const lastDateObj = new Date(cycleEnd + 'T00:00:00')
          lastDateObj.setDate(lastDateObj.getDate() - 1)
          const lastDateStr = lastDateObj.toISOString().split('T')[0]
          
          const endBoundStr = lastDateStr < activeDateStr ? lastDateStr : activeDateStr
          if (cycleStart > endBoundStr) return
          
          const datesInCycle = getDatesInRange(cycleStart, endBoundStr)
          let cumulativeEstimated = 0

          datesInCycle.forEach(dateStr => {
            const isToday = dateStr === activeDateStr
            let measured = 0
            let estimated = 0
            let cost = 0

            if (isToday) {
              const daySessions = readings.filter(s => getActiveISTDateStr(s.session_start) === dateStr)
              measured = daySessions.reduce((sum, s) => sum + parseFloat(s.kwh_consumed || 0), 0)
              const coverage = 0.6
              estimated = measured / coverage
              const prevCumulative = cumulativeEstimated
              cumulativeEstimated += estimated
              cost = calculateTNEBBill(cumulativeEstimated) - calculateTNEBBill(prevCumulative)
            } else {
              const snap = energySnaps.find(s => s.snapshot_date === dateStr)
              measured = snap ? parseFloat(snap.measured_kwh || 0) : 0
              estimated = snap ? parseFloat(snap.estimated_kwh || 0) : 0
              cost = snap ? parseFloat(snap.cost || 0) : 0
              cumulativeEstimated += estimated
            }

            computedMap[dateStr] = {
              measured_kwh: measured,
              estimated_kwh: estimated,
              daily_cost: cost
            }
          })
        })

        setDailyCostsMap(computedMap)
      } catch (err) {
        console.error(err)
        setError(err)
      } finally {
        setLoading(false)
      }
    }

    loadAllData()
  }, [householdId, selectedYear, activeDateStr])

  // Shift selected date based on period and direction
  const shiftDate = (direction) => {
    const d = new Date(selectedDateStr + 'T00:00:00')
    if (period === 'Today') {
      d.setDate(d.getDate() + direction)
    } else if (period === 'Weekly') {
      d.setDate(d.getDate() + (direction * 7))
    } else if (period === 'Billing Cycle') {
      const currentCycleIndex = allCycles.findIndex(c => selectedDateStr >= c.cycle_start && selectedDateStr < c.cycle_end)
      const targetIndex = currentCycleIndex - direction
      const targetCycle = allCycles[targetIndex]
      if (targetCycle) {
        setSelectedDateStr(targetCycle.cycle_start)
        return
      } else {
        d.setMonth(d.getMonth() + (direction * 2))
      }
    } else if (period === 'Yearly') {
      d.setFullYear(d.getFullYear() + direction)
    }

    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    setSelectedDateStr(`${y}-${m}-${day}`)
  }

  // Find latest/current cycle in state
  const latestCycle = useMemo(() => allCycles[0] || null, [allCycles])

  // Disable "next" navigation button when at maximum bounds
  const disableNext = useMemo(() => {
    if (period === 'Today') return selectedDateStr === activeDateStr
    if (period === 'Weekly') return selectedDateStr >= activeDateStr
    if (period === 'Billing Cycle') return latestCycle ? (selectedDateStr >= latestCycle.cycle_start) : true
    if (period === 'Yearly') return selectedYear === new Date(activeDateStr + 'T00:00:00').getFullYear()
    return false
  }, [period, selectedDateStr, activeDateStr, latestCycle, selectedYear])

  // Find currently selected cycle spanning selectedDateStr
  const selectedCycle = useMemo(() => {
    return allCycles.find(c => selectedDateStr >= c.cycle_start && selectedDateStr < c.cycle_end) || activeCycle
  }, [selectedDateStr, allCycles, activeCycle])

  // Construct navigator display text (navLabel)
  const navLabel = useMemo(() => {
    if (period === 'Today') {
      const isSelectedToday = selectedDateStr === activeDateStr
      const dateFormatted = new Date(selectedDateStr + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      return isSelectedToday ? `${dateFormatted} · 6 AM – Now` : `${dateFormatted} · 6 AM – 6 AM`
    }
    
    if (period === 'Weekly') {
      const d = new Date(selectedDateStr + 'T00:00:00')
      const day = d.getDay()
      const diff = (day === 0 ? -6 : 1) - day
      const monday = new Date(d)
      monday.setDate(d.getDate() + diff)
      const sunday = new Date(monday)
      sunday.setDate(monday.getDate() + 6)
      const startWeekStr = monday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      const endWeekStr = sunday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      return `${startWeekStr} – ${endWeekStr} (Mon 6 AM → Mon 6 AM)`
    }
    
    if (period === 'Billing Cycle') {
      if (selectedCycle) {
        const bStart = new Date(selectedCycle.cycle_start + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        const bEnd = new Date(selectedCycle.cycle_end + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        return `${bStart} – ${bEnd}`
      }
      return 'Loading...'
    }
    
    if (period === 'Yearly') {
      return `Jan ${selectedYear} – Dec ${selectedYear}`
    }

    return ''
  }, [period, selectedDateStr, activeDateStr, selectedCycle, selectedYear])

  // Define date strings included in the selected period
  const periodDateStrings = useMemo(() => {
    if (period === 'Today') {
      return [selectedDateStr]
    }
    
    if (period === 'Weekly') {
      const curr = new Date(selectedDateStr + 'T00:00:00')
      const day = curr.getDay()
      const diff = (day === 0 ? -6 : 1) - day
      const monday = new Date(curr)
      monday.setDate(curr.getDate() + diff)
      
      const dates = []
      const temp = new Date(monday)
      for (let i = 0; i < 7; i++) {
        const y = temp.getFullYear()
        const m = String(temp.getMonth() + 1).padStart(2, '0')
        const dd = String(temp.getDate()).padStart(2, '0')
        dates.push(`${y}-${m}-${dd}`)
        temp.setDate(temp.getDate() + 1)
      }
      return dates
    }
    
    if (period === 'Billing Cycle' && selectedCycle) {
      const lastDateObj = new Date(selectedCycle.cycle_end + 'T00:00:00')
      lastDateObj.setDate(lastDateObj.getDate() - 1)
      const lastDateStr = lastDateObj.toISOString().split('T')[0]
      const endBoundStr = lastDateStr < activeDateStr ? lastDateStr : activeDateStr
      return getDatesInRange(selectedCycle.cycle_start, endBoundStr)
    }
    
    if (period === 'Yearly') {
      const endBoundStr = `${selectedYear}-12-31` < activeDateStr ? `${selectedYear}-12-31` : activeDateStr
      return getDatesInRange(`${selectedYear}-01-01`, endBoundStr)
    }

    return []
  }, [period, selectedDateStr, activeDateStr, selectedCycle, selectedYear])

  // Filter readings within the selected period's date strings
  const periodReadings = useMemo(() => {
    return allReadings.filter(s => {
      const sDateStr = getActiveISTDateStr(s.session_start)
      return periodDateStrings.includes(sDateStr) && dailyCostsMap[sDateStr] !== undefined
    })
  }, [allReadings, periodDateStrings, dailyCostsMap])

  // Calculate totals and device breakdowns
  const periodMetrics = useMemo(() => {
    let totalKwh = 0
    let totalCost = 0
    let totalSessions = 0

    // Group device kWh
    const deviceMeasured = {}
    const deviceSessionsCount = {}
    const deviceSessions = {}
    const deviceMinutes = {}
    const deviceDailyKwh = {}
    
    DEVICES_METADATA.forEach(d => {
      deviceMeasured[d.id] = 0
      deviceSessionsCount[d.id] = 0
      deviceSessions[d.id] = []
      deviceMinutes[d.id] = 0
      deviceDailyKwh[d.id] = {}
      periodDateStrings.forEach(dateStr => {
        deviceDailyKwh[d.id][dateStr] = 0
      })
    })

    periodDateStrings.forEach(dateStr => {
      const isToday = dateStr === activeDateStr
      
      // Get total kWh and cost from dailyCostsMap
      const dayData = dailyCostsMap[dateStr]
      if (dayData) {
        totalKwh += dayData.measured_kwh
        totalCost += dayData.daily_cost
      }

      if (isToday) {
        // Use appliance_readings for today
        const daySessions = allReadings.filter(s => getActiveISTDateStr(s.session_start) === dateStr)
        totalSessions += daySessions.length

        // Group by device
        daySessions.forEach(s => {
          if (deviceMeasured[s.device_id] !== undefined) {
            deviceMeasured[s.device_id] += parseFloat(s.kwh_consumed || 0)
            deviceSessionsCount[s.device_id] += 1
            deviceSessions[s.device_id].push(s)
            deviceMinutes[s.device_id] += parseInt(s.duration_minutes || 0)
            deviceDailyKwh[s.device_id][dateStr] += parseFloat(s.kwh_consumed || 0)
          }
        })
      } else {
        // Use daily_device_snapshots for past days
        const daySnaps = deviceSnapshots.filter(s => s.snapshot_date === dateStr)
        daySnaps.forEach(s => {
          if (deviceMeasured[s.device_id] !== undefined) {
            deviceMeasured[s.device_id] += parseFloat(s.measured_kwh || 0)
            deviceSessionsCount[s.device_id] += parseInt(s.total_sessions || 0)
            deviceMinutes[s.device_id] += parseInt(s.total_duration_minutes || 0)
            deviceDailyKwh[s.device_id][dateStr] += parseFloat(s.measured_kwh || 0)
            totalSessions += parseInt(s.total_sessions || 0)
          }
        })
      }
    })

    // Calculate proportional costs
    const devicesList = DEVICES_METADATA.map(meta => {
      const kwh = deviceMeasured[meta.id]
      const sessCount = deviceSessionsCount[meta.id]
      const sessList = deviceSessions[meta.id]
      const mins = deviceMinutes[meta.id]
      const cost = totalKwh > 0 ? (kwh / totalKwh) * totalCost : 0
      
      return {
        ...meta,
        kwh,
        sessionsCount: sessCount,
        sessions: sessList,
        minutes: mins,
        cost,
        dailyKwh: deviceDailyKwh[meta.id]
      }
    }).filter(d => d.kwh > 0 || d.sessionsCount > 0) // Show only active devices

    // Sort by kWh descending
    devicesList.sort((a, b) => b.kwh - a.kwh)

    console.log('APPLIANCES PAGE DEVICES', devicesList)
    console.log('APPLIANCES PAGE TOTAL', devicesList.reduce((s,d)=>s+d.kwh,0))
    console.log('APPLIANCES SOURCE TABLE:', periodDateStrings.every(d => d === activeDateStr) ? 'appliance_readings' : 'daily_device_snapshots')
    console.log('APPLIANCES DATE RANGE:', {
      startDate: periodDateStrings[0],
      endDate: periodDateStrings[periodDateStrings.length - 1]
    })

    return {
      devicesList,
      totalKwh,
      totalCost,
      totalSessions
    }
  }, [allReadings, deviceSnapshots, periodDateStrings, dailyCostsMap, activeDateStr])

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-700 mx-auto mb-4"></div>
          <p className="text-sm text-[var(--tx2)]">Loading appliances data...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[var(--bg)] flex items-center justify-center p-4">
        <div className="bg-white p-6 rounded-2xl border border-red-100 max-w-sm text-center">
          <p className="text-red-600 font-medium mb-2">Error Loading Data</p>
          <p className="text-xs text-[var(--tx2)] mb-4">{error.message}</p>
          <button 
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-emerald-700 text-white rounded-xl text-xs"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] pb-24">
      <style>{`
        .hdr { background:white; padding:14px 16px; border-bottom:1px solid var(--b); position:sticky; top:0; z-index:20; }
        .hdr-top { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; }
        .hdr-title { font-size:22px; font-weight:500; color:var(--tx); letter-spacing:-.4px; }
        .hdr-sub { font-size:12px; color:var(--tx2); margin-top:2px; }

        .ftabs { display:flex; gap:6px; background:#f4f4f5; padding:4px; border-radius:14px; }
        .ftab { flex:1; text-align:center; font-size:11px; font-weight:600; padding:8px 4px; border-radius:10px; cursor:pointer; color:var(--tx2); transition:all .15s; }
        .ftab.active { background:white; color:var(--tx); box-shadow: 0 1px 3px rgba(0,0,0,0.1); }

        .strip { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; padding:12px 14px; background:white; border-bottom:1px solid var(--b); }
        .sc { background:var(--s2); border-radius:10px; padding:10px; text-align:center; }
        .sc-val { font-size:18px; font-weight:500; color:var(--tx); line-height:1.1; }
        .sc-lbl { font-size:10px; color:var(--tx3); margin-top:3px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; }

        .dev-table-wrap { background:white; margin:16px 14px; border-radius:16px; border:1px solid var(--b); overflow:hidden; }
        .dev-table { width:100%; border-collapse:collapse; text-align:left; }
        .dev-table th { padding:12px 14px; font-size:10px; font-weight:700; text-transform:uppercase; color:var(--tx3); border-bottom:1px solid var(--b); }
        .dev-table td { padding:12px 14px; font-size:13px; color:var(--tx2); border-bottom:1px solid var(--b); vertical-align:middle; }
        .dev-table tr.active-row { background:#fafafb; }
        .dev-table tr.total-row { background:#f4f4f5; font-weight:600; }
        .dev-table tr.total-row td { color:var(--tx); border-bottom:none; }

        .dev-cell-info { display:flex; align-items:center; gap:10px; }
        .dev-cell-ico { width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; }
        .dev-cell-name { font-size:13px; font-weight:500; color:var(--tx); }
        .dev-cell-sub { font-size:10px; color:var(--tx3); margin-top:1px; }

        .chevron { transition:transform .2s; }
        .chevron.open { transform:rotate(180deg); }

        .exp-container { padding:16px; background:#fcfcfd; border-bottom:1px solid var(--b); }
        .exp-summary-grid { display:grid; grid-template-columns:repeat(5, 1fr); gap:8px; margin-bottom:18px; }
        .exp-summary-box { background:white; border:1px solid var(--b); border-radius:10px; padding:10px 4px; text-align:center; }
        .esb-val { font-size:13px; font-weight:600; color:var(--tx); }
        .esb-lbl { font-size:8px; color:var(--tx3); text-transform:uppercase; margin-top:2px; letter-spacing:0.04em; }

        .chart-box { background:white; border:1px solid var(--b); border-radius:12px; padding:14px; margin-bottom:18px; }
        .chart-title { font-size:11px; font-weight:600; text-transform:uppercase; color:var(--tx3); margin-bottom:12px; letter-spacing:0.05em; }

        .sess-box { background:white; border:1px solid var(--b); border-radius:12px; overflow:hidden; }
        .sess-title { font-size:11px; font-weight:600; text-transform:uppercase; color:var(--tx3); padding:12px 14px; border-bottom:1px solid var(--b); letter-spacing:0.05em; }
        .sess-table { width:100%; border-collapse:collapse; }
        .sess-table th { padding:8px 12px; font-size:9px; font-weight:700; text-transform:uppercase; color:var(--tx3); border-bottom:1px solid var(--b); background:#fafafb; }
        .sess-table td { padding:10px 12px; font-size:11px; color:var(--tx2); border-bottom:1px solid var(--b); }
        .sess-table tr:last-child td { border-bottom:none; }
      `}</style>

      {/* HEADER */}
      <div className="hdr">
        <div className="hdr-top">
          <div>
            <div className="hdr-title font-serif">Appliances</div>
            <div className="hdr-sub">{periodMetrics.devicesList.length} active devices in selected period</div>
          </div>
        </div>
        <div className="ftabs">
          {['Today', 'Weekly', 'Billing Cycle', 'Yearly'].map(t => (
            <div 
              key={t} 
              className={`ftab ${period === t ? 'active' : ''}`}
              onClick={() => {
                setPeriod(t)
                setOpenId(null)
                setSelectedDateStr(activeDateStr)
              }}
            >
              {t}
            </div>
          ))}
        </div>
      </div>

      {/* DATE NAVIGATOR */}
      <div className="bg-white border-b border-[var(--b)] text-[var(--tx)]">
        <div className="flex items-center justify-between px-4 py-3.5">
          <button 
            onClick={() => shiftDate(-1)}
            className="w-9 h-9 rounded-full border border-[var(--b2)] flex justify-center items-center text-[20px] transition-opacity hover:bg-black/5"
          >
            ‹
          </button>
          <label className="relative cursor-pointer flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-black/5 transition-colors group">
            <div className="text-[15px] font-serif font-medium tracking-tight whitespace-nowrap">
              {navLabel}
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="opacity-40 group-hover:opacity-100 transition-opacity">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            <input 
              type="date" 
              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full" 
              value={selectedDateStr}
              onChange={(e) => {
                if (e.target.value) {
                  setSelectedDateStr(e.target.value)
                }
              }}
              max={todayStr}
            />
          </label>
          <button 
            onClick={() => shiftDate(1)}
            disabled={disableNext}
            className={`w-9 h-9 rounded-full border border-[var(--b2)] flex justify-center items-center text-[20px] transition-opacity ${disableNext ? 'opacity-30 cursor-default pointer-events-none' : 'hover:bg-black/5'}`}
          >
            ›
          </button>
        </div>
      </div>

      {/* SUMMARY STRIP */}
      <div className="strip">
        <div className="sc">
          <div className="sc-val">{periodMetrics.totalKwh.toFixed(1)}</div>
          <div className="sc-lbl">kWh Period</div>
        </div>
        <div className="sc">
          <div className="sc-val">{periodMetrics.totalSessions}</div>
          <div className="sc-lbl">Sessions</div>
        </div>
        <div className="sc">
          <div className="sc-val">₹{Math.round(periodMetrics.totalCost)}</div>
          <div className="sc-lbl">Est. Cost</div>
        </div>
      </div>

      {/* DEVICE TABLE */}
      <div className="dev-table-wrap">
        <table className="dev-table">
          <thead>
            <tr>
              <th style={{ width: '45%' }}>Device</th>
              <th style={{ textAlign: 'right' }}>Measured</th>
              <th style={{ textAlign: 'right' }}>Sessions</th>
              <th style={{ textAlign: 'right', width: '22%' }}>Cost</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {periodMetrics.devicesList.map(d => {
              const isExpanded = openId === d.id
              const icon = TYPE_ICONS[d.type]?.(d.color)

              return (
                <React.Fragment key={d.id}>
                  <tr 
                    onClick={() => setOpenId(isExpanded ? null : d.id)}
                    style={{ cursor: 'pointer' }}
                    className={isExpanded ? 'active-row' : ''}
                  >
                    <td>
                      <div className="dev-cell-info">
                        <div className="dev-cell-ico" style={{ background: d.bg }}>
                          {icon}
                        </div>
                        <div>
                          <div className="dev-cell-name">{d.name}</div>
                          <div className="dev-cell-sub">{d.floor} · {d.room}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: '500' }}>
                      {d.kwh.toFixed(2)} <span className="text-[10px] text-[var(--tx3)]">kWh</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {d.sessionsCount}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: '500', color: 'var(--Am)' }}>
                      ₹{Math.round(d.cost)}
                    </td>
                    <td style={{ paddingLeft: 0, paddingRight: 8 }}>
                      <svg className={`chevron ${isExpanded ? 'open' : ''}`} width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path d="M4 6l4 4 4-4" stroke="var(--tx3)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </td>
                  </tr>

                  {/* EXPANSION PANEL */}
                  {isExpanded && (
                    <tr>
                      <td colSpan="5" style={{ padding: 0 }}>
                        <DeviceExpansionPanel d={d} period={period} activeDateStr={activeDateStr} periodDateStrings={periodDateStrings} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
            
            {/* TOTALS ROW */}
            <tr className="total-row">
              <td>TOTAL</td>
              <td style={{ textAlign: 'right' }}>
                {periodMetrics.totalKwh.toFixed(2)} <span className="text-[10px] text-[var(--tx2)]">kWh</span>
              </td>
              <td style={{ textAlign: 'right' }}>
                {periodMetrics.totalSessions}
              </td>
              <td style={{ textAlign: 'right', color: 'var(--Am)' }}>
                ₹{Math.round(periodMetrics.totalCost)}
              </td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>

      <BottomNav />
    </div>
  )
}

function DeviceExpansionPanel({ d, period, activeDateStr, periodDateStrings }) {
  // Calculations for Period Summary
  const avgKwhPerSession = d.sessionsCount > 0 ? d.kwh / d.sessionsCount : 0
  const totalDuration = d.minutes || 0
  const avgDurationMins = d.sessionsCount > 0 ? totalDuration / d.sessionsCount : 0

  // Graph Data Construction
  const graphData = useMemo(() => {
    if (period === 'Today') {
      // 24 Hourly bins starting from 6:00 AM IST
      const bins = []
      for (let h = 0; h < 24; h++) {
        const hourIST = (6 + h) % 24
        const label = `${hourIST % 12 || 12}${hourIST < 12 ? ' AM' : ' PM'}`
        
        // Find sessions starting during this hour IST
        const hourlySessions = d.sessions.filter(s => {
          const startTime = new Date(s.session_start)
          const istTime = new Date(startTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
          return istTime.getHours() === hourIST
        })
        const kwh = hourlySessions.reduce((sum, s) => sum + parseFloat(s.kwh_consumed || 0), 0)
        
        bins.push({ label, kwh })
      }
      return bins
    }

    if (period === 'Weekly') {
      // 7 Daily bins
      const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      return periodDateStrings.map((dateStr, idx) => {
        const kwh = d.dailyKwh ? (d.dailyKwh[dateStr] || 0) : 0
        return {
          label: DAY_LABELS[idx],
          kwh
        }
      })
    }

    if (period === 'Billing Cycle') {
      // Daily bins for the cycle dates
      return periodDateStrings.map(dateStr => {
        const kwh = d.dailyKwh ? (d.dailyKwh[dateStr] || 0) : 0
        const dObj = new Date(dateStr + 'T00:00:00')
        const label = dObj.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
        return {
          label,
          kwh
        }
      })
    }

    if (period === 'Yearly') {
      // 12 Monthly bins
      const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const monthlyKwh = Array(12).fill(0)

      periodDateStrings.forEach(dateStr => {
        const kwh = d.dailyKwh ? (d.dailyKwh[dateStr] || 0) : 0
        const dObj = new Date(dateStr + 'T00:00:00')
        const monthIdx = dObj.getMonth()
        monthlyKwh[monthIdx] += kwh
      })

      return MONTH_LABELS.map((monthName, idx) => {
        return {
          label: monthName,
          kwh: monthlyKwh[idx]
        }
      })
    }

    return []
  }, [d.sessions, d.dailyKwh, period, periodDateStrings, activeDateStr])

  const formatTime = (isoStr) => {
    if (!isoStr) return 'Running'
    const d = new Date(isoStr)
    return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
  }

  const customTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white p-2 border border-slate-100 rounded-lg shadow-sm text-[10px] text-[var(--tx)]">
          <p className="font-semibold">{payload[0].payload.label}</p>
          <p className="text-[var(--tx2)] mt-1">{payload[0].value.toFixed(2)} kWh</p>
        </div>
      )
    }
    return null
  }

  return (
    <div className="exp-container">
      {/* PERIOD SUMMARY */}
      <div className="exp-summary-grid">
        <div className="exp-summary-box">
          <div className="esb-val">{d.kwh.toFixed(2)}</div>
          <div className="esb-lbl">Total kWh</div>
        </div>
        <div className="exp-summary-box">
          <div className="esb-val">{d.sessionsCount}</div>
          <div className="esb-lbl">Sessions</div>
        </div>
        <div className="exp-summary-box">
          <div className="esb-val">₹{Math.round(d.cost)}</div>
          <div className="esb-lbl">Total Cost</div>
        </div>
        <div className="exp-summary-box">
          <div className="esb-val">{fmt(Math.round(avgDurationMins))}</div>
          <div className="esb-lbl">Avg Duration</div>
        </div>
        <div className="exp-summary-box">
          <div className="esb-val">{avgKwhPerSession.toFixed(2)}</div>
          <div className="esb-lbl">Avg kWh</div>
        </div>
      </div>

      {/* DEVICE GRAPH */}
      <div className="chart-box">
        <div className="chart-title">Device Usage Timeline</div>
        <div style={{ width: '100%', height: 130 }}>
          <ResponsiveContainer>
            <BarChart data={graphData} margin={{ top: 5, right: 0, left: -25, bottom: 0 }}>
              <XAxis 
                dataKey="label" 
                tick={{ fontSize: 8, fill: 'var(--tx3)' }} 
                axisLine={false} 
                tickLine={false}
              />
              <YAxis 
                tick={{ fontSize: 8, fill: 'var(--tx3)' }} 
                axisLine={false} 
                tickLine={false}
              />
              <Tooltip content={customTooltip} cursor={{ fill: 'rgba(0,0,0,0.02)' }} />
              <Bar dataKey="kwh" radius={[3, 3, 0, 0]}>
                {graphData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={d.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* SESSION BREAKDOWN TABLE */}
      <div className="sess-box">
        <div className="sess-title">Sessions Breakdown</div>
        <div style={{ maxHeight: 180, overflowY: 'auto' }}>
          <table className="sess-table">
            <thead>
              <tr>
                <th>Start Time</th>
                <th>End Time</th>
                <th>Duration</th>
                <th style={{ textAlign: 'right' }}>kWh</th>
                <th style={{ textAlign: 'center' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {d.sessions.length > 0 ? (
                d.sessions.map((s, idx) => {
                  const status = s.session_end ? 'Completed' : 'Running'
                  const durVal = s.session_end 
                    ? s.duration_minutes 
                    : Math.round((new Date() - new Date(s.session_start)) / 60000)

                  return (
                    <tr key={idx}>
                      <td>{formatTime(s.session_start)}</td>
                      <td>{s.session_end ? formatTime(s.session_end) : 'Running'}</td>
                      <td>{fmt(durVal)}</td>
                      <td style={{ textAlign: 'right', fontWeight: '500' }}>
                        {parseFloat(s.kwh_consumed || 0).toFixed(2)} kWh
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{
                          fontSize: '8px',
                          fontWeight: '700',
                          background: s.session_end ? 'var(--Gbg)' : 'var(--Abg)',
                          color: s.session_end ? 'var(--G)' : 'var(--A)',
                          padding: '2px 6px',
                          borderRadius: '8px',
                          textTransform: 'uppercase'
                        }}>
                          {status}
                        </span>
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan="5" style={{ textAlign: 'center', padding: '16px', color: 'var(--tx3)' }}>
                    No sessions recorded for this period
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
