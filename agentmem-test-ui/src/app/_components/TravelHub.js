'use client'

import React, { useState, useEffect, useRef } from 'react'

const API = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000'

export default function TravelHub() {
  const [userId, setUserId] = useState('demo-user-001')
  const [sessionId, setSessionId] = useState('demo-session-001')
  const [agentId, setAgentId] = useState('h1')
  const [input, setInput] = useState('')
  const [messages, setMessages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [setupDone, setSetupDone] = useState(false)
  const [status, setStatus] = useState(null)
  const messagesEndRef = useRef(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const addLog = (type, text) => {
    setMessages(prev => [...prev, { type, text, ts: new Date().toLocaleTimeString() }])
  }

  async function ensureSetup() {
    if (setupDone) return true
    try {
      await fetch(`${API}/api/travel/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, name: 'Demo User' }),
      })
    } catch {}
    try {
      await fetch(`${API}/api/travel/users/${userId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      })
    } catch {}
    setSetupDone(true)
    return true
  }

  async function sendMessage() {
    if (!input.trim() || isLoading) return
    const userMsg = input.trim()
    setInput('')
    setIsLoading(true)

    addLog('user', userMsg)

    try {
      await ensureSetup()

      const recallResp = await fetch(
        `${API}/api/travel/users/${userId}/sessions/${sessionId}/recall`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: userMsg, filters: { annotations: { agent: agentId } } }),
        }
      )

      let context = ''
      if (recallResp.ok) {
        const data = await recallResp.json()
        const blocks = data.results || data.memories || data.blocks || []
        if (blocks.length > 0) {
          context = blocks
            .slice(0, 3)
            .map(b => b.summary || b.content || '')
            .filter(Boolean)
            .join(' | ')
        }
      }

      const assistantReply = context
        ? `[Recalled context: ${context.slice(0, 120)}…] Based on our history, I can help you with that.`
        : `As agent ${agentId}, I'd be happy to assist with: "${userMsg}". This has been stored in memory.`

      addLog('assistant', assistantReply)
      addLog('system', `Stored with annotation agent=${agentId}`)

      await fetch(`${API}/api/travel/users/${userId}/sessions/${sessionId}/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'user', content: userMsg },
            { role: 'assistant', content: assistantReply },
          ],
          annotations: { agent: agentId },
          async_processing: true,
        }),
      })
    } catch (err) {
      addLog('error', `Request failed: ${err.message}`)
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

  async function checkHealth() {
    try {
      const resp = await fetch(`${API}/api/health`)
      const data = await resp.json()
      setStatus(data)
    } catch {
      setStatus({ tester_status: 'error', agentmem_server_status: 'unreachable' })
    }
  }

  useEffect(() => { checkHealth() }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 20 }}>
      {/* Config bar */}
      <div className="card" style={{ padding: '16px 20px' }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 160px' }}>
            <label className="label">User ID</label>
            <input
              className="input"
              value={userId}
              onChange={e => { setUserId(e.target.value); setSetupDone(false) }}
              placeholder="user-id"
            />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label className="label">Session ID</label>
            <input
              className="input"
              value={sessionId}
              onChange={e => { setSessionId(e.target.value); setSetupDone(false) }}
              placeholder="session-id"
            />
          </div>
          <div style={{ flex: '0 0 120px' }}>
            <label className="label">Active Agent</label>
            <select
              className="input"
              value={agentId}
              onChange={e => setAgentId(e.target.value)}
              style={{ cursor: 'pointer' }}
            >
              <option value="h1">h1 — Diet</option>
              <option value="h2">h2 — Travel</option>
              <option value="h3">h3 — Work</option>
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 1 }}>
            {status && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span className={`badge ${status.tester_status === 'ok' ? 'badge-success' : 'badge-danger'}`}>
                  Tester {status.tester_status}
                </span>
                <span className={`badge ${status.agentmem_server_status === 'ok' ? 'badge-success' : 'badge-danger'}`}>
                  AMS {status.agentmem_server_status}
                </span>
              </div>
            )}
            <button className="btn-ghost" onClick={checkHealth} style={{ whiteSpace: 'nowrap' }}>
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Chat window */}
      <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
            Chat — agent <span style={{ color: 'var(--accent)' }}>{agentId}</span>
          </span>
          <button
            className="btn-ghost"
            onClick={() => setMessages([])}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            Clear
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.length === 0 && (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, marginTop: 40 }}>
              Send a message to start the conversation.
            </div>
          )}
          {messages.map((msg, i) => (
            <MessageBubble key={i} msg={msg} />
          ))}
          {isLoading && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              <div className="spinner" style={{ width: 14, height: 14 }} />
              <span>Processing...</span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
          <textarea
            className="input"
            rows={2}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message… (Enter to send, Shift+Enter for newline)"
            style={{ flex: 1, resize: 'none', lineHeight: 1.5 }}
          />
          <button
            className="btn-primary"
            onClick={sendMessage}
            disabled={isLoading || !input.trim()}
            style={{ alignSelf: 'flex-end', minWidth: 72 }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ msg }) {
  const styles = {
    user: { background: 'var(--accent-glow)', border: '1px solid rgba(99,102,241,0.3)', color: 'var(--text-primary)', alignSelf: 'flex-end', maxWidth: '80%' },
    assistant: { background: 'var(--bg-elevated)', border: '1px solid var(--border)', color: 'var(--text-primary)', alignSelf: 'flex-start', maxWidth: '80%' },
    system: { background: 'transparent', border: 'none', color: 'var(--text-muted)', alignSelf: 'center', fontSize: 11 },
    error: { background: 'var(--danger-bg)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--danger)', alignSelf: 'flex-start', maxWidth: '80%' },
  }
  const s = styles[msg.type] || styles.system
  return (
    <div style={{ ...s, borderRadius: 10, padding: '8px 14px', fontSize: 13, lineHeight: 1.5, wordBreak: 'break-word' }}>
      {msg.type !== 'system' && (
        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2, display: 'block' }}>
          {msg.type === 'user' ? 'You' : msg.type === 'error' ? 'Error' : 'Agent'}  · {msg.ts}
        </span>
      )}
      {msg.text}
    </div>
  )
}

