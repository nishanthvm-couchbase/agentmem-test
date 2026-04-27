'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'

const API = 'http://127.0.0.1:8000'

const SCENARIO_DESCRIPTIONS = {
  s01: 'Create, fetch, verify, and delete a user. Verify 404 after deletion.',
  s02: 'Create/fetch/list session, end it, delete it, verify 404 after deletion.',
  s03: 'Delete a user with active sessions and verify cascade removal.',
  s04: 'Add block with async=false/context_required=false; verify immediate searchability.',
  s05: 'Add block with async=true; verify processing→ready and LLM enrichment.',
  s06: 'Store h1 and h2 annotated blocks; verify annotation filters under concurrency.',
  s07: 'Semantic search returns ready blocks; filter-based retrieval returns all.',
  s08: 'Verify ended sessions reject new memory block additions.',
  s09: 'Verify duplicate user_id and session_id return 409 Conflict.',
  s10: 'Verify oversized and malformed blocks are rejected with 4xx.',
  s11: 'Verify TTL blocks expire; non-TTL blocks persist.',
}

function statusColor(status) {
  switch (status) {
    case 'passed': return 'var(--success)'
    case 'failed': return 'var(--danger)'
    case 'error':  return 'var(--danger)'
    case 'running': return 'var(--warning)'
    default: return 'var(--text-muted)'
  }
}

function StatusDot({ status, size = 8 }) {
  const color = statusColor(status)
  const isRunning = status === 'running'
  return (
    <span
      className={isRunning ? 'pulse-dot' : ''}
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

function AssertionRow({ a }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      padding: '5px 8px',
      borderRadius: 6,
      background: a.passed ? 'rgba(16,185,129,0.05)' : 'rgba(239,68,68,0.05)',
      border: `1px solid ${a.passed ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}`,
      marginBottom: 4,
    }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: a.passed ? 'var(--success)' : 'var(--danger)', minWidth: 34, marginTop: 1 }}>
        {a.passed ? 'PASS' : 'FAIL'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.4 }}>{a.name}</div>
        {(!a.passed && (a.expected || a.actual)) && (
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
  const { status, name, assertions, error_message, duration_ms, description } = scenario

  const passCount = assertions.filter(a => a.passed).length
  const failCount = assertions.filter(a => !a.passed).length

  const isExpandable = assertions.length > 0 || error_message

  useEffect(() => {
    if (status === 'failed' || status === 'error') setExpanded(true)
  }, [status])

  return (
    <div
      className="card-elevated"
      style={{
        borderColor: status === 'running' ? 'var(--warning)' :
                     status === 'passed'  ? 'rgba(16,185,129,0.35)' :
                     status === 'failed' || status === 'error' ? 'rgba(239,68,68,0.35)' :
                     'var(--border)',
        transition: 'border-color 0.2s',
      }}
    >
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
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', minWidth: 28 }}>
          {String(index + 1).padStart(2, '0')}
        </span>
        <StatusDot status={status} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3 }}>{name}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.3 }}>{description}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {assertions.length > 0 && (
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
            minWidth: 50,
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

function SummaryBar({ summary, status }) {
  const total = summary?.total || 0
  const passed = summary?.passed || 0
  const failed = summary?.failed || 0
  const pending = total - passed - failed
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
      {[
        { label: 'Total', value: total, color: 'var(--text-primary)' },
        { label: 'Passed', value: passed, color: 'var(--success)' },
        { label: 'Failed', value: failed, color: 'var(--danger)' },
        { label: 'Pass Rate', value: total > 0 ? `${pct}%` : '—', color: pct === 100 && total > 0 ? 'var(--success)' : pct > 50 ? 'var(--warning)' : 'var(--danger)' },
      ].map(item => (
        <div className="stat-card" key={item.label} style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: item.color, lineHeight: 1 }}>{item.value}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{item.label}</div>
        </div>
      ))}
    </div>
  )
}

export default function ValidationRunner() {
  const [activeRun, setActiveRun] = useState(null)
  const [pastRuns, setPastRuns] = useState([])
  const [launching, setLaunching] = useState(false)
  const [skipCleanup, setSkipCleanup] = useState(false)
  const [error, setError] = useState(null)
  const pollRef = useRef(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const poll = useCallback(async (runId) => {
    try {
      const resp = await fetch(`${API}/api/validation/status/${runId}`)
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
      const resp = await fetch(`${API}/api/validation/runs`)
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
      const resp = await fetch(`${API}/api/validation/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skip_cleanup: skipCleanup }),
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
      const resp = await fetch(`${API}/api/validation/status/${runId}`)
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
      await fetch(`${API}/api/validation/runs/${runId}`, { method: 'DELETE' })
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, height: '100%' }}>
      {/* Header controls */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Validation Suite</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {Object.keys(SCENARIO_DESCRIPTIONS).length} scenarios · sequential · isolated cleanup
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {error && (
              <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>
            )}
            {isRunning && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="spinner" style={{ width: 16, height: 16 }} />
                <span style={{ fontSize: 12, color: 'var(--warning)' }}>
                  Running scenario {currentIdx + 1}/{scenarios.length}
                </span>
              </div>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={skipCleanup}
                onChange={e => setSkipCleanup(e.target.checked)}
                disabled={isRunning || launching}
                style={{ accentColor: 'var(--accent)', width: 13, height: 13, cursor: 'pointer' }}
              />
              <span style={{ fontSize: 12, color: skipCleanup ? 'var(--warning)' : 'var(--text-muted)' }}>
                Keep test data
              </span>
            </label>
            <button
              className="btn-primary"
              onClick={launchRun}
              disabled={isRunning || launching}
              style={{ minWidth: 130 }}
            >
              {launching ? 'Launching…' : isRunning ? 'Running…' : '▶  Run All Tests'}
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
                      {run.summary?.passed ?? 0}/{run.summary?.total ?? 0} passed
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
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Main results panel */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {!activeRun ? (
            <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
              <div style={{ fontSize: 40 }}>🧪</div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>No active run</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 340 }}>
                  Launch a validation run to test all fundamental AMS layers. Each scenario runs sequentially, creates isolated data, and cleans up after itself.
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 400 }}>
                {Object.entries(SCENARIO_DESCRIPTIONS).map(([id, desc], i) => (
                  <div key={id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 10px', borderRadius: 6, background: 'var(--bg-elevated)' }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)', minWidth: 24, marginTop: 1 }}>{id}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
              {/* Summary stats */}
              <SummaryBar summary={activeRun.summary} status={activeRun.status} />

              {/* Progress bar */}
              {isRunning && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Progress</span>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-geist-mono)' }}>{progressPct}%</span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${progressPct}%` }} />
                  </div>
                </div>
              )}

              {/* Scenarios list */}
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {scenarios.map((s, i) => (
                  <ScenarioCard key={s.id} scenario={s} index={i} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
