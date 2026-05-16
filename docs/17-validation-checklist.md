# Validation checklist (pre-v1.0.0)

A short, copy-pasteable walkthrough for confirming the cockpit, integrations,
and motion signature all work end-to-end. Run this once with real credentials
before tagging `v1.0.0`. Most checks take under a minute each.

Where the cockpit is referenced, assume `http://127.0.0.1:4177/`.

---

## 1 · Cockpit shell

- [ ] **Boot.** Open `http://127.0.0.1:4177/`. Confirm the rail shows five groups (Decide, Operate, Verify, Connect, Reference), and the default landing route is Conductor.
- [ ] **Group collapse.** Click a group heading — its routes hide. Reload. State persisted.
- [ ] **Tablet pose.** Resize to ~1100 px wide. Rail collapses to glyphs only. Hover a glyph — flyout label appears.
- [ ] **Mobile pose.** Resize to ~380 px wide. Rail disappears. Bottom dock shows five group anchors. Tap one — bottom sheet opens with that group's routes.
- [ ] **Inspector.** From Conductor, click a slice-stop row. Inspector slides in. At ≥1440 px it sits beside the stage; at 1024–1439 it overlays with a scrim; below 1024 it's a bottom sheet.

---

## 2 · Command palette (⌘K / Ctrl+K)

- [ ] `Ctrl+K` opens the palette. `Esc` closes it.
- [ ] Type `tele` → top result reads **Telegram · in SETTINGS**. Enter → lands on Settings → Telegram panel with a brief lime ring.
- [ ] Type `kpi` → Roadmap → KPIs.
- [ ] Type `anthropic` (if a provider exists) → Auth → that provider.
- [ ] Type `wiki` → **Rebuild wiki from spine · action**. Enter → toast "Wiki rebuilt · N page(s)".
- [ ] Type `memory` → **Re-extract hindsight memory · action**. Enter → toast "+N fact(s)".

---

## 3 · Signature motion (slice-stop lime line)

- [ ] Open the cockpit on Conductor (or any route).
- [ ] In a terminal, register a session and post a slice-stop:
  ```bash
  curl -s -X POST http://127.0.0.1:4177/bridge/sessions/register \
    -H "content-type: application/json" \
    -d '{"role":"implementer","label":"validation"}'
  # take the sessionId from the response, then:
  curl -s -X POST http://127.0.0.1:4177/bridge/slice-stop \
    -H "content-type: application/json" \
    -d '{"sessionId":"<ID>","summary":"validation test","learnings":["motion works"]}'
  ```
- [ ] A 2 px lime line should trace left → right across the top of the viewport in ~900 ms. **If it does not fire, the stream loop didn't pick up the event** — check `/events` to confirm the SLICE_STOP appears, and `/bridge/events/wait?after=<id>` in a tab to confirm the long-poll delivers it.

---

## 4 · Telegram integration (optional, real token)

If you don't intend to use Telegram, skip this section.

- [ ] Create a bot with `@BotFather`. Save the token (`<digits>:<35+ chars>`).
- [ ] Message `@userinfobot` from your own account to get your numeric `chat_id`.
- [ ] In the cockpit, `Ctrl+K` → `tele` → land on the Telegram panel.
- [ ] Paste the token → **Save token**. Status flips to `set · ****<tail>`.
- [ ] Enter your `chat_id` in the allowlist → **Save allowlist**.
- [ ] Click **Enable**. Status flips to `enabled: YES`.
- [ ] Type a message in the test sender → **Send test**. Confirm it arrives on Telegram.
- [ ] On Telegram, reply with any text. Within ~25 s, `/bridge/telegram/chats` should show your message. Confirm `inbound` counter incremented in the status grid.
- [ ] From a different chat (not in allowlist), message the bot. Confirm `dropped` counter incremented but **no content is logged** in `.maddu/events/`.

---

## 5 · Discord integration (optional)

- [ ] Create a bot at https://discord.com/developers/applications and invite it to a server you own.
- [ ] Copy the bot token. Save in Discord panel.
- [ ] Copy a channel id (Developer Mode → right-click channel → Copy ID). Save in allowlist.
- [ ] Enable. Send test message. Confirm it appears in the channel.
- [ ] Try sending to a channel-id NOT in the allowlist — bridge refuses with "not in allowedChannelIds".

---

## 6 · Email integration (optional)

- [ ] Pick a provider with SMTP + app passwords (Gmail, Fastmail, Outlook).
- [ ] Save SMTP host, port (465 or 587), user, from address.
- [ ] Save SMTP password.
- [ ] Save recipient allowlist (your own email).
- [ ] Try to set port 25 → bridge refuses "plain SMTP refused".
- [ ] Enable. Send test mail. Confirm it arrives.
- [ ] Try sending to a non-allowlisted address → bridge refuses.

---

## 7 · Hard-rule spot-checks

- [ ] `~/.config/maddu/auth/` (or `%APPDATA%\maddu\auth\`) contains `telegram.json`, `discord.json`, `email-smtp.json` — but **only the bridge writes there**. Confirm the cockpit never returns raw token values: `curl /bridge/telegram/status` shows tail only, no full token.
- [ ] No SQLite files anywhere under `.maddu/`. Only NDJSON + JSON.
- [ ] `package.json` lists zero runtime dependencies (devDependencies acceptable).
- [ ] `maddu/runtime/` imports nothing from `anthropic`, `openai`, `discord.js`, `nodemailer`, or similar SDKs.

---

## 8 · Sign-off

When every box above is checked, the framework is ready to tag `v1.0.0`:

```bash
git tag -a v1.0.0 -m "v1.0.0 — depth + integrations + cockpit polish + sub-target system, validated"
```

If anything failed, file the failure in `.maddu/inbox/current.ndjson` via:

```bash
node maddu/runtime/server.js  # if not running
curl -s -X POST http://127.0.0.1:4177/bridge/inbox \
  -H "content-type: application/json" \
  -d '{"message":"validation: <what failed>","kind":"validation"}'
```
