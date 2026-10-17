import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import * as paypal from './src/paypal.js';
import { reviewOrder, checkMessage, aiConfigured } from './src/ai.js';
import { computeSignals } from './src/signals.js';
import * as store from './src/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const AUTO_HOLD = (process.env.AUTO_HOLD || 'true') !== 'false';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));

// ---- Security headers (CSP allows only what the PayPal JS SDK needs) ----
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://www.paypal.com https://*.paypal.com https://*.paypalobjects.com https://*.venmo.com",
    "frame-src https://*.paypal.com https://*.venmo.com",
    "connect-src 'self' https://*.paypal.com https://*.paypalobjects.com https://*.venmo.com",
    "img-src 'self' data: https://*.paypal.com https://*.paypalobjects.com",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'self'"
  ].join('; '));
  next();
});

// ---- Tiny rate limiter so nobody can burn the AI budget ----
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}|${req.ip}`;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    list.push(now);
    hits.set(key, list);
    next();
  };
}

// ---- Optional password for the seller side (dashboard + its APIs) ----
function sellerOnly(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();
  const header = req.headers.authorization || '';
  const [, encoded] = header.split(' ');
  const supplied = Buffer.from(encoded || '', 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(supplied);
  const b = Buffer.from(DASHBOARD_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="ShipSafe seller dashboard"');
  return res.status(401).send('Seller login required.');
}

const cleanText = (s, max) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, max);

async function analyze(order) {
  const signals = computeSignals(order, store.listOrders(), store.shop);
  const review = await reviewOrder(order, signals, store.shop);
  order.signals = signals;
  order.review = review;
  // Agent action: hold risky orders automatically so they are not shipped by mistake.
  if (AUTO_HOLD && review.verdict === 'HOLD' && order.status === 'NEW') {
    order.status = 'ON_HOLD';
    order.history = [...(order.history || []), { at: new Date().toISOString(), by: 'ShipSafe', action: 'Auto-hold', note: review.summary }];
  }
  return order;
}

// ---------- Public (storefront) API ----------
app.get('/api/config', (req, res) => {
  res.json({
    paypalMode: paypal.paypalConfigured ? 'sandbox' : 'simulated',
    paypalClientId: paypal.publicClientId,
    aiEnabled: aiConfigured,
    shop: store.shop,
    catalog: store.catalog
  });
});

app.post('/api/orders', rateLimit(20, 60_000), async (req, res) => {
  try {
    const cart = store.buildCart(req.body?.cart);
    if (!cart.length) return res.status(400).json({ error: 'Your cart is empty.' });
    const context = {
      shippingSpeed: req.body?.context?.shippingSpeed === 'overnight' ? 'overnight' : 'standard',
      buyerNote: cleanText(req.body?.context?.buyerNote, 500)
    };
    const id = store.newId();
    const created = await paypal.createOrder(cart, id);
    store.savePending(created.id, { id, cart, context });
    res.json({ id: created.id, simulated: Boolean(created.simulated) });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not start PayPal checkout.' });
  }
});

app.post('/api/orders/:paypalOrderId/capture', rateLimit(20, 60_000), async (req, res) => {
  const pending = store.takePending(req.params.paypalOrderId);
  if (!pending) return res.status(404).json({ error: 'Checkout session not found or already used.' });
  try {
    const simBuyer = paypal.paypalConfigured ? undefined : req.body?.simBuyer;
    const capture = await paypal.captureOrder(req.params.paypalOrderId, pending.cart, simBuyer);
    const n = paypal.normalizeCapture(capture);
    const order = {
      id: pending.id,
      createdAt: new Date().toISOString(),
      status: 'NEW',
      items: pending.cart,
      context: pending.context,
      ...n,
      history: [{ at: new Date().toISOString(), by: 'PayPal', action: 'Payment captured', note: `${n.amount?.value} ${n.amount?.currency_code}` }]
    };
    store.addOrder(order);
    await analyze(order);
    // The buyer only sees a thank-you, never the risk result.
    res.json({ orderId: order.id, status: 'PAID' });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Payment could not be completed.' });
  }
});

// ---------- Seller API ----------
app.get('/api/seller/orders', sellerOnly, (req, res) => res.json({ orders: store.listOrders(), aiEnabled: aiConfigured, paypalMode: paypal.paypalConfigured ? 'sandbox' : 'simulated' }));

app.post('/api/seller/orders/:id/review', sellerOnly, rateLimit(15, 60_000), async (req, res) => {
  const order = store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  await analyze(order);
  res.json({ order });
});

app.post('/api/seller/orders/:id/action', sellerOnly, rateLimit(30, 60_000), async (req, res) => {
  const order = store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const action = req.body?.action;
  const log = (a, note = '') => { order.history = [...(order.history || []), { at: new Date().toISOString(), by: 'Seller', action: a, note }]; };
  try {
    if (order.status === 'REFUNDED') return res.status(409).json({ error: 'This order was already refunded.' });
    if (action === 'ship') { order.status = 'SHIPPED'; log('Marked shipped'); }
    else if (action === 'hold') { order.status = 'ON_HOLD'; log('Put on hold'); }
    else if (action === 'release') { order.status = 'NEW'; log('Released hold'); }
    else if (action === 'refund') {
      if (!order.captureId) {
        if (!order.sample) return res.status(400).json({ error: 'No PayPal capture on this order.' });
        order.status = 'REFUNDED'; log('Refunded (sample order, no real payment)');
      } else {
        const r = await paypal.refundCapture(order.captureId);
        order.status = 'REFUNDED'; order.refundId = r.id;
        log('Refunded through PayPal', `Refund ${r.id} ${r.status}`);
      }
    } else return res.status(400).json({ error: 'Unknown action.' });
    res.json({ order });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'PayPal refund failed. Check the PayPal sandbox dashboard.' });
  }
});

app.post('/api/seller/check-message', sellerOnly, rateLimit(15, 60_000), async (req, res) => {
  const text = cleanText(req.body?.text, 2000).trim();
  if (!text) return res.status(400).json({ error: 'Paste a message first.' });
  res.json(await checkMessage(text));
});

app.post('/api/seller/reset', sellerOnly, rateLimit(5, 60_000), async (req, res) => {
  await seed();
  res.json({ ok: true });
});

// ---------- Pages ----------
app.get('/dashboard', sellerOnly, (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
app.get('/health', (req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

async function seed() {
  store.resetOrders();
  const samples = store.sampleOrders();
  samples.forEach((o) => {
    o.history = [{ at: o.createdAt, by: 'PayPal', action: 'Payment captured (sample)', note: `${o.amount.value} USD` }];
    store.addOrder(o);
  });
  await Promise.all(samples.map((o) => analyze(o)));
}

export { app, seed };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await seed();
  app.listen(PORT, () => {
    console.log(`ShipSafe running on http://localhost:${PORT}`);
    console.log(`  PayPal: ${paypal.paypalConfigured ? 'sandbox' : 'SIMULATED (add PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)'}`);
    console.log(`  AI:     ${aiConfigured ? 'on' : 'OFF (add ANTHROPIC_API_KEY)'}`);
  });
}
