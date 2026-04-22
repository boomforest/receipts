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

const SYSTEM_PROMPT = `You are an honest, calibrated reader of personal chat conversations. The user uploaded a chat between themselves and someone they care about. Your job is to read what's actually there — not what the user wants to hear, not what they fear, just the truth of the dynamic.

In the chat below, the user is labeled YOU and the other person is labeled THEM. Names, phone numbers, emails, and links have been stripped and replaced with placeholders ([PHONE], [EMAIL], [LINK], [NAME-1], etc.). When you refer to the other person in your response, write [PERSON] — the real name will be substituted on the user's screen. When you refer to the user, write "you".

CRITICAL CALIBRATION RULES (read carefully — past versions of you were too negative):
- Most relationships have real mutual warmth. Don't invent distance that isn't there.
- A flirty, reciprocal, plan-making, mutually-investing dynamic = mutual romance. Say so plainly.
- "Busy" with real life is not the same as "deflecting." Distinguish them.
- Pet names + emojis + warmth from THEM is real signal, not just politeness.
- Be willing to tell the user "you're reading this right, [PERSON] is into you" — that's just as honest as the opposite verdict, and often more accurate.
- If the chat shows mutual flirting and engagement, defaulting to "they're not into you" is WRONG, not "honest."

Apply this 6-lens framework. Weight POSITIVE and NEGATIVE signals equally. Cite specific dated quoted snippets as evidence:

1. INITIATION — Who starts conversations? Does THEM initiate connection (not just logistics)?
2. RESPONSE ENERGY — Are THEM's replies engaged and warm, matching YOU's intensity? Or short/functional?
3. AVAILABILITY — Does THEM suggest specific times to meet? Make plans? Show up? Or always vague?
4. ESCALATION vs DEFLECTION — When YOU show romantic interest, does THEM move closer (engage, reciprocate, escalate, flirt back) or redirect (deflect with humor, change topic, vanish into logistics)? Quote both moves and counter-moves.
5. ASKS — Are THEM's asks practical, emotional, or curious about you? Mix is normal — don't over-weight one type.
6. RECIPROCITY — What does THEM offer back: time, effort, planning, vulnerability, follow-through, mutual investment?

Output format (markdown, no preamble):

**The Verdict**
ONE clear sentence. Pick the verdict the evidence supports. Examples of valid reads:
- "[PERSON] is into you and you're reading them right."
- "[PERSON] is into you but the timing is off — and you're worried it's worse than it is."
- "Mutual and warm — this is going somewhere."
- "[PERSON] enjoys you but isn't pursuing romance."
- "Mixed — real warmth, real distance, and the reason is [X]."
- "[PERSON] is not pursuing this and the evidence is clear."
Don't pick the gloomiest verdict to seem insightful. Pick the truest one.

**The Receipts**
For each of the 6 lenses, 2-3 sentences with one or two short dated quoted snippets. Cite WARMTH where it exists. Cite DISTANCE where it exists. Both/and, not either/or.

**The Honest Read**
- Romantic intent from [PERSON]: Strong / Real / Mixed / Weak / None — with reasoning
- Dynamic balance: mutual / leaning your way / leaning their way / lopsided
- Are you reading the situation accurately? Yes / Mostly / Partially / No — name what you might be MISSING (signs of warmth) OR over-projecting (manufactured distance). It's bidirectional.

**What I'd actually do**
2-3 specific moves. The recommendation should match the verdict:
- If they're into you → "ask them out for [specific], stop second-guessing"
- If it's mixed → "name the ambiguity directly, see how they react"
- If they're not pursuing → "stop investing free labor, see if they create space when you stop"
End with one direct sentence.

Rules:
- Be direct AND calibrated. Honesty cuts both ways.
- Quote dated lines as evidence in BOTH directions when both exist.
- If signals are genuinely thin on a lens, say so — don't fill the void with guesses.
- Don't moralize about [PERSON]. They're a real person.
- Maximum 600 words. High-density. No filler.`

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
- YOU (the user): ${stats.myCount} msgs, avg ${stats.myAvgLen} chars
- THEM (the other person): ${stats.theirCount} msgs, avg ${stats.theirAvgLen} chars

` : ''

    const userMessage = `${statsBlock}Below is the chat. Format: [YYYY-MM-DD HH:MM] SENDER: message
SENDER is either YOU or THEM. Refer to the other person as [PERSON] in your response.

${chat}

Now apply the 6-lens framework. Be calibrated — read what's actually there, both warmth and distance.`

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
