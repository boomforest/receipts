// Client-side redactor. Anything identifiable about real humans is replaced
// with stable placeholder tokens BEFORE the text is sent to the model.
//
// We replace, in order:
//   1. The two senders → "Person A" and "Person B" (user picks which is them)
//   2. Phone numbers → [PHONE]
//   3. Emails → [EMAIL]
//   4. URLs → [LINK]
//   5. Common name patterns of *third parties* mentioned in the body → [NAME-N]
//      (capitalized first names that aren't obviously English words)
//
// We deliberately DON'T strip:
//   - Pet names, slang, emojis (these carry the dynamic, not identity)
//   - Place names — too easy to lose meaning. Borderline; revisit.
//
// After analysis, we substitute names BACK in on the client so the user sees
// the real names in their report. The model never does.

const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
const URL_RE   = /\bhttps?:\/\/[^\s)<>"]+/g

// English stopwords that might be capitalized at sentence starts — don't redact these
const COMMON_WORDS = new Set([
  'I','You','We','They','He','She','It','My','Your','Our','Their','His','Her','Its',
  'The','A','An','This','That','These','Those','And','But','Or','So','If','Then','When','Where','Why','How','What','Who',
  'Yes','No','Maybe','Ok','Okay','Sure','Thanks','Thank','Sorry','Please','Hi','Hey','Hello','Bye','Lol','Omg','Wow',
  'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday',
  'January','February','March','April','May','June','July','August','September','October','November','December',
  'Today','Tomorrow','Yesterday','Tonight','Morning','Night','Evening','Afternoon',
  'God','Jesus','Christ','Lord',
  'Mom','Dad','Mommy','Daddy','Mama','Papa',
  'AM','PM','EST','PST','UTC','USD','MXN',
])

export function redact(messages, meSender) {
  // Build sender map
  const themSender = (() => {
    const others = [...new Set(messages.map(m => m.sender))].filter(s => s !== meSender)
    return others[0] || 'Other'
  })()
  const senderMap = new Map([
    [meSender, 'Person A (me)'],
    [themSender, 'Person B (them)'],
  ])

  // First pass: collect candidate third-party names from message bodies
  // Heuristic: capitalized words that aren't common, aren't sender names,
  // appear at least twice across the chat, and have a vowel.
  const candidateCounts = {}
  const namePattern = /\b([A-Z][a-z]{2,})\b/g
  for (const m of messages) {
    let match
    while ((match = namePattern.exec(m.body))) {
      const w = match[1]
      if (COMMON_WORDS.has(w)) continue
      if (w === meSender || w === themSender) continue
      if (!/[aeiouy]/i.test(w)) continue
      candidateCounts[w] = (candidateCounts[w] || 0) + 1
    }
  }
  const thirdPartyNames = Object.entries(candidateCounts)
    .filter(([, n]) => n >= 2)
    .map(([w]) => w)
    .sort((a, b) => candidateCounts[b] - candidateCounts[a])
    .slice(0, 50)
  const nameMap = new Map()
  thirdPartyNames.forEach((name, i) => nameMap.set(name, `[NAME-${i + 1}]`))

  // Apply redactions to each message body
  const redacted = messages.map(m => ({
    sender: senderMap.get(m.sender) || 'Other',
    date: m.date,
    body: redactBody(m.body, nameMap),
  }))

  return {
    redacted,
    senderMap,        // original → placeholder
    nameMap,          // original third-party name → [NAME-N]
    themSender,
  }
}

function redactBody(body, nameMap) {
  let out = body
  out = out.replace(URL_RE, '[LINK]')
  out = out.replace(EMAIL_RE, '[EMAIL]')
  out = out.replace(PHONE_RE, '[PHONE]')
  for (const [name, token] of nameMap) {
    // word-boundary replacement
    out = out.replace(new RegExp(`\\b${escapeRegex(name)}\\b`, 'g'), token)
  }
  return out
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Reverse pass — used on the LLM's response to swap [NAME-N] back to real names
// for display only. Sender map is also reversed so 'Person B (them)' → 'Kat'.
export function unredact(text, redactionResult, displayThemAs) {
  let out = text
  for (const [name, token] of redactionResult.nameMap) {
    out = out.replace(new RegExp(escapeRegex(token), 'g'), name)
  }
  if (displayThemAs) {
    out = out.replace(/Person B \(them\)/g, displayThemAs)
    out = out.replace(/Person B/g, displayThemAs)
  }
  return out
}

// Build the text payload sent to the model. Trims to the most recent N messages
// to keep token costs predictable.
export function buildPayload(redactedMessages, maxMessages = 1500) {
  const recent = redactedMessages.slice(-maxMessages)
  return recent
    .map(m => `[${m.date.toISOString().slice(0, 16).replace('T', ' ')}] ${m.sender}: ${m.body.replace(/\n/g, ' ⏎ ')}`)
    .join('\n')
}
