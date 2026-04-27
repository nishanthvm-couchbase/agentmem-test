'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'

const API = 'http://127.0.0.1:8000'

// ---------------------------------------------------------------------------
// Preset scenarios
// ---------------------------------------------------------------------------
const PRESETS = [
  {
    label: 'Baseline',
    desc: 'Small clean run — verify basic functioning before stress',
    config: {
      num_users: 5, sessions_per_user: 1, messages_per_session: 3,
      async_processing: true, context_required: null,
      max_concurrency: 10, delay_between_requests: 0,
      include_facts: false, facts_per_session: 0,
      include_oversized: false, oversized_per_session: 0,
    },
  },
  {
    label: 'Queue Pressure',
    desc: 'Flood async queue with LLM extraction — look for queue_full + rate_limited errors',
    config: {
      num_users: 40, sessions_per_user: 2, messages_per_session: 5,
      async_processing: true, context_required: true,
      max_concurrency: 80, delay_between_requests: 0,
      include_facts: true, facts_per_session: 2,
      include_oversized: false, oversized_per_session: 0,
    },
  },
  {
    label: 'Sync Flood',
    desc: 'Many blocking sync+LLM calls — tests connection pool and timeout behaviour',
    config: {
      num_users: 25, sessions_per_user: 1, messages_per_session: 6,
      async_processing: false, context_required: true,
      max_concurrency: 25, delay_between_requests: 0,
      include_facts: false, facts_per_session: 0,
      include_oversized: false, oversized_per_session: 0,
    },
  },
  {
    label: 'Mixed Storm',
    desc: 'Valid + fact + oversized blocks together — exercises all rejection paths',
    config: {
      num_users: 30, sessions_per_user: 2, messages_per_session: 4,
      async_processing: true, context_required: null,
      max_concurrency: 60, delay_between_requests: 0,
      include_facts: true, facts_per_session: 2,
      include_oversized: true, oversized_per_session: 1,
    },
  },
]

const DEFAULT_CONFIG = PRESETS[0].config

// ---------------------------------------------------------------------------
// Latency formatter
// ---------------------------------------------------------------------------
function fmtLatency(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

// ---------------------------------------------------------------------------
// Error category colours
// ---------------------------------------------------------------------------
const ERROR_COLORS = {
  rate_limited:     '#f59e0b',
  queue_full:       '#ef4444',
  server_error:     '#ef4444',
  validation_error: '#8b5cf6',
  conflict:         '#6366f1',
  timeout:          '#f97316',
  network_error:    '#64748b',
}

function errorColor(cat) {
  return ERROR_COLORS[cat] ?? '#94a3b8'
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------
function StatCard({ label, value, sub, color = 'var(--text-primary)', mono = false }) {
  return (
    <div className="stat-card" style={{ textAlign: 'center' }}>
      <div style={{
        fontSize: 20, fontWeight: 700, color, lineHeight: 1,
        fontFamily: mono ? 'var(--font-geist-mono)' : undefined,
      }}>
        {value ?? '—'}
        {sub != null && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>{sub}</span>}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
    </div>
  )
}

function Toggle({ value, onChange, disabled }) {
  return (
    <div
      onClick={() => !disabled && onChange(!value)}
      style={{
        width: 40, height: 22, borderRadius: 11,
        background: value ? 'var(--accent)' : 'var(--bg-overlay)',
        position: 'relative', cursor: disabled ? 'default' : 'pointer',
        transition: 'background 0.2s', border: '1px solid var(--border)', flexShrink: 0,
      }}
    >
      <div style={{
        position: 'absolute', top: 2, left: value ? 18 : 2,
        width: 16, height: 16, borderRadius: '50%', background: 'white',
        transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
      }} />
    </div>
  )
}

function NumField({ label, value, onChange, min = 1, max = 500, step = 1, disabled }) {
  return (
    <div style={{ flex: '1 1 100px', minWidth: 80 }}>
      <label className="label">{label}</label>
      <input
        type="number" className="input"
        min={min} max={max} step={step}
        value={value}
        disabled={disabled}
        onChange={e => onChange(Number(e.target.value))}
        style={{ opacity: disabled ? 0.5 : 1 }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function SwarmTester() {
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [activeRun, setActiveRun] = useState(null)
  const [pastRuns, setPastRuns] = useState([])
  const [launching, setLaunching] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null }
  }, [])

  const poll = useCallback(async (runId) => {
    try {
      const resp = await fetch(`${API}/api/swarm/status/${runId}`)
      if (!resp.ok) return
      const data = await resp.json()
      setActiveRun(data)
      if (!data.completed) {
        pollRef.current = setTimeout(() => poll(runId), 1200)
      } else {
        stopPolling()
        fetchPastRuns()
      }
    } catch {
      pollRef.current = setTimeout(() => poll(runId), 2000)
    }
  }, [stopPolling])

  const fetchPastRuns = useCallback(async () => {
    try {
      const resp = await fetch(`${API}/api/swarm/runs`)
      if (resp.ok) setPastRuns(await resp.json())
    } catch {}
  }, [])

  useEffect(() => {
    fetchPastRuns()
    return () => stopPolling()
  }, [fetchPastRuns, stopPolling])

  async function launchSwarm() {
    setLaunching(true)
    setError(null)
    stopPolling()
    try {
      const resp = await fetch(`${API}/api/swarm/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      })
      if (!resp.ok) throw new Error(`Launch failed: ${resp.status}`)
      const { run_id } = await resp.json()
      pollRef.current = setTimeout(() => poll(run_id), 800)
    } catch (err) {
      setError(err.message)
    } finally {
      setLaunching(false)
    }
  }

  async function cleanupRun(runId) {
    setCleaning(true)
    try {
      await fetch(`${API}/api/swarm/cleanup/${runId}`, { method: 'DELETE' })
      fetchPastRuns()
      if (activeRun?.run_id === runId) setActiveRun(null)
    } catch {}
    setCleaning(false)
  }

  async function loadRun(runId) {
    stopPolling()
    try {
      const resp = await fetch(`${API}/api/swarm/status/${runId}`)
      if (resp.ok) {
        const data = await resp.json()
        setActiveRun(data)
        if (!data.completed) poll(runId)
      }
    } catch {}
  }

  const cfg = (key, val) => setConfig(c => ({ ...c, [key]: val }))
  const isRunning = activeRun && !activeRun.completed
  const run = activeRun

  // ---------------------------------------------------------------------------
  // Derived metrics
  // ---------------------------------------------------------------------------
  const totalSent     = run ? (run.messages_sent ?? 0) + (run.facts_sent ?? 0) : 0
  const totalSucceeded = run ? (run.messages_succeeded ?? 0) + (run.facts_succeeded ?? 0) : 0
  const progressPct   = run?.total_expected?.users > 0
    ? Math.round((run.users_created ?? 0) / run.total_expected.users * 100) : 0

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>

      {/* ── Config card ── */}
      <div className="card" style={{ padding: '16px 20px' }}>

        {/* Preset buttons */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.07em', alignSelf: 'center', marginRight: 4 }}>
            Presets
          </span>
          {PRESETS.map(p => (
            <button
              key={p.label}
              disabled={isRunning || launching}
              onClick={() => setConfig(p.config)}
              title={p.desc}
              style={{
                fontSize: 11, fontWeight: 600, padding: '4px 12px',
                borderRadius: 20, border: '1px solid var(--border)',
                background: JSON.stringify(config) === JSON.stringify(p.config)
                  ? 'var(--accent-glow)' : 'var(--bg-elevated)',
                color: JSON.stringify(config) === JSON.stringify(p.config)
                  ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: isRunning || launching ? 'not-allowed' : 'pointer',
                transition: 'all 0.15s',
                opacity: isRunning || launching ? 0.5 : 1,
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Numeric fields */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <NumField label="Users"           value={config.num_users}           onChange={v => cfg('num_users', v)}           min={1} max={500} disabled={!!isRunning} />
          <NumField label="Sessions / User" value={config.sessions_per_user}   onChange={v => cfg('sessions_per_user', v)}   min={1} max={20}  disabled={!!isRunning} />
          <NumField label="Messages / Sess" value={config.messages_per_session} onChange={v => cfg('messages_per_session', v)} min={1} max={50}  disabled={!!isRunning} />
          <NumField label="Concurrency"     value={config.max_concurrency}     onChange={v => cfg('max_concurrency', v)}     min={1} max={200} disabled={!!isRunning} />
          <NumField label="Delay (s)"       value={config.delay_between_requests} onChange={v => cfg('delay_between_requests', v)} min={0} max={5} step={0.1} disabled={!!isRunning} />
        </div>

        {/* Toggle row */}
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Async toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Toggle value={config.async_processing} onChange={v => cfg('async_processing', v)} disabled={!!isRunning} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Async processing</span>
          </div>

          {/* Include facts toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Toggle value={config.include_facts} onChange={v => cfg('include_facts', v)} disabled={!!isRunning} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Include facts</span>
            {config.include_facts && (
              <input
                type="number" className="input" min={1} max={10}
                value={config.facts_per_session}
                disabled={!!isRunning}
                onChange={e => cfg('facts_per_session', Number(e.target.value))}
                style={{ width: 52, padding: '4px 8px', fontSize: 12 }}
                title="Facts per session"
              />
            )}
          </div>

          {/* Include oversized toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Toggle value={config.include_oversized} onChange={v => cfg('include_oversized', v)} disabled={!!isRunning} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Oversized blocks</span>
          </div>

          {/* Context required selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Context</span>
            {[
              { label: 'Auto', val: null },
              { label: 'Always', val: true },
              { label: 'Skip', val: false },
            ].map(opt => (
              <button
                key={opt.label}
                disabled={!!isRunning}
                onClick={() => cfg('context_required', opt.val)}
                style={{
                  fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: config.context_required === opt.val ? 'var(--accent-glow)' : 'transparent',
                  color: config.context_required === opt.val ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: isRunning ? 'not-allowed' : 'pointer',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Launch */}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
            {error && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>}
            {isRunning && run && (
              <span style={{ fontSize: 12, color: 'var(--warning)' }}>
                {run.users_created ?? 0}/{run.num_users} users · {progressPct}%
              </span>
            )}
            <button
              className="btn-primary"
              onClick={launchSwarm}
              disabled={!!(isRunning || launching)}
              style={{ minWidth: 130 }}
            >
              {launching ? 'Launching…' : isRunning ? 'Running…' : '▶  Launch Swarm'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>

        {/* Past runs sidebar */}
        <div style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Run History
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pastRuns.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', paddingTop: 20 }}>No runs yet</div>
            )}
            {pastRuns.map(r => (
              <div
                key={r.run_id}
                className="card-elevated"
                onClick={() => loadRun(r.run_id)}
                style={{
                  padding: '10px 12px', cursor: 'pointer',
                  borderColor: activeRun?.run_id === r.run_id ? 'var(--accent)' : 'var(--border)',
                  transition: 'border-color 0.15s',
                }}
              >
                <div style={{ fontSize: 10, fontFamily: 'var(--font-geist-mono)', color: 'var(--text-muted)', marginBottom: 3 }}>
                  {r.run_id.slice(-10)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                  <div style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: !r.completed ? 'var(--warning)' : r.errors_total > 0 ? 'var(--warning)' : 'var(--success)',
                  }} />
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>
                    {r.messages_succeeded ?? 0} stored
                  </span>
                  {r.errors_total > 0 && (
                    <span style={{ fontSize: 10, color: 'var(--danger)' }}>· {r.errors_total} err</span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {r.num_users}u · {r.sessions_per_user}s · {r.messages_per_session}m
                  {r.async_processing ? ' · async' : ' · sync'}
                </div>
                {r.elapsed_seconds && (
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {r.elapsed_seconds}s
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Main panel */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {!run ? (
            <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
              <div style={{ fontSize: 36 }}>⚡</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)' }}>No active swarm run</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 400 }}>
                {PRESETS.map(p => (
                  <div key={p.label} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 10px', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', minWidth: 90 }}>{p.label}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 }}>{p.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>

              {/* Progress bar */}
              {isRunning && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className="spinner" style={{ width: 13, height: 13 }} />
                      <span style={{ fontSize: 12, color: 'var(--warning)' }}>Swarm in progress</span>
                    </div>
                    <span style={{ fontSize: 11, fontFamily: 'var(--font-geist-mono)', color: 'var(--text-secondary)' }}>
                      {run.users_created ?? 0}/{run.num_users} users
                    </span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${progressPct}%` }} />
                  </div>
                </div>
              )}

              {/* Throughput / perf row */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
                <StatCard label="Users"        value={`${run.users_created ?? 0}/${run.num_users}`}    color="var(--info)" />
                <StatCard label="Messages ✓"   value={run.messages_succeeded ?? 0}   color="var(--success)" />
                <StatCard label="Facts ✓"      value={run.facts_succeeded ?? 0}      color="var(--success)" />
                <StatCard label="Errors"        value={run.errors_total ?? 0}         color={(run.errors_total ?? 0) > 0 ? 'var(--danger)' : 'var(--text-muted)'} />
                <StatCard label="Success %"     value={run.success_rate_pct != null ? `${run.success_rate_pct}%` : '—'} color={(run.success_rate_pct ?? 100) >= 95 ? 'var(--success)' : 'var(--warning)'} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
                <StatCard label="Throughput"  value={run.throughput_rps != null ? run.throughput_rps : '—'} sub=" ops/s" color="var(--accent)" mono />
                <StatCard label="Latency P50" value={fmtLatency(run.latency_p50_ms)} mono />
                <StatCard label="Latency P95" value={fmtLatency(run.latency_p95_ms)} mono />
                <StatCard label="Elapsed"     value={run.elapsed_seconds != null ? `${run.elapsed_seconds} s` : '—'} mono />
                <StatCard label="Oversized ✗" value={run.oversized_rejected ?? 0} color={(run.oversized_rejected ?? 0) > 0 ? 'var(--warning)' : 'var(--text-muted)'} />
              </div>

              {/* Error breakdown */}
              {run.errors_total > 0 && Object.keys(run.errors_by_type).length > 0 && (
                <div className="card-elevated" style={{ padding: '12px 16px' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
                    Error Breakdown
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {Object.entries(run.errors_by_type).map(([cat, count]) => (
                      <div
                        key={cat}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '4px 10px', borderRadius: 20,
                          border: `1px solid ${errorColor(cat)}44`,
                          background: `${errorColor(cat)}18`,
                        }}
                      >
                        <span style={{ fontSize: 16, fontWeight: 700, color: errorColor(cat), fontFamily: 'var(--font-geist-mono)' }}>{count}</span>
                        <span style={{ fontSize: 11, color: errorColor(cat), fontWeight: 600 }}>{cat}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Completion banner */}
              {run.completed && (
                <div style={{
                  padding: '12px 16px', borderRadius: 10,
                  background: run.errors_total === 0 ? 'var(--success-bg)' : 'var(--warning-bg)',
                  border: `1px solid ${run.errors_total === 0 ? 'rgba(16,185,129,0.3)' : 'rgba(245,158,11,0.3)'}`,
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <span style={{ fontSize: 18 }}>{run.errors_total === 0 ? '✓' : '⚠'}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: run.errors_total === 0 ? 'var(--success)' : 'var(--warning)' }}>
                      {run.errors_total === 0 ? 'Swarm completed cleanly' : `Swarm completed — ${run.errors_total} error(s)`}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {totalSucceeded} ops succeeded of {totalSent} sent ·{' '}
                      {run.throughput_rps ?? '—'} ops/s · p95 {run.latency_p95_ms ?? '—'} ms
                    </div>
                  </div>
                  <button
                    className="btn-ghost"
                    onClick={() => cleanupRun(run.run_id)}
                    disabled={cleaning}
                    style={{ fontSize: 12 }}
                  >
                    {cleaning ? 'Cleaning…' : 'Delete Users'}
                  </button>
                </div>
              )}

              {/* Recent errors */}
              {run.recent_errors?.length > 0 && (
                <div className="card-elevated" style={{ padding: '12px 16px' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
                    Recent Errors (last {run.recent_errors.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
                    {run.recent_errors.map((e, i) => (
                      <div
                        key={i}
                        style={{
                          padding: '8px 10px', borderRadius: 8,
                          background: 'rgba(255,255,255,0.7)',
                          border: `1px solid ${errorColor(e.category)}30`,
                          borderLeft: `3px solid ${errorColor(e.category)}`,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          {e.status_code && (
                            <span style={{
                              fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                              background: errorColor(e.category) + '20',
                              color: errorColor(e.category),
                              fontFamily: 'var(--font-geist-mono)',
                            }}>
                              HTTP {e.status_code}
                            </span>
                          )}
                          <span style={{ fontSize: 11, fontWeight: 700, color: errorColor(e.category) }}>{e.category}</span>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>· {e.stage} · user {e.user_id}</span>
                        </div>
                        <div style={{
                          fontSize: 11, color: 'var(--text-secondary)',
                          fontFamily: 'var(--font-geist-mono)',
                          wordBreak: 'break-all', lineHeight: 1.5,
                          whiteSpace: 'pre-wrap',
                        }}>
                          {e.detail}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Run config summary */}
              <div className="card-elevated" style={{ padding: '10px 14px' }}>
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: run.log_file ? 8 : 0 }}>
                  {[
                    ['Run ID', run.run_id?.slice(-12)],
                    ['Mode', run.async_processing ? 'async' : 'sync'],
                    ['Context', run.context_required === true ? 'always' : run.context_required === false ? 'skip' : 'auto'],
                    ['Load', `${run.num_users}u × ${run.sessions_per_user}s × ${run.messages_per_session}m`],
                    ['Concurrency', run.max_concurrency],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{k}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-geist-mono)' }}>{v}</div>
                    </div>
                  ))}
                </div>
                {run.log_file && (
                  <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>Log File</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', wordBreak: 'break-all' }}>
                      {run.log_file}
                    </div>
                  </div>
                )}
              </div>

            </div>
          )}
        </div>
      </div>
    </div>
  )
}
