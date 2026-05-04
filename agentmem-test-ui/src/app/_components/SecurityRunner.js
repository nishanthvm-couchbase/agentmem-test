'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000'

const CATEGORY_META = {
  input_validation: { label: 'Input Validation',      color: '#f59e0b', bg: 'rgba(245,158,11,0.08)',  border: 'rgba(245,158,11,0.25)' },
  isolation:        { label: 'Cross-Tenant Isolation', color: '#3b82f6', bg: 'rgba(59,130,246,0.08)',  border: 'rgba(59,130,246,0.25)' },
  auth:             { label: 'Auth Boundary',          color: '#ef4444', bg: 'rgba(239,68,68,0.08)',   border: 'rgba(239,68,68,0.25)' },
  mtls:             { label: 'mTLS',                   color: '#8b5cf6', bg: 'rgba(139,92,246,0.08)',  border: 'rgba(139,92,246,0.25)' },
}

function statusColor(status) {
  switch (status) {
    case 'passed':  return 'var(--success)'
    case 'failed':  return 'var(--danger)'
    case 'error':   return 'var(--danger)'
    case 'skipped': return 'var(--text-muted)'
    case 'running': return 'var(--warning)'
    default: return 'var(--text-muted)'
  }
}

function StatusDot({ status, size = 8 }) {
  const color = statusColor(status)
  return (
    <span
      className={status === 'running' ? 'pulse-dot' : ''}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }}
    />
  )
}

function CategoryBadge({ category }) {
  const meta = CATEGORY_META[category] || { label: category, color: 'var(--text-muted)', bg: 'var(--bg-elevated)', border: 'var(--border)' }
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 700,
      padding: '2px 6px',
      borderRadius: 4,
      background: meta.bg,
      border: `1px solid ${meta.border}`,
      color: meta.color,
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      flexShrink: 0,
    }}>
      {meta.label}
    </span>
  )
}

function AssertionRow({ a }) {
  const isSkipped = a.actual === 'skipped'
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      padding: '5px 8px',
      borderRadius: 6,
      background: isSkipped ? 'rgba(255,255,255,0.03)' : a.passed ? 'rgba(16,185,129,0.05)' : 'rgba(239,68,68,0.05)',
      border: `1px solid ${isSkipped ? 'rgba(255,255,255,0.08)' : a.passed ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}`,
      marginBottom: 4,
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: isSkipped ? 'var(--text-muted)' : a.passed ? 'var(--success)' : 'var(--danger)', minWidth: 34, marginTop: 1 }}>
        {isSkipped ? 'SKIP' : a.passed ? 'PASS' : 'FAIL'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.4 }}>{a.name}</div>
        {(!a.passed && !isSkipped && (a.expected || a.actual)) && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, fontFamily: 'var(--font-geist-mono)', lineHeight: 1.4 }}>
            expected <span style={{ color: 'var(--success)' }}>{a.expected}</span>
            {' · '}got <span style={{ color: 'var(--danger)' }}>{a.actual}</span>
            {a.error && <span style={{ color: 'var(--warning)' }}> · {a.error}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

function ScenarioCard({ scenario, index }) {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const { status, name, category, assertions, error_message, duration_ms, description } = scenario

  const passCount = assertions.filter(a => a.passed && a.actual !== 'skipped').length
  const failCount = assertions.filter(a => !a.passed).length
  const skipCount = assertions.filter(a => a.actual === 'skipped').length

  const isExpandable = assertions.length > 0 || error_message

  useEffect(() => {
    if (status === 'failed' || status === 'error') setExpanded(true)
  }, [status])

  const borderColor =
    status === 'running' ? 'var(--warning)' :
    status === 'passed'  ? 'rgba(16,185,129,0.35)' :
    status === 'skipped' ? 'rgba(255,255,255,0.1)' :
    status === 'failed' || status === 'error' ? 'rgba(239,68,68,0.35)' :
    'var(--border)'

  return (
    <div className="card-elevated" style={{ borderColor, transition: 'border-color 0.2s' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          cursor: isExpandable ? 'pointer' : 'default',
          userSelect: 'none',
          background: hovered && isExpandable ? 'rgba(255,255,255,0.03)' : 'transparent',
          transition: 'background 0.15s',
        }}
        onClick={() => isExpandable && setExpanded(e => !e)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', minWidth: 40 }}>
          {scenario.id}
        </span>
        <StatusDot status={status} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>{name}</span>
            <CategoryBadge category={category} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.3 }}>{description}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {skipCount > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              <span style={{ color: 'var(--text-muted)' }}>{skipCount} skipped</span>
            </span>
          )}
          {assertions.length > 0 && skipCount === 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              <span style={{ color: 'var(--success)' }}>{passCount}</span>
              {failCount > 0 && <span style={{ color: 'var(--danger)' }}>/{failCount} fail</span>}
              {' checks'}
            </span>
          )}
          {duration_ms > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }}>
              {duration_ms > 1000 ? `${(duration_ms / 1000).toFixed(1)}s` : `${duration_ms}ms`}
            </span>
          )}
          <span style={{
            fontSize: 11,
            fontWeight: 700,
            color: statusColor(status),
            textTransform: 'uppercase',
            minWidth: 54,
            textAlign: 'right',
          }}>
            {status === 'pending' ? '—' : status}
          </span>
          {isExpandable && (
            <span style={{ color: 'var(--text-muted)', fontSize: 12, transition: 'transform 0.15s', display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'none' }}>
              ▶
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '0 16px 14px', borderTop: '1px solid var(--border-subtle)' }}>
          <div style={{ paddingTop: 12 }}>
            {error_message && (
              <div style={{ background: 'var(--danger-bg)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 10, fontSize: 12, color: 'var(--danger)', fontFamily: 'var(--font-geist-mono)' }}>
                {error_message}
              </div>
            )}
            {assertions.map((a, i) => <AssertionRow key={i} a={a} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function CategoryGroup({ categoryKey, scenarios }) {
  const meta = CATEGORY_META[categoryKey] || { label: categoryKey, color: 'var(--text-muted)' }
  const passCount = scenarios.filter(s => s.status === 'passed').length
  const failCount = scenarios.filter(s => s.status === 'failed' || s.status === 'error').length
  const skipCount = scenarios.filter(s => s.status === 'skipped').length
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
        <div style={{ width: 3, height: 16, borderRadius: 2, background: meta.color, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {meta.label}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {passCount > 0 && <span style={{ color: 'var(--success)' }}>{passCount} pass </span>}
          {failCount > 0 && <span style={{ color: 'var(--danger)' }}>{failCount} fail </span>}
          {skipCount > 0 && <span>{skipCount} skipped</span>}
        </span>
      </div>
      {scenarios.map((s, i) => <ScenarioCard key={s.id} scenario={s} index={i} />)}
    </div>
  )
}

function SummaryBar({ summary }) {
  const total = summary?.total || 0
  const passed = summary?.passed || 0
  const skipped = summary?.skipped || 0
  const failed = summary?.failed || 0
  const effective = total - skipped
  const pct = effective > 0 ? Math.round((passed / effective) * 100) : (total > 0 ? 100 : 0)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
      {[
        { label: 'Total',   value: total,   color: 'var(--text-primary)' },
        { label: 'Passed',  value: passed,  color: 'var(--success)' },
        { label: 'Failed',  value: failed,  color: failed > 0 ? 'var(--danger)' : 'var(--text-muted)' },
        { label: 'Skipped', value: skipped, color: 'var(--text-muted)' },
        { label: 'Pass Rate', value: effective > 0 ? `${pct}%` : '—', color: pct === 100 && effective > 0 ? 'var(--success)' : pct > 50 ? 'var(--warning)' : 'var(--danger)' },
      ].map(item => (
        <div className="stat-card" key={item.label} style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: item.color, lineHeight: 1 }}>{item.value}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{item.label}</div>
        </div>
      ))}
    </div>
  )
}

export default function SecurityRunner() {
  const [activeRun, setActiveRun] = useState(null)
  const [pastRuns, setPastRuns] = useState([])
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null }
  }, [])

  const poll = useCallback(async (runId) => {
    try {
      const resp = await fetch(`${API}/api/security/status/${runId}`)
      if (!resp.ok) return
      const data = await resp.json()
      setActiveRun(data)
      if (data.status === 'running') {
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
      const resp = await fetch(`${API}/api/security/runs`)
      if (resp.ok) setPastRuns(await resp.json())
    } catch {}
  }, [])

  useEffect(() => {
    fetchPastRuns()
    return () => stopPolling()
  }, [fetchPastRuns, stopPolling])

  async function launchRun() {
    setLaunching(true)
    setError(null)
    stopPolling()
    try {
      const resp = await fetch(`${API}/api/security/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!resp.ok) throw new Error(`Launch failed: ${resp.status}`)
      const { run_id } = await resp.json()
      pollRef.current = setTimeout(() => poll(run_id), 600)
    } catch (err) {
      setError(err.message)
    } finally {
      setLaunching(false)
    }
  }

  async function loadRun(runId) {
    stopPolling()
    try {
      const resp = await fetch(`${API}/api/security/status/${runId}`)
      if (resp.ok) {
        const data = await resp.json()
        setActiveRun(data)
        if (data.status === 'running') poll(runId)
      }
    } catch {}
  }

  async function deleteRun(runId, e) {
    e.stopPropagation()
    try {
      await fetch(`${API}/api/security/runs/${runId}`, { method: 'DELETE' })
      if (activeRun?.run_id === runId) setActiveRun(null)
      fetchPastRuns()
    } catch {}
  }

  const isRunning = activeRun?.status === 'running'
  const scenarios = activeRun?.scenarios || []
  const currentIdx = activeRun?.current_scenario ?? -1

  const progressPct = scenarios.length > 0
    ? Math.round((scenarios.filter(s => s.status !== 'pending').length / scenarios.length) * 100)
    : 0

  // Group scenarios by category in display order
  const CATEGORY_ORDER = ['input_validation', 'isolation', 'auth', 'mtls']
  const grouped = CATEGORY_ORDER.map(cat => ({
    key: cat,
    scenarios: scenarios.filter(s => s.category === cat),
  })).filter(g => g.scenarios.length > 0)

  const oidcEnabled = activeRun?.oidc_enabled ?? false

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, height: '100%' }}>
      {/* Header */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Security Test Suite</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              11 scenarios · input validation, tenant isolation, auth boundary
              {activeRun && (
                <span style={{ marginLeft: 8, padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                  background: oidcEnabled ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.05)',
                  color: oidcEnabled ? 'var(--danger)' : 'var(--text-muted)',
                  border: `1px solid ${oidcEnabled ? 'rgba(239,68,68,0.3)' : 'rgba(255,255,255,0.1)'}`,
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>
                  OIDC {oidcEnabled ? 'ON' : 'OFF'}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {error && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>}
            {isRunning && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="spinner" style={{ width: 16, height: 16 }} />
                <span style={{ fontSize: 12, color: 'var(--warning)' }}>
                  Running scenario {currentIdx + 1}/{scenarios.length}
                </span>
              </div>
            )}
            <button
              className="btn-primary"
              onClick={launchRun}
              disabled={isRunning || launching}
              style={{ minWidth: 140, background: 'linear-gradient(135deg, #dc2626, #991b1b)' }}
            >
              {launching ? 'Launching…' : isRunning ? 'Running…' : '▶  Run Security Tests'}
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 20, flex: 1, minHeight: 0 }}>
        {/* Past runs sidebar */}
        <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Run History
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto' }}>
            {pastRuns.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', paddingTop: 16 }}>No runs yet</div>
            )}
            {pastRuns.map(run => (
              <div
                key={run.run_id}
                className="card-elevated"
                onClick={() => loadRun(run.run_id)}
                style={{
                  padding: '10px 12px',
                  cursor: 'pointer',
                  borderColor: activeRun?.run_id === run.run_id ? 'var(--accent)' : 'var(--border)',
                  transition: 'border-color 0.15s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                      <StatusDot status={run.status} size={7} />
                      <span style={{ fontSize: 11, fontFamily: 'var(--font-geist-mono)', color: 'var(--text-secondary)' }}>
                        {run.run_id.slice(4, 12)}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {run.summary?.passed ?? 0}p
                      {(run.summary?.skipped ?? 0) > 0 && ` · ${run.summary.skipped}s`}
                      {(run.summary?.failed ?? 0) > 0 && <span style={{ color: 'var(--danger)' }}> · {run.summary.failed}f</span>}
                      {' / '}{run.summary?.total ?? 0}
                    </div>
                  </div>
                  <button
                    onClick={(e) => deleteRun(run.run_id, e)}
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 2 }}
                    title="Delete run"
                  >
                    ×
                  </button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                  {new Date(run.started_at).toLocaleTimeString()}
                  {run.oidc_enabled && <span style={{ marginLeft: 6, color: 'var(--danger)' }}>OIDC</span>}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Main results panel */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!activeRun ? (
            <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
              <div style={{ fontSize: 40 }}>🔒</div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>No active run</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 380 }}>
                  Run security tests to validate input handling, tenant isolation, and auth boundaries. Auth scenarios auto-skip when OIDC is disabled.
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%', maxWidth: 480 }}>
                {Object.entries(CATEGORY_META).map(([key, meta]) => (
                  <div key={key} style={{ borderRadius: 8, border: `1px solid ${meta.border}`, background: meta.bg, padding: '10px 14px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: meta.color, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{meta.label}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {key === 'input_validation' && 'Injection, path traversal, XSS, oversized IDs, special characters (SEC-01–05)'}
                      {key === 'isolation' && 'Session path isolation, memory read isolation, cross-delete data integrity (SEC-06–08)'}
                      {key === 'auth' && 'No-token, malformed/HS256/wrong-realm token, expired JWT — auto-skipped when OIDC is off (SEC-09–14)'}
                      {key === 'mtls' && 'Couchbase mTLS connectivity smoke — auto-skipped unless AMS_MTLS_ENABLED=true (SEC-15)'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              <SummaryBar summary={activeRun.summary} />

              {isRunning && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Progress</span>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-geist-mono)' }}>{progressPct}%</span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${progressPct}%`, background: 'linear-gradient(90deg, #dc2626, #f59e0b)' }} />
                  </div>
                </div>
              )}

              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
                {grouped.map(g => (
                  <CategoryGroup key={g.key} categoryKey={g.key} scenarios={g.scenarios} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
