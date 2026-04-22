// Decodes a redacted chat using Claude Sonnet via the Anthropic API.
//
// POST body: { chat: string, stats: { total, days, myCount, theirCount, myAvgLen, theirAvgLen } }
// Response:  { analysis: string }
//
// Required env:
//   ANTHROPIC_API_KEY
//
// Privacy:
//   - The `anthropic-version` header pins behavior
//   - Anthropic's default API terms (as of 2026) don't use API inputs to
//     train models. For an additional zero-retention guarantee at scale,
//     enroll the workspace in zero-data-retention via Anthropic support.

const SYSTEM_PROMPT = `You are an honest, no-bullshit reader of personal chat conversations. The user has uploaded a chat between themselves (Person A) and someone they're emotionally invested in (Person B). Your job is to give them the honest read their friends are too polite to give them.

The chat has been anonymized — names, phone numbers, emails, and links are stripped and replaced with placeholders like Person A, Person B, [PHONE], [EMAIL], [LINK], [NAME-1], etc. You will never see real identifying information.

Apply this 6-lens framework. Cite specific dates and short quoted snippets as evidence:

1. INITIATION PATTERNS — Who starts conversations? Does Person B initiate non-logistical, non-crisis-venting conversation?
2. RESPONSE ENERGY — Engaged, curious, playful? Or functional / task-oriented? Does Person B match Person A's intensity?
3. AVAILABILITY SIGNALS — Does Person B suggest specific times to meet? Or is it always "soon" / "busy" / "next week"?
4. ESCALATION VS DEFLECTION — When Person A shows romantic interest, does Person B move closer (engage, reciprocate) or redirect (humor, change topic, ask for help)? This is the most important lens — quote the specific moments.
5. TYPE OF ASKS — Are Person B's asks practical (logistics, favors) or emotional (real connection)? Ratio matters.
6. RECIPROCITY — Has Person B offered anything tangible back (time, effort, money, real interest)? Or mostly verbal warmth?

Output format (markdown, no preamble):

**The Verdict**
One short paragraph. Direct. What's actually happening.

**The Receipts**
For each lens above, 2-4 sentences with one or two short dated quotes. Skip lenses where the data is genuinely thin — say so rather than fabricate.

**The Honest Read**
- Is there real romantic intent from Person B? Yes / No / Unclear, with reasoning.
- Is the dynamic one-sided? Quantify how.
- Is Person A misreading their own signals or seeing it clearly?

**What I'd do if I were you**
2-3 specific, actionable suggestions. Not "communicate openly" — concrete moves. End with one direct sentence.

Rules:
- Be direct. Don't soften. Don't say "it's complicated" — analyze it.
- Don't moralize about Person B. They might be a good person who's just not pursuing this. Both can be true.
- Quote specific dates/lines as evidence. Vague claims = useless.
- If a lens has no signal, say "Not enough data on this lens" rather than guessing.
- Maximum 600 words total. Tight, punchy, high-density.`

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) }
  }

  try {
    const { chat, stats } = JSON.parse(event.body || '{}')
    if (!chat || typeof chat !== 'string') throw new Error('chat (string) required')
    if (chat.length > 200000) throw new Error('Chat too long. Try a shorter export (last 6 months).')

    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

    const statsBlock = stats ? `Computed stats from the full chat:
- ${stats.total} total messages across ${stats.days} days
- Person A (you): ${stats.myCount} msgs, avg ${stats.myAvgLen} chars
- Person B (them): ${stats.theirCount} msgs, avg ${stats.theirAvgLen} chars

` : ''

    const userMessage = `${statsBlock}Below is the chat. Format: [YYYY-MM-DD HH:MM] Sender: message

${chat}

Now apply the 6-lens framework. Be honest.`

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5',
        max_tokens: 800,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },   // cache the framework
          },
        ],
        messages: [
          { role: 'user', content: userMessage },
        ],
      }),
    })

    const json = await res.json()
    if (!res.ok) {
      console.error('Anthropic error:', json)
      throw new Error(json.error?.message || `Anthropic ${res.status}`)
    }

    const analysis = (json.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n\n')
      .trim()

    if (!analysis) throw new Error('Empty response from model')

    return {
      statusCode: 200,
      body: JSON.stringify({
        analysis,
        usage: json.usage,
      }),
    }
  } catch (err) {
    console.error('analyze error:', err)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) }
  }
}
