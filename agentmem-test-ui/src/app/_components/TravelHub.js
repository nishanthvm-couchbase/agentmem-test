'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000'

const AGENTS = [
  { id: 'h1', label: 'Health Coach' },
  { id: 'h2', label: 'Travel Assistant' },
  { id: 'h3', label: 'Work Assistant' },
]

function newSessionId() {
  return 'session-' + Math.random().toString(36).slice(2, 10)
}

export default function TravelHub() {
  const [userId, setUserId] = useState('demo-user-001')
  const [sessionId, setSessionId] = useState('demo-session-001')
  const [agentId, setAgentId] = useState('h1')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [health, setHealth] = useState(null)
  const [showConfig, setShowConfig] = useState(false)

  const [lastExchange, setLastExchange] = useState(null)
  const [isStoringMemory, setIsStoringMemory] = useState(false)

  const [fetchQuery, setFetchQuery] = useState('')
  const [fetchAgent, setFetchAgent] = useState('h1')
  const [fetchBlockIds, setFetchBlockIds] = useState('')
  const [crossSession, setCrossSession] = useState(false)
  const [isFetching, setIsFetching] = useState(false)
  const [fetchedBlocks, setFetchedBlocks] = useState([])
  const [hasFetched, setHasFetched] = useState(false)
  const [activeContext, setActiveContext] = useState([])

  const messagesEndRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => { setFetchAgent(agentId) }, [agentId])

  const fetchHealth = useCallback(async () => {
    try {
      const resp = await fetch(`${API}/api/health`)
      setHealth(resp.ok ? await resp.json() : { tester_status: 'error', agentmem_server_status: 'error' })
    } catch {
      setHealth({ tester_status: 'error', agentmem_server_status: 'unreachable' })
    }
  }, [])

  useEffect(() => {
    fetchHealth()
    const t = setInterval(fetchHealth, 15000)
    return () => clearInterval(t)
  }, [fetchHealth])

  const addMsg = (type, text) =>
    setMessages(prev => [...prev, { type, text, ts: new Date().toLocaleTimeString() }])

  async function sendMessage() {
    if (!input.trim() || isLoading) return
    const userMsg = input.trim()
    setInput('')
    setIsLoading(true)
    addMsg('user', userMsg)
    if (activeContext.length > 0) {
      addMsg('system', `Injecting ${activeContext.length} memory block${activeContext.length > 1 ? 's' : ''} as context`)
    }
    try {
      const resp = await fetch(`${API}/api/travel/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          session_id: sessionId,
          agent_id: agentId,
          message: userMsg,
          context_blocks: activeContext.length > 0 ? activeContext : undefined,
        }),
      })
      if (!resp.ok) {
        const err = await resp.json()
        addMsg('error', err.detail || 'Request failed')
        return
      }
      const data = await resp.json()
      addMsg('assistant', data.reply)
      setLastExchange({ userMsg, reply: data.reply })
    } catch (err) {
      addMsg('error', `Request failed: ${err.message}`)
    } finally {
      setIsLoading(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  async function addLastExchangeToMemory() {
    if (!lastExchange || isStoringMemory) return
    setIsStoringMemory(true)
    try {
      const resp = await fetch(
        `${API}/api/travel/users/${userId}/sessions/${sessionId}/memory`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_message: lastExchange.userMsg,
            assistant_response: lastExchange.reply,
            agent_type: agentId,
          }),
        }
      )
      if (resp.ok) {
        addMsg('system', `Stored in memory — agent: ${agentId}`)
        setLastExchange(null)
      } else {
        const err = await resp.json()
        addMsg('error', `Store failed: ${err.detail || 'unknown error'}`)
      }
    } catch (err) {
      addMsg('error', `Store failed: ${err.message}`)
    } finally {
      setIsStoringMemory(false)
    }
  }

  async function fetchMemory() {
    setIsFetching(true)
    setFetchedBlocks([])
    setHasFetched(false)
    try {
      const body = { cross_session: crossSession }
      if (fetchQuery.trim()) body.query = fetchQuery.trim()
      if (fetchAgent) body.agent_type = fetchAgent
      const ids = fetchBlockIds.split(',').map(s => s.trim()).filter(Boolean)
      if (ids.length > 0) body.block_ids = ids

      const resp = await fetch(
        `${API}/api/travel/users/${userId}/sessions/${sessionId}/recall`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      )
      if (resp.ok) {
        const data = await resp.json()
        setFetchedBlocks(data.blocks || [])
        setHasFetched(true)
        const count = data.blocks?.length || 0
        addMsg('system',
          count > 0
            ? `Found ${count} memory block(s) — agent: ${fetchAgent || 'all'}`
            : `No blocks found — agent: ${fetchAgent || 'all'}`
        )
      } else {
        const err = await resp.json()
        addMsg('error', `Recall failed: ${err.detail || 'unknown'}`)
      }
    } catch (err) {
      addMsg('error', `Recall failed: ${err.message}`)
    } finally {
      setIsFetching(false)
    }
  }

  function toggleBlockInContext(block) {
    const snippet = block.snippet
    setActiveContext(prev =>
      prev.includes(snippet) ? prev.filter(s => s !== snippet) : [...prev, snippet]
    )
  }

  function clearContext() {
    setActiveContext([])
    addMsg('system', 'Context cleared')
  }

  function startNewSession() {
    setSessionId(newSessionId())
    setMessages([])
    setLastExchange(null)
    setFetchedBlocks([])
    setActiveContext([])
    setHasFetched(false)
  }

  const amsOk = health?.agentmem_server_status === 'healthy'
  const testerOk = health?.tester_status === 'ok'
  const currentAgent = AGENTS.find(a => a.id === agentId)

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'linear-gradient(160deg, #F8F9FB 0%, #FFFFFF 50%, #F4F6F9 100%)',
      fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
      color: 'var(--text-primary)',
    }}>

      {/* ── Header ── */}
      <header style={{
        height: 60,
        flexShrink: 0,
        borderBottom: '1px solid var(--border)',
        background: 'rgba(255,255,255,0.85)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        gap: 20,
      }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <BrandMark />
          <div style={{ lineHeight: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>AgentMem</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>by Couchbase</div>
          </div>
        </div>

        <div style={{ width: 1, height: 28, background: 'var(--border)', flexShrink: 0 }} />

        {/* Agent tabs */}
        <div style={{ display: 'flex', gap: 3, flex: 1 }}>
          {AGENTS.map(a => (
            <AgentTab
              key={a.id}
              agent={a}
              active={agentId === a.id}
              onClick={() => setAgentId(a.id)}
            />
          ))}
        </div>

        {/* Right side */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {health && (
            <div style={{ display: 'flex', gap: 6 }}>
              <StatusPill label="Tester" ok={testerOk} />
              <StatusPill label="AMS" ok={amsOk} />
            </div>
          )}
          <button
            onClick={() => setShowConfig(c => !c)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 10px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: showConfig ? 'rgba(0,0,0,0.04)' : 'transparent',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
              fontFamily: 'inherit',
              transition: 'background 0.14s',
            }}
          >
            <IconSettings size={13} />
            <span style={{ fontFamily: 'var(--font-geist-mono), monospace', fontSize: 11 }}>{userId}</span>
          </button>
        </div>
      </header>

      {/* ── Config popover ── */}
      {showConfig && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            onClick={() => setShowConfig(false)}
          />
          <div style={{
            position: 'fixed',
            top: 68,
            right: 16,
            width: 300,
            background: 'white',
            border: '1px solid var(--border)',
            borderRadius: 14,
            boxShadow: 'var(--shadow-lg)',
            padding: 16,
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Session Configuration</div>
            <div>
              <label className="label">User ID</label>
              <input
                className="input"
                value={userId}
                onChange={e => setUserId(e.target.value)}
                placeholder="user-id"
              />
            </div>
            <div>
              <label className="label">Session ID</label>
              <input
                className="input"
                value={sessionId}
                readOnly
                style={{ opacity: 0.6, cursor: 'default', fontSize: 11, fontFamily: 'var(--font-geist-mono), monospace' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn-primary"
                onClick={() => { startNewSession(); setShowConfig(false) }}
                style={{ flex: 1, fontSize: 12 }}
              >
                New Session
              </button>
              <button
                className="btn-ghost"
                onClick={() => setShowConfig(false)}
                style={{ fontSize: 12, padding: '7px 14px' }}
              >
                Done
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── Main content ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Chat panel */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* Messages */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '28px 32px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}>
            {messages.length === 0 && (
              <EmptyState agent={currentAgent} />
            )}
            {messages.map((msg, i) => (
              <MessageBubble key={i} msg={msg} agentLabel={currentAgent?.label} agentId={agentId} />
            ))}
            {isLoading && <TypingIndicator />}
            <div ref={messagesEndRef} />
          </div>

          {/* Input bar */}
          <div style={{
            flexShrink: 0,
            padding: '12px 20px 16px',
            borderTop: '1px solid var(--border)',
            background: 'white',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}>
            {activeContext.length > 0 && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 10px',
                background: 'var(--accent-glow)',
                border: '1px solid rgba(234,35,40,0.18)',
                borderRadius: 7,
                fontSize: 11,
                color: 'var(--accent)',
                fontWeight: 500,
              }}>
                <span>{activeContext.length} memory block{activeContext.length > 1 ? 's' : ''} in context</span>
                <button
                  onClick={clearContext}
                  style={{
                    marginLeft: 'auto', background: 'none', border: 'none',
                    cursor: 'pointer', color: 'var(--accent)', fontSize: 14,
                    padding: 0, lineHeight: 1, fontFamily: 'inherit',
                  }}
                >
                  ×
                </button>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <textarea
                className="input"
                rows={2}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${currentAgent?.label}…  (Enter to send, Shift+Enter for newline)`}
                style={{ flex: 1, resize: 'none', lineHeight: 1.55 }}
              />
              <button
                className="btn-primary"
                onClick={sendMessage}
                disabled={isLoading || !input.trim()}
                style={{
                  height: 60,
                  minWidth: 72,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  flexShrink: 0,
                }}
              >
                <IconSend size={14} />
                Send
              </button>
            </div>
            {lastExchange && (
              <button
                className="btn-ghost"
                onClick={addLastExchangeToMemory}
                disabled={isStoringMemory}
                style={{ fontSize: 11, color: 'var(--text-muted)', borderStyle: 'dashed' }}
              >
                {isStoringMemory ? 'Saving to memory…' : 'Save last exchange to memory'}
              </button>
            )}
          </div>
        </div>

        {/* Memory panel */}
        <div style={{
          width: 340,
          flexShrink: 0,
          borderLeft: '1px solid var(--border)',
          background: '#FAFBFC',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '14px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'white',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Memory</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              Fetch and inject blocks into context
            </div>
          </div>

          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}>

            {/* Recall section */}
            <section>
              <SectionHeading>Recall</SectionHeading>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div>
                  <label className="label">Semantic search</label>
                  <input
                    className="input"
                    value={fetchQuery}
                    onChange={e => setFetchQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && fetchMemory()}
                    placeholder="e.g. travel preferences, diet goals"
                    style={{ fontSize: 12 }}
                  />
                </div>
                <div>
                  <label className="label">Agent filter</label>
                  <select
                    className="input"
                    value={fetchAgent}
                    onChange={e => setFetchAgent(e.target.value)}
                    style={{ fontSize: 12, cursor: 'pointer' }}
                  >
                    <option value="">All agents</option>
                    {AGENTS.map(a => (
                      <option key={a.id} value={a.id}>{a.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Block IDs</label>
                  <input
                    className="input"
                    value={fetchBlockIds}
                    onChange={e => setFetchBlockIds(e.target.value)}
                    placeholder="id-1, id-2, ..."
                    style={{ fontSize: 12 }}
                  />
                </div>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  userSelect: 'none',
                }}>
                  <input
                    type="checkbox"
                    checked={crossSession}
                    onChange={e => setCrossSession(e.target.checked)}
                    style={{ cursor: 'pointer' }}
                  />
                  Cross-session recall
                </label>
                <button
                  className="btn-primary"
                  onClick={fetchMemory}
                  disabled={isFetching}
                  style={{ fontSize: 12 }}
                >
                  {isFetching ? 'Searching…' : 'Search Memory'}
                </button>
              </div>
            </section>

            {/* Results */}
            {hasFetched && (
              <section>
                <SectionHeading>
                  Results{fetchedBlocks.length > 0 ? ` (${fetchedBlocks.length})` : ''}
                  {fetchedBlocks.length > 0 && (
                    <span style={{ fontWeight: 400, marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>
                      — click to add to context
                    </span>
                  )}
                </SectionHeading>
                {fetchedBlocks.length === 0 ? (
                  <div style={{
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    padding: '10px 12px',
                    background: 'white',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                  }}>
                    No blocks matched. Try a different query or agent filter.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {fetchedBlocks.map((b, i) => (
                      <MemoryBlock
                        key={i}
                        block={b}
                        isActive={activeContext.includes(b.snippet)}
                        onClick={() => toggleBlockInContext(b)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            {/* Active context */}
            {activeContext.length > 0 && (
              <section>
                <SectionHeading>Active Context ({activeContext.length})</SectionHeading>
                <div style={{
                  fontSize: 11,
                  color: 'var(--accent)',
                  padding: '8px 10px',
                  background: 'var(--accent-glow)',
                  border: '1px solid rgba(234,35,40,0.18)',
                  borderRadius: 8,
                  marginBottom: 6,
                }}>
                  These blocks will be injected with your next message.
                </div>
                <button
                  className="btn-ghost"
                  onClick={clearContext}
                  style={{ fontSize: 11, width: '100%' }}
                >
                  Clear Context
                </button>
              </section>
            )}

          </div>
        </div>

      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function BrandMark() {
  return (
    <div style={{
      width: 32, height: 32,
      borderRadius: 9,
      background: 'var(--accent)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      boxShadow: '0 2px 8px rgba(234,35,40,0.35)',
    }}>
      <svg width="18" height="14" viewBox="0 0 18 14" fill="none">
        <path
          d="M1.5 11L5.5 2.5L9 8.5L12.5 2.5L16.5 11"
          stroke="white"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

function AgentTab({ agent, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '6px 14px',
        borderRadius: 8,
        border: active ? '1px solid rgba(234,35,40,0.25)' : '1px solid transparent',
        background: active ? 'var(--accent-glow)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        transition: 'all 0.14s',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'rgba(0,0,0,0.04)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
    >
      {agent.label}
    </button>
  )
}

function StatusPill({ label, ok }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '3px 8px',
      borderRadius: 20,
      background: ok ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
      border: `1px solid ${ok ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`,
    }}>
      <div style={{
        width: 5, height: 5,
        borderRadius: '50%',
        background: ok ? '#10B981' : '#EF4444',
      }} />
      <span style={{
        fontSize: 11,
        fontWeight: 600,
        color: ok ? '#10B981' : '#EF4444',
      }}>
        {label}
      </span>
    </div>
  )
}

function SectionHeading({ children }) {
  return (
    <div style={{
      fontSize: 10,
      fontWeight: 700,
      color: 'var(--text-muted)',
      textTransform: 'uppercase',
      letterSpacing: '0.07em',
      marginBottom: 8,
    }}>
      {children}
    </div>
  )
}

function EmptyState({ agent }) {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 14,
      marginTop: 60,
      animation: 'fadeIn 0.3s ease-out',
    }}>
      <div style={{
        width: 52, height: 52,
        borderRadius: 16,
        background: 'var(--accent-glow)',
        border: '1px solid rgba(234,35,40,0.18)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--accent)',
      }}>
        <AgentIcon agentId={agent?.id} size={24} />
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
          {agent?.label}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 380, lineHeight: 1.6 }}>
          Start a conversation. Use the memory panel to store and recall context across sessions.
        </div>
      </div>
    </div>
  )
}

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', animation: 'fadeIn 0.2s ease-out' }}>
      <div style={{
        width: 30, height: 30,
        borderRadius: 9,
        background: 'var(--accent-glow)',
        border: '1px solid rgba(234,35,40,0.15)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        fontWeight: 700,
        color: 'var(--accent)',
        flexShrink: 0,
      }}>
        AI
      </div>
      <div style={{
        padding: '12px 16px',
        borderRadius: '4px 12px 12px 12px',
        background: 'white',
        border: '1px solid var(--border)',
        boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
        display: 'flex',
        gap: 5,
        alignItems: 'center',
      }}>
        {[0, 1, 2].map(i => (
          <div
            key={i}
            style={{
              width: 7, height: 7,
              borderRadius: '50%',
              background: 'var(--text-muted)',
              animation: `bounce 1.3s ease-in-out ${i * 0.2}s infinite`,
            }}
          />
        ))}
      </div>
    </div>
  )
}

function MessageBubble({ msg, agentLabel, agentId }) {
  if (msg.type === 'system') {
    return (
      <div style={{
        textAlign: 'center',
        fontSize: 11,
        color: 'var(--text-muted)',
        padding: '2px 0',
        animation: 'fadeIn 0.2s ease-out',
      }}>
        {msg.text}
      </div>
    )
  }

  const isUser = msg.type === 'user'
  const isError = msg.type === 'error'

  return (
    <div style={{
      display: 'flex',
      gap: 10,
      flexDirection: isUser ? 'row-reverse' : 'row',
      alignItems: 'flex-start',
      animation: 'fadeIn 0.2s ease-out',
    }}>
      {/* Avatar */}
      <div style={{
        width: 30,
        height: 30,
        borderRadius: 9,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        fontWeight: 700,
        ...(isUser
          ? { background: 'rgba(0,0,0,0.06)', color: 'var(--text-secondary)' }
          : isError
            ? { background: 'rgba(239,68,68,0.08)', color: '#EF4444', border: '1px solid rgba(239,68,68,0.15)' }
            : { background: 'var(--accent-glow)', color: 'var(--accent)', border: '1px solid rgba(234,35,40,0.15)' }
        ),
      }}>
        {isUser ? 'U' : isError ? '!' : <AgentIcon agentId={agentId} size={15} />}
      </div>

      <div style={{ maxWidth: '76%' }}>
        <div style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          marginBottom: 4,
          textAlign: isUser ? 'right' : 'left',
        }}>
          {isUser ? 'You' : isError ? 'Error' : agentLabel} · {msg.ts}
        </div>
        <div style={{
          padding: '10px 14px',
          borderRadius: isUser ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
          background: isUser ? 'var(--accent)' : isError ? 'rgba(239,68,68,0.05)' : 'white',
          border: `1px solid ${isUser ? 'transparent' : isError ? 'rgba(239,68,68,0.18)' : 'var(--border)'}`,
          color: isUser ? 'white' : isError ? '#EF4444' : 'var(--text-primary)',
          fontSize: 13,
          lineHeight: 1.65,
          wordBreak: 'break-word',
          boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
        }}>
          {msg.type === 'assistant' ? (
            <div dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }} />
          ) : (
            msg.text
          )}
        </div>
      </div>
    </div>
  )
}

const AGENT_LABELS = { h1: 'Health Coach', h2: 'Travel Assistant', h3: 'Work Assistant' }

function MemoryBlock({ block: b, isActive, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: isActive ? 'rgba(234,35,40,0.04)' : 'white',
        border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 9,
        padding: '9px 11px',
        fontSize: 11,
        cursor: 'pointer',
        transition: 'border-color 0.14s, background 0.14s',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{
          fontSize: 10,
          fontWeight: 700,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}>
          {b.type}
        </span>
        {b.annotations?.agent && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {AGENT_LABELS[b.annotations.agent] || b.annotations.agent}
          </span>
        )}
      </div>
      {b.block_id && (
        <div style={{
          fontSize: 10,
          color: 'var(--text-muted)',
          marginBottom: 4,
          fontFamily: 'var(--font-geist-mono), monospace',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {b.block_id}
        </div>
      )}
      {b.type === 'message' ? (
        <>
          <div style={{ color: 'var(--text-secondary)', marginBottom: 2 }}>
            <strong>You:</strong> {(b.user || '').slice(0, 80)}{(b.user || '').length > 80 ? '…' : ''}
          </div>
          <div style={{ color: 'var(--text-primary)' }}>
            <strong>Agent:</strong> {(b.agent || '').slice(0, 80)}{(b.agent || '').length > 80 ? '…' : ''}
          </div>
        </>
      ) : (
        <div style={{ color: 'var(--text-primary)', lineHeight: 1.45 }}>
          {(b.content || '').slice(0, 140)}{(b.content || '').length > 140 ? '…' : ''}
        </div>
      )}
      {isActive && (
        <div style={{ fontSize: 10, color: 'var(--accent)', marginTop: 5, fontWeight: 600 }}>
          In context for next message
        </div>
      )}
    </div>
  )
}

// ── Icons ───────────────────────────────────────────────────────────────────

function AgentIcon({ agentId, size = 20 }) {
  if (agentId === 'h1') return <IconHeart size={size} />
  if (agentId === 'h2') return <IconCompass size={size} />
  return <IconBriefcase size={size} />
}

function IconHeart({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 17s-7-4.5-7-9a4 4 0 0 1 7-2.65A4 4 0 0 1 17 8c0 4.5-7 9-7 9z"/>
    </svg>
  )
}

function IconCompass({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="7.5"/>
      <path d="M13.5 6.5L11.5 11.5L6.5 13.5L8.5 8.5L13.5 6.5z"/>
    </svg>
  )
}

function IconBriefcase({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="16" height="11" rx="2"/>
      <path d="M7 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
      <path d="M2 11h16"/>
    </svg>
  )
}

function IconSettings({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5"/>
      <path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M3.4 12.6l.7-.7M11.9 4.1l.7-.7"/>
    </svg>
  )
}

function IconSend({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2L8 8M14 2L9.5 14 8 8 2 6.5 14 2z"/>
    </svg>
  )
}

// ── Markdown renderer ────────────────────────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<strong style="display:block;margin-top:8px;margin-bottom:2px">$1</strong>')
    .replace(/^## (.+)$/gm,  '<strong style="display:block;margin-top:8px;margin-bottom:2px;font-size:14px">$1</strong>')
    .replace(/^# (.+)$/gm,   '<strong style="display:block;margin-top:8px;margin-bottom:2px;font-size:15px">$1</strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<div style="padding-left:12px">· $1</div>')
    .replace(/\n/g, '<br/>')
}
