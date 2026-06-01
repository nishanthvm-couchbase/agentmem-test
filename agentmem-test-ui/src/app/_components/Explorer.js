'use client'

import React, { useState, useRef } from 'react'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000'

// ─── Code lines ─────────────────────────────────────────────────────────────
// n:true  → highlighted (SDK addition)
// c:true  → comment line (dimmed)
//
// Both panels show the same respond() function — only the highlighted lines differ.
// The demo extends the WITH pattern to 2 sessions + 2 agents (visible in results).

const WITHOUT_LINES = [
  { t: 'from openai import OpenAI' },
  { t: '' },
  { t: 'client = OpenAI()' },
  { t: '' },
  { t: '' },
  { t: 'def respond(persona: str, message: str) -> str:' },
  { t: '    r = client.chat.completions.create(' },
  { t: '        model="gpt-4o-mini",' },
  { t: '        messages=[' },
  { t: '            {"role": "system", "content": persona},' },
  { t: '            {"role": "user",   "content": message},' },
  { t: '        ],' },
  { t: '    )' },
  { t: '    return r.choices[0].message.content' },
]

const WITH_LINES = [
  { t: 'from openai import OpenAI' },
  { t: 'from agentmemory import AgentMemoryClient',       n: true },
  { t: '' },
  { t: 'client  = OpenAI()' },
  { t: 'ams     = AgentMemoryClient(base_url=AMS_URL)',   n: true },
  { t: 'user    = ams.get_user(user_id)',                 n: true },
  { t: 'session = user.create_session(session_id)',       n: true },
  { t: '' },
  { t: '' },
  { t: 'def respond(persona: str, message: str) -> str:' },
  { t: '    blocks = session.get_memory(',               n: true },
  { t: '        query=message,',                         n: true },
  { t: '        filters={"session_ids": "all"},',        n: true },
  { t: '    ).memory_blocks',                            n: true },
  { t: '    context = "\\n".join(',                      n: true },
  { t: '        b.fact or b.summary for b in blocks)',   n: true },
  { t: '    r = client.chat.completions.create(' },
  { t: '        model="gpt-4o-mini",' },
  { t: '        messages=[' },
  { t: '            {"role": "system",',                 n: true },
  { t: '             "content": persona + context},',   n: true },
  { t: '            {"role": "user",   "content": message},' },
  { t: '        ],' },
  { t: '    )' },
  { t: '    reply = r.choices[0].message.content' },
  { t: '    session.add_memory(messages=[{',            n: true },
  { t: '        "user_content":    message,',           n: true },
  { t: '        "assistant_content": reply,',           n: true },
  { t: '    }])',                                       n: true },
  { t: '    return reply' },
]

const NEW_LINE_COUNT = WITH_LINES.filter(l => l.n).length  // 13

// ─── Scenarios ───────────────────────────────────────────────────────────────

const SCENARIOS = [
  {
    id: 'travel',
    label: 'Travel Planning',
    description: 'Plan a Tokyo trip across 3 turns',
    turns: [
      "I'm planning a 10-day trip to Tokyo with my partner. We love street food and traditional architecture — places like Yanaka and Tsukiji are high on our list.",
      "Quick one — can you draft a short out-of-office email for while I'm away?",
      "Is 10 days in Tokyo enough to do justice to our interests, or should we extend the trip?",
    ],
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    ),
  },
  {
    id: 'health',
    label: 'Health Coach',
    description: 'Build a personalised fitness plan across 3 turns',
    turns: [
      "I want to lose 8 kg in 3 months. I'm vegetarian, have a bad left knee, and can only exercise before my 7am shift.",
      "Random question — any good audiobook app recommendations? I'm into mysteries.",
      "Design me a workout routine that actually fits my situation.",
    ],
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
      </svg>
    ),
  },
  {
    id: 'work',
    label: 'Work Assistant',
    description: 'Navigate a high-stakes product launch across 3 turns',
    turns: [
      "I'm leading a mobile app launch in 6 weeks. My team is 4 devs and 2 QA with no dedicated PM, and we just had a major feature added to scope last week.",
      "Switching gears — any tips for giving better code review feedback to junior devs?",
      "What's the biggest risk threatening our launch right now, and what should I do about it this week?",
    ],
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="7" width="20" height="14" rx="2" ry="2"/>
        <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
      </svg>
    ),
  },
]

// Per-turn metadata that drives labels in the results panel
const TURN_META = [
  { agent: 'Advisor',    session: 'Session A', recall: 'none',         badge: null },
  { agent: 'Advisor',    session: 'Session A', recall: 'in-session',   badge: null },
  { agent: 'Specialist', session: 'Session B', recall: 'cross-session', badge: 'new session' },
]

// ─── Markdown renderer (bold + line breaks only) ────────────────────────────

function ReplyText({ text }) {
  const html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')
  return (
    <div
      style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.65, padding: '2px 0' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// ─── Syntax tokeniser (no deps) ──────────────────────────────────────────────

function tokenise(line) {
  if (!line.trim()) return [{ text: line, color: 'inherit' }]
  const tokens = []
  let rest = line
  const rules = [
    { re: /^(#.*)/, color: '#8b949e' },
    { re: /^(from|import|def|return|class|if|else|for|in|not|and|or|True|False|None)\b/, color: '#ff7b72' },
    { re: /^([a-zA-Z_][a-zA-Z0-9_]*)(\s*=\s*)/, handler: m => [
      { text: m[1], color: '#79c0ff' },
      { text: m[2], color: '#c9d1d9' },
    ]},
    { re: /^("[^"]*"|'[^']*')/, color: '#a5d6ff' },
    { re: /^(\(|\)|\[|\]|\{|\}|,|:)/, color: '#c9d1d9' },
    { re: /^[a-zA-Z_][a-zA-Z0-9_]*/, color: '#c9d1d9' },
    { re: /^./, color: '#c9d1d9' },
  ]
  while (rest.length > 0) {
    let matched = false
    for (const rule of rules) {
      const m = rest.match(rule.re)
      if (m) {
        if (rule.handler) tokens.push(...rule.handler(m))
        else tokens.push({ text: m[0], color: rule.color })
        rest = rest.slice(m[0].length)
        matched = true
        break
      }
    }
    if (!matched) { tokens.push({ text: rest[0], color: '#c9d1d9' }); rest = rest.slice(1) }
  }
  return tokens
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ScenarioCard({ scenario, selected, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        padding: '18px 20px',
        background: selected ? 'rgba(234,35,40,0.05)' : 'white',
        border: selected ? '1.5px solid #EA2328' : '1.5px solid var(--border)',
        borderRadius: 14, cursor: 'pointer', textAlign: 'left',
        transition: 'all 0.15s ease', flex: 1, minWidth: 0,
      }}
    >
      <div style={{
        width: 38, height: 38, borderRadius: 10,
        background: selected ? 'rgba(234,35,40,0.1)' : 'rgba(0,0,0,0.04)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: selected ? '#EA2328' : 'var(--text-secondary)',
        transition: 'all 0.15s ease', flexShrink: 0,
      }}>
        {scenario.icon}
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: selected ? '#EA2328' : 'var(--text-primary)', marginBottom: 3 }}>
          {scenario.label}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {scenario.description}
        </div>
      </div>
    </button>
  )
}

function CodePanel({ lines, title, newCount }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', background: '#161b22',
        borderRadius: '10px 10px 0 0', borderBottom: '1px solid #30363d',
      }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: '#8b949e', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {title}
        </span>
        {newCount != null && (
          <span style={{
            fontSize: 11, fontWeight: 700,
            background: newCount > 0 ? 'rgba(46,160,67,0.2)' : 'rgba(255,255,255,0.06)',
            color: newCount > 0 ? '#3fb950' : '#8b949e',
            padding: '2px 9px', borderRadius: 20, letterSpacing: '0.02em',
          }}>
            {newCount > 0 ? `+${newCount} SDK lines` : 'base code'}
          </span>
        )}
      </div>
      <div style={{
        background: '#0d1117', borderRadius: '0 0 10px 10px',
        padding: '14px 0', overflowX: 'auto',
      }}>
        {lines.map((line, i) => {
          const isComment = line.c
          const tokens = isComment ? [{ text: line.t, color: '#8b949e' }] : tokenise(line.t)
          return (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center', minHeight: 22, paddingRight: 16,
                background: line.n ? 'rgba(46,160,67,0.15)' : 'transparent',
                borderLeft: line.n ? '2px solid #2ea043' : '2px solid transparent',
              }}
            >
              <span style={{
                minWidth: 38, paddingRight: 16, paddingLeft: 10,
                fontSize: 11.5, color: '#484f58', userSelect: 'none',
                textAlign: 'right', flexShrink: 0,
                fontFamily: 'var(--font-geist-mono), monospace',
              }}>
                {i + 1}
              </span>
              <span style={{
                width: 14, flexShrink: 0, fontSize: 11,
                color: line.n ? '#3fb950' : 'transparent',
                fontWeight: 700, userSelect: 'none',
                fontFamily: 'var(--font-geist-mono), monospace',
              }}>
                {line.n ? '+' : ' '}
              </span>
              <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: 12.5, whiteSpace: 'pre' }}>
                {tokens.map((tok, j) => (
                  <span key={j} style={{ color: tok.color }}>{tok.text}</span>
                ))}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TurnBlock({ turn, index, isWithMem }) {
  const meta = TURN_META[index]
  const hasContext = isWithMem && (turn.context_used?.length || 0) > 0 &&
    turn.context_used.some(s => (typeof s === 'string' ? s : s?.text))
  const isNewSession = isWithMem && turn.is_new_session

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* Session handoff divider (with side only) */}
      {isNewSession && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
          <div style={{ flex: 1, height: 1, background: 'rgba(234,35,40,0.2)' }} />
          <span style={{
            fontSize: 10, fontWeight: 700, color: '#EA2328',
            letterSpacing: '0.08em', textTransform: 'uppercase',
            background: 'rgba(234,35,40,0.06)', padding: '2px 10px', borderRadius: 10,
          }}>
            session ended → new session
          </span>
          <div style={{ flex: 1, height: 1, background: 'rgba(234,35,40,0.2)' }} />
        </div>
      )}

      {/* Turn header */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
          letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>
          Turn {index + 1}
        </span>

        {/* WITHOUT side: stateless badge */}
        {!isWithMem && (
          <span style={{
            fontSize: 10, color: 'var(--text-muted)',
            background: 'rgba(0,0,0,0.04)', padding: '1px 7px', borderRadius: 6,
          }}>
            stateless · no session
          </span>
        )}

        {/* WITH side: session + agent + recall status */}
        {isWithMem && (
          <>
            <span style={{
              fontSize: 10, color: '#8b949e',
              background: 'rgba(0,0,0,0.05)', padding: '1px 7px', borderRadius: 6,
              fontFamily: 'var(--font-geist-mono), monospace',
            }}>
              {meta.session} · {meta.agent}
            </span>
            {hasContext ? (
              <span style={{
                fontSize: 10, background: 'rgba(234,35,40,0.1)',
                color: '#EA2328', padding: '1px 7px', borderRadius: 10, fontWeight: 600,
              }}>
                {meta.recall} recall
              </span>
            ) : meta.recall === 'none' ? (
              <span style={{
                fontSize: 10, background: 'rgba(0,0,0,0.04)',
                color: 'var(--text-muted)', padding: '1px 7px', borderRadius: 10,
              }}>
                no recall — fresh start
              </span>
            ) : (
              <span style={{
                fontSize: 10, background: 'rgba(245,158,11,0.08)',
                color: '#f59e0b', padding: '1px 7px', borderRadius: 10,
              }}>
                {meta.recall} · off-topic → no match
              </span>
            )}
          </>
        )}
      </div>

      {/* User message */}
      <div style={{
        fontSize: 12.5, color: 'var(--text-secondary)',
        background: 'rgba(0,0,0,0.03)', borderRadius: 8,
        padding: '8px 12px', lineHeight: 1.5,
        borderLeft: '2px solid var(--border)',
      }}>
        {turn.user}
      </div>

      {/* Injected memory context — with side only */}
      {isWithMem && hasContext && (
        <div style={{
          background: 'rgba(234,35,40,0.03)',
          border: '1px solid rgba(234,35,40,0.12)',
          borderRadius: 8, padding: '8px 12px',
        }}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: '#EA2328',
            letterSpacing: '0.06em', textTransform: 'uppercase',
            marginBottom: 6,
          }}>
            Injected into system prompt
          </div>
          {turn.context_used.map((snippet, i) => {
            const text  = typeof snippet === 'string' ? snippet : snippet.text
            const score = typeof snippet === 'object' ? snippet.score : null
            return (
              <div key={i} style={{
                display: 'flex', gap: 6, alignItems: 'flex-start',
                marginBottom: i < turn.context_used.length - 1 ? 6 : 0,
              }}>
                <span style={{ flexShrink: 0, marginTop: 1, color: '#EA2328', opacity: 0.5 }}>•</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                    {text}
                  </span>
                  {score != null && (
                    <span style={{
                      display: 'inline-block', marginLeft: 6,
                      fontSize: 10, fontWeight: 700,
                      color: score >= 0.85 ? '#10b981' : score >= 0.78 ? '#f59e0b' : '#8b949e',
                      background: score >= 0.85 ? 'rgba(16,185,129,0.08)' : score >= 0.78 ? 'rgba(245,158,11,0.08)' : 'rgba(0,0,0,0.04)',
                      padding: '0px 6px', borderRadius: 6,
                      fontFamily: 'var(--font-geist-mono), monospace',
                    }}>
                      {score}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ReplyText text={turn.reply} />
    </div>
  )
}

function MemoryInspector({ blocks }) {
  const [open, setOpen] = useState(true)
  if (!blocks || blocks.length === 0) return null

  const typeColor = { fact: 'var(--info)', summary: 'var(--success)', message: 'var(--text-muted)' }
  const typeBg   = { fact: 'var(--info-bg)', summary: 'var(--success-bg)', message: 'rgba(0,0,0,0.04)' }

  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '6px 0', color: 'var(--text-secondary)',
        }}
      >
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 0.2s' }}
        >
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
          Memory Inspector
        </span>
        <span style={{
          fontSize: 11, background: 'rgba(234,35,40,0.1)', color: '#EA2328',
          padding: '1px 7px', borderRadius: 10, fontWeight: 700,
        }}>
          {blocks.length} blocks · Session A
        </span>
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {blocks.map((b, i) => (
            <div
              key={i}
              style={{
                display: 'flex', gap: 10, alignItems: 'flex-start',
                background: 'white', border: '1px solid var(--border)',
                borderRadius: 10, padding: '10px 14px',
              }}
            >
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                color: typeColor[b.type] || 'var(--text-muted)',
                background: typeBg[b.type] || 'rgba(0,0,0,0.04)',
                padding: '2px 8px', borderRadius: 6, flexShrink: 0, marginTop: 1,
              }}>
                {b.type}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                {b.content || b.user || '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Explorer() {
  const [name, setName] = useState('')
  const [scenario, setScenario] = useState(null)
  const [phase, setPhase] = useState('setup')  // setup | running | done
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)
  const resultsRef = useRef(null)

  const ready = name.trim().length > 0 && scenario !== null

  async function handleRun() {
    if (!ready || phase === 'running') return
    setPhase('running')
    setError(null)
    setResults(null)
    try {
      const resp = await fetch(`${API}/api/explorer/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), scenario_id: scenario.id }),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || resp.statusText)
      }
      const data = await resp.json()
      setResults(data)
      setPhase('done')
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
    } catch (e) {
      setError(e.message)
      setPhase('setup')
    }
  }

  function handleReset() {
    setPhase('setup')
    setResults(null)
    setError(null)
  }

  return (
    <div style={{
      height: '100%', overflowY: 'auto',
      background: 'linear-gradient(160deg, #F8F9FB 0%, #FFFFFF 50%, #F4F6F9 100%)',
      fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
    }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '32px 24px 64px' }}>

        {/* ── Page header ─────────────────────────────────────────────── */}
        <div style={{ marginBottom: 36 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{
              width: 34, height: 34, borderRadius: 9, background: '#EA2328',
              boxShadow: '0 2px 8px rgba(234,35,40,0.35)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>SDK Explorer</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                Multi-agent · Multi-session · Selective recall — in {NEW_LINE_COUNT} lines of SDK code
              </div>
            </div>
          </div>
        </div>

        {/* ── Step 1: Identity ─────────────────────────────────────────── */}
        <Section step="1" title="Your name" subtitle="Used to isolate your data — all prior memory for this name is cleared before each run so results are always fresh">
          <input
            className="input"
            placeholder="e.g. Jane Smith"
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={phase === 'running'}
            style={{ maxWidth: 320, fontSize: 14 }}
            onKeyDown={e => e.key === 'Enter' && ready && handleRun()}
          />
          {name.trim() && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
              Memory key:{' '}
              <code style={{ fontFamily: 'var(--font-geist-mono), monospace', color: 'var(--text-secondary)' }}>
                explorer-{name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 30)}
              </code>
            </div>
          )}
        </Section>

        {/* ── Step 2: Scenario ─────────────────────────────────────────── */}
        <Section step="2" title="Choose a scenario" subtitle="Turn 2 is deliberately off-topic — shows that memory retrieval is selective, not forced">
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            {SCENARIOS.map(s => (
              <ScenarioCard
                key={s.id}
                scenario={s}
                selected={scenario?.id === s.id}
                onClick={() => setScenario(s)}
              />
            ))}
          </div>

          {scenario && (
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Conversation turns
              </div>
              {scenario.turns.map((turn, i) => {
                const meta = TURN_META[i]
                const isOffTopic = i === 1
                return (
                  <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginTop: 1 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
                        background: 'rgba(0,0,0,0.05)', padding: '3px 8px',
                        borderRadius: 6, letterSpacing: '0.04em',
                      }}>
                        T{i + 1}
                      </span>
                      {isOffTopic && (
                        <span style={{
                          fontSize: 10, fontWeight: 600, color: '#f59e0b',
                          background: 'rgba(245,158,11,0.1)', padding: '3px 7px', borderRadius: 6,
                        }}>
                          off-topic
                        </span>
                      )}
                      {i === 2 && (
                        <span style={{
                          fontSize: 10, fontWeight: 600, color: '#EA2328',
                          background: 'rgba(234,35,40,0.08)', padding: '3px 7px', borderRadius: 6,
                        }}>
                          {meta.agent}
                        </span>
                      )}
                    </div>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {turn}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </Section>

        {/* ── Step 3: Code comparison ──────────────────────────────────── */}
        <Section step="3" title="Code comparison" subtitle={`${NEW_LINE_COUNT} lines add persistent memory, multi-agent handoff, and cross-session recall`}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <CodePanel lines={WITHOUT_LINES} title="Without Agent Memory" newCount={0} />
            <CodePanel lines={WITH_LINES}    title="With Agent Memory"    newCount={NEW_LINE_COUNT} />
          </div>
          <div style={{
            marginTop: 14, padding: '12px 16px',
            background: 'rgba(234,35,40,0.04)', borderRadius: 10,
            border: '1px solid rgba(234,35,40,0.12)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#EA2328" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Highlighted lines are the only additions. Both panels call{' '}
              <code style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: 11.5 }}>client.chat.completions.create()</code>{' '}
              identically — the difference is memory retrieval before the call and storage after.{' '}
              <strong style={{ color: 'var(--text-primary)' }}>
                The demo extends this to 2 agents + 2 sessions with{' '}
                <code style={{ fontSize: 11.5 }}>session.end()</code> and cross-session recall — visible in the results below.
              </strong>
            </span>
          </div>
        </Section>

        {/* ── Run button ───────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, margin: '36px 0' }}>
          {error && (
            <div style={{
              fontSize: 13, color: 'var(--danger)', background: 'var(--danger-bg)',
              padding: '10px 16px', borderRadius: 10, maxWidth: 480, textAlign: 'center',
            }}>
              {error}
            </div>
          )}
          <button
            className="btn-primary"
            onClick={handleRun}
            disabled={!ready || phase === 'running'}
            style={{ padding: '13px 40px', fontSize: 14, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 10 }}
          >
            {phase === 'running' ? (
              <>
                <span className="spinner" style={{ width: 16, height: 16 }} />
                Running both paths…
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white" stroke="none">
                  <polygon points="5 3 19 12 5 21 5 3"/>
                </svg>
                Run Comparison
              </>
            )}
          </button>
          {!ready && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {!name.trim() ? 'Enter your name to continue' : 'Select a scenario to continue'}
            </div>
          )}
        </div>

        {/* ── Results ──────────────────────────────────────────────────── */}
        {results && (
          <div ref={resultsRef} style={{ animation: 'fadeIn 0.4s ease' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
                  Results — {results.scenario}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                  {results.with_mem.some(t => (t.context_used?.length || 0) > 0)
                    ? 'Memory injected on Turn 3 — Specialist agent recalled context from the ended Advisor session'
                    : 'No context retrieved this run — prior data was cleared before execution'
                  }
                </div>
              </div>
              <button className="btn-ghost" onClick={handleReset} style={{ fontSize: 12 }}>
                ↩ Run again
              </button>
            </div>

            {/* Side-by-side results */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 28 }}>
              {/* Without column */}
              <div className="card" style={{ padding: '20px 22px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--text-muted)' }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                    Without Agent Memory
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    3 parallel calls · stateless
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {results.without_mem.map((turn, i) => (
                    <TurnBlock key={i} turn={turn} index={i} isWithMem={false} />
                  ))}
                </div>
              </div>

              {/* With column */}
              <div className="card" style={{ padding: '20px 22px', borderColor: 'rgba(234,35,40,0.18)', boxShadow: '0 0 0 1px rgba(234,35,40,0.08), var(--shadow-sm)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20, paddingBottom: 14, borderBottom: '1px solid rgba(234,35,40,0.12)' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#EA2328' }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#EA2328', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                    With Agent Memory
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-muted)', marginLeft: 'auto' }}>
                    2 sessions · 2 agents
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {results.with_mem.map((turn, i) => (
                    <TurnBlock key={i} turn={turn} index={i} isWithMem={true} />
                  ))}
                </div>
              </div>
            </div>

            {/* Memory Inspector + stats */}
            <div className="card" style={{ padding: '18px 22px' }}>
              <MemoryInspector blocks={results.memory_blocks} />
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)', display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                <Stat label="User ID"     value={results.user_id}     mono />
                <Stat label="Session A"   value={results.session_a_id} mono />
                <Stat label="Session B"   value={results.session_b_id} mono />
                <Stat label="Blocks stored" value={results.memory_blocks?.length ?? 0} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Layout helpers ──────────────────────────────────────────────────────────

function Section({ step, title, subtitle, children }) {
  return (
    <div style={{ marginBottom: 36 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <span style={{
          width: 22, height: 22, borderRadius: '50%',
          background: '#EA2328', color: 'white',
          fontSize: 11, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          {step}
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
      </div>
      {subtitle && (
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 16, paddingLeft: 32 }}>
          {subtitle}
        </div>
      )}
      <div style={{ paddingLeft: 32 }}>{children}</div>
    </div>
  )
}

function Stat({ label, value, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{
        fontSize: 12, color: 'var(--text-secondary)',
        fontFamily: mono ? 'var(--font-geist-mono), monospace' : 'inherit',
      }}>
        {value}
      </div>
    </div>
  )
}
