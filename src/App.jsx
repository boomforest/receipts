import React, { useState } from 'react'
import { parseWhatsApp, summarize } from './parser'
import { redact, unredact, buildPayload } from './redact'
import { C, BRAND, FONT } from './theme'

export default function App() {
  const [stage, setStage]       = useState('upload')   // upload | pickme | preview | analyzing | result | error
  const [filename, setFilename] = useState('')
  const [messages, setMessages] = useState([])
  const [summary,  setSummary]  = useState(null)
  const [meSender, setMeSender] = useState('')
  const [redaction, setRedaction] = useState(null)
  const [analysis, setAnalysis] = useState('')
  const [error, setError]       = useState('')

  const reset = () => {
    setStage('upload'); setFilename(''); setMessages([])
    setSummary(null); setMeSender(''); setRedaction(null)
    setAnalysis(''); setError('')
  }

  const handleFile = async (file) => {
    if (!file) return
    setFilename(file.name)
    setError('')
    try {
      const text = await file.text()
      const msgs = parseWhatsApp(text)
      if (msgs.length === 0) {
        throw new Error("Couldn't find any messages. Make sure it's the .txt file from WhatsApp's Export Chat.")
      }
      const sum = summarize(msgs)
      setMessages(msgs)
      setSummary(sum)
      // If only 2 senders, default "me" guess to whichever sent more — user can flip
      if (sum.senders.length >= 2) {
        setMeSender(sum.senders[0])
        setStage('pickme')
      } else {
        throw new Error('This export only has one sender. Make sure it includes both sides of the conversation.')
      }
    } catch (e) {
      setError(e.message)
      setStage('error')
    }
  }

  const goPreview = () => {
    const r = redact(messages, meSender)
    setRedaction(r)
    setStage('preview')
  }

  const analyze = async () => {
    setStage('analyzing')
    try {
      const payload = buildPayload(redaction.redacted)
      const res = await fetch('/.netlify/functions/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat: payload,
          stats: {
            total: summary.total,
            days:  summary.days,
            myCount:    summary.counts[meSender],
            theirCount: summary.counts[redaction.themSender],
            myAvgLen:   summary.avgLengths[meSender],
            theirAvgLen:summary.avgLengths[redaction.themSender],
          },
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Analysis failed')
      setAnalysis(json.analysis)
      setStage('result')
    } catch (e) {
      setError(e.message)
      setStage('error')
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: FONT, position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: '5%', left: '50%', transform: 'translateX(-50%)', width: '600px', height: '600px', pointerEvents: 'none', background: 'radial-gradient(ellipse, rgba(204,68,238,0.08) 0%, transparent 65%)' }} />

      <div style={{ maxWidth: '600px', margin: '0 auto', padding: '2.5rem 1.5rem 4rem', position: 'relative', zIndex: 1 }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2.5rem' }}>
          <div onClick={reset} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: BRAND.gradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🧾</div>
            <span style={{ fontWeight: 800, fontSize: '0.95rem', letterSpacing: '-0.01em' }}>Receipts</span>
          </div>
          <span style={{ fontSize: '0.7rem', color: C.textMid, border: `1px solid ${C.border}`, borderRadius: 99, padding: '0.2rem 0.6rem' }}>v0.1 · beta</span>
        </div>

        {stage === 'upload'    && <Upload onFile={handleFile} />}
        {stage === 'pickme'    && <PickMe summary={summary} meSender={meSender} setMeSender={setMeSender} onNext={goPreview} />}
        {stage === 'preview'   && <Preview redaction={redaction} onAnalyze={analyze} onBack={() => setStage('pickme')} />}
        {stage === 'analyzing' && <Analyzing />}
        {stage === 'result'    && <Result analysis={analysis} redaction={redaction} themSender={redaction.themSender} onReset={reset} />}
        {stage === 'error'     && <ErrorView error={error} onReset={reset} />}

        <div style={{ marginTop: '4rem', textAlign: 'center', color: C.textDim, fontSize: '0.72rem', letterSpacing: '0.04em', lineHeight: 1.7 }}>
          Names, numbers, emails, and links are stripped on your phone before anything leaves it.<br />
          Anthropic processes the redacted text under a zero-retention contract.<br />
          We never see your messages and never store them.
        </div>
      </div>
    </div>
  )
}

// ─── UPLOAD ───────────────────────────────────────────────────────────────────
function Upload({ onFile }) {
  return (
    <div>
      <Eyebrow>An honest read of your texts</Eyebrow>
      <h1 style={{ fontSize: 'clamp(1.8rem, 5vw, 2.5rem)', fontWeight: 900, lineHeight: 1.1, letterSpacing: '-0.025em', margin: '0.4rem 0 1rem' }}>
        Drop in a chat. <br /><span style={{ background: BRAND.gradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Get the truth.</span>
      </h1>
      <p style={{ color: C.textMid, fontSize: '1rem', lineHeight: 1.6, marginBottom: '2rem' }}>
        Six lenses. No bullshit. The friend who tells you what your other friends won't.
      </p>

      <label style={{ display: 'block', cursor: 'pointer', border: `1.5px dashed ${BRAND.pink}55`, borderRadius: 16, padding: '2.5rem 1.5rem', textAlign: 'center', background: C.card, transition: 'all 0.2s' }}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files?.[0]) }}
      >
        <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📎</div>
        <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '0.4rem' }}>Drop your WhatsApp .txt export</div>
        <div style={{ fontSize: '0.82rem', color: C.textMid, lineHeight: 1.6 }}>
          On your phone: open the chat → More → <strong style={{ color: C.text }}>Export Chat</strong> → Without Media → email to yourself
        </div>
        <input type="file" accept=".txt,text/plain" onChange={e => onFile(e.target.files?.[0])} style={{ display: 'none' }} />
        <div style={{ marginTop: '1.25rem', display: 'inline-block', background: BRAND.gradient, color: '#000', borderRadius: 10, padding: '0.7rem 1.4rem', fontWeight: 800, fontSize: '0.9rem' }}>
          Choose file
        </div>
      </label>

      <div style={{ marginTop: '2rem', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '1rem 1.2rem' }}>
        <div style={{ fontSize: '0.7rem', color: BRAND.neon, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700, marginBottom: '0.5rem' }}>Privacy</div>
        <div style={{ color: C.textMid, fontSize: '0.85rem', lineHeight: 1.6 }}>
          Your messages never touch our servers. Names, phone numbers, emails, and links are stripped right here in your browser. The AI sees "Person A" and "Person B."
        </div>
      </div>
    </div>
  )
}

// ─── PICK ME ──────────────────────────────────────────────────────────────────
function PickMe({ summary, meSender, setMeSender, onNext }) {
  const others = summary.senders
  return (
    <div>
      <Eyebrow>Step 1 of 2</Eyebrow>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 900, letterSpacing: '-0.02em', margin: '0.4rem 0 0.5rem' }}>Which one is you?</h2>
      <p style={{ color: C.textMid, fontSize: '0.92rem', marginBottom: '1.5rem' }}>
        We found {summary.total.toLocaleString()} messages across {summary.days} days. Tell us which sender is you so we know who's reading whom.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {others.map(s => (
          <button key={s} onClick={() => setMeSender(s)} style={{
            background: meSender === s ? `${BRAND.pink}15` : C.card,
            border: `1px solid ${meSender === s ? BRAND.pink : C.border}`,
            borderRadius: 12, padding: '1rem 1.2rem', cursor: 'pointer', textAlign: 'left',
            color: C.text, fontFamily: FONT, fontSize: '0.95rem', fontWeight: 700,
          }}>
            <div>{s} <span style={{ color: C.textMid, fontWeight: 500, fontSize: '0.82rem', marginLeft: 6 }}>· {summary.counts[s]} msgs · avg {summary.avgLengths[s]} chars</span></div>
          </button>
        ))}
      </div>
      <button onClick={onNext} disabled={!meSender} style={{
        marginTop: '1.5rem', background: meSender ? BRAND.gradient : '#1a1a24', color: meSender ? '#000' : C.textMid,
        border: 'none', borderRadius: 10, padding: '0.95rem 1.5rem', fontWeight: 800, fontSize: '0.95rem',
        cursor: meSender ? 'pointer' : 'not-allowed', fontFamily: FONT, width: '100%',
      }}>
        Continue →
      </button>
    </div>
  )
}

// ─── PREVIEW REDACTED ─────────────────────────────────────────────────────────
function Preview({ redaction, onAnalyze, onBack }) {
  const sample = redaction.redacted.slice(-12)
  return (
    <div>
      <Eyebrow>Step 2 of 2</Eyebrow>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 900, letterSpacing: '-0.02em', margin: '0.4rem 0 0.5rem' }}>This is exactly what the AI sees</h2>
      <p style={{ color: C.textMid, fontSize: '0.92rem', marginBottom: '1rem' }}>
        Names, phone numbers, emails, and links are gone. The AI sees Person A (you) and Person B (them).
      </p>

      <div style={{ background: '#0a0a14', border: `1px solid ${C.border}`, borderRadius: 12, padding: '1rem 1.2rem', maxHeight: 320, overflowY: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem', lineHeight: 1.6, color: C.textMid }}>
        {sample.map((m, i) => (
          <div key={i} style={{ marginBottom: '0.4rem' }}>
            <span style={{ color: m.sender.startsWith('Person A') ? BRAND.pink : BRAND.orange }}>{m.sender}:</span>{' '}
            <span style={{ color: C.text }}>{m.body}</span>
          </div>
        ))}
      </div>

      {redaction.nameMap.size > 0 && (
        <div style={{ marginTop: '1rem', fontSize: '0.78rem', color: C.textMid }}>
          Also stripped: {redaction.nameMap.size} name{redaction.nameMap.size === 1 ? '' : 's'} mentioned in messages.
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1.5rem' }}>
        <button onClick={onBack} style={{
          flex: 1, background: 'transparent', color: C.textMid, border: `1px solid ${C.border}`,
          borderRadius: 10, padding: '0.95rem', fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer', fontFamily: FONT,
        }}>← Back</button>
        <button onClick={onAnalyze} style={{
          flex: 2, background: BRAND.gradient, color: '#000', border: 'none', borderRadius: 10,
          padding: '0.95rem', fontWeight: 800, fontSize: '0.95rem', cursor: 'pointer', fontFamily: FONT,
        }}>
          Get the Receipts →
        </button>
      </div>
    </div>
  )
}

// ─── ANALYZING ────────────────────────────────────────────────────────────────
function Analyzing() {
  return (
    <div style={{ textAlign: 'center', padding: '5rem 1rem' }}>
      <div style={{ fontSize: '2.5rem', marginBottom: '1rem', animation: 'pulse 1.5s ease-in-out infinite' }}>🪞</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '0.3rem' }}>Reading the receipts…</div>
      <div style={{ color: C.textMid, fontSize: '0.85rem' }}>~10-30 seconds</div>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }`}</style>
    </div>
  )
}

// ─── RESULT ───────────────────────────────────────────────────────────────────
function Result({ analysis, redaction, themSender, onReset }) {
  const [displayName, setDisplayName] = React.useState(themSender)
  const final = unredact(analysis, redaction, displayName)

  return (
    <div>
      <Eyebrow color={BRAND.neon}>The Receipts</Eyebrow>
      <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ color: C.textMid, fontSize: '0.85rem' }}>Show their name as:</span>
        <input
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: '0.4rem 0.7rem', fontSize: '0.85rem', outline: 'none', fontFamily: FONT, width: 160 }}
        />
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: '1.5rem 1.6rem', whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: '0.95rem', color: C.text }}>
        {final}
      </div>

      <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1.25rem' }}>
        <button onClick={() => navigator.clipboard?.writeText(final)} style={{
          flex: 1, background: 'transparent', color: BRAND.neon, border: `1px solid ${BRAND.neon}55`, borderRadius: 10,
          padding: '0.85rem', fontWeight: 700, fontSize: '0.88rem', cursor: 'pointer', fontFamily: FONT,
        }}>
          Copy
        </button>
        <button onClick={onReset} style={{
          flex: 1, background: BRAND.gradient, color: '#000', border: 'none', borderRadius: 10,
          padding: '0.85rem', fontWeight: 800, fontSize: '0.88rem', cursor: 'pointer', fontFamily: FONT,
        }}>
          Run another
        </button>
      </div>
    </div>
  )
}

// ─── ERROR ────────────────────────────────────────────────────────────────────
function ErrorView({ error, onReset }) {
  return (
    <div style={{ textAlign: 'center', padding: '4rem 1rem' }}>
      <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>😬</div>
      <div style={{ color: C.text, fontSize: '1rem', fontWeight: 800, marginBottom: '0.4rem' }}>Something went sideways</div>
      <div style={{ color: BRAND.orange, fontSize: '0.85rem', marginBottom: '1.5rem' }}>{error}</div>
      <button onClick={onReset} style={{ background: BRAND.gradient, color: '#000', border: 'none', borderRadius: 10, padding: '0.85rem 1.5rem', fontWeight: 800, fontSize: '0.9rem', cursor: 'pointer', fontFamily: FONT }}>
        Try again
      </button>
    </div>
  )
}

// ─── ATOMS ────────────────────────────────────────────────────────────────────
function Eyebrow({ children, color = BRAND.pink }) {
  return (
    <div style={{ fontSize: '0.7rem', color, textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700 }}>
      {children}
    </div>
  )
}
