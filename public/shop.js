// Storefront: product grid, cart, and PayPal checkout (real sandbox or simulated).

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const money = (n) => `$${Number(n).toFixed(2)}`;

const state = { config: null, cart: {} };

const PERSONAS = {
  normal: { label: 'Normal buyer (Austin, TX)', givenName: 'Taylor', surname: 'Nguyen', email: 'taylor.nguyen@example.com', payerCountry: 'US', addressLine1: '2100 Lakeview Blvd', city: 'Austin', state: 'TX', postalCode: '78704', shipCountry: 'US', sellerProtection: 'ELIGIBLE' },
  risky: { label: 'Risky buyer (UK account, ships to a forwarder)', givenName: 'Chris', surname: 'Vale', email: 'cvale77310428@example.net', payerCountry: 'GB', shipName: 'Swift Reship c/o C. Vale', addressLine1: '9 Freight Plaza Suite 50317', city: 'Miami', state: 'FL', postalCode: '33166', shipCountry: 'US', sellerProtection: 'NOT_ELIGIBLE' }
};

function cartItems() {
  return Object.entries(state.cart).filter(([, q]) => q > 0).map(([id, quantity]) => ({ id, quantity }));
}

function renderProducts() {
  const box = document.getElementById('products');
  box.replaceChildren(...state.config.catalog.map((p) => {
    const count = h('span', {}, String(state.cart[p.id] || 0));
    const change = (d) => { state.cart[p.id] = Math.max(0, Math.min(20, (state.cart[p.id] || 0) + d)); count.textContent = state.cart[p.id]; renderCart(); };
    return h('article', { class: 'card product' },
      h('div', { class: 'pic', 'aria-hidden': 'true' }, p.emoji),
      h('div', { class: 'name' }, p.name),
      h('div', { class: 'muted' }, money(p.price)),
      h('div', { class: 'qty' },
        h('button', { 'aria-label': `Remove one ${p.name}`, onclick: () => change(-1) }, '−'),
        count,
        h('button', { 'aria-label': `Add one ${p.name}`, onclick: () => change(1) }, '+')));
  }));
}

function renderCart() {
  const lines = document.getElementById('cart-lines');
  const items = cartItems();
  let total = 0;
  if (!items.length) { lines.replaceChildren('Nothing here yet.'); }
  else {
    lines.replaceChildren(...items.map(({ id, quantity }) => {
      const p = state.config.catalog.find((c) => c.id === id);
      total += p.price * quantity;
      return h('div', { class: 'cart-line' }, h('span', {}, `${quantity} × ${p.name}`), h('span', {}, money(p.price * quantity)));
    }));
  }
  document.getElementById('cart-total').textContent = money(total);
}

function showResult(kind, text) {
  document.getElementById('result').replaceChildren(h('div', { class: `notice ${kind}` }, text));
}

async function startOrder() {
  const res = await fetch('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cart: cartItems(),
      context: { shippingSpeed: document.getElementById('speed').value, buyerNote: document.getElementById('note').value }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Checkout failed');
  return data.id;
}

async function finishOrder(paypalOrderId, simBuyer) {
  const res = await fetch(`/api/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(simBuyer ? { simBuyer } : {})
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Payment failed');
  state.cart = {};
  renderProducts(); renderCart();
  document.getElementById('note').value = '';
  showResult('ok', `Thanks! Order ${data.orderId} is paid. (Open the seller view to see what ShipSafe thinks of it.)`);
}

function renderSimulatedCheckout(area) {
  const select = h('select', { id: 'persona' }, ...Object.entries(PERSONAS).map(([k, p]) => h('option', { value: k }, p.label)));
  const btn = h('button', { class: 'btn primary', onclick: async () => {
    if (!cartItems().length) return showResult('err', 'Add something to your cart first.');
    btn.disabled = true;
    try { await finishOrder(await startOrder(), PERSONAS[select.value]); }
    catch (e) { showResult('err', e.message); }
    finally { btn.disabled = false; }
  } }, 'Pay with PayPal (simulated)');
  area.replaceChildren(h('div', { class: 'sim-box' },
    h('b', {}, 'Simulated PayPal checkout'),
    h('span', { class: 'small' }, 'No PayPal keys are set on this server, so the payment is simulated. Pick who is buying:'),
    select, btn));
}

function renderPayPalButtons(area) {
  const holder = h('div', { id: 'paypal-buttons' });
  area.replaceChildren(holder);
  const s = document.createElement('script');
  s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(state.config.paypalClientId)}&currency=USD&intent=capture`;
  s.onload = () => {
    window.paypal.Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'paypal' },
      onClick: (data, actions) => {
        if (!cartItems().length) { showResult('err', 'Add something to your cart first.'); return actions.reject(); }
        return actions.resolve();
      },
      createOrder: () => startOrder(),
      onApprove: (data) => finishOrder(data.orderID).catch((e) => showResult('err', e.message)),
      onCancel: () => showResult('err', 'Checkout cancelled.'),
      onError: (err) => { console.error(err); showResult('err', 'PayPal had a problem. Please try again.'); }
    }).render('#paypal-buttons');
  };
  s.onerror = () => showResult('err', 'Could not load PayPal.');
  document.head.append(s);
}

async function init() {
  state.config = await (await fetch('/api/config')).json();
  const chip = document.getElementById('mode-chip');
  chip.textContent = state.config.paypalMode === 'sandbox' ? 'PayPal sandbox' : 'PayPal simulated';
  chip.className = `chip ${state.config.paypalMode === 'sandbox' ? 'on' : 'off'}`;
  renderProducts(); renderCart();
  const area = document.getElementById('paypal-area');
  if (state.config.paypalMode === 'sandbox') renderPayPalButtons(area);
  else renderSimulatedCheckout(area);
}

init().catch((e) => showResult('err', `Could not load the shop: ${e.message}`));
