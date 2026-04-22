# Receipts

> An honest read of your texts. Six lenses. No bullshit.
>
> Built on Gottman, Sue Johnson, Esther Perel, Stan Tatkin, Logan Ury,
> and attachment theory. Real psychology, not AI vibes.
>
> Live at **[receipts.mx](https://receipts.mx)**

Drag in a WhatsApp .txt export → get a sharp, evidence-cited analysis of the relationship dynamic. Names and numbers are stripped client-side before anything leaves the browser.

## Stack
- Vite + React (single page)
- Netlify Functions (one endpoint: `/analyze`)
- Anthropic Claude Sonnet 4.5 with prompt caching
- Zero server-side storage

## Local dev
```bash
npm install
npm run dev          # frontend at :5174
# in another terminal, for the function:
npx netlify dev      # full stack at :8888
```

## Required env vars (Netlify)
- `ANTHROPIC_API_KEY` — server-side only

## How a chat gets exported
On WhatsApp (iOS or Android):
1. Open the conversation
2. Tap the contact's name at the top → scroll down → **Export Chat**
3. Choose **Without Media**
4. Email/save the `.txt` file
5. Drop it on the site

## Privacy architecture
- Names of both senders → `Person A` / `Person B`
- Phone numbers → `[PHONE]`
- Emails → `[EMAIL]`
- URLs → `[LINK]`
- Repeated capitalized first names mentioned in messages → `[NAME-N]`
- All redaction happens in the user's browser (`src/redact.js`)
- The Netlify function only sees the redacted text, then calls Anthropic
- After analysis, names are substituted back **on the client** for display

## Roadmap
- [x] v0.1: WhatsApp upload, redact, read, copy
- [ ] iMessage support (Mac SQLite export → upload)
- [ ] Stripe pay-per-read ($9 standard / $19 deep / $49 Opus)
- [ ] "Watch this situationship" subscription (monthly re-runs)
- [ ] Shareable verdict cards
