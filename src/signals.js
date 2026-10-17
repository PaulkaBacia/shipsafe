// Rule-based fraud signals.
// These run on every order, with or without AI. They give the AI concrete
// facts to reason about, and they act as a safety floor so a buyer cannot
// talk the AI into calling a risky order "safe".

const SCAM_PHRASES = [
  'overpay', 'over pay', 'send the difference', 'refund the extra', 'refund the difference',
  'my shipper', 'my mover', 'my agent will', 'pick up', 'pickup', 'courier will collect',
  'gift card', 'western union', 'moneygram', 'zelle', 'cash app', 'wire transfer',
  'cashier check', "cashier's check", 'certified check', 'urgent', 'asap no matter',
  'outside paypal', 'off paypal', 'pay you directly'
];

// Text that tries to give orders to the AI reviewer instead of describing the order.
const INJECTION_PHRASES = [
  'ignore previous', 'ignore all previous', 'ignore the above', 'disregard previous',
  'system prompt', 'you are now', 'mark this order as safe', 'mark as safe',
  'risk score 0', 'risk_score', 'verdict: ship', 'approve this order'
];

const FORWARDER_HINTS = [
  'freight', 'forward', 'reship', 're-ship', 'parcel', 'c/o', 'care of',
  'export', 'consolidat', 'shipito', 'myus', 'package receiving'
];

const lower = (s) => (s || '').toString().toLowerCase();

function matchAny(text, list) {
  const t = lower(text);
  return list.filter((p) => t.includes(p));
}

// Emails like "xk9q2z7731@..." or "john48291736@..." are common for throwaway accounts.
export function looksRandomEmail(email) {
  const local = lower(email).split('@')[0] || '';
  if (local.length < 6) return false;
  const digits = (local.match(/\d/g) || []).length;
  const vowels = (local.match(/[aeiou]/g) || []).length;
  return digits >= 5 || (local.length >= 10 && vowels / local.length < 0.15);
}

function addressKey(addr = {}) {
  return lower([addr.address_line_1, addr.postal_code, addr.country_code].join('|')).replace(/\s+/g, '');
}

/**
 * Build the list of signals for one order.
 * @param {object} order   normalized order (see store.js)
 * @param {object[]} history other orders, used for velocity checks
 * @param {object} shop    { averageOrderValue }
 */
export function computeSignals(order, history = [], shop = { averageOrderValue: 60 }) {
  const signals = [];
  const add = (id, weight, label, detail) => signals.push({ id, weight, label, detail });

  const ship = order.shipping?.address || {};
  const payer = order.payer || {};
  const total = Number(order.amount?.value || 0);

  // 1. PayPal Seller Protection status (comes straight from the PayPal capture).
  const sp = order.sellerProtection;
  if (sp === 'NOT_ELIGIBLE') add('seller_protection', 20, 'Not covered by PayPal Seller Protection', 'If this turns into a chargeback, the shop has no PayPal protection.');
  else if (sp === 'PARTIALLY_ELIGIBLE') add('seller_protection', 10, 'Only partly covered by PayPal Seller Protection', 'Some chargeback types would not be covered.');

  // 2. Ship-to country differs from the PayPal account country.
  if (payer.country_code && ship.country_code && payer.country_code !== ship.country_code) {
    add('country_mismatch', 15, 'Shipping to a different country than the PayPal account', `Account: ${payer.country_code}, ship to: ${ship.country_code}.`);
  }

  // 3. Freight forwarder / reshipper address.
  const addrText = [ship.address_line_1, ship.address_line_2, order.shipping?.name].join(' ');
  const fw = matchAny(addrText, FORWARDER_HINTS);
  if (fw.length) add('forwarder_address', 20, 'Address looks like a package forwarder', `Matched: ${fw.join(', ')}.`);

  // 4. Unusually large order for this shop.
  const avg = Number(shop.averageOrderValue) || 60;
  if (total >= avg * 3) add('high_value', 15, 'Much bigger than a normal order', `$${total.toFixed(2)} vs. a usual $${avg.toFixed(2)}.`);

  // 5. Rush shipping on a large order.
  if (order.context?.shippingSpeed === 'overnight' && total >= avg * 2) {
    add('rush_high_value', 10, 'Overnight shipping on a large order', 'Fraudsters want the goods before the real card owner notices.');
  }

  // 6. Several of the same item.
  const bulk = (order.items || []).find((i) => Number(i.quantity) >= 3);
  if (bulk) add('bulk_quantity', 10, 'Several of the same item', `${bulk.quantity} x ${bulk.name}.`);

  // 7. Throwaway-looking email.
  if (looksRandomEmail(payer.email_address)) add('random_email', 10, 'Email address looks auto-generated', payer.email_address);

  // 8. Ship-to name differs from PayPal account holder.
  const payerName = lower(`${payer.name?.given_name || ''} ${payer.name?.surname || ''}`).trim();
  const shipName = lower(order.shipping?.name).trim();
  if (payerName && shipName) {
    const payerLast = payerName.split(' ').pop();
    if (!shipName.includes(payerLast)) add('name_mismatch', 10, 'Package goes to someone other than the payer', `Payer: ${payerName}, ship to: ${shipName}.`);
  }

  // 9. Scam language in the buyer's note.
  const scam = matchAny(order.context?.buyerNote, SCAM_PHRASES);
  if (scam.length) add('scam_language', 25, 'Buyer note uses common scam phrases', `Matched: ${scam.join(', ')}.`);

  // 10. Someone trying to instruct the AI reviewer.
  const inj = matchAny(order.context?.buyerNote, INJECTION_PHRASES);
  if (inj.length) add('prompt_injection', 25, 'Buyer note tries to give orders to the AI', `Matched: ${inj.join(', ')}. Treated as a red flag, never as an instruction.`);

  // 11. Velocity: same address or email on another recent order.
  const key = addressKey(ship);
  const dayMs = 24 * 60 * 60 * 1000;
  const recent = history.filter((o) => o.id !== order.id && Math.abs(new Date(o.createdAt) - new Date(order.createdAt)) < dayMs);
  const sameAddr = key.length > 3 ? recent.filter((o) => addressKey(o.shipping?.address) === key) : [];
  const sameEmail = payer.email_address ? recent.filter((o) => lower(o.payer?.email_address) === lower(payer.email_address)) : [];
  if (sameAddr.length || sameEmail.length) {
    add('velocity', 15, 'Repeat orders in the last 24 hours', `${sameAddr.length} other order(s) to this address, ${sameEmail.length} from this email.`);
  }

  return signals;
}

export function scoreSignals(signals) {
  return Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0));
}

export function verdictFor(score) {
  if (score >= 60) return 'HOLD';
  if (score >= 30) return 'VERIFY';
  return 'SHIP';
}

// Quick rule check for a pasted buyer message (used by the message checker).
export function messageSignals(text) {
  return {
    scamPhrases: matchAny(text, SCAM_PHRASES),
    injectionPhrases: matchAny(text, INJECTION_PHRASES)
  };
}
