import React, { useState, useEffect } from 'react'
import { parseWhatsApp, parseRaw, flipAlternating, summarize } from './parser'
import { redact, unredact, buildPayload } from './redact'
import { supabase, authEnabled } from './supabase'
import SignIn from './SignIn'
import { C, BRAND, GRAIL, FONT } from './theme'

// Convert a gateway-timeout-shaped status into a friendly user message.
// Anything else flows through unchanged. Should rarely fire now that
// the function streams responses instead of buffering them, but kept
// as a safety net for any infrastructure-level hiccups.
const timeoutOr = (status, fallback) =>
  (status === 504 || status === 502)
    ? "Connection hiccup — please try again. (If this keeps happening, export a smaller chat window and ping us.)"
    : fallback

export default function App() {
  const [stage, setStage]       = useState('upload')   // upload | pickme | preview | analyzing | result | error
  const [filename, setFilename] = useState('')
  const [messages, setMessages] = useState([])
  const [summary,  setSummary]  = useState(null)
  const [meSender, setMeSender] = useState('')
  const [redaction, setRedaction] = useState(null)
  const [analysis, setAnalysis] = useState('')
  const [error, setError]       = useState('')
  const [sourceKind, setSourceKind] = useState('')    // 'whatsapp' | 'paste'
  const [tier, setTier]         = useState(() => {
    // Allow ?tier=standard or ?tier=deep for testing — default 'free'
    if (typeof window === 'undefined') return 'free'
    const param = new URLSearchParams(window.location.search).get('tier')
    return ['free', 'standard', 'deep'].includes(param) ? param : 'free'
  })
  const [usedTier, setUsedTier] = useState('')        // tier the server actually ran
  const [session, setSession]   = useState(null)
  const [signInOpen, setSignInOpen] = useState(false)
  const [tokensRemaining, setTokensRemaining] = useState(null)   // deep_tokens (free promo OR paid)
  const [standardTokens, setStandardTokens] = useState(0)         // standard_tokens (always paid)
  const [tokenExpiresAt, setTokenExpiresAt] = useState(null)      // promo deep_tokens only — paid never expire
  const [checkoutBusy,   setCheckoutBusy]   = useState(false)     // true while POSTing to /api/checkout
  const [paidReturn,     setPaidReturn]     = useState(null)      // 'standard' | 'deep' when returning from Stripe
  const [pendingReanalyze, setPendingReanalyze] = useState(false)
  const [reanalyzing, setReanalyzing] = useState(false)   // inline loading overlay on result page
  const [reanalyzeError, setReanalyzeError] = useState('') // banner on result page when reanalyze fails
  const [streaming, setStreaming] = useState(false)        // text deltas currently flowing in

  // Track Supabase auth session
  useEffect(() => {
    if (!authEnabled) return
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription?.unsubscribe()
  }, [])

  // After sign-in: if the user was viewing a free Quick Read result, auto
  // re-run the analysis as a Deep Read in place. Effect waits for `session`
  // to actually land in state before calling analyze() — avoids stale-closure
  // bugs where the JWT wouldn't be in headers yet.
  useEffect(() => {
    if (!pendingReanalyze) return
    if (!session?.access_token) return
    if (!redaction) { setPendingReanalyze(false); return }
    setPendingReanalyze(false)
    analyze('deep', true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, pendingReanalyze])

  // When session changes, fetch the user's token balances + expiry.
  // RLS allows users to read their own row only. If no row yet, the
  // backend will auto-grant 1 deep_token on the first analyze call —
  // show the optimistic '1' until then. Expired free-promo tokens
  // display as 0 client-side even before the server confirms.
  // Paid standard_tokens never expire.
  const refreshCredits = async (userId) => {
    if (!userId || !supabase) {
      setTokensRemaining(null); setStandardTokens(0); setTokenExpiresAt(null)
      return
    }
    const { data } = await supabase
      .from('receipts_credits')
      .select('deep_tokens, standard_tokens, expires_at')
      .eq('user_id', userId)
      .maybeSingle()
    const expired = data?.expires_at && new Date(data.expires_at) < new Date()
    setTokensRemaining(expired ? 0 : (data?.deep_tokens ?? 1))  // optimistic 1 for new users
    setStandardTokens(data?.standard_tokens ?? 0)
    setTokenExpiresAt(data?.expires_at ?? null)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (cancelled) return
      await refreshCredits(session?.user?.id)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // Effective tier requested:
  // - Signed-in user with a token → request 'free' (server upgrades to 'deep' and consumes)
  // - Signed-in but tokens=0 → request 'free' (server returns free)
  // - Anon → use whatever was set (URL override or 'free')
  const requestedTier = session ? 'free' : tier

  const signOut = async () => {
    if (!supabase) return
    await supabase.auth.signOut()
    setSession(null)
    setTokensRemaining(null)
  }

  const reset = () => {
    setStage('upload'); setFilename(''); setMessages([])
    setSummary(null); setMeSender(''); setRedaction(null)
    setAnalysis(''); setError(''); setSourceKind('')
  }

  // Single ingest path — works for both file uploads and pasted text.
  const ingestText = (text, sourceLabel) => {
    setError('')
    try {
      const { kind, messages: msgs } = parseRaw(text)
      if (msgs.length === 0) {
        throw new Error("Couldn't find any messages in that. Try the WhatsApp .txt export, or paste a chat with at least a few back-and-forth lines.")
      }
      setSourceKind(kind)
      setFilename(sourceLabel || (kind === 'whatsapp' ? 'WhatsApp export' : 'Pasted chat'))
      const sum = summarize(msgs)
      setMessages(msgs)
      setSummary(sum)
      if (sum.senders.length >= 2) {
        setMeSender(sum.senders[0])
        setStage('pickme')
      } else if (kind === 'paste' && sum.senders.length === 1) {
        // Single-sender paste — usually means the user pasted only one side
        throw new Error("Only found messages from one person. Make sure you copied both sides of the conversation.")
      } else {
        throw new Error('Need at least two participants to read the receipts.')
      }
    } catch (e) {
      setError(e.message)
      setStage('error')
    }
  }

  const handleFile = async (file) => {
    if (!file) return
    const text = await file.text()
    ingestText(text, file.name)
  }

  const handlePaste = (text) => {
    if (!text || text.trim().length < 20) {
      setError('That paste is too short. Need at least a few back-and-forth messages.')
      setStage('error')
      return
    }
    ingestText(text, 'Pasted chat')
  }

  // For pasted iMessage content where senders alternate — let the user flip
  // the "me" assignment if our default got it backwards.
  const flipMeAssignment = () => {
    if (sourceKind !== 'paste') return
    const flipped = flipAlternating(messages)
    setMessages(flipped)
    const sum = summarize(flipped)
    setSummary(sum)
    setMeSender(meSender === 'Sender 1' ? 'Sender 2' : 'Sender 1')
  }

  const goPreview = () => {
    const r = redact(messages, meSender)
    setRedaction(r)
    setStage('preview')
  }

  // Single ingest path for both first-run and re-run.
  //   forceTier:  optional override. If given, sent verbatim to the server.
  //               (Lets us request 'deep' directly when signed in, sidestepping
  //                the server-side token check during F&F beta.)
  //   isReanalyze: if true, keep the user on the result page and show an
  //                inline loading overlay instead of swapping to the
  //                'analyzing' screen — fixes the disorienting scroll-to-top.
  const analyze = async (forceTier, isReanalyze = false) => {
    if (isReanalyze) setReanalyzing(true)
    else setStage('analyzing')
    try {
      // Defensive: a callsite that did `onClick={analyze}` would pass the
      // React SyntheticEvent in here as `forceTier`. Reject anything that
      // isn't a known tier string — events have circular DOM refs and would
      // crash JSON.stringify below.
      const safeForceTier =
        (forceTier === 'free' || forceTier === 'standard' || forceTier === 'deep')
          ? forceTier
          : null

      // Auth-hydration race: on a cold tab the session is loaded async via
      // supabase.auth.getSession(). If the user clicks fast, our React state
      // hasn't caught up yet → no Authorization header → server treats them
      // as anon and returns a free read. Await the live session here so the
      // very first analyze on a cold load still gets the JWT attached.
      let activeSession = session
      if (!activeSession && supabase) {
        try {
          const { data } = await supabase.auth.getSession()
          if (data?.session) {
            activeSession = data.session
            setSession(data.session)
          }
        } catch {/* fall through as anon */}
      }

      const payload = buildPayload(redaction.redacted)
      const headers = { 'Content-Type': 'application/json' }
      if (activeSession?.access_token) headers.Authorization = `Bearer ${activeSession.access_token}`

      // Whatever tier the UI requested wins. Gating comes later — for now
      // we want to be able to test free vs standard vs deep side by side.
      const tierToSend = safeForceTier || tier

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tier: tierToSend,
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

      // Pre-stream errors come back as JSON. Streaming responses come back as
      // text/event-stream. Distinguish on Content-Type (and on res.ok).
      const ct = res.headers.get('content-type') || ''
      const isStream = ct.includes('text/event-stream')

      if (!isStream) {
        // Pre-stream error path (non-200 JSON response, or Netlify gateway HTML)
        const rawText = await res.text()
        let parsed
        try { parsed = JSON.parse(rawText) } catch { parsed = null }
        const fallback = parsed?.error || `Analyze failed: ${res.status}`
        throw new Error(timeoutOr(res.status, fallback))
      }

      // ── SSE stream — render text deltas as they arrive ──
      // Clear the analysis pane up front so streaming shows from empty.
      setAnalysis('')
      if (!isReanalyze) setStage('result')
      setReanalyzing(false)   // overlay off — the streaming text IS the loading indicator
      setStreaming(true)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accumulated = ''
      let metaTier = tierToSend
      let metaDone = false
      let streamErr = null

      const handleEvent = (eventName, dataStr) => {
        let data = {}
        try { data = JSON.parse(dataStr) } catch {/* skip */}
        if (eventName === 'meta') {
          metaTier = data.tier || metaTier
          setUsedTier(metaTier)
          if (typeof data.deep_tokens === 'number')     setTokensRemaining(data.deep_tokens)
          if (typeof data.standard_tokens === 'number') setStandardTokens(data.standard_tokens)
          if (data.token_expires_at)                    setTokenExpiresAt(data.token_expires_at)
        } else if (eventName === 'text' && typeof data.text === 'string') {
          accumulated += data.text
          setAnalysis(accumulated)
        } else if (eventName === 'done') {
          if (typeof data.deep_tokens === 'number')     setTokensRemaining(data.deep_tokens)
          if (typeof data.standard_tokens === 'number') setStandardTokens(data.standard_tokens)
          if (data.token_expires_at)                    setTokenExpiresAt(data.token_expires_at)
          metaDone = true
        } else if (eventName === 'error') {
          streamErr = data.error || 'Stream error'
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvt = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          let eventName = 'message', dataStr = ''
          for (const line of rawEvt.split('\n')) {
            if (line.startsWith('event: ')) eventName = line.slice(7).trim()
            else if (line.startsWith('data: ')) dataStr += line.slice(6)
          }
          if (dataStr) handleEvent(eventName, dataStr)
        }
        if (streamErr) break
      }

      setStreaming(false)
      if (streamErr) throw new Error(streamErr)
      if (!metaDone && !accumulated) throw new Error('Stream ended without any output')
      // Partial content but no explicit `done` — the connection was cut
      // mid-analysis (proxy timeout, Anthropic drop, network blip). Tell
      // the user rather than leaving them with a truncated read.
      if (!metaDone && accumulated) {
        throw new Error('The analysis got cut off mid-stream. Please try again — the server was still writing when the connection closed.')
      }

      // Scroll the result into view at the top once streaming finishes
      if (isReanalyze && typeof window !== 'undefined') {
        setTimeout(() => window.scrollTo({ top: 0, behavior: 'smooth' }), 50)
      }
    } catch (e) {
      // On a re-run from the result page, don't tear down the result —
      // just surface the error inline so the user can read it and decide.
      if (isReanalyze) {
        setReanalyzeError(e.message)
      } else {
        setError(e.message)
        setStage('error')
      }
      setReanalyzing(false)
      setStreaming(false)
    }
  }

  // Convenience handler for the "Re-run as Deep Read" button.
  const reanalyzeAsDeep = () => { setReanalyzeError(''); analyze('deep', true) }

  // ── Stripe checkout: pay for Standard ($3) or Deep ($7) ──
  // Saves the current chat state to sessionStorage, POSTs /api/checkout to
  // create a Stripe session, then redirects the browser to the hosted page.
  // On return, the ?paid= effect below restores state and auto-runs the read.
  const buyTier = async (tierId) => {
    if (!session?.access_token) {
      setSignInOpen(true)
      return
    }
    if (!['standard', 'deep'].includes(tierId)) return
    setCheckoutBusy(true)
    try {
      // Persist the chat-flow state so we can resume after Stripe roundtrip.
      // Date objects survive JSON via toISOString — we revive them on read.
      const persisted = {
        messages: messages.map(m => ({ ...m, date: m.date.toISOString() })),
        meSender,
        sourceKind,
        filename,
        tier: tierId,
        savedAt: Date.now(),
      }
      try { sessionStorage.setItem('receipts_pending', JSON.stringify(persisted)) } catch {/* quota */}

      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          tier: tierId,
          return_url: window.location.origin + window.location.pathname,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `Checkout failed: ${res.status}`)
      }
      const { url } = await res.json()
      if (!url) throw new Error('No checkout URL returned')
      window.location.href = url   // hand off to Stripe
    } catch (e) {
      setCheckoutBusy(false)
      setError(e.message)
      setStage('error')
    }
  }

  // ── Return-from-Stripe handler ──
  // On mount, look for ?paid=standard|deep in the URL. If present:
  //   1. Restore the chat state from sessionStorage (so the user lands
  //      back on the preview screen, not the upload screen)
  //   2. Mark `paidReturn` so the UI can show a "✓ Payment received" banner
  //   3. Strip the query param so a refresh doesn't re-trigger
  // The actual token-grant happens server-side via Stripe webhook; the credits
  // useEffect above will pick it up the next time we refreshCredits().
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params  = new URLSearchParams(window.location.search)
    const paidVal = params.get('paid')
    if (!paidVal) return

    if (['standard', 'deep'].includes(paidVal)) {
      setPaidReturn(paidVal)
      // Restore prior chat state if present
      try {
        const raw = sessionStorage.getItem('receipts_pending')
        if (raw) {
          const saved = JSON.parse(raw)
          if (saved?.messages?.length) {
            const restored = saved.messages.map(m => ({ ...m, date: new Date(m.date) }))
            setMessages(restored)
            setMeSender(saved.meSender || '')
            setSourceKind(saved.sourceKind || '')
            setFilename(saved.filename || '')
            const sum = summarize(restored)
            setSummary(sum)
            const r = redact(restored, saved.meSender)
            setRedaction(r)
            setStage('preview')
          }
          sessionStorage.removeItem('receipts_pending')
        }
      } catch {/* ignore restore errors */}
    }

    // Strip ?paid / ?canceled / ?session_id from the URL
    if (window.history?.replaceState) {
      const cleanUrl = window.location.origin + window.location.pathname
      window.history.replaceState({}, '', cleanUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // After a paid return + session lands, poll Supabase for the granted token
  // (Stripe webhook is async; the token may arrive after we land back).
  // Stops polling once the token shows up or after ~30s.
  useEffect(() => {
    if (!paidReturn || !session?.user?.id) return
    let attempts = 0
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      attempts += 1
      await refreshCredits(session.user.id)
      // Re-read fresh values after refreshCredits sets them
      const { data } = await supabase
        .from('receipts_credits')
        .select('deep_tokens, standard_tokens')
        .eq('user_id', session.user.id)
        .maybeSingle()
      const got = paidReturn === 'deep'
        ? (data?.deep_tokens ?? 0) > 0
        : (data?.standard_tokens ?? 0) > 0
      if (got || attempts >= 15) return
      setTimeout(tick, 2000)
    }
    tick()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paidReturn, session?.user?.id])

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: FONT, position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: '5%', left: '50%', transform: 'translateX(-50%)', width: '600px', height: '600px', pointerEvents: 'none', background: 'radial-gradient(ellipse, rgba(204,68,238,0.08) 0%, transparent 65%)' }} />

      <div style={{ maxWidth: '600px', margin: '0 auto', padding: '2.5rem 1.5rem 4rem', position: 'relative', zIndex: 1 }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2.5rem' }}>
          <div onClick={reset} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: BRAND.gradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🧾</div>
            <span style={{ fontWeight: 800, fontSize: '0.95rem', letterSpacing: '-0.01em' }}>Receipts</span>
          </div>
          {authEnabled && (
            session ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                {tokensRemaining > 0 ? (
                  <span title={tokenExpiresAt ? `Expires ${new Date(tokenExpiresAt).toLocaleDateString()}` : ''} style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                    fontSize: '0.7rem', color: GRAIL.gold,
                    border: `1px solid ${GRAIL.gold}55`, background: `${GRAIL.gold}10`,
                    borderRadius: 99, padding: '0.22rem 0.6rem',
                    fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}>
                    <span style={{ fontSize: '0.85rem' }}>{GRAIL.dove}</span>
                    {tokensRemaining} Free Deep Read{tokensRemaining === 1 ? '' : 's'}
                    {tokenExpiresAt && (
                      <span style={{ fontWeight: 600, opacity: 0.75, letterSpacing: 0, textTransform: 'none' }}>
                        · til {new Date(tokenExpiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                    )}
                  </span>
                ) : (
                  <span style={{
                    fontSize: '0.7rem', color: C.textMid,
                    border: `1px solid ${C.border}`,
                    borderRadius: 99, padding: '0.22rem 0.6rem',
                    fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}>
                    Deep Read used
                  </span>
                )}
                <button onClick={signOut} style={{
                  background: 'transparent', border: `1px solid ${C.border}`, color: C.textMid,
                  borderRadius: 99, padding: '0.25rem 0.65rem', fontSize: '0.72rem', cursor: 'pointer', fontFamily: FONT,
                }}>Sign out</button>
              </div>
            ) : (
              <button onClick={() => setSignInOpen(true)} style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.45rem',
                background: GRAIL.gradient, color: '#000', border: 'none',
                borderRadius: 99, padding: '0.4rem 0.95rem', fontSize: '0.78rem', fontWeight: 800,
                cursor: 'pointer', fontFamily: FONT,
                boxShadow: `0 0 18px ${GRAIL.gold}33`,
              }}>
                <span style={{ fontSize: '0.95rem' }}>{GRAIL.dove}</span> Sign in with Grail
              </button>
            )
          )}
        </div>

        {stage === 'upload'    && <Upload onFile={handleFile} onPaste={handlePaste} />}
        {stage === 'pickme'    && <PickMe summary={summary} meSender={meSender} setMeSender={setMeSender} onNext={goPreview} sourceKind={sourceKind} onFlip={flipMeAssignment} />}
        {stage === 'preview'   && <Preview redaction={redaction} onAnalyze={analyze} onBack={() => setStage('pickme')} initialTier={tier} signedIn={!!session} deepTokens={tokensRemaining ?? 0} standardTokens={standardTokens} onBuy={buyTier} checkoutBusy={checkoutBusy} paidReturn={paidReturn} />}
        {stage === 'analyzing' && <Analyzing />}
        {stage === 'result'    && <Result analysis={analysis} redaction={redaction} themSender={redaction.themSender} onReset={reset} tier={usedTier} onSignIn={() => setSignInOpen(true)} signedIn={!!session} tokensRemaining={tokensRemaining} onReanalyze={reanalyzeAsDeep} reanalyzing={reanalyzing} reanalyzeError={reanalyzeError} streaming={streaming} />}
        {stage === 'error'     && <ErrorView error={error} onReset={reset} />}

        <div style={{ marginTop: '4rem', textAlign: 'center', color: C.textDim, fontSize: '0.72rem', letterSpacing: '0.04em', lineHeight: 1.7 }}>
          Names, numbers, emails, and links are stripped on your phone before anything leaves it.<br />
          Anthropic processes the redacted text under a zero-retention contract.<br />
          We never see your messages and never store them.
        </div>

        {/* Grail Protocol watermark */}
        <a href="https://grail.mx" target="_blank" rel="noopener" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.45rem',
          marginTop: '2rem', textDecoration: 'none',
          fontSize: '0.68rem', color: GRAIL.goldDim, letterSpacing: '0.18em', fontWeight: 700, textTransform: 'uppercase',
          opacity: 0.85,
        }}>
          <span style={{ fontSize: '0.9rem' }}>{GRAIL.dove}</span>
          <span>Powered by Grail Protocol</span>
        </a>
      </div>

      {signInOpen && (
        <SignIn
          onClose={() => setSignInOpen(false)}
          onSuccess={(s) => {
            setSession(s)
            setSignInOpen(false)
            // If we're sitting on a result, auto re-run with the new auth so
            // the server upgrades the read to a Deep Read in place.
            if (stage === 'result' && redaction) setPendingReanalyze(true)
          }}
        />
      )}
    </div>
  )
}

// ─── UPLOAD ───────────────────────────────────────────────────────────────────
function Upload({ onFile, onPaste }) {
  const [tab, setTab] = useState('upload')   // upload | paste
  const [pasted, setPasted] = useState('')

  return (
    <div>
      <Eyebrow>An honest read of your texts</Eyebrow>
      <h1 style={{ fontSize: 'clamp(1.8rem, 5vw, 2.5rem)', fontWeight: 900, lineHeight: 1.1, letterSpacing: '-0.025em', margin: '0.4rem 0 1rem' }}>
        Drop in a chat. <br /><span style={{ background: BRAND.gradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Get the truth.</span>
      </h1>
      <p style={{ color: C.textMid, fontSize: '1rem', lineHeight: 1.6, marginBottom: '0.85rem' }}>
        Six lenses. No bullshit. The friend who tells you what your other friends won't.
      </p>
      <div style={{ marginBottom: '0.6rem', fontSize: '0.78rem', color: C.textMid, lineHeight: 1.6 }}>
        <span style={{ color: BRAND.neon, fontWeight: 700 }}>Built on</span> Gottman, Sue Johnson, Esther Perel, Stan Tatkin, Logan Ury, attachment theory. <span style={{ color: C.textDim }}>Real psychology, not vibes.</span>
      </div>
      <div style={{ marginBottom: '1.5rem', fontSize: '0.74rem', color: C.textDim, lineHeight: 1.6 }}>
        We focus on the most recent ~4-6 months — the window where the dynamic actually lives. <span style={{ color: GRAIL.gold }}>Full-history reads launching as a Premium tier soon.</span>
      </div>

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem', background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '0.25rem' }}>
        {[['upload', 'Upload .txt'], ['paste', 'Paste chat']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            flex: 1, padding: '0.55rem', borderRadius: 7, border: 'none',
            background: tab === k ? BRAND.gradient : 'transparent',
            color: tab === k ? '#000' : C.textMid,
            cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700, fontFamily: FONT,
          }}>{label}</button>
        ))}
      </div>

      {tab === 'upload' && (
        <label style={{ display: 'block', cursor: 'pointer', border: `1.5px dashed ${BRAND.pink}55`, borderRadius: 16, padding: '2.5rem 1.5rem', textAlign: 'center', background: C.card }}
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
      )}

      {tab === 'paste' && (
        <div>
          <textarea
            value={pasted}
            onChange={e => setPasted(e.target.value)}
            placeholder={`Paste your conversation here.\n\nWorks with iMessage (open Messages on Mac → Cmd+A → Cmd+C → paste here), or any chat where you can see both sides.\n\nDon't worry about formatting — we'll figure it out.`}
            rows={10}
            style={{
              width: '100%', boxSizing: 'border-box',
              background: C.card, border: `1px solid ${C.border}`,
              borderRadius: 12, color: C.text, padding: '1rem',
              fontSize: '0.88rem', outline: 'none', fontFamily: FONT,
              resize: 'vertical', minHeight: 220, lineHeight: 1.5,
            }}
          />
          <button
            onClick={() => onPaste(pasted)}
            disabled={pasted.trim().length < 20}
            style={{
              width: '100%', marginTop: '0.75rem',
              background: pasted.trim().length < 20 ? '#1a1a24' : BRAND.gradient,
              color: pasted.trim().length < 20 ? C.textMid : '#000',
              border: 'none', borderRadius: 10, padding: '0.95rem',
              fontWeight: 800, fontSize: '0.95rem',
              cursor: pasted.trim().length < 20 ? 'not-allowed' : 'pointer', fontFamily: FONT,
            }}
          >
            Use this chat →
          </button>
        </div>
      )}

      <HowToExport />

      <div style={{ marginTop: '1.5rem', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '1rem 1.2rem' }}>
        <div style={{ fontSize: '0.7rem', color: BRAND.neon, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 700, marginBottom: '0.5rem' }}>Privacy</div>
        <div style={{ color: C.textMid, fontSize: '0.85rem', lineHeight: 1.6 }}>
          Your messages never touch our servers. Names, phone numbers, emails, and links are stripped right here in your browser. The AI sees "Person A" and "Person B."
        </div>
      </div>
    </div>
  )
}

// ─── HOW TO EXPORT (collapsible tutorial) ────────────────────────────────────
function HowToExport() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('whatsapp')

  return (
    <div style={{ marginTop: '1.25rem', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '0.85rem 1.2rem' }}>
      <button onClick={() => setOpen(!open)} style={{
        background: 'transparent', border: 'none', color: C.text, padding: 0,
        fontFamily: FONT, fontSize: '0.88rem', fontWeight: 700, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
      }}>
        <span>How do I get my chat?</span>
        <span style={{ color: C.textMid, fontSize: '0.85rem' }}>{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div style={{ marginTop: '1rem' }}>
          <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.85rem', borderBottom: `1px solid ${C.border}` }}>
            {[
              ['whatsapp', 'WhatsApp'],
              ['imessage-mac', 'iMessage (Mac)'],
              ['imessage-iphone', 'iMessage (iPhone)'],
            ].map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} style={{
                background: 'transparent', border: 'none',
                color: tab === k ? BRAND.pink : C.textMid,
                borderBottom: `2px solid ${tab === k ? BRAND.pink : 'transparent'}`,
                padding: '0.4rem 0.6rem', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 700, fontFamily: FONT, marginBottom: -1,
              }}>{label}</button>
            ))}
          </div>

          {tab === 'whatsapp' && (
            <ol style={{ color: C.textMid, fontSize: '0.85rem', lineHeight: 1.7, paddingLeft: '1.1rem', margin: 0 }}>
              <li>Open the conversation in WhatsApp on your phone</li>
              <li>Tap the contact's name at the top of the chat</li>
              <li>Scroll down → tap <strong style={{ color: C.text }}>Export Chat</strong></li>
              <li>Choose <strong style={{ color: C.text }}>Without Media</strong> (way smaller file)</li>
              <li>Email it to yourself, or save to Files</li>
              <li>Come back here and drop the .txt file on the upload tab</li>
            </ol>
          )}

          {tab === 'imessage-mac' && (
            <div style={{ color: C.textMid, fontSize: '0.85rem', lineHeight: 1.7 }}>
              <p style={{ margin: '0 0 0.6rem' }}>
                <strong style={{ color: C.text }}>The fast way:</strong>
              </p>
              <ol style={{ paddingLeft: '1.1rem', margin: '0 0 0.85rem' }}>
                <li>Open <strong style={{ color: C.text }}>Messages</strong> on your Mac</li>
                <li>Click into the conversation you want to read</li>
                <li>Press <strong style={{ color: C.text }}>Cmd+A</strong> to select all messages, then <strong style={{ color: C.text }}>Cmd+C</strong> to copy</li>
                <li>Switch to the <strong style={{ color: C.text }}>Paste chat</strong> tab above and paste</li>
                <li>Click "Use this chat →"</li>
              </ol>
              <p style={{ margin: 0, fontSize: '0.78rem', color: C.textDim }}>
                Note: paste loses some sender info. We'll alternate by default — there's a "Flip" button on the next step if it gets it backwards.
              </p>
            </div>
          )}

          {tab === 'imessage-iphone' && (
            <div style={{ color: C.textMid, fontSize: '0.85rem', lineHeight: 1.7 }}>
              <ol style={{ paddingLeft: '1.1rem', margin: '0 0 0.85rem' }}>
                <li>Open the conversation in <strong style={{ color: C.text }}>Messages</strong></li>
                <li>Long-press any message → tap <strong style={{ color: C.text }}>More…</strong></li>
                <li>Circles appear next to each message — tap them to select the ones you want</li>
                <li>Tap the <strong style={{ color: C.text }}>share / forward arrow</strong> at the bottom-left, then forward to yourself in the Notes app</li>
                <li>Open Notes, copy the text, paste here on the <strong style={{ color: C.text }}>Paste chat</strong> tab</li>
              </ol>
              <p style={{ margin: 0, fontSize: '0.78rem', color: C.textDim }}>
                Way easier on Mac if you have one. iPhone selecting is slow for long chats.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── PICK ME ──────────────────────────────────────────────────────────────────
function PickMe({ summary, meSender, setMeSender, onNext, sourceKind, onFlip }) {
  const others = summary.senders
  const isPaste = sourceKind === 'paste'

  return (
    <div>
      <Eyebrow>Step 1 of 2</Eyebrow>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 900, letterSpacing: '-0.02em', margin: '0.4rem 0 0.5rem' }}>Which one is you?</h2>
      <p style={{ color: C.textMid, fontSize: '0.92rem', marginBottom: '1.5rem' }}>
        Found {summary.total.toLocaleString()} messages{summary.days > 1 ? ` across ${summary.days} days` : ''}.
        {isPaste && ' Pasted text doesn\'t carry sender labels — we alternated. Pick yourself below; if the messages look swapped, hit "Flip senders."'}
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

      {isPaste && (
        <button onClick={onFlip} style={{
          marginTop: '0.85rem', width: '100%', background: 'transparent',
          color: C.textMid, border: `1px solid ${C.border}`,
          borderRadius: 10, padding: '0.7rem', fontSize: '0.82rem', fontWeight: 600,
          cursor: 'pointer', fontFamily: FONT,
        }}>
          ↔ Flip senders (if our guess was backwards)
        </button>
      )}

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
// Tier picker with three options. For paid tiers, shows the price unless the
// user already has a token for that tier (then shows "Free · 1 left"). The
// CTA button morphs based on what the user picked: free → "Get the Receipts",
// paid w/ token → "Get the Receipts", paid w/o token → "Buy & Run · $X"
// (which kicks off Stripe Checkout).
function Preview({ redaction, onAnalyze, onBack, initialTier, signedIn, deepTokens, standardTokens, onBuy, checkoutBusy, paidReturn }) {
  const sample = redaction.redacted.slice(-12)
  const [pickedTier, setPickedTier] = useState(initialTier || 'free')

  const TIER_OPTIONS = [
    { id: 'free',     label: 'Quick',    sub: 'Haiku · ~140 words',      price: 0 },
    { id: 'standard', label: 'Standard', sub: 'Sonnet · full breakdown', price: 3 },
    { id: 'deep',     label: 'Deep',     sub: 'Opus · max depth',        price: 7 },
  ]

  const tokensFor = (id) => id === 'deep' ? deepTokens : id === 'standard' ? standardTokens : Infinity
  const hasFreeRun = (id) => tokensFor(id) > 0
  const pickedOpt  = TIER_OPTIONS.find(o => o.id === pickedTier) || TIER_OPTIONS[0]
  const needsBuy   = pickedOpt.price > 0 && !hasFreeRun(pickedTier)

  const ctaLabel = checkoutBusy
    ? 'Opening Stripe…'
    : needsBuy
      ? `Buy & Run · $${pickedOpt.price}`
      : 'Get the Receipts →'

  const onCta = () => {
    if (checkoutBusy) return
    if (needsBuy) onBuy(pickedTier)
    else onAnalyze(pickedTier)
  }

  return (
    <div>
      <Eyebrow>Step 2 of 2</Eyebrow>
      <h2 style={{ fontSize: '1.4rem', fontWeight: 900, letterSpacing: '-0.02em', margin: '0.4rem 0 0.5rem' }}>This is exactly what the AI sees</h2>
      <p style={{ color: C.textMid, fontSize: '0.92rem', marginBottom: '1rem' }}>
        Names, phone numbers, emails, and links are gone. The AI sees YOU and THEM.
      </p>

      {paidReturn && (
        <div style={{
          background: `${GRAIL.gold}15`, border: `1px solid ${GRAIL.gold}55`,
          borderRadius: 10, padding: '0.7rem 0.9rem', marginBottom: '1rem',
          fontSize: '0.85rem', color: GRAIL.gold, fontWeight: 700,
          display: 'flex', alignItems: 'center', gap: '0.5rem',
        }}>
          <span>{GRAIL.dove}</span>
          {hasFreeRun(paidReturn)
            ? `Payment received — your ${paidReturn === 'deep' ? 'Deep' : 'Standard'} Read is loaded. Tap Get the Receipts.`
            : `Payment received — confirming your ${paidReturn === 'deep' ? 'Deep' : 'Standard'} Read…`}
        </div>
      )}

      <div style={{ background: '#0a0a14', border: `1px solid ${C.border}`, borderRadius: 12, padding: '1rem 1.2rem', maxHeight: 320, overflowY: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem', lineHeight: 1.6, color: C.textMid }}>
        {sample.map((m, i) => (
          <div key={i} style={{ marginBottom: '0.4rem' }}>
            <span style={{ color: m.sender === 'YOU' ? BRAND.pink : BRAND.orange }}>{m.sender}:</span>{' '}
            <span style={{ color: C.text }}>{m.body}</span>
          </div>
        ))}
      </div>

      {redaction.nameMap.size > 0 && (
        <div style={{ marginTop: '1rem', fontSize: '0.78rem', color: C.textMid }}>
          Also stripped: {redaction.nameMap.size} name{redaction.nameMap.size === 1 ? '' : 's'} mentioned in messages.
        </div>
      )}

      <div style={{ marginTop: '1.5rem' }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textMid, marginBottom: '0.5rem' }}>
          Pick a tier
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
          {TIER_OPTIONS.map(opt => {
            const active = pickedTier === opt.id
            const tokens = tokensFor(opt.id)
            const free   = opt.price === 0
            const owned  = !free && tokens > 0
            return (
              <button
                key={opt.id}
                onClick={() => setPickedTier(opt.id)}
                style={{
                  background: active ? `${BRAND.pink}18` : 'transparent',
                  color: active ? C.text : C.textMid,
                  border: `1px solid ${active ? BRAND.pink : C.border}`,
                  borderRadius: 10, padding: '0.7rem 0.5rem',
                  cursor: 'pointer', fontFamily: FONT, textAlign: 'left',
                  display: 'flex', flexDirection: 'column', gap: '0.15rem',
                  position: 'relative',
                }}
              >
                <span style={{ fontWeight: 800, fontSize: '0.85rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  {opt.label}
                  {free ? null : owned ? (
                    <span style={{ fontSize: '0.62rem', color: GRAIL.gold, fontWeight: 800, letterSpacing: '0.06em' }}>FREE</span>
                  ) : (
                    <span style={{ fontSize: '0.78rem', color: C.text, fontWeight: 800 }}>${opt.price}</span>
                  )}
                </span>
                <span style={{ fontSize: '0.68rem', color: C.textMid }}>{opt.sub}</span>
              </button>
            )
          })}
        </div>
        {needsBuy && !signedIn && (
          <div style={{ marginTop: '0.7rem', fontSize: '0.75rem', color: C.textMid }}>
            Sign in with Grail to buy a paid read.
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem' }}>
        <button onClick={onBack} style={{
          flex: 1, background: 'transparent', color: C.textMid, border: `1px solid ${C.border}`,
          borderRadius: 10, padding: '0.95rem', fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer', fontFamily: FONT,
        }}>← Back</button>
        <button onClick={onCta} disabled={checkoutBusy} style={{
          flex: 2, background: BRAND.gradient, color: '#000', border: 'none', borderRadius: 10,
          padding: '0.95rem', fontWeight: 800, fontSize: '0.95rem',
          cursor: checkoutBusy ? 'wait' : 'pointer', fontFamily: FONT,
          opacity: checkoutBusy ? 0.7 : 1,
        }}>
          {ctaLabel}
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
function Result({ analysis, redaction, themSender, onReset, tier, onSignIn, signedIn, tokensRemaining, onReanalyze, reanalyzing, reanalyzeError, streaming }) {
  const [displayName, setDisplayName] = React.useState(themSender)
  const final = unredact(analysis, redaction, displayName)

  const tierLabel = {
    free:     { label: 'Quick Read · Free',           color: C.textMid, dove: false },
    standard: { label: 'Deep Read · via Grail',       color: GRAIL.gold, dove: true },
    deep:     { label: 'Deepest Read · via Grail',    color: GRAIL.gold, dove: true },
  }[tier] || { label: 'Quick Read', color: C.textMid, dove: false }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <Eyebrow color={BRAND.neon}>The Receipts</Eyebrow>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
          fontSize: '0.65rem', color: tierLabel.color,
          border: `1px solid ${tierLabel.color}55`,
          background: tierLabel.dove ? `${GRAIL.gold}10` : 'transparent',
          borderRadius: 99, padding: '0.18rem 0.6rem',
          fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>
          {tierLabel.dove && <span style={{ fontSize: '0.85rem' }}>{GRAIL.dove}</span>}
          {tierLabel.label}
        </span>
      </div>

      <div style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ color: C.textMid, fontSize: '0.85rem' }}>Show their name as:</span>
        <input
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, padding: '0.4rem 0.7rem', fontSize: '0.85rem', outline: 'none', fontFamily: FONT, width: 160 }}
        />
      </div>

      {reanalyzeError && (
        <div style={{
          background: 'rgba(239,68,68,0.08)', border: `1px solid ${C.red}55`,
          borderRadius: 12, padding: '0.85rem 1rem', marginBottom: '0.75rem',
          color: C.red, fontSize: '0.85rem', lineHeight: 1.55,
        }}>
          ⚠️ {reanalyzeError}
        </div>
      )}

      <div style={{ position: 'relative', background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: '1.5rem 1.6rem', whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: '0.95rem', color: C.text, minHeight: streaming && !final ? 80 : 'auto' }}>
        <div style={{ opacity: reanalyzing ? 0.25 : 1, transition: 'opacity 0.25s' }}>
          {final}
          {streaming && (
            <span style={{
              display: 'inline-block', width: '0.5em', height: '1em',
              marginLeft: 2, verticalAlign: 'text-bottom',
              background: BRAND.pink,
              animation: 'cursorBlink 1s step-end infinite',
            }} />
          )}
          {streaming && !final && (
            <span style={{ color: C.textMid, fontSize: '0.88rem', fontStyle: 'italic' }}>
              Reading the receipts…
            </span>
          )}
        </div>
        <style>{`@keyframes cursorBlink { 50% { opacity: 0 } }`}</style>
        {reanalyzing && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            background: `${C.card}cc`, backdropFilter: 'blur(4px)',
            borderRadius: 16, gap: '0.75rem',
          }}>
            <div style={{ fontSize: '2rem', animation: 'pulse 1.4s ease-in-out infinite' }}>🪞</div>
            <div style={{ fontSize: '0.95rem', fontWeight: 800, color: C.text }}>
              Re-reading at depth…
            </div>
            <div style={{ fontSize: '0.78rem', color: C.textMid }}>
              ~10-30 seconds
            </div>
          </div>
        )}
      </div>

      {tier === 'free' && <UpgradeCard onSignIn={() => onSignIn()} onReanalyze={onReanalyze} signedIn={signedIn} tokensRemaining={tokensRemaining} />}

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

// ─── UPGRADE CARD ─────────────────────────────────────────────────────────────
// The scintillating upsell. Sits below every free read.
// Three states:
//   1. Anon  → "Sign in with Grail" gold CTA
//   2. Signed in, tokens > 0 → shouldn't usually happen here (server would've
//      upgraded), but if it does, just nudge to use it next time
//   3. Signed in, tokens = 0 → standard "Get the Deep Read · $19" coming-soon
function UpgradeCard({ onSignIn, onReanalyze, signedIn, tokensRemaining }) {
  const layers = [
    { icon: '💞', label: 'Attachment style' },
    { icon: '🧠', label: 'Myers-Briggs / Enneagram' },
    { icon: '✨', label: 'Zodiac & astrology' },
    { icon: '🌌', label: 'Human Design' },
    { icon: '📖', label: 'Relationship history' },
    { icon: '🌍', label: 'Cultural context' },
  ]

  return (
    <div style={{
      marginTop: '1.25rem', padding: '1.5rem 1.6rem',
      background: 'linear-gradient(135deg, rgba(221,34,170,0.10) 0%, rgba(240,112,32,0.06) 100%)',
      border: `1px solid ${BRAND.pink}55`, borderRadius: 16, position: 'relative', overflow: 'hidden',
    }}>
      {/* Glow accent */}
      <div style={{
        position: 'absolute', top: -40, right: -40, width: 180, height: 180, pointerEvents: 'none',
        background: 'radial-gradient(circle, rgba(221,34,170,0.18) 0%, transparent 65%)',
      }} />

      <div style={{ position: 'relative' }}>
        <div style={{ fontSize: '0.7rem', color: BRAND.pink, textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700, marginBottom: '0.5rem' }}>
          The Deep Read
        </div>
        <div style={{ color: C.text, fontSize: '1.2rem', fontWeight: 900, letterSpacing: '-0.02em', lineHeight: 1.25, marginBottom: '0.75rem' }}>
          You can change the trajectory.<br />
          <span style={{ background: BRAND.gradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Here's exactly how.
          </span>
        </div>

        <div style={{ color: C.text, fontSize: '0.9rem', lineHeight: 1.65, marginBottom: '1.1rem' }}>
          The Quick Read tells you what's happening. The <strong>Deep Read</strong> tells you what to do about it. You'll get:
        </div>

        <ul style={{ color: C.textMid, fontSize: '0.85rem', lineHeight: 1.7, paddingLeft: '1.1rem', margin: '0 0 1.1rem' }}>
          <li><strong style={{ color: C.text }}>Your role</strong> — what you did that shaped this dynamic, with quoted moments</li>
          <li><strong style={{ color: C.text }}>Their pattern</strong> — what's actually driving them (avoidance ≠ disinterest)</li>
          <li><strong style={{ color: C.text }}>The trajectory</strong> — where this goes if nothing changes, and where it could go</li>
          <li><strong style={{ color: C.text }}>The Playbook</strong> — 3-5 specific moves to shift it, ranked by impact</li>
          <li><strong style={{ color: C.text }}>Watchpoints</strong> — exactly what to look for over the next 2-4 weeks</li>
          <li><strong style={{ color: C.text }}>The pattern about you</strong> — what this dynamic reveals about your own wiring</li>
        </ul>

        <div style={{ borderTop: `1px solid ${BRAND.pink}33`, paddingTop: '1.1rem', marginBottom: '1.1rem' }}>
          <div style={{ fontSize: '0.68rem', color: BRAND.neon, textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700, marginBottom: '0.6rem' }}>
            Add context lenses
          </div>
          <div style={{ color: C.textMid, fontSize: '0.82rem', lineHeight: 1.6, marginBottom: '0.85rem' }}>
            Optional layers you can add to make the read bespoke:
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {layers.map(l => (
              <div key={l.label} style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                background: C.card, border: `1px solid ${C.border}`, borderRadius: 99,
                padding: '0.35rem 0.75rem', fontSize: '0.78rem', color: C.text, fontWeight: 600,
              }}>
                <span style={{ fontSize: '0.95rem' }}>{l.icon}</span>{l.label}
              </div>
            ))}
          </div>
        </div>

        {/* Three states: anon promo / signed in with tokens / signed in tokens=0 */}
        {authEnabled && !signedIn && (
          <>
            <button onClick={onSignIn} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
              width: '100%', background: GRAIL.gradient, color: '#000', border: 'none', borderRadius: 12,
              padding: '0.95rem', fontSize: '0.95rem', fontWeight: 800, cursor: 'pointer',
              fontFamily: FONT, letterSpacing: '0.01em',
              boxShadow: `0 0 24px ${GRAIL.gold}33`,
            }}>
              <span style={{ fontSize: '1.05rem' }}>{GRAIL.dove}</span>
              Sign in with Grail · 1 Free Deep Read
            </button>
            <div style={{ textAlign: 'center', color: GRAIL.gold, fontSize: '0.72rem', marginTop: '0.6rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Every Grail account gets one. No card.
            </div>
          </>
        )}

        {authEnabled && signedIn && tokensRemaining > 0 && (
          <>
            <button onClick={onReanalyze} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
              width: '100%', background: GRAIL.gradient, color: '#000', border: 'none', borderRadius: 12,
              padding: '0.95rem', fontSize: '0.95rem', fontWeight: 800, cursor: 'pointer',
              fontFamily: FONT, letterSpacing: '0.01em',
              boxShadow: `0 0 24px ${GRAIL.gold}33`,
            }}>
              <span style={{ fontSize: '1.05rem' }}>{GRAIL.dove}</span>
              Re-run this chat as a Deep Read
            </button>
            <div style={{ textAlign: 'center', color: GRAIL.gold, fontSize: '0.72rem', marginTop: '0.6rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {tokensRemaining} Deep Read{tokensRemaining === 1 ? '' : 's'} left in your account
            </div>
          </>
        )}

        {(!authEnabled || (signedIn && tokensRemaining === 0)) && (
          <>
            <button disabled style={{
              width: '100%', background: BRAND.gradient, color: '#000', border: 'none', borderRadius: 12,
              padding: '0.95rem', fontSize: '0.95rem', fontWeight: 800, cursor: 'not-allowed',
              fontFamily: FONT, opacity: 0.7, letterSpacing: '0.01em',
            }}>
              Get the Deep Read · $19 — coming soon
            </button>
            <div style={{ textAlign: 'center', color: C.textDim, fontSize: '0.72rem', marginTop: '0.6rem' }}>
              {signedIn && tokensRemaining === 0
                ? 'You\'ve used your free Deep Read. Paid reads coming soon.'
                : 'Same privacy. Same redaction. Way more depth.'}
            </div>
          </>
        )}
      </div>
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
