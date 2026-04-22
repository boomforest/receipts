import React, { useState } from 'react'
import { supabase } from './supabase'
import { C, BRAND, GRAIL, FONT } from './theme'

// Single modal that handles both sign-in and sign-up. The same Supabase
// project that runs Grail backs this — one account works across both.

export default function SignIn({ onClose, onSuccess }) {
  const [mode, setMode]       = useState('signin')   // signin | signup
  const [email, setEmail]     = useState('')
  const [password, setPass]   = useState('')
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)
  const [info, setInfo]       = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (!supabase) {
      setError('Auth not configured. Tell JP.')
      return
    }
    setError(''); setInfo(''); setLoading(true)
    try {
      if (mode === 'signin') {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        onSuccess(data.session)
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        if (data.session) {
          onSuccess(data.session)
        } else {
          setInfo('Check your email to confirm your account, then come back and sign in.')
        }
      }
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 18, padding: '2rem 1.75rem', maxWidth: 380, width: '100%',
        position: 'relative', overflow: 'hidden',
      }}>
        {/* Subtle Grail-gold glow at the top */}
        <div style={{
          position: 'absolute', top: -80, left: '50%', transform: 'translateX(-50%)',
          width: 280, height: 200, pointerEvents: 'none',
          background: `radial-gradient(ellipse, ${GRAIL.gold}22 0%, transparent 65%)`,
        }} />

        <button onClick={onClose} style={{
          position: 'absolute', top: 12, right: 14, background: 'transparent',
          border: 'none', color: C.textMid, fontSize: '1.4rem', cursor: 'pointer', lineHeight: 1, zIndex: 2,
        }}>×</button>

        {/* Grail mark + protocol attribution */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '0.55rem', marginBottom: '1.25rem' }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: GRAIL.gradient,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            boxShadow: `0 0 20px ${GRAIL.gold}33`,
          }}>{GRAIL.dove}</div>
          <div>
            <div style={{ fontSize: '0.62rem', color: GRAIL.gold, textTransform: 'uppercase', letterSpacing: '0.18em', fontWeight: 800 }}>
              Grail Protocol
            </div>
            <div style={{ fontSize: '0.92rem', color: C.text, fontWeight: 700, marginTop: 1 }}>
              {mode === 'signin' ? 'Sign in with Grail' : 'Sign up with Grail'}
            </div>
          </div>
        </div>

        <div style={{ position: 'relative', color: C.text, fontSize: '1.15rem', fontWeight: 900, letterSpacing: '-0.02em', lineHeight: 1.3, marginBottom: '0.6rem' }}>
          One account.<br/>
          <span style={{ background: BRAND.gradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            The whole Protocol.
          </span>
        </div>
        <div style={{ position: 'relative', color: C.textMid, fontSize: '0.83rem', lineHeight: 1.6, marginBottom: '1.4rem' }}>
          Your Grail account works on Receipts, <a href="https://grail.mx" target="_blank" rel="noopener" style={{ color: GRAIL.gold, textDecoration: 'none', fontWeight: 700 }}>grail.mx</a>, and every product in the Protocol family. Beta users get the Deep Read free on every chat.
        </div>

        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem', background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '0.25rem' }}>
          {[['signin', 'Sign in'], ['signup', 'Sign up']].map(([k, label]) => (
            <button key={k} type="button" onClick={() => { setMode(k); setError(''); setInfo('') }} style={{
              flex: 1, padding: '0.5rem', borderRadius: 7, border: 'none',
              background: mode === k ? BRAND.gradient : 'transparent',
              color: mode === k ? '#000' : C.textMid,
              cursor: 'pointer', fontSize: '0.82rem', fontWeight: 700, fontFamily: FONT,
            }}>{label}</button>
          ))}
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <input
            type="email" placeholder="Email" value={email} required
            onChange={e => setEmail(e.target.value)} autoComplete="email"
            style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '0.8rem 1rem', color: C.text, fontSize: '0.92rem', outline: 'none', fontFamily: FONT }}
          />
          <input
            type="password" placeholder="Password" value={password} required
            onChange={e => setPass(e.target.value)} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: '0.8rem 1rem', color: C.text, fontSize: '0.92rem', outline: 'none', fontFamily: FONT }}
          />
          {error && <div style={{ color: BRAND.orange, fontSize: '0.82rem' }}>{error}</div>}
          {info  && <div style={{ color: BRAND.neon,   fontSize: '0.82rem' }}>{info}</div>}
          <button type="submit" disabled={loading} style={{
            background: BRAND.gradient, color: '#000', border: 'none', borderRadius: 10,
            padding: '0.95rem', fontWeight: 800, fontSize: '0.95rem',
            cursor: loading ? 'wait' : 'pointer', fontFamily: FONT, marginTop: '0.4rem', opacity: loading ? 0.6 : 1,
          }}>
            {loading ? '…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <div style={{ marginTop: '1rem', textAlign: 'center', fontSize: '0.72rem', color: C.textDim }}>
          Same privacy on both sides. We never see your texts.
        </div>

        <div style={{ marginTop: '1rem', paddingTop: '0.85rem', borderTop: `1px solid ${C.border}`, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', fontSize: '0.68rem', color: GRAIL.gold, letterSpacing: '0.1em', fontWeight: 700, textTransform: 'uppercase' }}>
          <span>{GRAIL.dove}</span> Powered by Grail Protocol
        </div>
      </div>
    </div>
  )
}
