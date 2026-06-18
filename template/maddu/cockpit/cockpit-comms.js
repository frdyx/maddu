// cockpit-comms.js — the comms-plugin settings panels (extracted from
// cockpit.js, v1.36.0): Telegram (slice ζ), Discord + Email (slice η).
//
// Each renders a settings panel into a mount node by reading
// /bridge/<provider>/status and wiring token / allowlist / enable / test-send
// controls. They depend only on `el`, `placeholder`, `showToast` (from the
// shared leaf cockpit-util.js) + browser globals (fetch / document), so they
// lift cleanly out of the SPA monolith with no back-reference to cockpit
// state. cockpit.js imports the three render functions and calls them from
// the comms settings view.

import { el, placeholder, showToast } from './cockpit-util.js';

// ─── Slice ζ — Telegram settings panel ──────────────────────────────────
export async function renderTelegramPanel(mount) {
  mount.innerHTML = '';
  let st;
  try {
    const r = await fetch('/bridge/telegram/status', { cache: 'no-store' });
    st = await r.json();
  } catch (e) {
    mount.appendChild(placeholder('Error', String(e)));
    return;
  }

  const warning = el('div', { class: 'tg-warning' }, [
    el('strong', {}, 'Trust note · '),
    document.createTextNode(
      'Telegram routes message bodies through their servers. Hard rules protect tokens and feature state, not message content. ' +
      'Only enable this if you accept that trade. Token is stored device-bound in the OS auth dir and is never returned over HTTP.'
    )
  ]);
  mount.appendChild(warning);

  const statusGrid = el('div', { class: 'tg-status' }, [
    el('div', {}, [el('span', { class: 'panel-aside' }, 'enabled '), el('span', { class: 'pill tone-' + (st.enabled ? 'ok' : 'warn') }, st.enabled ? 'YES' : 'no')]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'token '), el('span', { class: 'mono' }, st.tokenConfigured ? `set · ****${st.tokenTail}` : '(none)')]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'allowlist '), el('span', { class: 'mono' }, st.allowedChatIds.length ? st.allowedChatIds.join(', ') : '(empty)')]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'inbound '), el('span', { class: 'mono' }, String(st.counts.inbound))]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'dropped '), el('span', { class: 'mono' }, String(st.counts.dropped))]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'outbound '), el('span', { class: 'mono' }, `${st.counts.outboundSent} sent · ${st.counts.outboundFailed} failed`)]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'last poll '), el('span', { class: 'mono' }, st.lastPolledAt || '(never)')]),
    st.lastError ? el('div', { class: 'tg-err' }, [el('span', { class: 'panel-aside' }, 'last error '), el('span', { class: 'mono' }, st.lastError)]) : null
  ]);
  mount.appendChild(statusGrid);

  // Token entry
  const tokRow = el('div', { class: 'tg-row' });
  const tokIn = el('input', { type: 'password', class: 'm-input', placeholder: '<digits>:<secret> from @BotFather', autocomplete: 'off' });
  tokIn.style.flex = '1';
  const tokBtn = el('button', { class: 'm-btn' }, 'Save token');
  tokBtn.addEventListener('click', async () => {
    if (!tokIn.value.trim()) return;
    tokBtn.disabled = true;
    try {
      const r = await fetch('/bridge/telegram/token', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: tokIn.value.trim() })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      showToast(`Token stored · ****${j.masked.tail}`, 'ok');
      tokIn.value = '';
      await renderTelegramPanel(mount);
    } catch (e) {
      showToast(`Save failed: ${e.message}`, 'err');
    } finally { tokBtn.disabled = false; }
  });
  tokRow.appendChild(el('span', { class: 'panel-aside' }, 'Bot token'));
  tokRow.appendChild(tokIn);
  tokRow.appendChild(tokBtn);
  mount.appendChild(tokRow);

  // Allowlist
  const alRow = el('div', { class: 'tg-row' });
  const alIn = el('input', { class: 'm-input', placeholder: 'comma-separated chat_ids (numeric)', value: st.allowedChatIds.join(', ') });
  alIn.style.flex = '1';
  const alBtn = el('button', { class: 'm-btn' }, 'Save allowlist');
  alBtn.addEventListener('click', async () => {
    const ids = alIn.value.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
    alBtn.disabled = true;
    try {
      const r = await fetch('/bridge/telegram/allowlist', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatIds: ids })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      showToast(`Allowlist saved (${j.allowedChatIds.length} chat_ids)`, 'ok');
      await renderTelegramPanel(mount);
    } catch (e) {
      showToast(`Save failed: ${e.message}`, 'err');
    } finally { alBtn.disabled = false; }
  });
  alRow.appendChild(el('span', { class: 'panel-aside' }, 'Allowed chats'));
  alRow.appendChild(alIn);
  alRow.appendChild(alBtn);
  mount.appendChild(alRow);

  // Enable / Disable
  const actRow = el('div', { class: 'tg-row' });
  const enBtn = el("button", { class: "m-btn " + (st.enabled ? "is-danger" : "is-primary") }, st.enabled ? "Disable" : "Enable");
  enBtn.addEventListener('click', async () => {
    enBtn.disabled = true;
    try {
      const r = await fetch(`/bridge/telegram/${st.enabled ? 'disable' : 'enable'}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      showToast(`Telegram ${st.enabled ? 'disabled' : 'enabled'}`, 'ok');
      await renderTelegramPanel(mount);
    } catch (e) {
      showToast(`Toggle failed: ${e.message}`, 'err');
    } finally { enBtn.disabled = false; }
  });
  actRow.appendChild(enBtn);

  // Test send (requires enabled + at least one allowlisted chat)
  if (st.enabled && st.allowedChatIds.length) {
    const sendChat = el('select', { class: 'm-select' });
    for (const cid of st.allowedChatIds) sendChat.appendChild(el('option', { value: String(cid) }, String(cid)));
    const sendIn = el('input', { class: 'm-input', placeholder: 'Test message…' });
    sendIn.style.flex = '1';
    const sendBtn = el('button', { class: 'm-btn' }, 'Send test');
    sendBtn.addEventListener('click', async () => {
      if (!sendIn.value.trim()) return;
      sendBtn.disabled = true;
      try {
        const r = await fetch('/bridge/telegram/send', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId: Number(sendChat.value), text: sendIn.value.trim() })
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        showToast(`Queued · ${j.queued.length} chars`, 'ok');
        sendIn.value = '';
      } catch (e) {
        showToast(`Send failed: ${e.message}`, 'err');
      } finally { sendBtn.disabled = false; }
    });
    actRow.appendChild(sendChat);
    actRow.appendChild(sendIn);
    actRow.appendChild(sendBtn);
  }
  mount.appendChild(actRow);
}

// ─── Slice η — Discord settings panel ───────────────────────────────────
export async function renderDiscordPanel(mount) {
  mount.innerHTML = '';
  let st;
  try { st = await (await fetch('/bridge/discord/status', { cache: 'no-store' })).json(); }
  catch (e) { mount.appendChild(placeholder('Error', String(e))); return; }

  mount.appendChild(el('div', { class: 'tg-warning' }, [
    el('strong', {}, 'Trust note · '),
    document.createTextNode(
      'Outbound-only. The Discord gateway is NOT opened — nothing inbound. Token is stored device-bound in the OS auth dir; ' +
      'message content routes through Discord. Bot must be invited to a server you control and have permission to post in each channel.'
    )
  ]));

  const grid = el('div', { class: 'tg-status' }, [
    el('div', {}, [el('span', { class: 'panel-aside' }, 'enabled '), el('span', { class: 'pill tone-' + (st.enabled ? 'ok' : 'warn') }, st.enabled ? 'YES' : 'no')]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'token '), el('span', { class: 'mono' }, st.tokenConfigured ? `set · ****${st.tokenTail}` : '(none)')]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'channels '), el('span', { class: 'mono' }, st.allowedChannelIds.length ? st.allowedChannelIds.join(', ') : '(empty)')]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'sent '), el('span', { class: 'mono' }, String(st.counts.outboundSent))]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'failed '), el('span', { class: 'mono' }, String(st.counts.outboundFailed))]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'last send '), el('span', { class: 'mono' }, st.lastSentAt || '(never)')])
  ]);
  mount.appendChild(grid);

  // Token
  const tokRow = el('div', { class: 'tg-row' });
  const tokIn = el('input', { type: 'password', class: 'm-input', placeholder: 'bot token from Discord developer portal', autocomplete: 'off' });
  tokIn.style.flex = '1';
  const tokBtn = el('button', { class: 'm-btn' }, 'Save token');
  tokBtn.addEventListener('click', async () => {
    if (!tokIn.value.trim()) return;
    tokBtn.disabled = true;
    try {
      const r = await fetch('/bridge/discord/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: tokIn.value.trim() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      showToast(`Token stored · ****${j.masked.tail}`, 'ok');
      tokIn.value = ''; await renderDiscordPanel(mount);
    } catch (e) { showToast(`Save failed: ${e.message}`, 'err'); }
    finally { tokBtn.disabled = false; }
  });
  tokRow.appendChild(el('span', { class: 'panel-aside' }, 'Bot token'));
  tokRow.appendChild(tokIn); tokRow.appendChild(tokBtn);
  mount.appendChild(tokRow);

  // Allowlist
  const alRow = el('div', { class: 'tg-row' });
  const alIn = el('input', { class: 'm-input', placeholder: 'comma-separated channel_ids (17-20 digits each)', value: st.allowedChannelIds.join(', ') });
  alIn.style.flex = '1';
  const alBtn = el('button', { class: 'm-btn' }, 'Save channels');
  alBtn.addEventListener('click', async () => {
    const ids = alIn.value.split(',').map((x) => x.trim()).filter(Boolean);
    alBtn.disabled = true;
    try {
      const r = await fetch('/bridge/discord/allowlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelIds: ids }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      showToast(`Allowlist saved (${j.allowedChannelIds.length})`, 'ok');
      await renderDiscordPanel(mount);
    } catch (e) { showToast(`Save failed: ${e.message}`, 'err'); }
    finally { alBtn.disabled = false; }
  });
  alRow.appendChild(el('span', { class: 'panel-aside' }, 'Allowed chans'));
  alRow.appendChild(alIn); alRow.appendChild(alBtn);
  mount.appendChild(alRow);

  // Enable/Disable + test send
  const actRow = el('div', { class: 'tg-row' });
  const enBtn = el("button", { class: "m-btn " + (st.enabled ? "is-danger" : "is-primary") }, st.enabled ? "Disable" : "Enable");
  enBtn.addEventListener('click', async () => {
    enBtn.disabled = true;
    try {
      const r = await fetch(`/bridge/discord/${st.enabled ? 'disable' : 'enable'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      showToast(`Discord ${st.enabled ? 'disabled' : 'enabled'}`, 'ok');
      await renderDiscordPanel(mount);
    } catch (e) { showToast(`Toggle failed: ${e.message}`, 'err'); }
    finally { enBtn.disabled = false; }
  });
  actRow.appendChild(enBtn);
  if (st.enabled && st.allowedChannelIds.length) {
    const sel = el('select', { class: 'm-select' });
    for (const cid of st.allowedChannelIds) sel.appendChild(el('option', { value: cid }, cid));
    const txt = el('input', { class: 'm-input', placeholder: 'Test message…' });
    txt.style.flex = '1';
    const send = el('button', { class: 'm-btn' }, 'Send test');
    send.addEventListener('click', async () => {
      if (!txt.value.trim()) return;
      send.disabled = true;
      try {
        const r = await fetch('/bridge/discord/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId: sel.value, text: txt.value.trim() }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        showToast(`Queued · ${j.queued.length} chars`, 'ok');
        txt.value = '';
      } catch (e) { showToast(`Send failed: ${e.message}`, 'err'); }
      finally { send.disabled = false; }
    });
    actRow.appendChild(sel); actRow.appendChild(txt); actRow.appendChild(send);
  }
  mount.appendChild(actRow);
}

// ─── Slice η — Email settings panel ─────────────────────────────────────
export async function renderEmailPanel(mount) {
  mount.innerHTML = '';
  let st;
  try { st = await (await fetch('/bridge/email/status', { cache: 'no-store' })).json(); }
  catch (e) { mount.appendChild(placeholder('Error', String(e))); return; }

  mount.appendChild(el('div', { class: 'tg-warning' }, [
    el('strong', {}, 'Trust note · '),
    document.createTextNode(
      'Outbound-only SMTP. No IMAP — nothing is read. TLS is required (port 465 implicit, port 587 STARTTLS — plain SMTP is refused). ' +
      'Password is stored device-bound in the OS auth dir and never returned over HTTP. Recipients must be allowlisted to prevent the bridge from being used as an open relay.'
    )
  ]));

  const grid = el('div', { class: 'tg-status' }, [
    el('div', {}, [el('span', { class: 'panel-aside' }, 'enabled '), el('span', { class: 'pill tone-' + (st.enabled ? 'ok' : 'warn') }, st.enabled ? 'YES' : 'no')]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'host '), el('span', { class: 'mono' }, st.config.host || '(none)')]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'port '), el('span', { class: 'mono' }, String(st.config.port || '(none)'))]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'user '), el('span', { class: 'mono' }, st.config.user || '(none)')]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'from '), el('span', { class: 'mono' }, st.config.from || '(none)')]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'password '), el('span', { class: 'mono' }, st.passwordConfigured ? `set · ****${st.passwordTail}` : '(none)')]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'recipients '), el('span', { class: 'mono' }, st.allowedRecipients.length ? st.allowedRecipients.join(', ') : '(empty)')]),
    el('div', {}, [el('span', { class: 'panel-aside' }, 'sent '), el('span', { class: 'mono' }, `${st.counts.sent} · ${st.counts.failed} failed`)])
  ]);
  mount.appendChild(grid);

  // Config row
  const cfgRow = el('div', { class: 'tg-row' });
  const hostIn = el('input', { class: 'm-input', placeholder: 'smtp.example.com', value: st.config.host || '' });
  const portIn = el('input', { class: 'm-input', placeholder: '465 or 587', value: String(st.config.port || ''), style: 'width:80px;' });
  const userIn = el('input', { class: 'm-input', placeholder: 'login user', value: st.config.user || '' });
  const fromIn = el('input', { class: 'm-input', placeholder: 'from@example.com', value: st.config.from || '' });
  hostIn.style.flex = '1.4'; userIn.style.flex = '1'; fromIn.style.flex = '1.2';
  const cfgBtn = el('button', { class: 'm-btn' }, 'Save config');
  cfgBtn.addEventListener('click', async () => {
    cfgBtn.disabled = true;
    try {
      const r = await fetch('/bridge/email/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: hostIn.value.trim(), port: Number(portIn.value), user: userIn.value.trim(), from: fromIn.value.trim() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      showToast('SMTP config saved', 'ok');
      await renderEmailPanel(mount);
    } catch (e) { showToast(`Save failed: ${e.message}`, 'err'); }
    finally { cfgBtn.disabled = false; }
  });
  cfgRow.appendChild(el('span', { class: 'panel-aside' }, 'SMTP'));
  cfgRow.appendChild(hostIn); cfgRow.appendChild(portIn); cfgRow.appendChild(userIn); cfgRow.appendChild(fromIn); cfgRow.appendChild(cfgBtn);
  mount.appendChild(cfgRow);

  // Password
  const pwRow = el('div', { class: 'tg-row' });
  const pwIn = el('input', { type: 'password', class: 'm-input', placeholder: 'SMTP password / app password', autocomplete: 'off' });
  pwIn.style.flex = '1';
  const pwBtn = el('button', { class: 'm-btn' }, 'Save password');
  pwBtn.addEventListener('click', async () => {
    if (!pwIn.value) return;
    pwBtn.disabled = true;
    try {
      const r = await fetch('/bridge/email/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: pwIn.value }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      showToast(`Password stored · ****${j.masked.tail}`, 'ok');
      pwIn.value = ''; await renderEmailPanel(mount);
    } catch (e) { showToast(`Save failed: ${e.message}`, 'err'); }
    finally { pwBtn.disabled = false; }
  });
  pwRow.appendChild(el('span', { class: 'panel-aside' }, 'Password'));
  pwRow.appendChild(pwIn); pwRow.appendChild(pwBtn);
  mount.appendChild(pwRow);

  // Allowlist
  const alRow = el('div', { class: 'tg-row' });
  const alIn = el('input', { class: 'm-input', placeholder: 'comma-separated email addresses', value: st.allowedRecipients.join(', ') });
  alIn.style.flex = '1';
  const alBtn = el('button', { class: 'm-btn' }, 'Save recipients');
  alBtn.addEventListener('click', async () => {
    const r0 = alIn.value.split(',').map((x) => x.trim()).filter(Boolean);
    alBtn.disabled = true;
    try {
      const r = await fetch('/bridge/email/allowlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipients: r0 }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      showToast(`Allowlist saved (${j.allowedRecipients.length})`, 'ok');
      await renderEmailPanel(mount);
    } catch (e) { showToast(`Save failed: ${e.message}`, 'err'); }
    finally { alBtn.disabled = false; }
  });
  alRow.appendChild(el('span', { class: 'panel-aside' }, 'Recipients'));
  alRow.appendChild(alIn); alRow.appendChild(alBtn);
  mount.appendChild(alRow);

  // Enable + test send
  const actRow = el('div', { class: 'tg-row' });
  const enBtn = el("button", { class: "m-btn " + (st.enabled ? "is-danger" : "is-primary") }, st.enabled ? "Disable" : "Enable");
  enBtn.addEventListener('click', async () => {
    enBtn.disabled = true;
    try {
      const r = await fetch(`/bridge/email/${st.enabled ? 'disable' : 'enable'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      showToast(`Email ${st.enabled ? 'disabled' : 'enabled'}`, 'ok');
      await renderEmailPanel(mount);
    } catch (e) { showToast(`Toggle failed: ${e.message}`, 'err'); }
    finally { enBtn.disabled = false; }
  });
  actRow.appendChild(enBtn);
  if (st.enabled && st.allowedRecipients.length) {
    const sel = el('select', { class: 'm-select' });
    for (const r of st.allowedRecipients) sel.appendChild(el('option', { value: r }, r));
    const subj = el('input', { class: 'm-input', placeholder: 'Subject', style: 'width:160px;' });
    const txt = el('input', { class: 'm-input', placeholder: 'Test body…' });
    txt.style.flex = '1';
    const send = el('button', { class: 'm-btn' }, 'Send test');
    send.addEventListener('click', async () => {
      if (!txt.value.trim() || !subj.value.trim()) return;
      send.disabled = true;
      try {
        const r = await fetch('/bridge/email/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: sel.value, subject: subj.value.trim(), text: txt.value.trim() }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        showToast('Queued for send', 'ok');
        txt.value = ''; subj.value = '';
      } catch (e) { showToast(`Send failed: ${e.message}`, 'err'); }
      finally { send.disabled = false; }
    });
    actRow.appendChild(sel); actRow.appendChild(subj); actRow.appendChild(txt); actRow.appendChild(send);
  }
  mount.appendChild(actRow);
}
