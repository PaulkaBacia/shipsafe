// Seller dashboard. All buyer text is inserted with textContent (never innerHTML),
// so a malicious buyer note can't inject code into the page.

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const STATUS = { NEW: 'New', ON_HOLD: 'On hold', SHIPPED: 'Shipped', REFUNDED: 'Refunded' };
const VERDICT = { SHIP: 'SAFE TO SHIP', VERIFY: 'CHECK FIRST', HOLD: 'HOLD' };
const SP = { ELIGIBLE: 'Covered', PARTIALLY_ELIGIBLE: 'Partly covered', NOT_ELIGIBLE: 'Not covered', UNKNOWN: 'Unknown' };

const open = new Set();
let orders = [];

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function stats() {
  const v = (o) => o.review?.verdict;
  document.getElementById('s-total').textContent = orders.length;
  document.getElementById('s-ship').textContent = orders.filter((o) => v(o) === 'SHIP' && o.status !== 'REFUNDED').length;
  document.getElementById('s-hold').textContent = orders.filter((o) => v(o) !== 'SHIP' && ['NEW', 'ON_HOLD'].includes(o.status)).length;
  const kept = orders.filter((o) => v(o) !== 'SHIP' && ['ON_HOLD', 'REFUNDED'].includes(o.status))
    .reduce((s, o) => s + Number(o.amount?.value || 0), 0);
  document.getElementById('s-saved').textContent = money(kept);
}

function addressLines(o) {
  const a = o.shipping?.address || {};
  return [o.shipping?.name, a.address_line_1, a.address_line_2, [a.admin_area_2, a.admin_area_1, a.postal_code].filter(Boolean).join(', '), a.country_code].filter(Boolean);
}

function orderCard(o) {
  const r = o.review || {};
  const verdict = r.verdict || 'VERIFY';
  const payer = `${o.payer?.name?.given_name || ''} ${o.payer?.name?.surname || ''}`.trim();
  const card = h('article', { class: 'card order' });

  const head = h('div', { class: 'order-head', role: 'button', tabindex: '0', 'aria-expanded': String(open.has(o.id)),
    onclick: () => { open.has(o.id) ? open.delete(o.id) : open.add(o.id); render(); },
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); } } },
    h('div', { class: `score ${verdict}`, title: 'Risk score (0 = safe, 100 = very risky)' }, String(r.riskScore ?? '–')),
    h('div', { class: 'order-main' },
      h('div', { class: 'order-title' },
        h('span', {}, `${o.id} · ${payer || 'Unknown buyer'}`),
        h('span', { class: `badge ${verdict}` }, VERDICT[verdict]),
        h('span', { class: 'status' }, STATUS[o.status] || o.status),
        o.simulated ? h('span', { class: 'status' }, 'simulated pay') : null,
        o.sample ? h('span', { class: 'status' }, 'sample') : null),
      h('div', { class: 'summary' }, r.summary || '')),
    h('div', { class: 'amount' }, money(o.amount?.value)));
  card.append(head);

  if (!open.has(o.id)) return card;

  const act = (action, label, cls = 'btn') => h('button', { class: cls, onclick: (e) => doAction(e.target, o.id, action) }, label);
  const done = o.status === 'REFUNDED';

  card.append(h('div', { class: 'details' },
    h('div', {},
      h('h4', {}, r.source === 'ai' ? `AI review (${r.model})` : 'Rule review'),
      r.reasons?.length ? h('ul', {}, r.reasons.map((x) => h('li', {}, x))) : h('div', { class: 'muted' }, 'No warning signs.'),
      r.nextStep ? h('p', {}, h('b', {}, 'Next step: '), r.nextStep) : null,
      r.note ? h('p', { class: 'muted small' }, r.note) : null,
      r.buyerMessage ? h('div', {},
        h('h4', {}, 'Message you could send the buyer'),
        h('div', { class: 'reply' }, r.buyerMessage),
        h('button', { class: 'btn', style: 'margin-top:6px', onclick: (e) => { navigator.clipboard?.writeText(r.buyerMessage); e.target.textContent = 'Copied'; } }, 'Copy message')) : null),
    h('div', {},
      h('h4', {}, `Fraud checks (rule score ${r.ruleScore ?? 0})`),
      o.signals?.length ? o.signals.map((s) => h('div', { class: 'signal', title: s.detail }, h('span', {}, s.label), h('b', {}, `+${s.weight}`)))
        : h('div', { class: 'muted' }, 'All 11 checks passed.'),
      h('h4', { style: 'margin-top:12px' }, 'Buyer note (untrusted)'),
      h('div', { class: 'untrusted' }, o.context?.buyerNote || '(none)'),
      h('h4', { style: 'margin-top:12px' }, 'PayPal details'),
      h('div', { class: 'small' },
        `PayPal account: ${payer} · ${o.payer?.email_address || ''} · ${o.payer?.country_code || ''}`, h('br'),
        `Seller Protection: ${SP[o.sellerProtection] || o.sellerProtection}`, h('br'),
        `Shipping: ${o.context?.shippingSpeed || 'standard'}`, h('br'),
        `Ship to: ${addressLines(o).join(' · ')}`, h('br'),
        `Items: ${(o.items || []).map((i) => `${i.quantity} × ${i.name}`).join(', ')}`)),
    h('div', { class: 'actions' },
      done ? null : act('ship', 'Mark shipped'),
      done ? null : (o.status === 'ON_HOLD' ? act('release', 'Release hold') : act('hold', 'Hold')),
      done ? null : act('refund', 'Refund via PayPal', 'btn danger'),
      act('review', r.source === 'ai' ? 'Re-run AI review' : 'Run review again')),
    h('div', { class: 'history', style: 'grid-column:1/-1' },
      (o.history || []).map((x) => h('div', {}, `${new Date(x.at).toLocaleString()} · ${x.by}: ${x.action}${x.note ? ` — ${x.note}` : ''}`)))));
  return card;
}

function render() {
  stats();
  const box = document.getElementById('orders');
  box.replaceChildren(...(orders.length ? orders.map(orderCard) : [h('div', { class: 'muted' }, 'No orders yet.')]));
}

async function doAction(btn, id, action) {
  if (action === 'refund' && !confirm('Refund this order in full through PayPal?')) return;
  const old = btn.textContent;
  btn.disabled = true; btn.replaceChildren(h('span', { class: 'spin' }), ' Working…');
  try {
    const { order } = action === 'review'
      ? await api(`/api/seller/orders/${encodeURIComponent(id)}/review`, {})
      : await api(`/api/seller/orders/${encodeURIComponent(id)}/action`, { action });
    orders = orders.map((o) => (o.id === id ? order : o));
    render();
  } catch (e) {
    alert(e.message);
    btn.disabled = false; btn.textContent = old;
  }
}

async function load() {
  const data = await api('/api/seller/orders');
  orders = data.orders;
  const pp = document.getElementById('paypal-chip');
  pp.textContent = data.paypalMode === 'sandbox' ? 'PayPal sandbox: connected' : 'PayPal: simulated';
  pp.className = `chip ${data.paypalMode === 'sandbox' ? 'on' : 'off'}`;
  const ai = document.getElementById('ai-chip');
  ai.textContent = data.aiEnabled ? 'AI review: on' : 'AI review: off (rules only)';
  ai.className = `chip ${data.aiEnabled ? 'on' : 'off'}`;
  render();
}

document.getElementById('msg-btn').addEventListener('click', async (e) => {
  const out = document.getElementById('msg-result');
  const text = document.getElementById('msg').value;
  e.target.disabled = true;
  out.replaceChildren(h('span', { class: 'muted' }, h('span', { class: 'spin' }), ' Checking…'));
  try {
    const r = await api('/api/seller/check-message', { text });
    out.replaceChildren(h('div', { class: `notice ${r.scamLikely ? 'err' : 'ok'}` },
      h('b', {}, r.scamLikely ? `Likely scam: ${r.scamType}` : 'Looks OK'), h('br'), r.explanation),
      r.safeReply ? h('div', { style: 'margin-top:8px' }, h('b', { class: 'small' }, 'Suggested reply'), h('div', { class: 'reply' }, r.safeReply)) : '',
      r.note ? h('div', { class: 'muted small' }, r.note) : '');
  } catch (err) {
    out.replaceChildren(h('div', { class: 'notice err' }, err.message));
  } finally { e.target.disabled = false; }
});

document.getElementById('reset-btn').addEventListener('click', async () => {
  if (!confirm('Reset to the 5 sample orders? New test orders will be removed.')) return;
  await api('/api/seller/reset', {});
  open.clear();
  await load();
});

load().catch((e) => { document.getElementById('orders').replaceChildren(h('div', { class: 'notice err' }, e.message)); });
setInterval(() => { if (!open.size) load().catch(() => {}); }, 15000);
