'use client'

import React, { useState, useEffect, useCallback } from 'react'
import TravelHub from './_components/TravelHub'
import ValidationRunner from './_components/ValidationRunner'
import SwarmTester from './_components/SwarmTester'

const API = 'http://127.0.0.1:8000'

const NAV = [
  { id: 'travel',     label: 'Travel Hub',     icon: IconTravel,     desc: 'Interactive agent memory sandbox' },
  { id: 'validation', label: 'Validation',     icon: IconValidation, desc: 'Assertion-based AMS test suite' },
  { id: 'swarm',      label: 'Swarm Tester',   icon: IconSwarm,      desc: 'Concurrent load & volume testing' },
  { id: 'chaos',      label: 'Chaos Injector', icon: IconChaos,      desc: 'Resilience & fault injection', soon: true },
]

export default function Home() {
  const [section, setSection] = useState('travel')
  const [health, setHealth] = useState(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const fetchHealth = useCallback(async () => {
    try {
      const resp = await fetch(`${API}/api/health`)
      if (resp.ok) setHealth(await resp.json())
      else setHealth({ tester_status: 'error', agentmem_server_status: 'error' })
    } catch {
      setHealth({ tester_status: 'error', agentmem_server_status: 'unreachable' })
    }
  }, [])

  useEffect(() => {
    fetchHealth()
    const t = setInterval(fetchHealth, 15000)
    return () => clearInterval(t)
  }, [fetchHealth])

  const amsOk = health?.agentmem_server_status === 'healthy'
  const testerOk = health?.tester_status === 'ok'

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg-base)', backgroundAttachment: 'fixed', overflow: 'hidden' }}>
      {/* Sidebar */}
      <aside style={{
        width: sidebarOpen ? 228 : 60,
        flexShrink: 0,
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width 0.2s ease',
        overflow: 'hidden',
        backdropFilter: 'blur(22px)',
        WebkitBackdropFilter: 'blur(22px)',
      }}>
        {/* Logo area */}
        <div style={{
          padding: sidebarOpen ? '20px 20px 16px' : '20px 14px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          overflow: 'hidden',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0,
            background: 'linear-gradient(135deg, #6366f1, #818cf8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, boxShadow: '0 0 16px rgba(99,102,241,0.4)',
          }}>
            ◈
          </div>
          {sidebarOpen && (
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>AgentMem</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Test Dashboard</div>
            </div>
          )}
        </div>

        {/* Nav items */}
        <nav style={{ flex: 1, padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NAV.map(item => {
            const active = section === item.id && !item.soon
            const Icon = item.icon
            return (
              <button
                key={item.id}
                disabled={item.soon}
                onClick={() => !item.soon && setSection(item.id)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: sidebarOpen ? '9px 12px' : '9px 14px',
                  borderRadius: 8,
                  border: 'none',
                  background: active ? 'var(--accent-glow)' : 'transparent',
                  cursor: item.soon ? 'not-allowed' : 'pointer',
                  transition: 'background 0.15s',
                  textAlign: 'left',
                  overflow: 'hidden',
                  borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
                }}
                onMouseEnter={e => { if (!active && !item.soon) e.currentTarget.style.background = 'var(--bg-elevated)' }}
                onMouseLeave={e => { if (!active && !item.soon) e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{
                  color: active ? 'var(--accent)' : item.soon ? 'var(--text-muted)' : 'var(--text-secondary)',
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                }}>
                  <Icon size={16} />
                </span>
                {sidebarOpen && (
                  <div style={{ overflow: 'hidden' }}>
                    <div style={{
                      fontSize: 13,
                      fontWeight: active ? 600 : 400,
                      color: active ? 'var(--text-primary)' : item.soon ? 'var(--text-muted)' : 'var(--text-secondary)',
                      whiteSpace: 'nowrap',
                    }}>
                      {item.label}
                      {item.soon && (
                        <span style={{
                          marginLeft: 6, fontSize: 9, fontWeight: 700, padding: '1px 5px',
                          borderRadius: 4, background: 'var(--bg-overlay)', color: 'var(--text-muted)',
                          textTransform: 'uppercase', letterSpacing: '0.05em', verticalAlign: 'middle',
                        }}>
                          soon
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </button>
            )
          })}
        </nav>

        {/* Health status */}
        <div style={{ padding: sidebarOpen ? '12px 16px' : '12px 8px', borderTop: '1px solid var(--border)' }}>
          {sidebarOpen ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <HealthRow label="Tester API" ok={testerOk} />
              <HealthRow label="AMS Server" ok={amsOk} />
            </div>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: amsOk && testerOk ? 'var(--success)' : 'var(--danger)',
              }} />
            </div>
          )}
        </div>

        {/* Collapse toggle */}
        <button
          onClick={() => setSidebarOpen(o => !o)}
          style={{
            background: 'none',
            border: 'none',
            borderTop: '1px solid var(--border)',
            padding: '10px',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: sidebarOpen ? 'flex-end' : 'center',
            paddingRight: sidebarOpen ? 16 : 10,
          }}
          title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {sidebarOpen ? '◀' : '▶'}
        </button>
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <header style={{
          padding: '0 24px',
          height: 56,
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--bg-surface)',
          backdropFilter: 'blur(22px)',
          WebkitBackdropFilter: 'blur(22px)',
          flexShrink: 0,
        }}>
          <div>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
              {NAV.find(n => n.id === section)?.label}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 10 }}>
              {NAV.find(n => n.id === section)?.desc}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {health && (
              <div style={{ display: 'flex', gap: 8 }}>
                <StatusPill label="Tester" ok={testerOk} />
                <StatusPill label="AMS" ok={amsOk} />
              </div>
            )}
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-geist-mono)' }}>
              {API}
            </span>
          </div>
        </header>

        {/* Section content */}
        <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          {section === 'travel' && <TravelHub />}
          {section === 'validation' && <ValidationRunner />}
          {section === 'swarm' && <SwarmTester />}
          {section === 'chaos' && <ChaosComing />}
        </div>
      </main>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared small components
// ---------------------------------------------------------------------------

function HealthRow({ label, ok }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: ok ? 'var(--success)' : 'var(--danger)' }} />
        <span style={{ fontSize: 10, fontWeight: 600, color: ok ? 'var(--success)' : 'var(--danger)' }}>
          {ok ? 'OK' : 'DOWN'}
        </span>
      </div>
    </div>
  )
}

function StatusPill({ label, ok }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '3px 8px', borderRadius: 20,
      background: ok ? 'var(--success-bg)' : 'var(--danger-bg)',
      border: `1px solid ${ok ? 'rgba(16,185,129,0.25)' : 'rgba(239,68,68,0.25)'}`,
    }}>
      <div style={{ width: 5, height: 5, borderRadius: '50%', background: ok ? 'var(--success)' : 'var(--danger)' }} />
      <span style={{ fontSize: 11, fontWeight: 600, color: ok ? 'var(--success)' : 'var(--danger)' }}>{label}</span>
    </div>
  )
}

function ChaosComing() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60%', gap: 16 }}>
      <div style={{ fontSize: 48 }}>💥</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-secondary)' }}>Chaos Injector</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 380 }}>
        Fault injection, crash recovery testing, and resilience validation are coming soon. Covers AMS restart, WAL recovery, network partitions, and model unavailability scenarios.
      </div>
      <span style={{ padding: '4px 12px', borderRadius: 20, background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Coming Soon
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
function IconTravel({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.5C5.5 1.5 3 3.5 3 6.5c0 3.5 5 8 5 8s5-4.5 5-8c0-3-2.5-5-5-5z"/>
      <circle cx="8" cy="6.5" r="1.5"/>
    </svg>
  )
}

function IconValidation({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="2"/>
      <path d="M5 8l2 2 4-4"/>
    </svg>
  )
}

function IconSwarm({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="3" cy="8" r="1.5"/>
      <circle cx="8" cy="3" r="1.5"/>
      <circle cx="13" cy="8" r="1.5"/>
      <circle cx="8" cy="13" r="1.5"/>
      <path d="M4.5 8h3m1.5-3.5v3m1.5 1.5h-3m-1.5 1.5v-3"/>
    </svg>
  )
}

function IconChaos({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 8h3l2-5 2 10 2-5h3"/>
    </svg>
  )
}
