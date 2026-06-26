import React, { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import BottomNav from '../components/BottomNav'
import { getCurrentSlab, calculateTNEBBill } from '../utils/tariff'

// --- Helpers ---
const toISO = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

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

const fmtDate = (iso) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${parseInt(d)} ${months[parseInt(m) - 1]}`
}

const fmtMonth = (date) => {
  return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

const fmtTime = (mins) => {
  if (!mins) return '0m'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

export default function Reports() {
  const { household } = useAuth()
  const householdId = household?.id

  // --- State ---
  const [currentMonth, setCurrentMonth] = useState(new Date())
  const [selectedDate, setSelectedDate] = useState(null)
  const [monthReports, setMonthReports] = useState([])
  const [reportDatesSet, setReportDatesSet] = useState(new Set())
  const [selectedReport, setSelectedReport] = useState(null)
  const [monthLoading, setMonthLoading] = useState(false)
  const [reportLoading, setReportLoading] = useState(false)

  useEffect(() => {
    document.documentElement.style.setProperty('--bg', '#FDFCF0')
    document.documentElement.style.setProperty('--tx', '#1A1916')
    document.documentElement.style.setProperty('--tx2', '#6B6860')
    document.documentElement.style.setProperty('--tx3', '#A8A59E')
    document.documentElement.style.setProperty('--brand-green', '#1F3E32')
    document.documentElement.style.setProperty('--r', '16px')
  }, [])

  // --- Month Navigator ---
  const prevMonth = () => {
    const d = new Date(currentMonth)
    d.setMonth(d.getMonth() - 1)
    setCurrentMonth(d)
    setSelectedDate(null)
  }

  const nextMonth = () => {
    const d = new Date(currentMonth)
    d.setMonth(d.getMonth() + 1)
    setCurrentMonth(d)
    setSelectedDate(null)
  }

  const isCurrentMonth = 
    currentMonth.getMonth() === new Date().getMonth() &&
    currentMonth.getFullYear() === new Date().getFullYear()

  // --- Date Generation ---
  const dates = useMemo(() => {
    const year = currentMonth.getFullYear()
    const month = currentMonth.getMonth()
    const lastDay = new Date(year, month + 1, 0).getDate()
    return Array.from({ length: lastDay }, (_, i) => new Date(year, month, i + 1))
  }, [currentMonth])

  // --- Data Fetching ---
  useEffect(() => {
    if (!householdId) return
    const fetchMonth = async () => {
      setMonthLoading(true)
      const year = currentMonth.getFullYear()
      const month = currentMonth.getMonth()
      const start = new Date(year, month, 1).toLocaleDateString('en-CA')
      const end = new Date(year, month + 1, 0).toLocaleDateString('en-CA')

      const { data } = await supabase
        .from('daily_reports')
        .select('report_date, total_kwh, total_sessions')
        .eq('household_id', householdId)
        .gte('report_date', start)
        .lte('report_date', end)

      setMonthReports(data ?? [])
      const dateSet = new Set(data?.map(r => r.report_date) ?? [])
      setReportDatesSet(dateSet)

      // Auto-select most recent report
      if (data?.length > 0) {
        const sorted = [...data].sort((a, b) => b.report_date.localeCompare(a.report_date))
        setSelectedDate(sorted[0].report_date)
      }
      setMonthLoading(false)
    }
    fetchMonth()
  }, [currentMonth, householdId])

  useEffect(() => {
    if (!selectedDate || !householdId) return
    const fetchReport = async () => {
      setReportLoading(true)
      const { data: reportData } = await supabase
        .from('daily_reports')
        .select('*')
        .eq('household_id', householdId)
        .eq('report_date', selectedDate)
        .maybeSingle()

      if (reportData) {
        // Get cycle start date
        const { cycleStart } = getInitialCycleDates(selectedDate)
        
        // Fetch all reports in this cycle up to selectedDate
        const { data: cycleReports } = await supabase
          .from('daily_reports')
          .select('report_date, total_kwh, estimated_full_home_kwh, estimated_cost_inr, coverage_ratio')
          .eq('household_id', householdId)
          .gte('report_date', cycleStart)
          .lte('report_date', selectedDate)
          .order('report_date', { ascending: true })

        // Fetch all sessions in this cycle up to selectedDate
        const cycleStartIST = `${cycleStart}T00:30:00Z`
        const selectedDateEndIST = `${selectedDate}T23:59:59+05:30`
        const { data: cycleReadings } = await supabase
          .from('appliance_readings')
          .select('*')
          .eq('household_id', householdId)
          .gte('session_start', cycleStartIST)
          .lte('session_start', new Date(selectedDateEndIST).toISOString())

        const getActiveISTDateStr = (isoStr) => {
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

        const getDatesInRange = (startStr, endStr) => {
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

        const cycleDates = getDatesInRange(cycleStart, selectedDate)
        let cumulativeEstimated = 0
        let selectedDayCost = 0
        let sumDailyCosts = 0
        let selectedDayMeasured = 0
        let selectedDayEstimated = 0
        let cycleMeasuredSum = 0
        
        cycleDates.forEach(dateStr => {
          const daySessions = (cycleReadings || []).filter(s => getActiveISTDateStr(s.session_start) === dateStr)
          const report = (cycleReports || []).find(r => r.report_date === dateStr)
          const isToday = dateStr === getActiveISTDateStr(new Date().toISOString())
          
          let measured = daySessions.reduce((sum, s) => sum + parseFloat(s.kwh_consumed || 0), 0)
          const coverage = parseFloat(report?.coverage_ratio || 0.6)
          let estimated = coverage > 0 ? measured / coverage : measured

          if (!isToday && report) {
            if (report.total_kwh !== null && report.total_kwh !== undefined) {
              measured = parseFloat(report.total_kwh)
            }
            if (report.estimated_full_home_kwh !== null && report.estimated_full_home_kwh !== undefined) {
              estimated = parseFloat(report.estimated_full_home_kwh)
            }
          }

          const prevCumulative = cumulativeEstimated
          cumulativeEstimated += estimated
          
          let cost = calculateTNEBBill(cumulativeEstimated) - calculateTNEBBill(prevCumulative)
          if (!isToday && report && report.estimated_cost_inr !== null && report.estimated_cost_inr !== undefined) {
            cost = parseFloat(report.estimated_cost_inr)
          }

          sumDailyCosts += cost
          cycleMeasuredSum += measured

          if (dateStr === selectedDate) {
            selectedDayCost = cost
            selectedDayMeasured = measured
            selectedDayEstimated = estimated
          }
        })
        
        setSelectedReport({
          ...reportData,
          total_kwh: selectedDayMeasured,
          estimated_full_home_kwh: selectedDayEstimated,
          cycle_measured_kwh_after: cycleMeasuredSum,
          cycle_estimated_after: cumulativeEstimated,
          computed_daily_cost: selectedDayCost,
          computed_cycle_cost: sumDailyCosts
        })
      } else {
        setSelectedReport(null)
      }
      setReportLoading(false)
    }
    fetchReport()
  }, [selectedDate, householdId])

  const monthTotalKwh = monthReports.reduce((s, r) => s + (parseFloat(r.total_kwh) || 0), 0)
  const monthSessionsCount = monthReports.reduce((s, r) => s + (parseInt(r.total_sessions) || 0), 0)
  const daysWithReport = monthReports.length

  return (
    <div className="reports-page">
      <style>{`
        .serif { @apply font-serif; }
        
        .reports-page {
          min-height: 100vh;
          background: #FDFCF0;
          color: #1A1916;
          font-family: 'DM Sans', sans-serif;
          padding-bottom: 100px;
        }

        .m-nav {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 16px 8px;
          position: sticky;
          top: 0;
          background: #FDFCF0;
          z-index: 50;
        }
        .m-nav-title { font-size: 20px; font-weight: 500; }
        .m-nav-btn {
          width: 34px; height: 34px;
          border-radius: 50%; border: 1px solid rgba(0,0,0,0.08);
          background: white; display: flex; align-items: center; justify-content: center;
          cursor: pointer;
        }

        .m-sum-strip {
          display: flex; gap: 24px; padding: 0 16px 16px;
          overflow-x: auto; scrollbar-width: none;
        }
        .m-sum-item { text-align: center; flex-shrink: 0; }
        .m-sum-val { font-size: 16px; font-weight: 700; }
        .m-sum-lbl { font-size: 10px; color: #777; margin-top: 1px; }

        .date-grid {
          display: flex; overflow-x: auto; gap: 8px; padding: 12px 16px;
          scrollbar-width: none; scroll-snap-type: x mandatory;
        }
        .date-grid::-webkit-scrollbar { display: none; }
        .date-chip {
          flex: 0 0 54px; height: 68px; border-radius: 12px;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          cursor: pointer; font-size: 15px; font-weight: 600;
          transition: all 0.2s; scroll-snap-align: start;
        }
        .date-chip-day { font-size: 9px; font-weight: 700; opacity: 0.5; text-transform: uppercase; margin-bottom: 3px; }
        .dot { width: 4px; height: 4px; border-radius: 50%; background: #22C55E; margin-top: 4px; }

        .report-section { padding: 20px 16px; }
        .greeting { font-size: 32px; line-height: 1.1; margin-bottom: 6px; }
        .sub-greeting { font-size: 14px; opacity: 0.7; margin-bottom: 24px; }

        .card-usage {
          background: #EBEAE1; border-radius: 16px; padding: 24px;
          margin-bottom: 32px; position: relative;
        }
        .card-usage::after {
          content: ""; position: absolute; right: 10px; bottom: 10px;
          width: 80px; height: 80px; background: rgba(0,0,0,0.02); border-radius: 50%;
        }
        .usage-lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #666; margin-bottom: 4px; }
        .usage-val { font-size: 40px; font-weight: 600; letter-spacing: -1px; }
        .usage-unit { font-size: 20px; font-style: italic; font-weight: 400; margin-left: 6px; color: #666; }

        .section-title { font-size: 19px; margin-bottom: 16px; }
        .device-item { display: flex; align-items: center; gap: 14px; padding: 10px 0; }
        .device-ico { width: 42px; height: 42px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; }
        .device-info { flex: 1; }
        .device-name { font-size: 15px; font-weight: 600; }
        .device-meta { font-size: 11px; opacity: 0.6; margin-top: 1px; }
        .device-stats { text-align: right; }
        .device-units { font-size: 15px; font-weight: 600; }
        .device-cost { font-size: 10px; font-weight: 700; color: #B87200; margin-top: 1px; }

        .calc-note { font-size: 11px; font-style: italic; color: #666; margin-top: 20px; line-height: 1.5; }
        .calc-card {
          background: #F1F3E9; border-left: 4px solid #1F3E32; border-radius: 4px 12px 12px 4px;
          padding: 14px 16px; display: flex; gap: 12px; margin-top: 20px; align-items: center;
        }
        .still-on {
          background: #FEE2E2; color: #991B1B; border-radius: 12px; padding: 14px 16px;
          display: flex; gap: 12px; margin-top: 20px; font-size: 12px; line-height: 1.4; font-weight: 500;
        }

        .card-cycle { background: #EBEAE1; border-radius: 16px; padding: 20px; margin-top: 32px; }
        .cycle-hdr { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 16px; }
        .cycle-range { font-size: 10px; font-weight: 700; color: #666; text-transform: uppercase; }
        .prog-bg { height: 6px; background: white; border-radius: 3px; overflow: hidden; margin: 12px 0 6px; }
        .prog-fill { height: 100%; background: #1A1916; border-radius: 3px; }
        .prog-sub { font-size: 9px; font-weight: 600; text-transform: uppercase; opacity: 0.5; letter-spacing: 0.05em; }

        .slab-box { background: #F5F4EE; border-radius: 12px; padding: 16px; margin-top: 16px; }
        .slab-tag { font-size: 10px; font-weight: 800; text-transform: uppercase; color: #B87200; display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }

        .card-tip {
          background: #1F3E32; color: white; border-radius: 16px; padding: 24px; margin-top: 32px;
          position: relative; overflow: hidden;
        }
        .tip-tag { font-size: 24px; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; }
        .tip-body { font-size: 14px; line-height: 1.6; opacity: 0.9; margin-bottom: 20px; }
        .tip-btn {
          display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px;
          background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
          border-radius: 20px; font-size: 12px; font-weight: 500; color: white; cursor: pointer;
        }

        .skeleton { background: rgba(0,0,0,0.05); border-radius: 12px; animation: pulse 1.5s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      `}</style>

      {/* Top Bar */}
      <div className="flex justify-between items-center px-4 py-4">
        <div className="w-10 h-10 flex items-center justify-center">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        </div>
        <div className="w-10 h-10 rounded-full overflow-hidden bg-surface-2 border border-black/5">
          <img src="https://api.dicebear.com/7.x/avataaars/svg?seed=Mohamed" alt="Profile" />
        </div>
      </div>

      <div className="px-4 pt-2">
        <h1 className="greeting serif">Good morning Mohamed!</h1>
        <p className="sub-greeting">Here's your home report for {fmtDate(selectedDate)} (6 AM – 6 AM) ☀️</p>
      </div>

      {/* 1. Header (Month Nav) */}
      <div className="m-nav">
        <button className="m-nav-btn" onClick={prevMonth}>‹</button>
        <div className="m-nav-title serif">{fmtMonth(currentMonth)}</div>
        <button className="m-nav-btn" onClick={nextMonth} disabled={isCurrentMonth}>›</button>
      </div>

      <div className="m-sum-strip">
        <div className="m-sum-item">
          <div className="m-sum-val">{monthLoading ? '...' : monthTotalKwh.toFixed(1)}</div>
          <div className="m-sum-lbl">kWh this month</div>
        </div>
        <div className="m-sum-item">
          <div className="m-sum-val">{monthLoading ? '...' : daysWithReport}</div>
          <div className="m-sum-lbl">days recorded</div>
        </div>
        <div className="m-sum-item">
          <div className="m-sum-val">{monthLoading ? '...' : monthSessionsCount}</div>
          <div className="m-sum-lbl">total sessions</div>
        </div>
      </div>

      {/* 2. Date Selector */}
      <div className="date-grid">
        {dates.map((date, i) => {
          const dateISO = toISO(date)
          const isSelected = selectedDate === dateISO
          const hasReport = reportDatesSet.has(dateISO)
          const isToday = dateISO === toISO(new Date())
          const isFuture = date > new Date()
          const dayName = date.toLocaleDateString('en-IN', { weekday: 'short' })

          return (
            <div 
              key={i} 
              className="date-chip" 
              style={{
                background: isSelected ? '#1A5FB4' : (isToday ? '#E6F1FB' : 'transparent'),
                color: isSelected ? 'white' : (isToday ? '#0C447C' : (isFuture ? '#CCC' : '#1A1916')),
                border: isToday && !isSelected ? '1px solid #378ADD' : 'none'
              }}
              onClick={() => { if (!isFuture && hasReport) setSelectedDate(dateISO) }}
            >
              <span className="date-chip-day" style={{ color: isSelected ? 'rgba(255,255,255,0.7)' : 'inherit' }}>{dayName}</span>
              {date.getDate()}
              {hasReport && !isSelected && !isToday && <div className="dot" />}
            </div>
          )
        })}
      </div>

      {/* 3. Detail Section */}
      <div className="report-section">
        {reportLoading ? (
          <div className="space-y-4">
            <div className="skeleton h-32" />
            <div className="skeleton h-64" />
          </div>
        ) : selectedReport ? (
          <>
            <div className="card-usage">
              <div className="usage-lbl">Measured Usage</div>
              <div className="usage-val">{parseFloat(selectedReport.total_kwh || 0).toFixed(2)}<span className="usage-unit">units</span></div>
              <div className="usage-lbl" style={{ marginTop: 14 }}>Estimated Full Home</div>
              <div className="usage-val" style={{ fontSize: 26 }}>~{parseFloat(selectedReport.estimated_full_home_kwh || 0).toFixed(2)}<span className="usage-unit" style={{ fontSize: 16 }}>units</span></div>
            </div>

            <h2 className="section-title serif">Breakdown for {fmtDate(selectedDate)}</h2>
            <div className="divide-y divide-black/5">
              {(() => {
                let breakdown = {}
                try { breakdown = typeof selectedReport.device_type_breakdown === 'string' ? JSON.parse(selectedReport.device_type_breakdown) : (selectedReport.device_type_breakdown || {}) } catch(e) {}
                const devs = breakdown.today || breakdown.by_device || breakdown.by_type || {}
                
                const totalDevKwh = Object.values(devs).reduce((sum, d) => sum + parseFloat(d.kwh || 0), 0)
                const dailyCost = selectedReport.computed_daily_cost ?? 0

                return Object.entries(devs).map(([id, d], idx) => {
                  const colors = ['#1F3E32', '#F5C518', '#1A5FB4']
                  const icoColor = colors[idx % colors.length]
                  const devMeasured = parseFloat(d.kwh || 0)
                  const devCost = totalDevKwh > 0 ? (devMeasured / totalDevKwh) * dailyCost : (d.cost || 0)

                  return (
                    <div key={idx} className="device-item">
                      <div className="device-ico" style={{ background: icoColor }}>
                        {d.type === 'ac' ? (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 12h10M7 15h10M7 9h10"/></svg>
                        ) : (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>
                        )}
                      </div>
                      <div className="device-info">
                        <div className="device-name">{d.name || d.type}</div>
                        <div className="device-meta">{fmtTime(d.minutes)}</div>
                      </div>
                      <div className="device-stats">
                        <div className="device-units">{devMeasured.toFixed(2)} units</div>
                        <div className="device-cost">₹{Math.round(devCost)}</div>
                      </div>
                    </div>
                  )
                })
              })()}
            </div>


            {selectedReport.open_sessions_count > 0 && (
              <div className="still-on">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01"/></svg>
                <span>AC - 1st Floor has been running since 9:06 pm and is still on — data in tomorrow's report.</span>
              </div>
            )}

            {(() => {
              const estimatedUnits = parseFloat(selectedReport.cycle_estimated_after || 0)
              const currentSlab = getCurrentSlab(estimatedUnits)
              const estimatedBill = Math.round(selectedReport.computed_cycle_cost ?? calculateTNEBBill(estimatedUnits))
              const unitsLeft = currentSlab.max >= 99999 ? null : currentSlab.max - estimatedUnits

              return (
                <div className="card-cycle">
                  <div className="cycle-hdr">
                    <h3 className="serif text-xl">Current Cycle</h3>
                    <span className="cycle-range">{selectedReport.cycle_period || 'Cycle Period'}</span>
                  </div>
                  <div className="flex justify-between items-end">
                    <div className="prog-sub" style={{ opacity: 0.7 }}>Cycle So Far</div>
                    <div className="text-sm font-bold">{parseFloat(selectedReport.cycle_measured_kwh_after || 0).toFixed(2)} units</div>
                  </div>
                  <div className="prog-bg">
                    <div className="prog-fill" style={{ width: `${Math.min(100, (parseFloat(selectedReport.cycle_measured_kwh_after || 0)/500)*100)}%` }} />
                  </div>
                  <p className="prog-sub">
                    Proj. {Math.max(0, estimatedUnits - parseFloat(selectedReport.cycle_measured_kwh_after || 0)).toFixed(1)} units remaining · {estimatedUnits.toFixed(1)} units est. end of cycle
                  </p>

                  <div className="slab-box">
                    <div className="slab-tag">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M12 9v4M12 17h.01"/></svg>
                      Slab Alert
                    </div>
                    <p className="text-[13px] opacity-70" style={{ lineHeight: '1.6' }}>
                      Current Slab: <strong>{currentSlab.rate === 0 ? 'Free' : `₹${currentSlab.rate.toFixed(2)}/unit`}</strong>
                      {unitsLeft !== null && (
                        <>
                          <br />
                          {parseFloat(unitsLeft.toFixed(2))} units remaining {currentSlab.rate === 0 ? '' : 'in current slab'}
                        </>
                      )}
                      <br />
                      Estimated Bill: <strong>₹{estimatedBill.toLocaleString()}</strong>
                    </p>
                  </div>
                </div>
              )
            })()}

            <div className="card-tip">
              <div className="tip-tag serif">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M9 18h6M10 22h4M12 2v1M5.22 5.22l.71.71M2 12h1M21 12h1M18.07 5.93l.71-.71M7 12a5 5 0 0 1 10 0"/></svg>
                Tip
              </div>
              <p className="tip-body">{selectedReport.tip_text}</p>
              <div className="flex items-center justify-between">
                <button className="tip-btn">Configure Habtekt Schedule</button>
                <span className="text-[11px] opacity-40">Feature arriving soon</span>
              </div>
            </div>
          </>
        ) : (
          <div className="text-center py-20 text-tx3">
             <p>Select a date with report data</p>
          </div>
        )}
      </div>

      <BottomNav />
    </div>
  )
}
