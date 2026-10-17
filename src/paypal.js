// PayPal REST API (Orders v2 + Payments v2), sandbox by default.
// If PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are missing, the app runs in
// "simulated PayPal" mode so it can still be tried locally. The UI says so.

import crypto from 'node:crypto';

const BASE = process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';

export const paypalConfigured = Boolean(CLIENT_ID && CLIENT_SECRET);
export const publicClientId = CLIENT_ID;

let cachedToken = null; // { value, expiresAt }

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status})`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function call(method, path, body) {
  const token = await accessToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID() // makes retries safe (idempotency)
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.details?.[0]?.description || data?.message || res.statusText;
    throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${msg}`);
  }
  return data;
}

/** cart: [{ id, name, price, quantity }] — prices come from the server catalog, never the browser. */
export async function createOrder(cart, referenceId) {
  const itemTotal = cart.reduce((s, i) => s + i.price * i.quantity, 0).toFixed(2);
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: referenceId,
      description: 'Maple & Thread order',
      amount: {
        currency_code: 'USD',
        value: itemTotal,
        breakdown: { item_total: { currency_code: 'USD', value: itemTotal } }
      },
      items: cart.map((i) => ({
        name: i.name,
        sku: i.id,
        quantity: String(i.quantity),
        unit_amount: { currency_code: 'USD', value: i.price.toFixed(2) }
      }))
    }]
  };
  if (!paypalConfigured) return { id: `SIM-${crypto.randomBytes(6).toString('hex').toUpperCase()}`, status: 'CREATED', simulated: true };
  return call('POST', '/v2/checkout/orders', body);
}

/** simBuyer is only used in simulated mode, to stand in for what PayPal would return. */
export async function captureOrder(orderId, cart, simBuyer) {
  if (!paypalConfigured) return simulatedCapture(orderId, cart, simBuyer);
  return call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`);
}

export async function refundCapture(captureId) {
  if (!paypalConfigured || captureId.startsWith('SIMCAP-')) {
    return { id: `SIMREF-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, status: 'COMPLETED', simulated: true };
  }
  return call('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {});
}

// Turn a PayPal capture response into the shape the rest of the app uses.
export function normalizeCapture(capture) {
  const pu = capture.purchase_units?.[0] || {};
  const cap = pu.payments?.captures?.[0] || {};
  return {
    paypalOrderId: capture.id,
    captureId: cap.id,
    captureStatus: cap.status,
    sellerProtection: cap.seller_protection?.status || 'UNKNOWN',
    amount: cap.amount || pu.amount,
    payer: {
      name: capture.payer?.name || {},
      email_address: capture.payer?.email_address || '',
      payer_id: capture.payer?.payer_id || '',
      country_code: capture.payer?.address?.country_code || ''
    },
    shipping: {
      name: pu.shipping?.name?.full_name || '',
      address: pu.shipping?.address || {}
    },
    simulated: Boolean(capture.simulated)
  };
}

function simulatedCapture(orderId, cart, b = {}) {
  const value = cart.reduce((s, i) => s + i.price * i.quantity, 0).toFixed(2);
  return {
    id: orderId,
    status: 'COMPLETED',
    simulated: true,
    payer: {
      name: { given_name: b.givenName || 'Test', surname: b.surname || 'Buyer' },
      email_address: b.email || 'test.buyer@example.com',
      payer_id: 'SIMPAYER',
      address: { country_code: b.payerCountry || 'US' }
    },
    purchase_units: [{
      amount: { currency_code: 'USD', value },
      shipping: {
        name: { full_name: b.shipName || `${b.givenName || 'Test'} ${b.surname || 'Buyer'}` },
        address: {
          address_line_1: b.addressLine1 || '100 Main St',
          admin_area_2: b.city || 'Austin',
          admin_area_1: b.state || 'TX',
          postal_code: b.postalCode || '78701',
          country_code: b.shipCountry || 'US'
        }
      },
      payments: {
        captures: [{
          id: `SIMCAP-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
          status: 'COMPLETED',
          amount: { currency_code: 'USD', value },
          seller_protection: { status: b.sellerProtection || 'ELIGIBLE' }
        }]
      }
    }]
  };
}
