const { createClient } = require('@supabase/supabase-js')

// Creates a PayPal order for a Receipts tier purchase.
//
// Auth:    Bearer <supabase_access_token>
// Body:    { tier: 'standard' | 'deep' }
// Returns: { orderId, amount_cents, currency }
//
// Amounts mirror the Stripe flow: $3 standard, $7 deep (USD).
// Funds land in the platform's PayPal account; reconciliation is off-platform.

const PAYPAL_API_BASE = process.env.PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com'

const PRICES_USD = { standard: 3, deep: 7 }

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

    const supabase = createClient(
      process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } },
    )

    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt)
    if (userErr || !userData?.user) throw new Error('Invalid session')
    const userId = userData.user.id

    const { tier } = JSON.parse(event.body || '{}')
    if (!['standard', 'deep'].includes(tier)) throw new Error('Invalid tier')

    const price = PRICES_USD[tier]
    const value = price.toFixed(2)

    const token = await getPayPalToken()
    const orderRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: 'USD', value },
          description: `Receipts ${tier === 'deep' ? 'Deepest' : 'Standard'} Read`,
          custom_id: JSON.stringify({ user_id: userId, tier }),
        }],
        application_context: {
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          brand_name: 'Receipts',
        },
      }),
    })

    const order = await orderRes.json()
    if (!orderRes.ok) throw new Error(order.message || 'Failed to create PayPal order')

    return {
      statusCode: 200,
      body: JSON.stringify({
        orderId:      order.id,
        amount_cents: Math.round(price * 100),
        currency:     'USD',
      }),
    }
  } catch (err) {
    console.error('create-paypal-checkout error:', err)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
