// Parses WhatsApp text exports (iOS + Android) into a normalized message list.
//
// iOS format:    [4/12/26, 8:09:23 PM] John Paul: hello
// Android fmt:   4/12/26, 8:09 PM - John Paul: hello
//                4/12/2026, 20:09 - John Paul: hello
//
// We don't care about media attachments (we just drop them).

const ATTACHMENT_HINTS = [
  '<Media omitted>', 'image omitted', 'video omitted',
  'audio omitted', 'sticker omitted', 'GIF omitted',
  'document omitted', 'Contact card omitted',
]

function isAttachment(line) {
  return ATTACHMENT_HINTS.some(h => line.toLowerCase().includes(h.toLowerCase()))
}

// Match start-of-message lines for both iOS and Android formats.
// Capture: date, time, sender, body
const IOS_RE     = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)\]\s+([^:]+):\s?(.*)$/
const ANDROID_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)\s*-\s+([^:]+):\s?(.*)$/

function parseDate(dateStr, timeStr) {
  const [m, d, y] = dateStr.split('/').map(s => s.trim())
  const year = y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10)
  const month = parseInt(m, 10) - 1
  const day = parseInt(d, 10)

  const time = timeStr.trim().toUpperCase()
  let hour = 0, minute = 0
  const ampmMatch = time.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/)
  if (ampmMatch) {
    hour = parseInt(ampmMatch[1], 10)
    minute = parseInt(ampmMatch[2], 10)
    const ampm = ampmMatch[3]
    if (ampm === 'PM' && hour < 12) hour += 12
    if (ampm === 'AM' && hour === 12) hour = 0
  }
  return new Date(year, month, day, hour, minute)
}

export function parseWhatsApp(text) {
  const lines = text.split(/\r?\n/)
  const messages = []
  let current = null

  for (const raw of lines) {
    const line = raw.replace(/^\u200E/, '')   // strip LRM
    let match = line.match(IOS_RE) || line.match(ANDROID_RE)

    if (match) {
      if (current) messages.push(current)
      const [, dateStr, timeStr, sender, body] = match
      if (isAttachment(body)) {
        current = null
        continue
      }
      current = {
        date: parseDate(dateStr, timeStr),
        sender: sender.trim(),
        body: (body || '').trim(),
      }
    } else if (current) {
      // continuation of previous message
      current.body += '\n' + line.trim()
    }
    // lines that match nothing and have no current message are dropped
    // (e.g. WhatsApp's "Messages and calls are end-to-end encrypted" header)
  }

  if (current) messages.push(current)
  return messages.filter(m => m.body && m.body.length > 0)
}

// Fallback parser for messy pasted content (iMessage Mac/iPhone copy-paste,
// random chat exports without our standard format).
//
// iMessage on Mac, when you Cmd+A → Cmd+C in Messages, you get something like:
//
//   Today 9:34 PM
//   Hey what are you doing
//   ok
//   Yesterday 11:22 PM
//   hey
//
// There are no sender labels — alternating sides aren't preserved in plain text.
// So we treat each non-timestamp line as a message and ask the user (in the UI)
// to mark "I'm the one whose messages start with [marker]" or use alternating mode.
//
// Strategy: detect lines that look like timestamps/date headers (drop them), then
// emit each remaining line as a message. We assign senders in alternating fashion
// by default — UI lets the user flip if it got it backwards.

const IMESSAGE_TIME_RE = /^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}\/\d{1,2}\/\d{2,4})/i
const PURE_TIME_RE     = /^\s*\d{1,2}:\d{2}\s*(?:am|pm)?\s*$/i
const SHORT_HEADER_RE  = /^\s*(?:read|delivered|sent)\s*$/i

function isImessageMetaLine(line) {
  const t = line.trim()
  if (!t) return true
  if (PURE_TIME_RE.test(t)) return true
  if (SHORT_HEADER_RE.test(t)) return true
  if (IMESSAGE_TIME_RE.test(t) && t.length < 40) return true
  return false
}

export function parseRaw(text) {
  // Try WhatsApp format first — if it returns anything, use that
  const wa = parseWhatsApp(text)
  if (wa.length > 0) return { kind: 'whatsapp', messages: wa }

  // Otherwise fall back to alternating-line iMessage paste
  const lines = text.split(/\r?\n/)
  const messages = []
  let alt = 0   // 0 = sender1, 1 = sender2
  const baseDate = new Date()
  let idx = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (isImessageMetaLine(line)) continue
    // Treat each non-meta line as a message
    messages.push({
      date: new Date(baseDate.getTime() + idx * 1000),
      sender: alt === 0 ? 'Sender 1' : 'Sender 2',
      body: line,
    })
    alt = 1 - alt
    idx += 1
  }
  return { kind: 'paste', messages }
}

// Flip the alternating-sender assumption (used when user says "actually I'm the
// other side" in the picker step).
export function flipAlternating(messages) {
  return messages.map(m => ({
    ...m,
    sender: m.sender === 'Sender 1' ? 'Sender 2' : 'Sender 1',
  }))
}

// Once we have messages, identify the two participants. Returns { me, them }
// based on which sender appears most often + their relative message lengths.
// In v1 we ask the user to confirm which one is them.
export function detectParticipants(messages) {
  const counts = {}
  for (const m of messages) counts[m.sender] = (counts[m.sender] || 0) + 1
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([s]) => s)
  return sorted   // [most common, second most common, ...]
}

export function summarize(messages) {
  if (messages.length === 0) return null
  const first = messages[0].date
  const last = messages[messages.length - 1].date
  const days = Math.max(1, Math.round((last - first) / (1000 * 60 * 60 * 24)))
  const senders = detectParticipants(messages)
  const counts = {}
  const lengths = {}
  for (const m of messages) {
    counts[m.sender] = (counts[m.sender] || 0) + 1
    lengths[m.sender] = (lengths[m.sender] || 0) + m.body.length
  }
  return {
    total: messages.length,
    senders,
    counts,
    avgLengths: Object.fromEntries(
      Object.entries(lengths).map(([s, n]) => [s, Math.round(n / counts[s])])
    ),
    days,
    firstDate: first,
    lastDate: last,
  }
}
