import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../supabase'
import { Sun, Moon, Users, Droplets, TrendingUp, TrendingDown, AlertTriangle, Factory, Calendar, Search, Map as MapIcon, Activity, Leaf, BarChart3, Thermometer, Brain, Zap, Loader2, Clock, MapPin, Ruler, Settings2, Trophy } from 'lucide-react'
import talukaStats from '../data/taluka_stats.json'
import { fetchBatchPredictions, fetchHarvestPredictions } from '../services/yieldPredictionService'
import { generateRiskAlerts } from '../services/riskAnalysisService'

// --- HELPER: Aggregate all Talukas for "All Regions" view ---
const getAggregatedData = () => {
  const allTalukas = Object.entries(talukaStats)
  const count = allTalukas.length || 1
  const sum = (key) => allTalukas.reduce((s, [, d]) => s + (d[key] || 0), 0)
  const avg = (key) => parseFloat((sum(key) / count).toFixed(2))

  const healthExcellent = allTalukas.reduce((s, [, d]) => s + (d.cropHealth?.excellent || 0), 0)
  const healthModerate = allTalukas.reduce((s, [, d]) => s + (d.cropHealth?.moderate || 0), 0)
  const healthPoor = allTalukas.reduce((s, [, d]) => s + (d.cropHealth?.poor || 0), 0)
  const healthTotal = healthExcellent + healthModerate + healthPoor || 1

  const varietyTotals = {}, varietyCounts = {}
  allTalukas.forEach(([, d]) => { Object.entries(d.varietyPerformance || {}).forEach(([v, y]) => { varietyTotals[v] = (varietyTotals[v] || 0) + y; varietyCounts[v] = (varietyCounts[v] || 0) + 1 }) })
  const varietyPerformance = {}
  Object.keys(varietyTotals).forEach(v => { varietyPerformance[v] = parseFloat((varietyTotals[v] / varietyCounts[v]).toFixed(2)) })

  const seasonTotals = {}, seasonCounts = {}
  allTalukas.forEach(([, d]) => { Object.entries(d.seasonPerformance || {}).forEach(([s, y]) => { seasonTotals[s] = (seasonTotals[s] || 0) + y; seasonCounts[s] = (seasonCounts[s] || 0) + 1 }) })
  const seasonPerformance = {}
  Object.keys(seasonTotals).forEach(s => { seasonPerformance[s] = parseFloat((seasonTotals[s] / seasonCounts[s]).toFixed(2)) })

  const yearTotals = {}, yearCounts = {}
  allTalukas.forEach(([, d]) => { Object.entries(d.yearlyTrend || {}).forEach(([yr, y]) => { yearTotals[yr] = (yearTotals[yr] || 0) + y; yearCounts[yr] = (yearCounts[yr] || 0) + 1 }) })
  const yearlyTrend = {}
  Object.keys(yearTotals).sort().forEach(yr => { yearlyTrend[yr] = parseFloat((yearTotals[yr] / yearCounts[yr]).toFixed(2)) })

  // Aggregate soil & irrigation distributions
  const soilDistribution = {}
  allTalukas.forEach(([, d]) => { Object.entries(d.soilDistribution || {}).forEach(([k, v]) => { soilDistribution[k] = (soilDistribution[k] || 0) + v }) })
  const irrigationDistribution = {}
  allTalukas.forEach(([, d]) => { Object.entries(d.irrigationDistribution || {}).forEach(([k, v]) => { irrigationDistribution[k] = (irrigationDistribution[k] || 0) + v }) })

  return {
    fieldCount: sum('fieldCount'), avgYield: avg('avgYield'), totalArea: parseFloat(sum('totalArea').toFixed(2)),
    totalEstYield: sum('totalEstYield'), avgNDVI: avg('avgNDVI'), avgRainfall: avg('avgRainfall'),
    avgHumidity: avg('avgHumidity'), avgMaxTemp: avg('avgMaxTemp'), avgMinTemp: avg('avgMinTemp'),
    avgHarvestDuration: Math.round(avg('avgHarvestDuration')),
    cropHealth: { excellent: healthExcellent, moderate: healthModerate, poor: healthPoor, excellentPct: parseFloat((healthExcellent / healthTotal * 100).toFixed(1)), moderatePct: parseFloat((healthModerate / healthTotal * 100).toFixed(1)), poorPct: parseFloat((healthPoor / healthTotal * 100).toFixed(1)) },
    varietyPerformance, seasonPerformance,
    topVariety: Object.keys(varietyPerformance).reduce((a, b) => varietyPerformance[a] > varietyPerformance[b] ? a : b, ''),
    topSeason: Object.keys(seasonPerformance).reduce((a, b) => seasonPerformance[a] > seasonPerformance[b] ? a : b, ''),
    yearlyTrend, soilDistribution, irrigationDistribution
  }
}

const FactoryDashboard = () => {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [factoryName, setFactoryName] = useState('Central Factory Command')

  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('agrolytics-theme')
    if (saved) return saved === 'dark'
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    if (isDarkMode) {
      document.body.classList.remove('light-theme')
      localStorage.setItem('agrolytics-theme', 'dark')
    } else {
      document.body.classList.add('light-theme')
      localStorage.setItem('agrolytics-theme', 'light')
    }
  }, [isDarkMode])

  useEffect(() => {
    const handleStorage = (e) => {
      if (e.key === 'agrolytics-theme') {
        setIsDarkMode(e.newValue !== 'light')
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  
  const [selectedTaluka, setSelectedTaluka] = useState('All Regions')
  const [searchTerm, setSearchTerm] = useState('')
  const [fields, setFields] = useState([])

  // Phase 2: AI Predictions
  const [aiPredictions, setAiPredictions] = useState(null)
  const [predictionsLoading, setPredictionsLoading] = useState(false)
  const [predictionsError, setPredictionsError] = useState(null)

  // Phase 3: Harvest Queue
  const [harvestQueue, setHarvestQueue] = useState([])
  const [harvestLoading, setHarvestLoading] = useState(false)

  const talukaNames = Object.keys(talukaStats)

  const currentData = useMemo(() => {
    if (selectedTaluka === 'All Regions') return getAggregatedData()
    return talukaStats[selectedTaluka] || getAggregatedData()
  }, [selectedTaluka])

  // Current AI prediction data for selected Taluka
  const currentAI = useMemo(() => {
    if (!aiPredictions) return null
    if (selectedTaluka === 'All Regions') return aiPredictions.allRegions
    return aiPredictions.byTaluka?.[selectedTaluka] || null
  }, [aiPredictions, selectedTaluka])

  useEffect(() => { fetchFactoryData() }, [])

  const fetchFactoryData = async () => {
    try {
      setLoading(true)
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { navigate('/factory/auth'); return }
      if (user.user_metadata?.factory_name) setFactoryName(user.user_metadata.factory_name)

      const { data: fieldsData } = await supabase
        .from('fields')
        .select(`id, name, area_size, field_details ( taluka, variety ), farmers:farmer_id ( users ( full_name ) )`)

      const processedFields = (fieldsData || []).map(field => {
        const fName = field.farmers?.users?.full_name || field.farmers?.full_name || 'Unknown Farmer'
        const detailsObj = Array.isArray(field.field_details) ? field.field_details[0] : field.field_details
        return { ...field, farmerName: fName, taluka: detailsObj?.taluka || 'Unknown', variety: detailsObj?.variety || '-', area: parseFloat(field.area_size || 0).toFixed(2) }
      })
      setFields(processedFields)
    } catch (error) {
      console.error('Error fetching data:', error.message)
    } finally { setLoading(false) }

    // Fire off AI predictions in background (non-blocking)
    loadPredictions()
  }

  const loadPredictions = async () => {
    setPredictionsLoading(true)
    setHarvestLoading(true)
    setPredictionsError(null)
    try {
      const [yieldResult, harvestResult] = await Promise.all([
        fetchBatchPredictions(),
        fetchHarvestPredictions()
      ])
      setAiPredictions(yieldResult)
      setHarvestQueue(harvestResult || [])
    } catch (err) {
      console.error('Prediction batch failed:', err)
      setPredictionsError('AI predictions unavailable')
    } finally {
      setPredictionsLoading(false)
      setHarvestLoading(false)
    }
  }

  const handleLogout = async () => { await supabase.auth.signOut(); navigate('/') }

  const filteredFields = fields.filter(f => {
    const matchTaluka = selectedTaluka === 'All Regions' || (f.taluka || '').toLowerCase().includes(selectedTaluka.toLowerCase())
    const matchSearch = (f.name || '').toLowerCase().includes(searchTerm.toLowerCase()) || (f.farmerName || '').toLowerCase().includes(searchTerm.toLowerCase())
    return matchTaluka && matchSearch
  })

  const yieldTrend = useMemo(() => {
    const years = Object.keys(currentData?.yearlyTrend || {}).sort()
    if (years.length < 2) return 'stable'
    const last = currentData.yearlyTrend[years[years.length - 1]]
    const prev = currentData.yearlyTrend[years[years.length - 2]]
    return last > prev ? 'up' : last < prev ? 'down' : 'stable'
  }, [currentData])

  // Phase 4: Active Risk Alerts
  const activeAlerts = useMemo(() => {
    return generateRiskAlerts(filteredFields, talukaStats)
  }, [filteredFields])

  // --- RENDER HELPERS ---

  const renderTopBar = () => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem', flexWrap: 'wrap', gap: '1rem' }}>
      <div>
        <h1 style={{ fontSize: '2rem', margin: '0 0 0.5rem 0', display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
          <Factory size={32} color="#3b82f6" /> {factoryName}
        </h1>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <span className="status-badge running"><span className="status-indicator running"></span> Mill Active</span>
          <span className="text-muted" style={{ fontSize: '0.9rem' }}>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <button 
          onClick={() => setIsDarkMode(!isDarkMode)}
          style={{ background: 'var(--fd-card-inner-bg)', border: '1px solid var(--fd-border-medium)', color: 'var(--fd-text-main)', padding: '0.5rem', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.2s', height: '40px', width: '40px' }}
          aria-label="Toggle theme"
          title="Toggle Dark/Light Mode"
        >
          {isDarkMode ? <Sun size={20} /> : <Moon size={20} />}
        </button>
        <select className="select-modern" value={selectedTaluka} onChange={(e) => setSelectedTaluka(e.target.value)}>
          <option value="All Regions">🌍 All Regions</option>
          {talukaNames.map(t => <option key={t} value={t}>📍 {t} ({talukaStats[t].fieldCount} fields)</option>)}
        </select>
        <button onClick={handleLogout} className="action-btn-urgent" style={{ borderColor: 'rgba(239,68,68,0.3)', color: '#ef4444', background: 'rgba(239,68,68,0.1)' }}>Logout</button>
      </div>
    </div>
  )

  const renderQuickStats = () => {
    const totalArea = filteredFields.reduce((sum, f) => sum + parseFloat(f.area || 0), 0).toFixed(1)
    const configuredCount = filteredFields.filter(f => {
      const d = Array.isArray(f.field_details) ? f.field_details?.[0] : f.field_details
      return d?.taluka && d?.season && d?.variety && d?.soil_type && d?.irrigation_method
    }).length

    const stats = [
      { icon: MapPin, label: 'Fields', value: filteredFields.length, color: '#3b82f6' },
      { icon: Ruler, label: 'Total Area', value: `${totalArea} Ha`, color: '#10b981' },
      { icon: Leaf, label: 'Avg NDVI', value: currentData?.avgNDVI || '—', color: currentData?.avgNDVI >= 0.65 ? '#10b981' : currentData?.avgNDVI >= 0.55 ? '#f59e0b' : '#ef4444' },
      { icon: Settings2, label: 'Configured', value: configuredCount, color: '#8b5cf6' },
      { icon: AlertTriangle, label: 'Alerts', value: activeAlerts.length, color: activeAlerts.length > 0 ? '#ef4444' : '#10b981' },
    ]

    return (
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1.5rem',
        padding: '0.7rem 1rem', borderRadius: '10px',
        background: 'var(--fd-card-inner-bg-solid)', border: '1px solid rgba(255,255,255,0.06)',
        backdropFilter: 'blur(8px)'
      }}>
        {stats.map((s, i) => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.3rem 0.7rem', borderRight: i < stats.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none', paddingRight: i < stats.length - 1 ? '1rem' : '0.7rem' }}>
            <s.icon size={14} color={s.color} />
            <span style={{ fontSize: '0.75rem', color: 'var(--fd-text-tertiary)' }}>{s.label}</span>
            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: s.color }}>{s.value}</span>
          </div>
        ))}
      </div>
    )
  }

  const renderMetrics = () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
      {/* Avg Yield */}
      <div className="glass-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.8rem' }}>
          <span className="card-label">Avg Yield (Dataset)</span>
          <div style={{ background: 'rgba(16,185,129,0.1)', padding: '0.5rem', borderRadius: '8px' }}><TrendingUp size={20} color="#10b981" /></div>
        </div>
        <h2 style={{ fontSize: '2.5rem', margin: '0 0 0.3rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {currentData?.avgYield || 0} <span style={{ fontSize: '1rem', color: 'var(--fd-text-muted)' }}>T/Ha</span>
          {yieldTrend === 'up' && <TrendingUp size={20} color="#10b981" />}
          {yieldTrend === 'down' && <TrendingDown size={20} color="#ef4444" />}
        </h2>
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--fd-text-muted)' }}>Across {currentData?.fieldCount?.toLocaleString() || 0} historical records</p>
      </div>

      {/* AI Predicted Yield — Phase 2 NEW */}
      <div className="glass-card" style={{ border: '1px solid rgba(139,92,246,0.3)', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: 0, right: 0, background: 'linear-gradient(135deg, #8b5cf6, #a78bfa)', padding: '0.2rem 0.7rem', borderRadius: '0 0 0 8px', fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.5px' }}>AI LIVE</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.8rem' }}>
          <span className="card-label">AI Predicted Yield</span>
          <div style={{ background: 'rgba(139,92,246,0.1)', padding: '0.5rem', borderRadius: '8px' }}><Brain size={20} color="#8b5cf6" /></div>
        </div>
        {predictionsLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '1rem 0' }}>
            <Loader2 size={20} className="spin-slow" color="#8b5cf6" />
            <span style={{ color: '#a78bfa', fontSize: '0.9rem' }}>Running predictions...</span>
          </div>
        ) : currentAI ? (
          <>
            <h2 style={{ fontSize: '2.5rem', margin: '0 0 0.3rem 0', color: '#a78bfa' }}>
              {currentAI.avgPredicted || '—'} <span style={{ fontSize: '1rem', color: 'var(--fd-text-muted)' }}>T/Ha</span>
            </h2>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--fd-text-muted)' }}>{currentAI.fieldCount || 0} fields predicted • {currentAI.totalPredicted?.toLocaleString() || 0} T total</p>
            {(() => {
              const hist = currentData?.avgYield || 0
              const ai = currentAI.avgPredicted || 0
              const diff = ai - hist
              const pct = hist ? ((diff / hist) * 100).toFixed(1) : 0
              const up = diff >= 0
              return (
                <p style={{ margin: '0.4rem 0 0', fontSize: '0.75rem', fontWeight: 600, color: up ? '#10b981' : '#ef4444' }}>
                  {up ? '▲' : '▼'} {up ? '+' : ''}{diff.toFixed(1)} T/Ha ({up ? '+' : ''}{pct}%) vs Historical
                </p>
              )
            })()}
          </>
        ) : (
          <div style={{ padding: '0.5rem 0' }}>
            <p style={{ color: 'var(--fd-text-tertiary)', fontSize: '0.85rem', margin: 0 }}>{predictionsError || 'No configured fields to predict'}</p>
            {aiPredictions && <p style={{ color: 'var(--fd-text-tertiary)', fontSize: '0.75rem', margin: '0.3rem 0 0' }}>{aiPredictions.unconfiguredCount || 0} fields need configuration</p>}
          </div>
        )}
      </div>

      {/* Crop Health */}
      <div className="glass-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.8rem' }}>
          <span className="card-label">Crop Health (NDVI)</span>
          <div style={{ background: 'rgba(59,130,246,0.1)', padding: '0.5rem', borderRadius: '8px' }}><Activity size={20} color="#3b82f6" /></div>
        </div>
        <h2 style={{ fontSize: '2.5rem', margin: '0 0 0.3rem 0', color: '#10b981' }}>{currentData?.cropHealth?.excellentPct || 0}% <span style={{ fontSize: '1rem', color: 'var(--fd-text-muted)' }}>Excellent</span></h2>
        <div className="progress-bar-container" style={{ height: '10px', marginTop: '0.5rem' }}>
          <div style={{ display: 'flex', height: '100%', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ width: `${currentData?.cropHealth?.excellentPct || 0}%`, background: '#10b981' }}></div>
            <div style={{ width: `${currentData?.cropHealth?.moderatePct || 0}%`, background: '#f59e0b' }}></div>
            <div style={{ width: `${currentData?.cropHealth?.poorPct || 0}%`, background: '#ef4444' }}></div>
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--fd-text-muted)' }}>
          <span>🟢 {currentData?.cropHealth?.excellentPct}%</span>
          <span>🟡 {currentData?.cropHealth?.moderatePct}%</span>
          <span>🔴 {currentData?.cropHealth?.poorPct}%</span>
        </div>
      </div>

      {/* Crushing Season Countdown — feat_7 */}
      {(() => {
        const now = new Date()
        const year = now.getFullYear()
        const month = now.getMonth() // 0-indexed

        // Season: Oct 15 → Apr 15
        let seasonStart, seasonEnd, seasonLabel
        if (month >= 9) {
          // Oct–Dec: current year season
          seasonStart = new Date(year, 9, 15)
          seasonEnd = new Date(year + 1, 3, 15)
          seasonLabel = `${year}–${year + 1}`
        } else if (month <= 3) {
          // Jan–Apr: previous year's season still running
          seasonStart = new Date(year - 1, 9, 15)
          seasonEnd = new Date(year, 3, 15)
          seasonLabel = `${year - 1}–${year}`
        } else {
          // May–Sep: off-season
          seasonStart = new Date(year, 9, 15)
          seasonEnd = new Date(year + 1, 3, 15)
          seasonLabel = `${year}–${year + 1}`
        }

        const inSeason = now >= seasonStart && now <= seasonEnd
        const totalDays = Math.ceil((seasonEnd - seasonStart) / (1000 * 60 * 60 * 24))
        const elapsed = inSeason ? Math.ceil((now - seasonStart) / (1000 * 60 * 60 * 24)) : 0
        const remaining = inSeason ? totalDays - elapsed : Math.ceil((seasonStart - now) / (1000 * 60 * 60 * 24))
        const progressPct = inSeason ? Math.min(100, ((elapsed / totalDays) * 100).toFixed(0)) : 0
        const tonnage = currentAI?.totalPredicted || currentData?.totalEstYield || 0

        return (
          <div className="glass-card" style={{ border: inSeason ? '1px solid rgba(59,130,246,0.3)' : '1px solid rgba(100,116,139,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.8rem' }}>
              <span className="card-label">Crushing Season</span>
              <div style={{ background: inSeason ? 'rgba(59,130,246,0.1)' : 'rgba(100,116,139,0.1)', padding: '0.5rem', borderRadius: '8px' }}><Calendar size={20} color={inSeason ? '#3b82f6' : 'var(--fd-text-tertiary)'} /></div>
            </div>
            {inSeason ? (
              <>
                <h2 style={{ fontSize: '2.2rem', margin: '0 0 0.3rem 0', color: '#3b82f6' }}>
                  {remaining} <span style={{ fontSize: '1rem', color: 'var(--fd-text-muted)' }}>Days Left</span>
                </h2>
                <div className="progress-bar-container" style={{ height: '8px', marginBottom: '0.5rem' }}>
                  <div style={{ width: `${progressPct}%`, height: '100%', borderRadius: '4px', background: 'linear-gradient(90deg, #3b82f6, #60a5fa)', transition: 'width 0.5s ease' }}></div>
                </div>
                <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--fd-text-muted)' }}>
                  {progressPct}% complete • Est: {tonnage.toLocaleString()} T • {seasonLabel}
                </p>
              </>
            ) : (
              <>
                <h2 style={{ fontSize: '2.2rem', margin: '0 0 0.3rem 0', color: 'var(--fd-text-tertiary)' }}>
                  Off-Season
                </h2>
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--fd-text-muted)' }}>
                  Next season starts in <strong style={{ color: '#f59e0b' }}>{remaining} days</strong>
                </p>
                <p style={{ margin: '0.3rem 0 0', fontSize: '0.75rem', color: 'var(--fd-text-tertiary)' }}>
                  {seasonLabel} • Oct 15 → Apr 15
                </p>
              </>
            )}
          </div>
        )
      })()}
    </div>
  )

  const renderInsights = () => {
    const varieties = currentData?.varietyPerformance || {}
    const seasons = currentData?.seasonPerformance || {}
    const yearlyTrend = currentData?.yearlyTrend || {}
    const maxVarietyYield = Math.max(...Object.values(varieties), 1)
    const maxSeasonYield = Math.max(...Object.values(seasons), 1)
    const yearEntries = Object.entries(yearlyTrend).sort(([a], [b]) => a.localeCompare(b))
    const maxYearYield = Math.max(...yearEntries.map(([, v]) => v), 1)

    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
        {/* Variety Performance */}
        <div className="glass-card" style={{ padding: '1rem 1.2rem' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 0.8rem 0', fontSize: '1rem' }}>
            <Leaf size={18} color="#10b981" /> Variety Performance
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {Object.entries(varieties).sort(([, a], [, b]) => b - a).map(([variety, avgYield]) => (
              <div key={variety}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.2rem', fontSize: '0.8rem' }}>
                  <span style={{ color: variety === currentData?.topVariety ? '#10b981' : 'var(--fd-text-secondary)', fontWeight: variety === currentData?.topVariety ? 700 : 400 }}>
                    {variety === currentData?.topVariety ? '⭐ ' : ''}{variety}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: '0.8rem' }}>{avgYield} T/Ha</span>
                </div>
                <div className="progress-bar-container" style={{ height: '5px' }}><div className="progress-bar-fill" style={{ width: `${(avgYield / maxVarietyYield) * 100}%` }}></div></div>
              </div>
            ))}
          </div>
        </div>

        {/* Season Performance */}
        <div className="glass-card" style={{ padding: '1rem 1.2rem' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 0.8rem 0', fontSize: '1rem' }}>
            <Calendar size={18} color="#f59e0b" /> Season Performance
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {Object.entries(seasons).sort(([, a], [, b]) => b - a).map(([season, avgYield]) => (
              <div key={season} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <div style={{ width: '85px', fontSize: '0.8rem', color: season === currentData?.topSeason ? '#f59e0b' : 'var(--fd-text-secondary)', fontWeight: season === currentData?.topSeason ? 700 : 400 }}>
                  {season === currentData?.topSeason ? '🏆 ' : ''}{season}
                </div>
                <div style={{ flex: 1 }}>
                  <div className="progress-bar-container" style={{ height: '6px' }}>
                    <div className="progress-bar-fill" style={{ width: `${(avgYield / maxSeasonYield) * 100}%`, background: season === 'Adsali' ? 'linear-gradient(90deg, #10b981, #34d399)' : season === 'Pre-seasonal' ? 'linear-gradient(90deg, #f59e0b, #fbbf24)' : 'linear-gradient(90deg, #3b82f6, #60a5fa)' }}></div>
                  </div>
                </div>
                <span style={{ fontWeight: 600, minWidth: '60px', textAlign: 'right', fontSize: '0.8rem' }}>{avgYield} T/Ha</span>
              </div>
            ))}
          </div>
        </div>

        {/* Yearly Trend */}
        <div className="glass-card" style={{ padding: '1rem 1.2rem' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 0.8rem 0', fontSize: '1rem' }}>
            <BarChart3 size={18} color="#8b5cf6" /> Yield Trend (2019–2024)
          </h3>
          {(() => {
            const barAreaHeight = 80 // px available for bars
            return (
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', height: '120px', paddingBottom: '24px', position: 'relative' }}>
                {yearEntries.map(([year, avgYield], i) => {
                  const barH = Math.max(8, Math.round((avgYield / maxYearYield) * barAreaHeight))
                  const prevYield = i > 0 ? yearEntries[i - 1][1] : avgYield
                  const isUp = avgYield >= prevYield
                  return (
                    <div key={year} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: '0.2rem' }}>
                      <span style={{ fontSize: '0.65rem', fontWeight: 600, color: isUp ? '#10b981' : '#ef4444' }}>{avgYield}</span>
                      <div style={{ width: '70%', maxWidth: '42px', height: `${barH}px`, background: isUp ? 'linear-gradient(0deg, #10b981, #34d399)' : 'linear-gradient(0deg, #ef4444, #f87171)', borderRadius: '4px 4px 0 0', transition: 'height 0.5s ease' }}></div>
                      <span style={{ fontSize: '0.65rem', color: 'var(--fd-text-muted)', marginTop: '2px' }}>{year}</span>
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </div>
      </div>
    )
  }

  // Smart Harvest Scheduling — Phase 3 NEW
  const renderHarvestQueue = () => {
    // Filter queue by selected Taluka if not "All Regions"
    const displayQueue = selectedTaluka === 'All Regions' 
      ? harvestQueue 
      : harvestQueue.filter(q => (q.taluka || '').toLowerCase() === selectedTaluka.toLowerCase())

    return (
      <div className="glass-card" style={{ marginBottom: '2rem', border: '1px solid rgba(239,68,68,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, fontSize: '1.1rem' }}>
            <Clock size={20} color="#ef4444" /> Smart Harvest Scheduling
          </h3>
          {harvestLoading && <Loader2 size={16} className="spin-slow" color="#ef4444" />}
        </div>
        
        {displayQueue.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--fd-text-tertiary)' }}>
            {harvestLoading ? 'Calculating optimal harvest dates...' : 'No fields scheduled for harvest. Update planting dates to see predictions.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
            {displayQueue.slice(0, 5).map(item => (
              <div key={item.fieldId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', background: 'var(--fd-card-inner-bg)', borderRadius: '8px', borderLeft: `4px solid ${item.urgency === 'critical' ? '#ef4444' : item.urgency === 'high' ? '#f59e0b' : '#10b981'}` }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', marginBottom: '0.3rem' }}>
                    <h4 style={{ margin: 0, color: 'var(--fd-text-main)', fontSize: '1rem' }}>{item.fieldName}</h4>
                    <span style={{ fontSize: '0.7rem', color: 'var(--fd-text-muted)', background: 'var(--fd-border-light)', padding: '0.1rem 0.4rem', borderRadius: '4px' }}>{item.taluka}</span>
                  </div>
                  <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--fd-text-muted)' }}>{item.farmerName} • {item.area} Ha • {item.variety}</p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700, color: item.urgency === 'critical' ? '#ef4444' : item.urgency === 'high' ? '#f59e0b' : '#10b981' }}>
                    {item.daysRemaining <= 0 ? 'Ready Now' : `${item.daysRemaining} Days`}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--fd-text-tertiary)', marginTop: '0.2rem' }}>
                    Model: {item.predictedDays} days total • Est: {item.expectedDate}
                  </div>
                </div>
              </div>
            ))}
            {displayQueue.length > 5 && (
              <div style={{ textAlign: 'center', marginTop: '0.5rem' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--fd-text-tertiary)' }}>+ {displayQueue.length - 5} more fields in queue</span>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  // Phase 4: Risk Alerts UI
  const renderRiskAlerts = () => {
    if (loading) return null

    return (
      <div className="glass-card" style={{ marginBottom: '2rem', border: activeAlerts.length > 0 ? '1px solid rgba(245,158,11,0.3)' : '1px solid rgba(16,185,129,0.2)' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.2rem', marginTop: 0, fontSize: '1.1rem' }}>
          {activeAlerts.length > 0 ? <AlertTriangle size={20} color="#f59e0b" /> : <Activity size={20} color="#10b981" />}
          Intelligent Risk Analytics
        </h3>
        
        {activeAlerts.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', padding: '1.5rem', background: 'rgba(16,185,129,0.08)', borderRadius: '8px', color: '#34d399' }}>
            <span style={{ fontSize: '1.5rem' }}>✅</span>
            <div>
              <h4 style={{ margin: '0 0 0.3rem 0', color: '#10b981' }}>All Systems Normal</h4>
              <p style={{ margin: 0, fontSize: '0.85rem' }}>No critical agronomic or climate risks detected for the currently displayed fields.</p>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {activeAlerts.map(alert => {
              const Icon = alert.icon
              const isCritical = alert.severity === 'critical'
              const color = isCritical ? '#ef4444' : '#f59e0b'
              const bg = isCritical ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)'
              
              return (
                <div key={alert.id} style={{ display: 'flex', gap: '1rem', padding: '1.2rem', background: 'var(--fd-card-inner-bg)', borderRadius: '8px', borderLeft: `4px solid ${color}` }}>
                  <div style={{ background: bg, padding: '0.8rem', borderRadius: '8px', height: 'fit-content' }}>
                    <Icon size={24} color={color} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                      <h4 style={{ margin: 0, color: 'var(--fd-text-main)', fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {alert.title}
                        {isCritical && <span style={{ fontSize: '0.65rem', background: '#ef4444', color: 'var(--fd-text-main)', padding: '0.1rem 0.4rem', borderRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Critical</span>}
                      </h4>
                      <span style={{ fontSize: '0.8rem', fontWeight: 600, color, background: bg, padding: '0.2rem 0.6rem', borderRadius: '12px' }}>
                        {alert.affectedCount} fields affected
                      </span>
                    </div>
                    <p style={{ margin: '0 0 0.8rem 0', fontSize: '0.85rem', color: 'var(--fd-text-secondary)', lineHeight: '1.5' }}>{alert.description}</p>
                    <div style={{ display: 'inline-block', fontSize: '0.75rem', fontWeight: 600, color: 'var(--fd-text-muted)', border: '1px solid rgba(255,255,255,0.1)', background: 'var(--fd-border-light)', padding: '0.3rem 0.6rem', borderRadius: '4px' }}>
                      ⚡ <strong>Action:</strong> {alert.action}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // Taluka Leaderboard — feat_5
  const renderTalukaLeaderboard = () => {
    if (selectedTaluka !== 'All Regions') return null

    const ranked = Object.entries(talukaStats)
      .map(([name, d]) => ({ name, yield: d.avgYield, fields: d.fieldCount }))
      .sort((a, b) => b.yield - a.yield)
    const maxYield = ranked[0]?.yield || 1
    const medals = ['🥇', '🥈', '🥉']

    return (
      <div className="glass-card" style={{ marginBottom: '2rem' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 1rem 0', fontSize: '1.1rem' }}>
          <Trophy size={20} color="#f59e0b" /> Taluka Leaderboard
        </h3>
        <div style={{ display: 'flex', gap: '0.6rem', overflowX: 'auto', paddingBottom: '0.5rem' }}>
          {ranked.map((t, i) => {
            const isTop3 = i < 3
            const isBottom3 = i >= ranked.length - 3
            const barColor = isTop3 ? '#f59e0b' : isBottom3 ? '#ef4444' : '#3b82f6'
            const bg = isTop3 ? 'rgba(245,158,11,0.08)' : isBottom3 ? 'rgba(239,68,68,0.06)' : 'var(--fd-card-inner-bg)'
            const border = isTop3 ? '1px solid rgba(245,158,11,0.2)' : isBottom3 ? '1px solid rgba(239,68,68,0.15)' : '1px solid rgba(255,255,255,0.05)'

            return (
              <div key={t.name} style={{ minWidth: '120px', flex: '0 0 auto', padding: '0.7rem', borderRadius: '8px', background: bg, border, textAlign: 'center' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--fd-text-tertiary)', marginBottom: '0.3rem' }}>
                  {isTop3 ? medals[i] : `#${i + 1}`}
                </div>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--fd-text-main)', marginBottom: '0.2rem', whiteSpace: 'nowrap' }}>{t.name}</div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: barColor }}>{t.yield} <span style={{ fontSize: '0.7rem', color: 'var(--fd-text-muted)' }}>T/Ha</span></div>
                <div className="progress-bar-container" style={{ height: '4px', marginTop: '0.4rem' }}>
                  <div style={{ width: `${(t.yield / maxYield * 100).toFixed(0)}%`, height: '100%', borderRadius: '2px', background: barColor }}></div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Soil & Irrigation Profile — feat_6
  const renderSoilIrrigation = () => {
    const soils = currentData?.soilDistribution || {}
    const irrig = currentData?.irrigationDistribution || {}
    const soilTotal = Object.values(soils).reduce((s, v) => s + v, 0) || 1
    const irrigTotal = Object.values(irrig).reduce((s, v) => s + v, 0) || 1
    const soilColors = { 'Sandy Loam': '#f59e0b', 'Black Cotton': '#6366f1', 'Medium Black': '#8b5cf6', 'Clay Loam': '#ec4899', 'Deep Black': '#a855f7' }
    const irrigColors = { 'Drip': '#10b981', 'Rainfed': '#3b82f6', 'Flood': '#f59e0b', 'Sprinkler': '#06b6d4' }

    if (Object.keys(soils).length === 0 && Object.keys(irrig).length === 0) return null

    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '2rem' }}>
        {/* Soil Distribution */}
        <div className="glass-card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 1rem 0', fontSize: '1.05rem' }}>
            <Leaf size={18} color="#f59e0b" /> Soil Distribution
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
            {Object.entries(soils).sort(([,a],[,b]) => b - a).map(([type, count]) => {
              const pct = ((count / soilTotal) * 100).toFixed(1)
              return (
                <div key={type}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem', fontSize: '0.8rem' }}>
                    <span style={{ color: 'var(--fd-text-secondary)' }}>{type}</span>
                    <span style={{ color: 'var(--fd-text-muted)', fontWeight: 600 }}>{pct}%</span>
                  </div>
                  <div className="progress-bar-container" style={{ height: '6px' }}>
                    <div style={{ width: `${pct}%`, height: '100%', borderRadius: '3px', background: soilColors[type] || 'var(--fd-text-tertiary)' }}></div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Irrigation Distribution */}
        <div className="glass-card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '0 0 1rem 0', fontSize: '1.05rem' }}>
            <Droplets size={18} color="#3b82f6" /> Irrigation Methods
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
            {Object.entries(irrig).sort(([,a],[,b]) => b - a).map(([method, count]) => {
              const pct = ((count / irrigTotal) * 100).toFixed(1)
              return (
                <div key={method}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem', fontSize: '0.8rem' }}>
                    <span style={{ color: 'var(--fd-text-secondary)' }}>{method}</span>
                    <span style={{ color: 'var(--fd-text-muted)', fontWeight: 600 }}>{pct}%</span>
                  </div>
                  <div className="progress-bar-container" style={{ height: '6px' }}>
                    <div style={{ width: `${pct}%`, height: '100%', borderRadius: '3px', background: irrigColors[method] || 'var(--fd-text-tertiary)' }}></div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const renderFieldsTable = () => (
    <div className="glass-card" style={{ overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.1rem', margin: 0 }}>
          <Users size={20} color="#a855f7" /> Registered Fields ({filteredFields.length})
        </h3>
        <div style={{ position: 'relative', width: '200px' }}>
          <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--fd-text-muted)' }} />
          <input type="text" placeholder="Search..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
            style={{ width: '100%', padding: '0.4rem 0.5rem 0.4rem 2rem', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)', background: 'var(--fd-card-inner-bg-solid)', color: 'var(--fd-text-main)', fontSize: '0.85rem', outline: 'none' }} />
        </div>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: '350px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '500px' }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--fd-table-header-bg)' }}>
            <tr>
              {['Field', 'Farmer', 'Taluka', 'Variety', 'Area', 'AI Yield', 'Harvest ETA'].map(h => (
                <th key={h} style={{ padding: '0.8rem 0.5rem', fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.1)', fontSize: '0.8rem', color: 'var(--fd-text-secondary)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredFields.map(field => {
              const fieldPred = aiPredictions?.fieldPredictions?.[field.id]
              return (
                <tr key={field.id}>
                  <td style={{ padding: '0.7rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: '0.85rem', color: 'var(--fd-text-main)' }}>{field.name}</td>
                  <td style={{ padding: '0.7rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: '0.85rem', color: 'var(--fd-text-muted)' }}>{field.farmerName}</td>
                  <td style={{ padding: '0.7rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ background: 'var(--fd-card-inner-bg-heavy)', padding: '0.15rem 0.4rem', borderRadius: '4px', fontSize: '0.75rem', color: 'var(--fd-text-muted)' }}>{field.taluka}</span>
                  </td>
                  <td style={{ padding: '0.7rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: '0.85rem', color: 'var(--fd-text-muted)' }}>{field.variety}</td>
                  <td style={{ padding: '0.7rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.05)', color: '#3b82f6', fontWeight: 600, fontSize: '0.85rem' }}>{field.area} Ha</td>
                  <td style={{ padding: '0.7rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    {predictionsLoading ? (
                      <span style={{ color: 'var(--fd-text-tertiary)', fontSize: '0.8rem' }}>...</span>
                    ) : fieldPred ? (
                      <span style={{ color: '#a78bfa', fontWeight: 600, fontSize: '0.85rem' }}>{fieldPred.toFixed(1)} T/Ha</span>
                    ) : (
                      <span style={{ color: 'var(--fd-text-tertiary)', fontSize: '0.75rem' }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '0.7rem 0.5rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    {harvestLoading ? (
                      <span style={{ color: 'var(--fd-text-tertiary)', fontSize: '0.8rem' }}>...</span>
                    ) : (() => {
                      const hq = harvestQueue.find(h => h.fieldId === field.id)
                      if (!hq) return <span style={{ color: 'var(--fd-text-tertiary)', fontSize: '0.75rem' }}>—</span>
                      const color = hq.daysRemaining <= 0 ? '#ef4444' : hq.daysRemaining <= 15 ? '#f59e0b' : '#10b981'
                      return (
                        <span style={{ fontSize: '0.8rem', fontWeight: 600, color }}>
                          {hq.daysRemaining <= 0 ? 'Ready Now' : `${hq.daysRemaining}d`}
                          <span style={{ color: 'var(--fd-text-tertiary)', fontWeight: 400, marginLeft: '0.3rem', fontSize: '0.7rem' }}>{hq.expectedDate}</span>
                        </span>
                      )
                    })()}
                  </td>
                </tr>
              )
            })}
            {filteredFields.length === 0 && !loading && (
              <tr><td colSpan="7" style={{ textAlign: 'center', padding: '2rem', color: 'var(--fd-text-tertiary)' }}>No fields found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )

  return (
    <div className="command-center-bg">
      <div className="dashboard-container" style={{ maxWidth: '1400px', margin: '0 auto', paddingTop: '2rem' }}>
        {renderTopBar()}
        {renderQuickStats()}
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '50vh' }}>
            <Droplets className="spin-slow" size={48} color="#3b82f6" style={{ marginBottom: '1rem' }} />
            <h3 style={{ color: 'var(--fd-text-muted)' }}>Syncing Factory Command Data...</h3>
          </div>
        ) : (
          <>
            {renderMetrics()}
            {renderRiskAlerts()}
            {renderTalukaLeaderboard()}
            {renderHarvestQueue()}
            {renderSoilIrrigation()}
            {renderInsights()}
            {renderFieldsTable()}
          </>
        )}
      </div>
    </div>
  )
}

export default FactoryDashboard
