import React, { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import BottomNav from '../components/BottomNav'
import { useAuth } from '../context/AuthContext'
import { useHomeData } from '../hooks/useHomeData'
import EnergyGraph from '../components/EnergyGraph'
import { supabase } from '../lib/supabase'
import { 
  calculateTNEBBill, 
  getCurrentSlab, 
  getSlabs, 
  getDailySlabRate, 
  SLABS_BELOW_500, 
  SLABS_ABOVE_500,
  calculateSubsidized,
  calculateHighUsage,
  calculateDailyCost
} from '../utils/tariff'

const DAYS = [
  {
    label:'Apr 20', kwh:14.10, est:23.5, cost:'₹0', runtime:'9h 3m', costSub:'Free',
    devices:[
      {name:'AC — 1st Floor',loc:'Bedroom',mins:543,kwh:7.80,pct:55.3,color:'var(--Am)',ico:'ac'},
      {name:'AC — Ground Floor',loc:'Living Room',mins:315,kwh:4.46,pct:31.6,color:'#1A5FB4',ico:'ac'},
      {name:'Water Pump',loc:'Utility',mins:11,kwh:0.06,pct:0.4,color:'var(--Gm)',ico:'pump'}
    ],
    openSession:{name:'AC — 1st Floor',since:'12:01 AM'},
    carriedOver:null,
    tip:{head:'AC 1st Floor used 25% more than AC Ground Floor',body:'Check if it\'s set to a lower temperature or running longer than needed. Both ACs running at 24°C and the same duration would save around 2–3 kWh per day.',kwh:'7.80',time:'9h 3m'}
  },
  {
    label:'Apr 21', kwh:15.52, est:25.87, cost:'₹0', runtime:'16h 15m', costSub:'Free',
    devices:[
      {name:'AC — 1st Floor',loc:'Bedroom',mins:975,kwh:7.97,pct:51.4,color:'var(--Am)',ico:'ac',carried:3.33},
      {name:'AC — Ground Floor',loc:'Living Room',mins:625,kwh:3.99,pct:25.7,color:'#1A5FB4',ico:'ac'},
      {name:'Water Pump',loc:'Utility',mins:35,kwh:0.23,pct:1.5,color:'var(--Gm)',ico:'pump'}
    ],
    openSession:null,
    tip:{head:'AC 1st Floor ran 16h 15m — includes a session from previous night',body:'3.33 kWh carried over from a session that started the night before and ended at 2:46 AM. Cycling it off for 30 min every 2 hrs can reduce consumption by 15–20% (BEE).',kwh:'7.97',time:'16h 15m'}
  },
  {
    label:'Apr 22', kwh:12.87, est:21.45, cost:'₹0', runtime:'13h 15m', costSub:'Free',
    devices:[
      {name:'AC — 1st Floor',loc:'Bedroom',mins:795,kwh:8.06,pct:62.6,color:'var(--Am)',ico:'ac'},
      {name:'AC — Ground Floor',loc:'Living Room',mins:615,kwh:4.72,pct:36.7,color:'#1A5FB4',ico:'ac'},
      {name:'Water Pump',loc:'Utility',mins:15,kwh:0.10,pct:0.8,color:'var(--Gm)',ico:'pump'}
    ],
    openSession:null,
    tip:{head:'AC 1st Floor ran 13h 15m on a cool night (25.8°C min)',body:'On cooler nights the AC needs less time. Try raising the set temperature slightly — BEE: every 1°C increase saves ~6% electricity.',kwh:'8.06',time:'13h 15m'}
  },
  {
    label:'Apr 23', kwh:13.87, est:23.12, cost:'₹0', runtime:'15h 50m', costSub:'Free',
    devices:[
      {name:'AC — 1st Floor',loc:'Bedroom',mins:950,kwh:8.23,pct:59.3,color:'var(--Am)',ico:'ac'},
      {name:'AC — Ground Floor',loc:'Living Room',mins:705,kwh:5.40,pct:38.9,color:'#1A5FB4',ico:'ac'},
      {name:'Water Pump',loc:'Utility',mins:30,kwh:0.24,pct:1.7,color:'var(--Gm)',ico:'pump'}
    ],
    openSession:null,
    tip:{head:'AC 1st Floor ran 15h 50m — cool night (25.7°C min)',body:'On cooler nights the AC needs less time. Try raising the set temperature slightly. BEE: every 1°C increase saves ~6% electricity.',kwh:'8.23',time:'15h 50m'}
  },
  {
    label:'Apr 24', kwh:17.20, est:28.67, cost:'₹0', runtime:'15h 58m', costSub:'Free',
    devices:[
      {name:'AC — 1st Floor',loc:'Bedroom',mins:958,kwh:11.31,pct:65.8,color:'var(--Am)',ico:'ac'},
      {name:'AC — Ground Floor',loc:'Living Room',mins:555,kwh:5.59,pct:32.5,color:'#1A5FB4',ico:'ac'},
      {name:'Water Pump',loc:'Utility',mins:35,kwh:0.29,pct:1.7,color:'var(--Gm)',ico:'pump'}
    ],
    openSession:null,
    tip:{head:'AC 1st Floor ran nearly 16 hours last night',body:'Cycling it off for 30 minutes every 2 hours can reduce consumption by 15–20% (BEE). You can set this schedule in the Habtekt app once scheduling is live.',kwh:'11.31',time:'15h 58m'}
  },
  {
    label:'Apr 25', kwh:18.22, est:30.37, cost:'₹0', runtime:'14h 10m', costSub:'Free',
    devices:[
      {name:'AC — 1st Floor',loc:'Bedroom',mins:850,kwh:10.09,pct:55.4,color:'var(--Am)',ico:'ac'},
      {name:'AC — Ground Floor',loc:'Living Room',mins:780,kwh:7.71,pct:42.3,color:'#1A5FB4',ico:'ac'},
      {name:'Water Pump',loc:'Utility',mins:55,kwh:0.42,pct:2.3,color:'var(--Gm)',ico:'pump'}
    ],
    openSession:null,
    tip:{head:'AC 1st Floor ran 14h 10m on a cool night (25.7°C min)',body:'On cooler nights the AC typically needs less time. Try raising the set temperature slightly — BEE: every 1°C increase saves ~6% electricity.',kwh:'10.09',time:'14h 10m'}
  }
]

const ICONS = {
  ac: (color) => (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none">
      <rect x="1.5" y="4.5" width="14" height="7" rx="2" stroke={color} strokeWidth="1.4"/>
      <path d="M4.5 4.5V3.7a1 1 0 011-1h6a1 1 0 011 1v.8" stroke={color} strokeWidth="1.4"/>
      <path d="M5.5 9h6" stroke={color} strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M5.5 11.5v2M11.5 11.5v2" stroke={color} strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  ),
  pump: (color) => (
    <svg width="17" height="17" viewBox="0 0 17 17" fill="none">
      <path d="M8.5 2.5C8.5 2.5 4 7.5 4 11a4.5 4.5 0 009 0c0-3.5-4.5-8.5-4.5-8.5Z" stroke={color} strokeWidth="1.4"/>
      <path d="M6.5 11.5c0-1.1.9-2 2-2" stroke={color} strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  )
}

const ICO_BGS = ['var(--Abg)', 'var(--Blbg)', 'var(--Gbg)']

function fmt(mins) {
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : (`${m}m`)
}


function EnergyHeader({ cycleDay, startDate, endDate, slabName, cost }) {
  const displayCostStr = cost === 0 ? '₹0 today' : `₹${Math.round(cost).toLocaleString()}`
  return (
    <div className="energy-header">
      <div className="left">
        <h1 className="font-serif">Energy</h1>
        <p>
          Cycle day {cycleDay} · {startDate} – {endDate}
        </p>
      </div>

      <div className="right">
        <span className="slab-badge">
          {slabName} · {displayCostStr}
        </span>
      </div>
    </div>
  )
}

// Returns the active date string honouring the 6 AM IST boundary
// (mirrors getActiveDateStr in useHomeData.js)
function getActiveDateStr() {
  const now = new Date()
  const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  if (istNow.getHours() < 6) istNow.setDate(istNow.getDate() - 1)
  const y = istNow.getFullYear()
  const m = String(istNow.getMonth() + 1).padStart(2, '0')
  const d = String(istNow.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export default function Energy() {
  const { household } = useAuth()

  // activeDateStr respects the 6 AM IST boundary (same rule as the hook)
  const activeDateStr = getActiveDateStr()
  // todayStr is the raw calendar date (used only for the date-picker max)
  const todayStr = new Date().toISOString().split('T')[0]

  const [viewMode, setViewMode] = useState('Daily')
  const [selectedDateStr, setSelectedDateStr] = useState(activeDateStr)

  const { data, loading, error } = useHomeData(household?.id, viewMode, selectedDateStr)

  const selectedDate = useMemo(() => new Date(selectedDateStr), [selectedDateStr])

  // Daily mode data processing
  const isLiveDate = selectedDateStr === activeDateStr
  const dailyCostObj = data?.dailyCosts?.find(d => d.report_date === selectedDateStr)

  const dailyMeasuredKwh = parseFloat(dailyCostObj?.measured_kwh || 0)
  const dailyEstimatedFullHome = parseFloat(dailyCostObj?.estimated_kwh || 0)
  const dailyEstimatedCost = Math.round(dailyCostObj?.daily_cost || 0)
  const _dailySlabInfo = getDailySlabRate(dailyEstimatedFullHome)
  const dailyCostSub = _dailySlabInfo.rate === 0 ? 'Free' : `Slab ${_dailySlabInfo.slab} · ₹${_dailySlabInfo.rate}/unit`
  const dailyReport = data?.report
  const dailyCoverage = parseFloat(dailyReport?.coverage_ratio ?? 0.6)

  const dailyDevices = useMemo(() => {
    if (data?.today?.devices) {
      return data.today.devices.map(d => ({
        name: d.name,
        kwh: parseFloat(d.kwh || 0),
        minutes: parseInt(d.minutes || 0, 10),
        type: d.type || 'Unknown Device'
      }))
    }
    return []
  }, [data?.today?.devices])

  // Add console logs for Energy Page
  useEffect(() => {
    if (!loading && data) {
      const activeDay = getActiveDateStr()
      const sourceUsed = selectedDateStr === activeDay ? 'live' : 'snapshot'
      const measuredValue = dailyMeasuredKwh
      const deviceCount = dailyDevices.length
      console.log('Energy Page Logs:')
      console.log('selectedDate', selectedDateStr)
      console.log('activeDay', activeDay)
      console.log('sourceUsed', sourceUsed)
      console.log('measuredValue', measuredValue)
      console.log('deviceCount', deviceCount)
    }
  }, [loading, data, selectedDateStr, dailyMeasuredKwh, dailyDevices])

  const topDevice = useMemo(() => {
    const devicesList = viewMode === 'Daily' ? dailyDevices : (data?.today?.devices || [])
    if (devicesList.length === 0) return null
    return [...devicesList].sort((a, b) => (b.kwh || 0) - (a.kwh || 0))[0]
  }, [viewMode, dailyDevices, data?.today?.devices])

  const dailyDevicesMapped = useMemo(() => {
    return dailyDevices.map((dev, i) => ({
      name: dev.name,
      loc: dev.type || 'Unknown Loc',
      mins: dev.minutes,
      kwh: dev.kwh,
      pct: (dailyMeasuredKwh > 0) ? (dev.kwh / dailyMeasuredKwh * 100) : 0,
      color: ['var(--Am)','#1A5FB4','var(--Gm)'][i] || '#888',
      ico: (dev.name || '').toLowerCase().includes('ac') ? 'ac' : 'pump',
      carried: null
    }))
  }, [dailyDevices, dailyMeasuredKwh])

  useEffect(() => {
    document.documentElement.style.setProperty('--bg', '#F2EFE9')
    document.documentElement.style.setProperty('--surface', '#FFF')
    document.documentElement.style.setProperty('--s2', '#F0EDE7')
    document.documentElement.style.setProperty('--s3', '#E8E4DE')
    document.documentElement.style.setProperty('--b', 'rgba(0,0,0,.07)')
    document.documentElement.style.setProperty('--b2', 'rgba(0,0,0,.12)')
    document.documentElement.style.setProperty('--tx', '#1A1916')
    document.documentElement.style.setProperty('--tx2', '#6B6860')
    document.documentElement.style.setProperty('--tx3', '#A8A59E')
    document.documentElement.style.setProperty('--G', '#1F6E3F')
    document.documentElement.style.setProperty('--Gbg', '#E3F5E9')
    document.documentElement.style.setProperty('--Gm', '#2D7D46')
    document.documentElement.style.setProperty('--A', '#B87200')
    document.documentElement.style.setProperty('--Abg', '#FEF3DC')
    document.documentElement.style.setProperty('--Am', '#D4880A')
    document.documentElement.style.setProperty('--R', '#A8261E')
    document.documentElement.style.setProperty('--Rbg', '#FDECEA')
    document.documentElement.style.setProperty('--Rm', '#C0392B')
    document.documentElement.style.setProperty('--Bl', '#1558A8')
    document.documentElement.style.setProperty('--Blbg', '#E4EEFF')
    document.documentElement.style.setProperty('--P', '#4A3490')
    document.documentElement.style.setProperty('--Pbg', '#EEEAFF')
    document.documentElement.style.setProperty('--Pm', '#5B3FA6')
    document.documentElement.style.setProperty('--r', '14px')
    document.documentElement.style.setProperty('--rs', '10px')
  }, [])

  const handleTab = (mode) => {
    setViewMode(mode)
    setSelectedDateStr(activeDateStr)
  }

  const shiftDate = (direction) => {
    const d = new Date(selectedDateStr)
    if (viewMode === 'Daily') d.setDate(d.getDate() + direction)
    else if (viewMode === 'Weekly') d.setDate(d.getDate() + (direction * 7))
    else if (viewMode === 'Billing Cycle') d.setMonth(d.getMonth() + (direction * 2))
    else if (viewMode === 'Yearly') d.setFullYear(d.getFullYear() + direction)
    setSelectedDateStr(d.toISOString().split('T')[0])
  }

  // ── Fix 2 & 4: use activeDateStr (6 AM IST boundary) not raw todayStr ───────
  const isTodayStr    = isLiveDate                         // keep alias for other code
  const isCurrentWeek = selectedDateStr >= activeDateStr
  const isCurrentCycle = data?.billing?.cycle_end ? data.billing.cycle_end >= activeDateStr : selectedDateStr >= activeDateStr
  const isCurrentYear = new Date(selectedDateStr).getFullYear() === new Date().getFullYear()

  // Fix 4: > button disabled when already at the active (latest) date
  const disableNext =
    viewMode === 'Daily'          ? isLiveDate :
    viewMode === 'Weekly'         ? isCurrentWeek :
    viewMode === 'Billing Cycle'  ? isCurrentCycle :
    viewMode === 'Yearly'         ? isCurrentYear : false

  let navLabel = ''
  if (viewMode === 'Daily') {
    navLabel = new Date(selectedDateStr).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  } else if (viewMode === 'Weekly') {
    const d = new Date(selectedDateStr + 'T00:00:00')
    const day = d.getDay()
    const diff = (day === 0 ? -6 : 1) - day
    const monday = new Date(d)
    monday.setDate(d.getDate() + diff)
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    
    navLabel = `${monday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${sunday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
  } else if (viewMode === 'Billing Cycle') {
    if (data?.billing?.cycle_start && data?.billing?.cycle_end) {
      const bStart = new Date(data.billing.cycle_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      const bEnd = new Date(data.billing.cycle_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      navLabel = `${bStart} – ${bEnd}`
    } else {
      navLabel = 'Loading...'
    }
  } else if (viewMode === 'Yearly') {
    navLabel = new Date(selectedDateStr).getFullYear().toString()
  }

  const billing = data?.billing
  const cycleStart = billing?.cycle_start ? new Date(billing.cycle_start) : null
  const cycleEnd = billing?.cycle_end ? new Date(billing.cycle_end) : null
  const currentTime = isTodayStr ? new Date() : new Date(selectedDateStr)

  const cycleDay = (cycleStart && cycleEnd)
    ? Math.min(Math.floor((currentTime - cycleStart) / (1000 * 60 * 60 * 24)) + 1, Math.floor((cycleEnd - cycleStart) / (1000 * 60 * 60 * 24)) + 1)
    : '—'

  // Dynamic TNEB cost and slab computations
  const cycleEstimated   = parseFloat(billing?.kwh_estimated ?? 0)
  const cycleAccumulated = parseFloat(billing?.kwh_accumulated ?? 0)
  const estKwh           = parseFloat(data?.today?.estimated_full_home_kwh ?? 0)

  const activeSlab = getCurrentSlab(cycleEstimated)
  const currentRate = activeSlab.rate

  let calculatedCost = 0
  let weeklyCostSub = 'Sum of daily costs'
  if (viewMode === 'Billing Cycle') {
    calculatedCost = Math.round(billing?.billing_cycle_cost ?? 0)
  } else if (viewMode === 'Weekly') {
    calculatedCost = Math.round(data?.today?.weekly_cost ?? 0)
  } else if (viewMode === 'Yearly') {
    calculatedCost = Math.round(data?.today?.yearly_cost ?? 0)
  } else {
    calculatedCost = Math.round(data?.today?.daily_cost ?? 0)
  }

  const mockD = DAYS[5]

  const d = {
    label: navLabel,
    kwh: viewMode === 'Daily' ? dailyMeasuredKwh : parseFloat(data?.today?.total_kwh ?? 0),
    est: viewMode === 'Daily' ? dailyEstimatedFullHome : estKwh,
    cost: viewMode === 'Daily' ? `₹${dailyEstimatedCost.toLocaleString()}` : `₹${calculatedCost.toLocaleString()}`,
    runtime: viewMode === 'Daily' ? (topDevice ? fmt(topDevice.minutes) : '—') : mockD.runtime,
    costSub: viewMode === 'Daily' ? dailyCostSub : (viewMode === 'Weekly' || viewMode === 'Yearly' ? weeklyCostSub : (activeSlab.rate === 0
      ? 'Free'
      : `Slab ${activeSlab.num} · ₹${activeSlab.rate}/unit`)),
    devices: viewMode === 'Daily' ? dailyDevicesMapped : (data?.today?.devices ?? []).map((dev, i) => ({
      name: dev.name,
      loc: dev.type || 'Unknown Loc',
      mins: dev.minutes,
      kwh: dev.kwh,
      pct: (parseFloat(data?.today?.total_kwh ?? 0) > 0) ? (dev.kwh / data.today.total_kwh * 100) : 0,
      color: ['var(--Am)','#1A5FB4','var(--Gm)'][i] || '#888',
      ico: (dev.name || '').toLowerCase().includes('ac') ? 'ac' : 'pump',
      carried: null
    })),
    openSession: viewMode === 'Daily' 
      ? (isTodayStr && data?.today?.open_sessions?.[0] ? {
          name: data.today.open_sessions[0].name,
          since: data.today.open_sessions[0].started_ist,
        } : null)
      : (data?.today?.open_sessions?.[0] ? {
          name: data.today.open_sessions[0].name,
          since: data.today.open_sessions[0].started_ist,
        } : null),
    tip: {
      head: viewMode === 'Daily'
        ? (dailyReport?.tip_text ?? 'No data recorded for this date')
        : (data?.report?.tip_text ?? 'No data recorded for this date'),
      body: viewMode === 'Daily'
        ? (dailyReport?.tip_text ? 'Insights are generated algorithmically based on session length compared to similar historical weather points. See BEE recommendations for saving tips.' : '')
        : (data?.report?.tip_text ? 'Insights are generated algorithmically based on session length compared to similar historical weather points. See BEE recommendations for saving tips.' : ''),
      kwh: '', time: ''
    }
  }

  console.log('CARD DATA', d)
  console.log('MEASURED CARD VALUE', d.kwh)
  console.log('VIEW MODE', viewMode)
  console.log('METRIC CARD OBJECT', {
    kwh: d.kwh,
    estimated: d.est,
    cost: d.cost,
    viewMode
  })
    
  const startFmt = cycleStart ? cycleStart.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: new Date().getFullYear() !== cycleStart.getFullYear() ? 'numeric' : undefined }) : '—'
  const endFmt = cycleEnd ? cycleEnd.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: new Date().getFullYear() !== cycleEnd.getFullYear() ? 'numeric' : undefined }) : '—'
  
  const daysLeft = cycleEnd 
    ? Math.max(0, Math.ceil((cycleEnd - currentTime) / (1000 * 60 * 60 * 24)))
    : '—'

  const dDate = new Date(selectedDateStr + 'T00:00:00')
  const dayOfWeek = dDate.getDay()
  const diffOfWeek = (dayOfWeek === 0 ? -6 : 1) - dayOfWeek
  const mondayOfWeek = new Date(dDate)
  mondayOfWeek.setDate(dDate.getDate() + diffOfWeek)
  const mondayStr = mondayOfWeek.toISOString().split('T')[0]
  const sundayOfWeek = new Date(mondayOfWeek)
  sundayOfWeek.setDate(mondayOfWeek.getDate() + 6)
  const sundayStr = sundayOfWeek.toISOString().split('T')[0]

  const weeklyMeasuredFromSnapshots = (data?.dailyCosts || [])
    .filter(s => s.report_date >= mondayStr && s.report_date <= sundayStr)
    .reduce((sum, s) => sum + parseFloat(s.measured_kwh || 0), 0)

  const weeklyMeasuredFromDevices = (data?.today?.devices || [])
    .reduce((sum, dev) => sum + parseFloat(dev.kwh || 0), 0)

  const displayedMeasuredValue = viewMode === 'Daily' ? dailyMeasuredKwh : parseFloat(data?.today?.total_kwh ?? 0)

  console.log('weeklyMeasuredFromSnapshots', weeklyMeasuredFromSnapshots)
  console.log('weeklyMeasuredFromDevices', weeklyMeasuredFromDevices)
  console.log('displayedMeasuredValue', displayedMeasuredValue)

  // ── Dynamic performance badge ─────────────────────────────────────────
  function getDailyBadge(kwh) {
    if (!kwh || kwh === 0) return null
    if (kwh <= 5)  return { label: 'low',           icon: '↓↓', bg: '#EAF3DE', color: '#27500A' }
    if (kwh <= 8)  return { label: 'below average', icon: '↓',  bg: '#EAF3DE', color: '#27500A' }
    if (kwh <= 12) return { label: 'average day',   icon: '~',  bg: '#F1EFE8', color: '#444441' }
    if (kwh < 15)  return { label: 'above average', icon: '↑',  bg: '#FCEBEB', color: '#791F1F' }
    return             { label: 'high',          icon: '↑↑', bg: '#FCEBEB', color: '#791F1F' }
  }
  function getWeeklyBadge(thisWeek, lastWeek) {
    if (!lastWeek || lastWeek === 0) return null
    const pct = Math.round(((thisWeek - lastWeek) / lastWeek) * 100)
    if (pct <= -10) return { label: `${Math.abs(pct)}% less than last week`, icon: '↓', bg: '#EAF3DE', color: '#27500A' }
    if (pct >= 10)  return { label: `${pct}% more than last week`,           icon: '↑', bg: '#FCEBEB', color: '#791F1F' }
    return               { label: 'similar to last week',                   icon: '~', bg: '#F1EFE8', color: '#444441' }
  }

  const _lastWeekKwh   = parseFloat(data?.today?.last_week_kwh   ?? 0)
  const _cycleDailyAvg = parseFloat(data?.today?.cycle_daily_avg ?? 0)

  const badge =
    viewMode === 'Daily'
      ? getDailyBadge(dailyMeasuredKwh)
      : viewMode === 'Weekly'
        ? getWeeklyBadge(parseFloat(data?.today?.total_kwh ?? 0), _lastWeekKwh)
        : getDailyBadge(_cycleDailyAvg)

  console.log('ENERGY PAGE DEVICES', dailyDevices);
  return (
    <div className="min-h-screen bg-[var(--bg)] pb-24">
      <style>{`
        .e-hdr { background:var(--surface); padding:14px 16px 14px; border-bottom:1px solid var(--b); position:sticky; top:0; z-index:20; }
        .e-hdr-row { display:flex; justify-content:space-between; align-items:flex-start; }
        .e-hdr-title { font-size:22px; font-weight:500; color:var(--tx); letter-spacing:-.4px; }
        .e-hdr-sub { font-size:12px; color:var(--tx2); margin-top:2px; }
        .e-badge { display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:700; padding:3px 9px; border-radius:20px; letter-spacing:.03em; }
        .e-pills { display:flex; gap:6px; padding:10px 14px 6px; overflow-x:auto; scrollbar-width:none; background:var(--surface); border-bottom:1px solid var(--b); }
        .e-pills::-webkit-scrollbar { display:none; }
        .e-pill { flex-shrink:0; display:flex; flex-direction:column; align-items:center; gap:2px; padding:6px 11px; border-radius:10px; cursor:pointer; border:1px solid var(--b2); background:var(--surface); transition:all .15s; }
        .e-pill.e-active { background:var(--tx); border-color:var(--tx); }
        .e-pill-day { font-size:10px; font-weight:600; }
        .e-pill-kwh { font-size:9px; font-weight:500; }
        .e-pill.e-active .e-pill-day, .e-pill.e-active .e-pill-kwh { color:var(--surface); }
        .e-pill:not(.e-active) .e-pill-day { color:var(--tx2); }
        .e-pill:not(.e-active) .e-pill-kwh { color:var(--tx3); }
        .e-pill.e-partial { border-style:dashed; }
        .e-section-lbl { font-size:10px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:var(--tx3); margin:14px 0 8px; padding:0 14px; }
        .e-card { background:var(--surface); border-radius:var(--r); padding:15px 16px; margin:0 14px 10px; border:.5px solid var(--b2); }
        .e-divider { height:.5px; background:var(--b); margin:11px 0; }
        .e-row { display:flex; justify-content:space-between; align-items:center; }
        .e-mgrid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin:0 14px 10px; }
        .e-metric { background:var(--surface); border-radius:var(--rs); padding:13px 14px; border:.5px solid var(--b2); }
        .e-m-lbl { font-size:10px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; color:var(--tx3); margin-bottom:6px; }
        .e-m-val { font-size:22px; font-weight:500; color:var(--tx); letter-spacing:-.5px; line-height:1.1; }
        .e-m-unit { font-size:12px; color:var(--tx2); font-weight:400; margin-left:2px; }
        .e-m-sub { font-size:11px; color:var(--tx2); margin-top:4px; }
        .e-dev-item { display:flex; align-items:center; gap:11px; padding:10px 0; }
        .e-dev-item+.e-dev-item { border-top:.5px solid var(--b); }
        .e-dev-ico { width:34px; height:34px; border-radius:50%; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .e-dev-info { flex:1; min-width:0; }
        .e-dev-name { font-size:13px; font-weight:500; color:var(--tx); }
        .e-dev-meta { font-size:11px; color:var(--tx2); margin-top:1px; }
        .e-dev-bar-bg { height:4px; background:var(--s2); border-radius:2px; overflow:hidden; margin-top:5px; }
        .e-dev-bar { height:100%; border-radius:2px; transition:width .5s ease; }
        .e-dev-kwh { font-size:14px; font-weight:500; white-space:nowrap; text-align:right; }
        .e-dev-pct { font-size:10px; color:var(--tx3); text-align:right; margin-top:2px; }
        .e-seg-track { display:flex; height:8px; border-radius:4px; overflow:hidden; margin:8px 0 4px; }
        .e-seg { height:100%; }
        .e-slab-row { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:5px; margin:9px 0; }
        .e-sp { border-radius:8px; padding:7px 4px; text-align:center; }
        .e-sp .sn { font-size:9px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; }
        .e-sp .sr { font-size:12px; font-weight:500; margin-top:1px; }
        .e-sp .ss { font-size:9px; margin-top:2px; }
        .e-sp-ring { border:1.5px solid currentColor; }
        .e-sp-bar-bg { height:3px; background:rgba(0,0,0,0.06); border-radius:2px; margin:5px auto 0; width:80%; overflow:hidden; }
        .e-sp-bar { height:100%; border-radius:2px; transition:width .5s ease; }
        .e-proj-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; text-align:center; margin-top:2px; }
        .e-prc { border-radius:9px; padding:8px 5px; }
        .e-prc-lbl { font-size:10px; color:var(--tx3); }
        .e-prc-val { font-size:14px; font-weight:500; margin-top:3px; }
        .e-chart-area { display:flex; align-items:flex-end; gap:5px; height:80px; position:relative; }
        .e-bc { flex:1; display:flex; flex-direction:column; align-items:center; gap:4px; height:100%; }
        .e-bw { flex:1; display:flex; flex-direction:column; justify-content:flex-end; position:relative; width:100%; }
        .e-bb { width:100%; border-radius:4px 4px 0 0; min-height:3px; }
        .e-bl { font-size:10px; color:var(--tx3); font-weight:500; }
        .e-bval { position:absolute; top:-17px; left:50%; transform:translateX(-50%); font-size:10px; font-weight:700; white-space:nowrap; padding:1px 5px; border-radius:5px; }
        .e-insight { border-radius:var(--r); padding:15px 16px; margin:0 14px 10px; border:.5px solid rgba(91,63,166,.25); background:var(--Pbg); }
        .e-i-tag { font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--Pm); margin-bottom:8px; display:flex; align-items:center; gap:5px; }
        .e-i-head { font-size:14px; font-weight:500; color:#1E1258; line-height:1.45; margin-bottom:6px; }
        .e-i-head { font-size:14px; font-weight:500; color:#1E1258; line-height:1.45; margin-bottom:6px; }
        .e-i-body { font-size:12px; color:#3C3489; line-height:1.6; }
        .e-share-row { display:flex; justify-content:space-between; align-items:center; margin-top:10px; padding-top:10px; border-top:.5px solid rgba(91,63,166,.15); }
        .e-share-btn { display:flex; align-items:center; gap:5px; font-size:12px; font-weight:500; padding:5px 12px; border-radius:20px; cursor:pointer; background:rgba(91,63,166,.1); color:var(--Pm); border:none; font-family:inherit; }
        .e-carried { font-size:10px; color:var(--tx3); background:var(--s2); border-radius:6px; padding:2px 7px; display:inline-block; margin-top:3px; }
        .e-open-banner { border-radius:10px; padding:9px 13px; display:flex; gap:8px; align-items:center; margin-top:10px; font-size:12px; background:var(--Abg); border:.5px solid #FAC775; color:#633806;}
        .e-pay-btn { border:none; border-radius:10px; padding:11px; font-size:13px; font-weight:500; cursor:pointer; font-family:inherit; width:100%; margin-top:10px; transition:opacity .15s; background:var(--s2); color:var(--tx2); }
        .e-card,.e-mgrid,.e-insight { animation:up .22s ease both; }
        @keyframes up { from{opacity:0;transform:translateY(8px);} to{opacity:1;transform:translateY(0);} }

        .energy-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px 16px 10px;
          position: sticky;
          top: 0;
          background: #fff;
          z-index: 10;
          border-bottom: 1px solid var(--b);
        }
        .energy-header h1 {
          font-family: 'DM Serif Display', serif;
          font-size: 22px;
          font-weight: 500;
          color: #1A1916;
          letter-spacing: -0.4px;
        }
        .energy-header p {
          font-size: 13px;
          color: #777;
          margin-top: 2px;
        }
        .slab-badge {
          background: #f3e8d5;
          color: #7a5c00;
          padding: 6px 12px;
          border-radius: 16px;
          font-size: 12px;
          font-weight: 600;
          display: inline-block;
        }
      `}</style>
      
      <EnergyHeader
        cycleDay={cycleDay}
        startDate={startFmt}
        endDate={endFmt}
        slabName={data?.today?.slab_name || 'Free'}
        cost={data?.today?.daily_cost || 0}
      />

      {/* TABS + DATE NAVIGATOR */}
      <div className="bg-[var(--surface)] border-b border-[var(--b)] text-[var(--tx)]">
        <div className="flex gap-1.5 px-4 py-3 overflow-x-auto scrollbar-hide">
          {['Daily', 'Weekly', 'Billing Cycle', 'Yearly'].map(m => (
            <button
              key={m}
              onClick={() => handleTab(m)}
              className={`px-4 py-2 text-[13px] font-semibold whitespace-nowrap transition-all duration-200 rounded-full ${
                viewMode === m 
                  ? 'bg-[#1A1916] text-white shadow-sm' 
                  : 'bg-[#F0EDE7] text-[#6B6860] hover:bg-[#E8E4DE]'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        
        <div className="flex items-center justify-between px-4 py-3.5">
          <button 
            onClick={() => shiftDate(-1)}
            className="w-9 h-9 rounded-full border border-[var(--b2)] flex justify-center items-center text-[20px] transition-opacity"
          >
            ‹
          </button>
          <label className="relative cursor-pointer flex items-center gap-2 px-1 py-1 rounded-lg hover:bg-black/5 transition-colors group">
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
            className={`w-9 h-9 rounded-full border border-[var(--b2)] flex justify-center items-center text-[20px] transition-opacity ${disableNext ? 'opacity-30 cursor-default pointer-events-none' : ''}`}
          >
            ›
          </button>
        </div>
      </div>

      {/* SUMMARY METRICS */}
      {/* Fix 3: show '6 AM – now' for the live/active date, '6 AM – 6 AM' for past dates */}
      <div className="e-section-lbl">{d.label} · {isLiveDate ? '6 AM – now' : '6 AM – 6 AM'}</div>
      <div className="e-mgrid">
        <div className="e-metric">
          <div className="e-m-lbl">Measured</div>
          <div><span className="e-m-val">{d.kwh.toFixed(1)}</span><span className="e-m-unit">kWh</span></div>
          <div className="e-m-sub" style={{ marginTop: 5 }}>
            {badge && (
              <>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 20,
                  background: badge.bg, color: badge.color,
                }}>
                  {badge.icon} {badge.label}
                </span>
                <div style={{ fontSize: 10, color: 'var(--tx3)', marginTop: 3 }}>
                  {viewMode === 'Daily' && 'typical: 9–12 kWh/day'}
                  {viewMode === 'Weekly' && _lastWeekKwh > 0 && `last week: ${_lastWeekKwh.toFixed(1)} kWh`}
                  {viewMode === 'Billing Cycle' && _cycleDailyAvg > 0 && `avg ${_cycleDailyAvg.toFixed(1)} kWh/day since ${startFmt}`}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="e-metric">
          <div className="e-m-lbl">Est. full home</div>
          <div><span className="e-m-val">{d.est.toFixed(1)}</span><span className="e-m-unit">kWh</span></div>
          <div className="e-m-sub" style={{ color: 'var(--tx3)' }}>
            {viewMode === 'Daily' ? `${(dailyCoverage * 100).toFixed(0)}% coverage` : '60% coverage'}
          </div>
        </div>
        <div className="e-metric">
          <div className="e-m-lbl">Cost today</div>
          <div><span className="e-m-val">{d.cost}</span></div>
          <div className="e-m-sub" style={{ color: 'var(--tx3)' }}>{d.costSub}</div>
        </div>
        <div className="e-metric">
          <div className="e-m-lbl">TOP DEVICE</div>
          <div className="e-m-val" style={{ fontSize: 14, fontWeight: 500, marginTop: 1, color: 'var(--tx)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {topDevice ? topDevice.name : 'No device usage'}
          </div>
          <div className="e-m-sub" style={{ color: 'var(--tx2)', fontSize: 11, marginTop: 2, display: 'flex', flexDirection: 'column' }}>
            {topDevice ? (
              <>
                <span>{fmt(topDevice.minutes || topDevice.mins)}</span>
                <span>{parseFloat(topDevice.kwh).toFixed(2)} kWh</span>
              </>
            ) : 'No device usage'}
          </div>
        </div>
      </div>

      {/* DEVICE BREAKDOWN */}
      <div className="e-section-lbl">Appliance breakdown</div>
      <div className="e-card">
        {d.devices.map((dev, i) => {
          const max = Math.max(...d.devices.map(x => x.kwh))
          const barW = Math.round((dev.kwh / max) * 100)
          const icoColor = ['#D4880A','#1A5FB4','#2D7D46'][i] || '#888'
          const bgColor = ICO_BGS[i] || 'var(--s2)'

          return (
            <div key={i} className="e-dev-item">
              <div className="e-dev-ico" style={{ background: bgColor }}>
                {ICONS[dev.ico] && ICONS[dev.ico](icoColor)}
              </div>
              <div className="e-dev-info">
                <div className="e-row">
                  <span className="e-dev-name">{dev.name}</span>
                  <span className="e-dev-kwh" style={{ color: i === 0 ? 'var(--Am)' : 'var(--tx)' }}>{dev.kwh.toFixed(2)} kWh</span>
                </div>
                <div className="e-row" style={{ marginTop: 1 }}>
                  <span className="e-dev-meta">{dev.loc} · {fmt(dev.mins)} · data from Tapo</span>
                  <span className="e-dev-pct">{dev.pct.toFixed(1)}%</span>
                </div>
                {dev.carried && <span className="e-carried">+{dev.carried} kWh carried from prev session</span>}
                <div className="e-dev-bar-bg"><div className="e-dev-bar" style={{ width: `${barW}%`, background: icoColor }}></div></div>
              </div>
            </div>
          )
        })}

        {d.openSession && (
          <div className="e-open-banner">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" style={{ flexShrink: 0 }}>
              <path d="M7.5 1L14 13H1L7.5 1Z" stroke="#D4880A" strokeWidth="1.3" strokeLinejoin="round"/>
              <path d="M7.5 5.5v3.5" stroke="#D4880A" strokeWidth="1.3" strokeLinecap="round"/>
              <circle cx="7.5" cy="11.5" r=".65" fill="#D4880A"/>
            </svg>
            <div><strong>{d.openSession.name}</strong> still on since {d.openSession.since} — not in today's count · appears in tomorrow's report</div>
          </div>
        )}
        {d.devices.length > 0 && (
          <Link 
            to="/appliances" 
            className="flex items-center justify-between w-full bg-[#E3F5E9] hover:bg-[#D5EEDD] border border-[#1F6E3F]/10 rounded-xl px-4 py-3 mt-2.5 transition-all group no-underline"
          >
            <span className="text-[13px] font-semibold text-[#2D7D46]">Dive deep into appliances reading</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="transform group-hover:translate-x-1 transition-transform">
              <path d="M5 12h14M12 5l7 7-7 7" stroke="#2D7D46" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
        )}

        <div className="e-divider"></div>
        <div className="e-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: 'var(--tx2)', fontWeight: 500 }}>
              {(() => {
                const activeSessions = data?.today?.open_sessions || []
                if (activeSessions.length === 0) return 'No sessions right now'
                if (activeSessions.length > 1) return `${activeSessions.length} devices currently running`
                return `${activeSessions[0].name} is still running`
              })()}
            </div>
            <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 2 }}>{data?.today?.session_count || 0} sessions {viewMode === 'Daily' ? 'today' : viewMode === 'Weekly' ? 'this week' : 'this cycle'}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{d.kwh.toFixed(2)} kWh</div>
            <div style={{ fontSize: 11, color: 'var(--tx3)' }}>~{d.est} est. full home</div>
          </div>
        </div>
      </div>

      {/* BILLING CYCLE */}
      <div className="e-section-lbl">Usage overview · {viewMode}</div>
      <EnergyGraph 
        viewMode={viewMode} 
        householdId={household?.id}
        cycleStart={data?.billing?.cycle_start}
        cycleEnd={data?.billing?.cycle_end}
        slabCrossingDate={data?.billing?.slab_crossing_date}
        selectedDate={selectedDateStr}
      />

      {/* BILLING CYCLE (Premium Slab Card matching Home.jsx) */}
      {viewMode !== 'Yearly' && (
        <>
          <div className="e-section-lbl">Billing cycle · TNEB LA1A</div>
          <div className="e-card" style={{ padding: '16px 16px' }}>
            {(() => {
              const measuredUnits = parseFloat(billing?.kwh_accumulated ?? 0)
              const estimatedUnits = parseFloat(billing?.kwh_estimated ?? 0)

              const isAbove500    = estimatedUnits > 500
              const currentSlab   = getCurrentSlab(estimatedUnits)
              const estimatedBill = Math.round(billing?.billing_cycle_cost ?? calculateTNEBBill(estimatedUnits))
              const unitsLeftInSlab = currentSlab.max >= 99999
                ? null
                : Math.max(0, currentSlab.max - estimatedUnits)

              const cycleStart = billing?.cycle_start ? new Date(billing.cycle_start) : null
              const cycleEnd   = billing?.cycle_end   ? new Date(billing.cycle_end)   : null
              const today      = new Date()

              const dLeft    = cycleEnd ? Math.max(0, Math.ceil((cycleEnd - today) / (1000 * 60 * 60 * 24))) : 0
              const dElapsed = cycleStart ? Math.max(1, Math.ceil((today - cycleStart) / (1000 * 60 * 60 * 24))) : 1
              const pace     = measuredUnits / dElapsed
              const projectedTotal = measuredUnits + (pace * dLeft)

              const TOTAL_BAR = isAbove500 ? 1000 : 500
              const measuredPct  = Math.min((measuredUnits  / TOTAL_BAR) * 100, 100)
              const estimatedPct = Math.min((estimatedUnits / TOTAL_BAR) * 100, 100)
              const activeSlabs  = getSlabs(estimatedUnits)

              // ── Case 1 tip (below 500) ─────────────────────────────────────────────────
              let normalTip = ''
              if (!isAbove500) {
                if (currentSlab.num === 4 && unitsLeftInSlab > 0) {
                  normalTip = `Est. total ${estimatedUnits.toFixed(0)} units — ${unitsLeftInSlab.toFixed(0)} units before Slab 4 limit (500 units). At ₹6.30/unit after 400 units.`
                } else if (currentSlab.num < 4 && projectedTotal > currentSlab.max) {
                  const crossDate = new Date(today)
                  const dToNext = pace > 0 ? Math.ceil((currentSlab.max - measuredUnits) / pace) : 0
                  crossDate.setDate(today.getDate() + dToNext)
                  const nextSlab = SLABS_BELOW_500[currentSlab.num]
                  normalTip = `At this rate you'll enter Slab ${nextSlab.num} (₹${nextSlab.rate}/unit) around ${crossDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}. Reduce AC by 1–2 hrs/day to stay in Slab ${currentSlab.num}.`
                } else {
                  normalTip = `On track. Est. to finish cycle at ${projectedTotal.toFixed(0)} units — staying in Slab ${currentSlab.num} (₹${currentSlab.rate}/unit).`
                }
              }

              // Next slab for above-500 warning banner
              const nextSlabAbove = isAbove500
                ? SLABS_ABOVE_500.find(s => s.num === currentSlab.num + 1) ?? null
                : null

              return (
                <>
                  {/* Header row */}
                  <div className="e-row" style={{ marginBottom: 4 }}>
                    <span style={{ fontSize: 12, color: 'var(--tx2)' }}>{startFmt} – {endFmt}</span>
                    <span className="badge text-[10px] font-bold" style={{ background: currentSlab.color + '18', color: currentSlab.color, padding: '3px 8px', borderRadius: 12 }}>
                      Slab {currentSlab.num} · {currentSlab.rate === 0 ? 'Free' : `₹${currentSlab.rate}/unit`}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div style={{ marginBottom: 36, marginTop: 16, paddingLeft: 4, paddingRight: 4 }}>
                    <div style={{ position: 'relative', height: 10, borderRadius: 5, background: 'rgba(0,0,0,0.05)', overflow: 'visible' }}>
                      <div style={{ display: 'flex', height: '100%', borderRadius: 5, overflow: 'hidden' }}>
                        {activeSlabs.map(s => {
                          const slabUnits = Math.min(s.max, TOTAL_BAR) - s.min + 1
                          const widthPct  = (Math.min(slabUnits, TOTAL_BAR) / TOTAL_BAR) * 100
                          return (
                            <div key={s.num} style={{
                              width: `${widthPct}%`,
                              background: estimatedUnits >= s.min ? s.color : 'rgba(0,0,0,0.1)',
                              opacity: estimatedUnits >= s.min ? 1 : 0.2,
                              flexShrink: 0,
                            }} />
                          )
                        })}
                      </div>
                      {/* Measured marker */}
                      <div style={{ position: 'absolute', top: -3, left: `${measuredPct}%`, width: 2, height: 16, background: '#333', borderRadius: 1, transform: 'translateX(-50%)', zIndex: 10 }} />
                      <div style={{ position: 'absolute', top: 14, left: `${measuredPct}%`, transform: 'translateX(-50%)', fontSize: 9, fontWeight: 700, color: '#666', whiteSpace: 'nowrap' }}>
                        {measuredUnits.toFixed(0)} measured
                      </div>
                      {/* Estimated triangle */}
                      <div style={{ position: 'absolute', top: -8, left: `${estimatedPct}%`, width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '8px solid #333', transform: 'translateX(-50%)' }} />
                    </div>
                  </div>

                  {/* Stats row */}
                  <div className="flex justify-between items-end mb-4">
                    <div>
                      <div className="text-[11px] text-tx-3 mb-0.5">
                        {measuredUnits.toFixed(0)} measured · {estimatedUnits.toFixed(0)} est. total
                      </div>
                      <div className="text-[13px] font-bold text-tx">
                        {estimatedUnits.toFixed(0)} units ·{' '}
                        {unitsLeftInSlab !== null && unitsLeftInSlab > 0
                          ? `${unitsLeftInSlab.toFixed(0)} left in Slab ${currentSlab.num}`
                          : unitsLeftInSlab === 0
                            ? `Reached end of Slab ${currentSlab.num}`
                            : `In final slab`}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-tx-3 uppercase font-bold tracking-wider">Est. Bill</div>
                      <div className="text-xl font-bold text-tx">₹{estimatedBill.toLocaleString()}</div>
                    </div>
                  </div>

                  {/* CASE 1 — Below 500: 4-card horizontal grid */}
                  {!isAbove500 && (
                    <>
                      <div className="grid grid-cols-4 gap-2 mb-4">
                        {SLABS_BELOW_500.map(s => {
                          const isNow  = s.num === currentSlab.num
                          const isDone = estimatedUnits > s.max
                          return (
                            <div key={s.num}
                              className={`rounded-xl py-2.5 px-1 text-center border-[1.5px] transition-all ${isNow ? '' : 'opacity-60'}`}
                              style={{
                                background: isNow ? s.color + '10' : isDone ? s.color + '05' : 'transparent',
                                borderColor: isNow ? s.color : 'rgba(0,0,0,0.05)',
                              }}>
                              <div className="text-[9px] font-bold uppercase tracking-wider mb-0.5" style={{ color: s.color }}>
                                Slab {s.num}
                              </div>
                              <div className="text-[13px] font-bold text-tx">{s.label}</div>
                              <div className="text-[8px] text-tx-3 mb-1">{s.min}–{s.max} units</div>
                              <div className="text-[9px] font-bold" style={{ color: (isNow || isDone) ? s.color : '#A8A59E' }}>
                                {isNow
                                  ? `Now · ${(unitsLeftInSlab ?? 0).toFixed(0)} left`
                                  : isDone ? 'Done ✓' : 'Soon'}
                              </div>
                            </div>
                          )
                        })}
                      </div>

                      {/* Savings insight tip */}
                      <div className="bg-surface-2 rounded-xl p-3 border border-black/5 mb-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className="w-5 h-5 rounded-full bg-brand-yellow/20 flex items-center justify-center">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#D4880A" strokeWidth="2.5">
                              <path d="M12 2v1M12 21v1M4.22 4.22l.71.71M18.36 18.36l.71.71M2 12h1M21 12h1M4.22 19.78l.71-.71M18.36 5.64l.71-.71M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z" />
                            </svg>
                          </div>
                          <span className="text-[11px] font-bold uppercase tracking-wider text-tx-2">Savings Insight</span>
                        </div>
                        <p className="text-xs text-tx-2 leading-relaxed">{normalTip}</p>
                      </div>
                    </>
                  )}

                  {/* CASE 2 — Above 500: 7-row vertical list */}
                  {isAbove500 && (
                    <>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '4px 0 12px' }}>
                        {SLABS_ABOVE_500.map(slab => {
                          const isDone   = estimatedUnits > slab.max
                          const isActive = currentSlab.num === slab.num
                          const isFuture = estimatedUnits < slab.min
                          const unitsInSlab = isDone
                            ? slab.max - slab.min + 1
                            : isActive
                              ? Math.round(estimatedUnits - slab.min + 1)
                              : 0
                          const slabUnitsLeft = slab.max >= 99999 ? null : Math.max(0, slab.max - estimatedUnits)

                          return (
                            <div key={slab.num} style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              padding: '8px 12px',
                              borderRadius: 10,
                              background: isActive ? slab.color + '15' : 'var(--s2, #F0EDE7)',
                              border: `1px solid ${isActive ? slab.color + '40' : 'rgba(0,0,0,0.06)'}`,
                              opacity: isFuture ? 0.4 : 1,
                              transition: 'all 0.2s',
                            }}>
                              <div style={{ width: 10, height: 10, borderRadius: '50%', background: slab.color, flexShrink: 0 }} />

                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--tx, #1A1916)' }}>
                                  Slab {slab.num} · {slab.label}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--tx3, #A8A59E)' }}>
                                  {slab.min}–{slab.max >= 99999 ? `${slab.min - 1}+` : slab.max} units
                                </div>
                              </div>

                              {(isDone || isActive) && (
                                <div style={{ fontSize: 12, color: 'var(--tx2, #6B6860)', textAlign: 'right', minWidth: 56 }}>
                                  {unitsInSlab} units
                                </div>
                              )}

                              <div style={{
                                fontSize: 10,
                                fontWeight: 700,
                                padding: '2px 8px',
                                borderRadius: 20,
                                whiteSpace: 'nowrap',
                                background: isDone   ? '#EAF3DE'
                                          : isActive  ? slab.color + '25'
                                          :             'rgba(0,0,0,0.05)',
                                color: isDone   ? '#27500A'
                                     : isActive  ? slab.color
                                     :             'var(--tx3, #A8A59E)',
                              }}>
                                {isDone
                                  ? 'Done ✓'
                                  : isActive
                                    ? slabUnitsLeft !== null
                                      ? `Now · ${slabUnitsLeft.toFixed(0)} left`
                                      : 'Now'
                                    : 'Upcoming'}
                              </div>
                            </div>
                          )
                        })}
                      </div>

                      {/* Warning banner */}
                      <div style={{
                        background: '#FAEEDA',
                        border: '1px solid #EF9F27',
                        borderRadius: 10,
                        padding: '10px 14px',
                        fontSize: 13,
                        color: '#633806',
                        lineHeight: 1.5,
                        marginTop: 4,
                        marginBottom: 10
                      }}>
                        ⚠ You've crossed 500 units — your entire bill is recalculated at higher rates.
                        Currently in Slab {currentSlab.num} at ₹{currentSlab.rate}/unit.
                        {unitsLeftInSlab !== null && unitsLeftInSlab > 0 && nextSlabAbove && (
                          <span> {unitsLeftInSlab.toFixed(0)} units before next slab (₹{nextSlabAbove.rate}/unit).</span>
                        )}
                      </div>
                    </>
                  )}

                  {/* Extra stats row */}
                  <div className="e-proj-row" style={{ marginTop: 8 }}>
                    <div className="e-prc" style={{ background: 'var(--s2)' }}>
                      <div className="e-prc-lbl">Cycle so far</div>
                      <div className="e-prc-val">{measuredUnits.toFixed(1)} kWh</div>
                    </div>
                    <div className="e-prc" style={{ background: 'var(--Rbg)' }}>
                      <div className="e-prc-lbl" style={{ color: 'var(--Rm)' }}>Projected end</div>
                      <div className="e-prc-val" style={{ color: 'var(--Rm)' }}>~{estimatedUnits.toFixed(0)} kWh</div>
                    </div>
                    <div className="e-prc" style={{ background: 'var(--s2)' }}>
                      <div className="e-prc-lbl">Bill est.</div>
                      <div className="e-prc-val">₹{estimatedBill.toLocaleString()}</div>
                    </div>
                  </div>

                  {/* Footer predictions */}
                  <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 10, lineHeight: 1.5 }}>
                    Based on {(measuredUnits / Math.max(1, cycleDay)).toFixed(1)} kWh/day avg · Slab crossing predicted <strong style={{ color: 'var(--Rm)' }}>{(() => {
                      const currentMax = currentSlab.max >= 99999 ? 500 : currentSlab.max
                      const dToNext = pace > 0 ? Math.ceil((currentMax - measuredUnits) / pace) : 0
                      const crossDate = new Date()
                      crossDate.setDate(crossDate.getDate() + dToNext)
                      return crossDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                    })()}</strong>
                  </div>
                </>
              );
            })()}
          </div>
        </>
      )}

      <div className="e-section-lbl" id="insight-lbl">Today's insight · {d.label}</div>
      <div className="e-insight">
        <div className="e-i-tag">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.1"/><path d="M6.5 4v2.5l1.5 1.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
          Insight
        </div>
        <div className="e-i-head">{d.tip.head}</div>
        <div className="e-i-body">{d.tip.body}</div>
        <div style={{ display:'inline-flex',alignItems:'center',gap:6,fontSize:12,fontWeight:600,padding:'5px 12px',borderRadius:20,background:'var(--Pm)',color:'var(--Pbg)',marginTop:10 }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M3 4l3-3 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Every 1°C saves ~6% AC energy
        </div>
        <div className="e-share-row">
          <span style={{ fontSize:11,color:'var(--Pm)',opacity:.7 }}>Bedroom · {d.tip.kwh} kWh · {d.tip.time}</span>
          <button className="e-share-btn">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="9.5" cy="2" r="1.5" stroke="currentColor" strokeWidth="1.1"/><circle cx="9.5" cy="10" r="1.5" stroke="currentColor" strokeWidth="1.1"/><circle cx="2.5" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.1"/><path d="M8 2.8L4 5.2M4 6.8l4 2.4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
            Share
          </button>
        </div>
      </div>

      <div className="e-section-lbl">Bill payment · BBPS</div>
      <div className="e-card">
        <div className="e-row" style={{ marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>TNEB electricity bill</div>
            <div style={{ fontSize: 11, color: 'var(--tx2)', marginTop: 2 }}>Consumer number not linked yet</div>
          </div>
          <span className="e-badge" style={{ background: 'var(--s2)', color: 'var(--tx3)' }}>Pending</span>
        </div>
        <div style={{ background: 'var(--s2)', borderRadius: 10, padding: 16, textAlign: 'center' }}>
          <svg width="38" height="38" viewBox="0 0 38 38" fill="none" style={{ display: 'block', margin: '0 auto 10px' }}>
            <rect x="5" y="6" width="28" height="26" rx="3" stroke="var(--b2)" strokeWidth="1.5"/>
            <path d="M10 17h18M10 22h12" stroke="var(--b2)" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M10 12h8" stroke="var(--Am)" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--tx)', marginBottom: 5 }}>No bill data yet</div>
          <div style={{ fontSize: 12, color: 'var(--tx2)', lineHeight: 1.55, maxWidth: 260, margin: '0 auto' }}>
            Add your TNEB consumer number in Settings. We'll fetch your bill via BBPS and enable one-tap payment.
          </div>
        </div>
        <button className="e-pay-btn" onClick={() => alert('→ Go to Settings')}>
          Settings → Add consumer number
        </button>
      </div>

      <BottomNav />
    </div>
  )
}
