'use client'

import { useState } from 'react'
import TravelHub from './_components/TravelHub'
import Explorer from './_components/Explorer'

const TABS = [
  { id: 'travelhub', label: 'TravelHub Demo' },
  { id: 'explorer', label: 'SDK Explorer' },
]

export default function Home() {
  const [activeTab, setActiveTab] = useState('travelhub')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Tab bar */}
      <div style={{
        height: 44,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        background: '#0d1117',
        borderBottom: '1px solid #21262d',
        gap: 0,
        paddingLeft: 16,
      }}>
        {TABS.map(tab => {
          const active = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '0 20px',
                height: '100%',
                background: 'none',
                border: 'none',
                borderBottom: active ? '2px solid #EA2328' : '2px solid transparent',
                color: active ? '#f0f6fc' : '#8b949e',
                fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
                fontSize: 13,
                fontWeight: active ? 600 : 400,
                cursor: 'pointer',
                letterSpacing: '0.01em',
                transition: 'color 0.15s, border-color 0.15s',
                whiteSpace: 'nowrap',
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {activeTab === 'travelhub' && <TravelHub />}
        {activeTab === 'explorer' && <Explorer />}
      </div>
    </div>
  )
}
