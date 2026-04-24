const { createClient } = require('@supabase/supabase-js')

// Captures a PayPal order and grants the buyer's token on receipts_credits.
// Idempotent: uses PayPal order id as the primary key in receipts_purchases.
//
// Auth:    Bearer <supabase_access_token>
// Body:    { paypal_order_id }
// Returns: { ok: true, tier, standard_tokens, deep_tokens }

const PAYPAL_API_BASE = process.env.PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com'

async function getPayPalToken() {
  const creds = Buffer.from(
    `${process.env.VITE_PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64')
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error_description || 'PayPal auth failed')
  return data.access_token
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  try {
    const auth = event.headers.authorization || event.headers.Authorization || ''
    const jwt  = auth.replace(/^Bearer\s+/i, '')
    if (!jwt) throw new Error('Not signed in')

    const { paypal_order_id } = JSON.parse(event.body || '{}')
    if (!paypal_order_id) throw new Error('paypal_order_id required')

    const supabase = createClient(
      process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    )

    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt)
    if (userErr || !userData?.user) throw new Error('Invalid session')
    const userId = userData.user.id

    const purchaseKey = `paypal_${paypal_order_id}`

    // Idempotency: if we already granted for this order, return current balance.
    const { data: existing } = await supabase
      .from('receipts_purchases')
      .select('tier')
      .eq('event_id', purchaseKey)
      .maybeSingle()

    if (existing) {
      const { data: creds } = await supabase
        .from('receipts_credits')
        .select('deep_tokens, standard_tokens')
        .eq('user_id', userId)
        .maybeSingle()
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          tier: existing.tier,
          standard_tokens: creds?.standard_tokens ?? 0,
          deep_tokens:     creds?.deep_tokens ?? 0,
          idempotent: true,
        }),
      }
    }

    const token = await getPayPalToken()

    const orderRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${paypal_order_id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    const order = await orderRes.json()
    if (!orderRes.ok) throw new Error(order.message || 'PayPal order not found')

    let status = order.status
    if (status === 'APPROVED') {
      const capRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${paypal_order_id}/capture`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
        },
      })
      const capData = await capRes.json()
      if (!capRes.ok) throw new Error(capData.message || 'PayPal capture failed')
      status = capData.status
    }

    if (status !== 'COMPLETED') throw new Error(`PayPal order not completed (status: ${status})`)

    const rawCustomId = order.purchase_units?.[0]?.custom_id
    if (!rawCustomId) throw new Error('Missing order metadata')
    let meta
    try {
      meta = JSON.parse(rawCustomId)
    } catch (e) {
      throw new Error('Malformed order metadata')
    }

    // Critical: the buyer on this session must match the user_id embedded
    // when the order was created. Prevents a signed-in user from claiming
    // someone else's PayPal order.
    if (meta.user_id !== userId) throw new Error('Order does not belong to this user')
    if (!['standard', 'deep'].includes(meta.tier)) throw new Error('Invalid tier in order metadata')

    const amountValue = order.purchase_units?.[0]?.amount?.value || '0'
    const amountCents = Math.round(parseFloat(amountValue) * 100)
    const currency    = (order.purchase_units?.[0]?.amount?.currency_code || 'USD').toLowerCase()

    // Upsert credits — bump the right token column.
    const tokenCol = meta.tier === 'deep' ? 'deep_tokens' : 'standard_tokens'

    const { data: creds } = await supabase
      .from('receipts_credits')
      .select('deep_tokens, standard_tokens')
      .eq('user_id', userId)
      .maybeSingle()

    if (!creds) {
      await supabase
        .from('receipts_credits')
        .insert({
          user_id:         userId,
          deep_tokens:     meta.tier === 'deep'     ? 1 : 0,
          standard_tokens: meta.tier === 'standard' ? 1 : 0,
        })
    } else {
      await supabase
        .from('receipts_credits')
        .update({
          [tokenCol]: (creds[tokenCol] || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
    }

    // Log the purchase for idempotency. Use paypal order id as both event_id
    // (PK) and session_id (NOT NULL, no real Stripe-session equivalent).
    const { error: purchaseErr } = await supabase
      .from('receipts_purchases')
      .insert({
        event_id:     purchaseKey,
        session_id:   purchaseKey,
        user_id:      userId,
        tier:         meta.tier,
        amount_cents: amountCents,
        currency,
      })
    if (purchaseErr && purchaseErr.code !== '23505') throw purchaseErr  // 23505 = duplicate PK = idempotent

    const { data: finalCreds } = await supabase
      .from('receipts_credits')
      .select('deep_tokens, standard_tokens')
      .eq('user_id', userId)
      .maybeSingle()

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        tier: meta.tier,
        standard_tokens: finalCreds?.standard_tokens ?? 0,
        deep_tokens:     finalCreds?.deep_tokens ?? 0,
      }),
    }
  } catch (err) {
    console.error('capture-paypal-checkout error:', err)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
