import React, { useState } from 'react'
import { supabase } from './supabase'
import { C, BRAND, FONT } from './theme'

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
        position: 'relative',
      }}>
        <button onClick={onClose} style={{
          position: 'absolute', top: 12, right: 14, background: 'transparent',
          border: 'none', color: C.textMid, fontSize: '1.4rem', cursor: 'pointer', lineHeight: 1,
        }}>×</button>

        <div style={{ fontSize: '0.7rem', color: BRAND.neon, textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 700, marginBottom: '0.5rem' }}>
          Limited launch promo
        </div>
        <div style={{ color: C.text, fontSize: '1.3rem', fontWeight: 900, letterSpacing: '-0.02em', lineHeight: 1.25, marginBottom: '0.6rem' }}>
          Sign up free.<br/>
          <span style={{ background: BRAND.gradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            Get the Deep Read on us.
          </span>
        </div>
        <div style={{ color: C.textMid, fontSize: '0.85rem', lineHeight: 1.6, marginBottom: '1.4rem' }}>
          One account works across Receipts and <a href="https://grail.mx" target="_blank" rel="noopener" style={{ color: BRAND.pink, textDecoration: 'none', fontWeight: 700 }}>Grail.mx</a>. While the promo runs, signed-in users get the full Deep Read free on every chat they upload.
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
      </div>
    </div>
  )
}
