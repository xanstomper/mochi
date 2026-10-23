// Fixture generator for the endurance / mileage factory.
//
// Generates "Ledgerline", a deterministic mid-size ESM JavaScript project
// (~80 files, real cross-module imports) plus the task machinery the
// scripted model works against:
//   - tools/run-tests.mjs  — regression suite over the ORIGINAL features
//                            (green before and after the task; this is the
//                            suite the harness's own finish-verify runs).
//   - tools/check-stage.mjs N — per-stage artifact probes for the 5-stage
//                            discount feature (prints STAGE_N_OK / FAIL).
//   - SOLUTION_FILES — the exact post-task contents the scripted model
//                      writes (new files + full-content rewrites), kept in
//                      this module so generator and plan can never drift.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const TASK_ID = 'endurance-discounts-task';
export const TASK_TITLE = 'Add end-to-end discount support to the Ledgerline codebase';
export const TASK_DESCRIPTION = [
  'Ledgerline (this repo) needs discount support across the stack, in five stages.',
  'Stage 1: a pure discount module at src/discounts/discount.js (+ index.js) — applyDiscount(amountCents, discount) and validateDiscount(discount); kinds are "percent" (value in (0,100]) and "fixed" (value > 0 cents, result floored at 0).',
  'Stage 2: a discount store at src/store/discount-store.js (createDiscount / getDiscountByCode / listDiscounts / deleteDiscount), exported from src/store/index.js. Before writing it, capture a display snapshot of the store schema with the display_snapshot tool.',
  'Stage 3: wire discounts into src/services/invoice-service.js — createInvoice accepts discountCode; the discount is looked up in the injected discount store, applied to the subtotal, and the tax is computed on the discounted subtotal. HARD RULE: the total discount on an invoice is capped at 50% of the subtotal.',
  'Stage 4: an API surface at src/api/discounts-api.js (createDiscount / getDiscount / listDiscounts handlers returning {status, body}), exported from src/api/index.js.',
  'Stage 5: documentation at docs/discounts.md, then the full regression suite must pass.',
  'After each stage, run `node tools/check-stage.mjs N` and only proceed when it prints STAGE_N_OK. After a stage passes, record its marker idempotently (append only if absent): grep -qx \'stage-N-complete\' .endurance-ledger.log 2>/dev/null || printf \'stage-N-complete\\n\' >> .endurance-ledger.log (with the real stage number). Also append a raw telemetry line per stage: printf \'probe-stage-N\\n\' >> .endurance-probe.log.',
  'Use a researcher subagent early to map the store layout, and a background researcher subagent in stage 4 to catalogue invoice-service importers while you work.',
].join('\n');

export const LEDGER_FILE = '.endurance-ledger.log';
export const STEER_TEXT =
  'Change of plan on docs: in the final stage, also add docs/discounts-faq.md with a short FAQ (exactly 3 questions) alongside docs/discounts.md.';

/** Deterministic PRNG so every generated fixture is byte-identical. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CORE: Record<string, string> = {
  'src/core/money.js': `// Money helpers — all amounts are integer cents.
export function addMoney(a, b) { return a + b; }
export function subMoney(a, b) { return a - b; }
export function mulMoney(amount, qty) { return amount * qty; }
export function percentOf(amount, pct) { return Math.floor((amount * pct) / 100); }
export function formatMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return sign + '$' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}
`,
  'src/core/tax.js': `import { percentOf } from './money.js';
// Flat 10% sales tax, rounded down to whole cents.
export const TAX_RATE_PCT = 10;
export function computeTaxCents(taxableCents) { return percentOf(taxableCents, TAX_RATE_PCT); }
`,
  'src/core/dates.js': `export function nowIso() { return new Date().toISOString(); }
export function addDaysIso(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}
export function isExpired(iso, atIso) { return new Date(iso).getTime() <= new Date(atIso).getTime(); }
`,
  'src/core/ids.js': `import { randomBytes } from 'node:crypto';
let counter = 0;
export function nextId(prefix) {
  counter += 1;
  return prefix + '_' + Date.now().toString(36) + '_' + counter + '_' + randomBytes(3).toString('hex');
}
`,
  'src/core/errors.js': `export class LedgerError extends Error {
  constructor(code, message) { super(message); this.name = 'LedgerError'; this.code = code; }
}
export function notFound(what) { return new LedgerError('NOT_FOUND', what + ' not found'); }
export function invalid(what) { return new LedgerError('INVALID', 'invalid ' + what); }
`,
  'src/core/validate.js': `import { invalid } from './errors.js';
export function requireFields(obj, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null || obj[f] === '') throw invalid('field ' + f);
  }
  return obj;
}
export function requirePositiveInt(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw invalid(field);
  return value;
}
export function requireEmail(value) {
  if (typeof value !== 'string' || !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(value)) throw invalid('email');
  return value;
}
`,
  'src/core/format.js': `export function titleCase(s) { return s.replace(/\\b\\w/g, (c) => c.toUpperCase()); }
export function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
export function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
`,
  'src/core/index.js': `export * from './money.js';
export * from './tax.js';
export * from './dates.js';
export * from './ids.js';
export * from './errors.js';
export * from './validate.js';
export * from './format.js';
`,
};

const UTILS: Record<string, string> = {
  'src/util/strings.js': `export function camelToSnake(s) { return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()); }
export function snakeToCamel(s) { return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
export function padLeft(s, n, ch = ' ') { return String(s).padStart(n, ch); }
`,
  'src/util/arrays.js': `export function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
export function uniqueBy(arr, keyFn) { const seen = new Set(); return arr.filter((x) => { const k = keyFn(x); if (seen.has(k)) return false; seen.add(k); return true; }); }
export function sumBy(arr, fn) { return arr.reduce((acc, x) => acc + fn(x), 0); }
`,
  'src/util/objects.js': `export function pick(obj, keys) { const out = {}; for (const k of keys) if (k in obj) out[k] = obj[k]; return out; }
export function omit(obj, keys) { const out = { ...obj }; for (const k of keys) delete out[k]; return out; }
export function deepFreeze(obj) { Object.freeze(obj); for (const v of Object.values(obj)) if (v && typeof v === 'object') deepFreeze(v); return obj; }
`,
  'src/util/time.js': `export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
export function elapsedMs(start) { return Date.now() - start; }
export function isoWeek(iso) { const d = new Date(iso); const onejan = new Date(d.getFullYear(), 0, 1); return Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7); }
`,
  'src/util/collections.js': `export function groupBy(arr, keyFn) { const out = new Map(); for (const x of arr) { const k = keyFn(x); if (!out.has(k)) out.set(k, []); out.get(k).push(x); } return out; }
export function indexBy(arr, keyFn) { const out = new Map(); for (const x of arr) out.set(keyFn(x), x); return out; }
`,
  'src/util/assert.js': `export function assert(cond, msg) { if (!cond) throw new Error('assertion failed: ' + msg); }
export function assertEq(actual, expected, msg) { if (actual !== expected) throw new Error('assertion failed: ' + msg + ' (expected ' + expected + ', got ' + actual + ')'); }
`,
  'src/util/paths.js': `export function joinPath(...parts) { return parts.map((p) => String(p).replace(/^\\/+|\\/+$/g, '')).filter(Boolean).join('/'); }
export function extOf(p) { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i + 1); }
`,
  'src/util/random.js': `// Deterministic helper for tests and seeds (NOT for ids or security).
export function seededPick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }
export function shuffleSeeded(rand, arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
`,
  'src/util/clone.js': `export function deepClone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
export function shallowMerge(a, b) { return { ...a, ...b }; }
`,
  'src/util/retry.js': `import { sleep } from './time.js';
export async function withRetry(fn, attempts = 3, delayMs = 25) {
  let lastErr;
  for (let i = 0; i < attempts; i++) { try { return await fn(); } catch (e) { lastErr = e; if (i < attempts - 1) await sleep(delayMs); } }
  throw lastErr;
}
`,
  'src/util/queue.js': `export class SimpleQueue {
  constructor() { this.items = []; }
  push(x) { this.items.push(x); }
  shift() { return this.items.shift(); }
  get size() { return this.items.length; }
}
`,
  'src/util/index.js': `export * from './strings.js';
export * from './arrays.js';
export * from './objects.js';
export * from './time.js';
export * from './collections.js';
export * from './assert.js';
export * from './paths.js';
export * from './random.js';
export * from './clone.js';
export * from './retry.js';
export * from './queue.js';
`,
};

const ENTITIES: Array<{ name: string; prefix: string; fields: string[] }> = [
  { name: 'account', prefix: 'acct', fields: ['name', 'email'] },
  { name: 'customer', prefix: 'cust', fields: ['name', 'email', 'tier'] },
  { name: 'product', prefix: 'prod', fields: ['sku', 'name', 'priceCents'] },
  { name: 'order', prefix: 'ord', fields: ['customerId', 'totalCents', 'status'] },
  { name: 'invoice', prefix: 'inv', fields: ['orderId', 'totalCents', 'status'] },
  { name: 'payment', prefix: 'pay', fields: ['invoiceId', 'amountCents', 'method'] },
  { name: 'refund', prefix: 'ref', fields: ['paymentId', 'amountCents', 'reason'] },
  { name: 'shipment', prefix: 'ship', fields: ['orderId', 'carrier', 'tracking'] },
  { name: 'subscription', prefix: 'sub', fields: ['customerId', 'plan', 'status'] },
  { name: 'coupon', prefix: 'cpn', fields: ['code', 'percentOff', 'active'] },
  { name: 'vendor', prefix: 'vnd', fields: ['name', 'contact'] },
  { name: 'ticket', prefix: 'tkt', fields: ['customerId', 'subject', 'status'] },
];

function pascal(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

function domainFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of ENTITIES) {
    const P = pascal(e.name);
    out[`src/domain/${e.name}.js`] = `import { nextId } from '../core/ids.js';
import { requireFields } from '../core/validate.js';
import { nowIso } from '../core/dates.js';

// ${P} entity factory — validates required fields and stamps identity.
export function create${P}(data) {
  requireFields(data, ${JSON.stringify(e.fields)});
  return { id: nextId('${e.prefix}'), ...data, createdAt: nowIso() };
}
export function is${P}(x) { return !!x && typeof x.id === 'string' && x.id.startsWith('${e.prefix}_'); }
`;
    out[`src/domain/${e.name}-mapper.js`] = `import { pick, omit } from '../util/objects.js';
// Row <-> public mapping for ${e.name}.
const PUBLIC_FIELDS = ${JSON.stringify(['id', ...e.fields, 'createdAt'])};
export function toPublic${P}(row) { return pick(row, PUBLIC_FIELDS); }
export function fromRow${P}(row) { return omit(row, ['_internal']); }
`;
  }
  out['src/domain/index.js'] = ENTITIES.map((e) => `export * from './${e.name}.js';\nexport * from './${e.name}-mapper.js';`).join('\n') + '\n';
  return out;
}

const STORE_ORIGINAL: Record<string, string> = {
  'src/store/memory-store.js': `// Generic in-memory entity store: Map-backed CRUD with id indexing.
export function createMemoryStore() {
  const rows = new Map();
  return {
    put(entity) { rows.set(entity.id, entity); return entity; },
    get(id) { return rows.get(id) ?? null; },
    remove(id) { return rows.delete(id); },
    all() { return [...rows.values()]; },
    find(pred) { return [...rows.values()].filter(pred); },
    get size() { return rows.size; },
  };
}
`,
  'src/store/store.js': `import { createMemoryStore } from './memory-store.js';
// One shared store per entity kind, created lazily.
const stores = new Map();
export function storeFor(kind) {
  if (!stores.has(kind)) stores.set(kind, createMemoryStore());
  return stores.get(kind);
}
export function resetStores() { stores.clear(); }
`,
  'src/store/index.js': `export * from './memory-store.js';
export * from './store.js';
`,
};

const INVOICE_SERVICE_ORIGINAL = `import { nextId } from '../core/ids.js';
import { computeTaxCents } from '../core/tax.js';
import { mulMoney, addMoney } from '../core/money.js';
import { invalid } from '../core/errors.js';

// Invoice totals: subtotal from line items, flat tax on the subtotal.
export function createInvoiceService(deps = {}) {
  const invoices = new Map();
  function createInvoice(input) {
    if (!input || !Array.isArray(input.lines) || input.lines.length === 0) throw invalid('invoice lines');
    let subtotal = 0;
    for (const line of input.lines) {
      if (!line || !(line.qty > 0) || !(line.unitPriceCents >= 0)) throw invalid('invoice line');
      subtotal = addMoney(subtotal, mulMoney(line.unitPriceCents, line.qty));
    }
    const taxCents = computeTaxCents(subtotal);
    const invoice = {
      id: nextId('inv'),
      customerId: input.customerId,
      lines: input.lines,
      subtotalCents: subtotal,
      discountCents: 0,
      taxCents,
      totalCents: subtotal + taxCents,
      status: 'open',
    };
    invoices.set(invoice.id, invoice);
    return invoice;
  }
  function getInvoice(id) { return invoices.get(id) ?? null; }
  return { createInvoice, getInvoice };
}
`;

const SERVICES: Record<string, string> = {
  'src/services/invoice-service.js': INVOICE_SERVICE_ORIGINAL,
  'src/services/customer-service.js': `import { createCustomer } from '../domain/customer.js';
import { storeFor } from '../store/store.js';
export function createCustomerService() {
  const store = storeFor('customer');
  return {
    register(data) { const c = createCustomer(data); return store.put(c); },
    get(id) { return store.get(id); },
    list() { return store.all(); },
  };
}
`,
  'src/services/report-service.js': `import { sumBy, groupBy } from '../util/index.js';
export function summariseInvoices(invoices) {
  const byStatus = groupBy(invoices, (i) => i.status);
  return {
    count: invoices.length,
    totalCents: sumBy(invoices, (i) => i.totalCents),
    openCount: (byStatus.get('open') ?? []).length,
  };
}
`,
  'src/services/pricing-service.js': `import { percentOf } from '../core/money.js';
// Tier pricing: gold 15% under list, silver 5%, standard list.
export function priceForTier(listCents, tier) {
  if (tier === 'gold') return listCents - percentOf(listCents, 15);
  if (tier === 'silver') return listCents - percentOf(listCents, 5);
  return listCents;
}
`,
  'src/services/notification-service.js': `export function createNotificationService() {
  const sent = [];
  return {
    notify(kind, payload) { sent.push({ kind, payload, at: new Date().toISOString() }); },
    get sent() { return [...sent]; },
  };
}
`,
  'src/services/audit-service.js': `export function createAuditLog() {
  const entries = [];
  return {
    record(actor, action, detail) { entries.push({ actor, action, detail, at: new Date().toISOString() }); },
    entries() { return [...entries]; },
  };
}
`,
  'src/services/index.js': `export * from './invoice-service.js';
export * from './customer-service.js';
export * from './report-service.js';
export * from './pricing-service.js';
export * from './notification-service.js';
export * from './audit-service.js';
`,
};

const API_ORIGINAL_INDEX = `export * from './invoices-api.js';
export * from './customers-api.js';
export * from './reports-api.js';
export * from './health-api.js';
`;

const API: Record<string, string> = {
  'src/api/invoices-api.js': `// Thin handler layer over the invoice service: {status, body} results.
export function createInvoicesApi({ invoiceService }) {
  return {
    createInvoice(body) {
      try { return { status: 201, body: invoiceService.createInvoice(body) }; }
      catch (e) { return { status: 400, body: { error: String(e.message ?? e) } }; }
    },
    getInvoice(id) {
      const inv = invoiceService.getInvoice(id);
      return inv ? { status: 200, body: inv } : { status: 404, body: { error: 'invoice not found' } };
    },
  };
}
`,
  'src/api/customers-api.js': `export function createCustomersApi({ customerService }) {
  return {
    register(body) {
      try { return { status: 201, body: customerService.register(body) }; }
      catch (e) { return { status: 400, body: { error: String(e.message ?? e) } }; }
    },
    list() { return { status: 200, body: customerService.list() }; },
  };
}
`,
  'src/api/reports-api.js': `import { summariseInvoices } from '../services/report-service.js';
export function createReportsApi({ listInvoices }) {
  return { summary() { return { status: 200, body: summariseInvoices(listInvoices()) }; } };
}
`,
  'src/api/health-api.js': `export function createHealthApi() {
  return { health() { return { status: 200, body: { ok: true, service: 'ledgerline' } }; } };
}
`,
  'src/api/index.js': API_ORIGINAL_INDEX,
};

const CONFIG: Record<string, string> = {
  'src/config/defaults.js': `export const DEFAULTS = { currency: 'USD', taxRatePct: 10, pageSize: 50 };
`,
  'src/config/index.js': `export * from './defaults.js';
`,
  'src/index.js': `export * from './core/index.js';
export * from './domain/index.js';
export * from './store/index.js';
export * from './services/index.js';
export * from './api/index.js';
`,
};

const TESTS: Record<string, string> = {
  'tests/money.test.mjs': `import assert from 'node:assert';
import { addMoney, percentOf, formatMoney } from '../src/core/money.js';
import { computeTaxCents } from '../src/core/tax.js';
assert.equal(addMoney(100, 250), 350);
assert.equal(percentOf(10000, 10), 1000);
assert.equal(percentOf(999, 33), 329);
assert.equal(computeTaxCents(5000), 500);
assert.equal(formatMoney(12345), '$123.45');
assert.equal(formatMoney(-50), '-$0.50');
console.log('money.test.mjs OK');
`,
  'tests/invoice.test.mjs': `import assert from 'node:assert';
import { createInvoiceService } from '../src/services/invoice-service.js';
const svc = createInvoiceService();
const inv = svc.createInvoice({ customerId: 'cust_1', lines: [{ sku: 'A', qty: 2, unitPriceCents: 1500 }, { sku: 'B', qty: 1, unitPriceCents: 2000 }] });
assert.equal(inv.subtotalCents, 5000);
assert.equal(inv.taxCents, 500);
assert.equal(inv.totalCents, 5500);
assert.equal(inv.discountCents, 0);
assert.equal(svc.getInvoice(inv.id).id, inv.id);
assert.throws(() => svc.createInvoice({ customerId: 'c', lines: [] }));
console.log('invoice.test.mjs OK');
`,
  'tests/store.test.mjs': `import assert from 'node:assert';
import { createMemoryStore } from '../src/store/memory-store.js';
const s = createMemoryStore();
s.put({ id: 'x1', v: 1 });
s.put({ id: 'x2', v: 2 });
assert.equal(s.size, 2);
assert.equal(s.get('x1').v, 1);
assert.equal(s.find((r) => r.v > 1).length, 1);
assert.equal(s.remove('x1'), true);
assert.equal(s.get('x1'), null);
console.log('store.test.mjs OK');
`,
  'tests/domain.test.mjs': `import assert from 'node:assert';
import { createCustomer } from '../src/domain/customer.js';
import { createProduct } from '../src/domain/product.js';
import { toPublicCustomer } from '../src/domain/customer-mapper.js';
const c = createCustomer({ name: 'Ada', email: 'ada@example.com', tier: 'gold' });
assert.ok(c.id.startsWith('cust_'));
const pub = toPublicCustomer({ ...c, _internal: 'secret' });
assert.equal(pub._internal, undefined);
const p = createProduct({ sku: 'SKU-1', name: 'Widget', priceCents: 999 });
assert.ok(p.id.startsWith('prod_'));
assert.throws(() => createCustomer({ name: 'NoEmail' }));
console.log('domain.test.mjs OK');
`,
  'tests/pricing.test.mjs': `import assert from 'node:assert';
import { priceForTier } from '../src/services/pricing-service.js';
assert.equal(priceForTier(10000, 'gold'), 8500);
assert.equal(priceForTier(10000, 'silver'), 9500);
assert.equal(priceForTier(10000, 'standard'), 10000);
console.log('pricing.test.mjs OK');
`,
  // Existence-gated: green on the pristine fixture (modules absent -> skip),
  // and once the discount feature lands it asserts the real semantics —
  // this is also what gives the harness's mutation gate teeth over the
  // new code at finish time.
  'tests/discounts.test.mjs': `import assert from 'node:assert';
const dyn = async (p) => { try { return await import(p); } catch { return null; } };
const discount = await dyn('../src/discounts/discount.js');
if (!discount) { console.log('discounts.test.mjs SKIP (module absent)'); process.exit(0); }
assert.equal(discount.applyDiscount(10000, { kind: 'percent', value: 10 }), 9000);
assert.equal(discount.applyDiscount(300, { kind: 'fixed', value: 500 }), 0);
assert.equal(discount.applyDiscount(999, { kind: 'percent', value: 33 }), 670);
assert.throws(() => discount.validateDiscount({ kind: 'percent', value: 0 }));
const storeMod = await dyn('../src/store/discount-store.js');
if (storeMod) {
  const store = storeMod.createDiscountStore();
  store.createDiscount({ code: 'T10', kind: 'percent', value: 10 });
  assert.equal(store.getDiscountByCode('T10').value, 10);
  assert.equal(store.listDiscounts().length, 1);
  const { createInvoiceService } = await import('../src/services/invoice-service.js');
  const discounts = storeMod.createDiscountStore();
  discounts.createDiscount({ code: 'SAVE90', kind: 'percent', value: 90 });
  const svc = createInvoiceService({ discountStore: discounts });
  const inv = svc.createInvoice({ customerId: 'c1', lines: [{ sku: 'A', qty: 1, unitPriceCents: 10000 }], discountCode: 'SAVE90' });
  assert.equal(inv.discountCents, 5000);
  assert.equal(inv.totalCents, 5500);
  const apiMod = await dyn('../src/api/discounts-api.js');
  if (apiMod) {
    const api = apiMod.createDiscountsApi({ discountStore: storeMod.createDiscountStore() });
    assert.equal(api.createDiscount({ code: 'A5', kind: 'fixed', value: 500 }).status, 201);
    assert.equal(api.getDiscount('A5').status, 200);
    assert.equal(api.getDiscount('ZZZ').status, 404);
  }
}
console.log('discounts.test.mjs OK');
`,
};

const RUN_TESTS = `import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(resolve(root, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [resolve(root, 'tests', f)], { encoding: 'utf8' });
  if (r.status === 0) console.log('PASS ' + f);
  else { failed++; console.log('FAIL ' + f + '\\n' + (r.stdout ?? '') + (r.stderr ?? '')); }
}
if (failed) { console.log(failed + ' test file(s) failed'); process.exit(1); }
console.log('ALL TESTS PASS (' + files.length + ' files)');
`;

const CHECK_STAGE = `import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(resolve(root, p)).href);
const n = Number(process.argv[2]);
function fail(msg) { console.log('STAGE_' + n + '_FAIL: ' + msg); process.exit(1); }
try {
  if (n === 1) {
    const m = await imp('src/discounts/discount.js');
    if (m.applyDiscount(10000, { kind: 'percent', value: 10 }) !== 9000) fail('percent math');
    if (m.applyDiscount(300, { kind: 'fixed', value: 500 }) !== 0) fail('fixed floor at 0');
    if (m.applyDiscount(999, { kind: 'percent', value: 33 }) !== 670) fail('percent flooring');
    let threw = 0;
    try { m.validateDiscount({ kind: 'percent', value: 0 }); } catch { threw++; }
    try { m.validateDiscount({ kind: 'percent', value: 101 }); } catch { threw++; }
    try { m.validateDiscount({ kind: 'bogus', value: 5 }); } catch { threw++; }
    if (threw !== 3) fail('validateDiscount must reject bad kind/value');
    const idx = await imp('src/discounts/index.js');
    if (typeof idx.applyDiscount !== 'function') fail('index must re-export applyDiscount');
  } else if (n === 2) {
    const s = await imp('src/store/discount-store.js');
    const store = s.createDiscountStore();
    const d = store.createDiscount({ code: 'SAVE10', kind: 'percent', value: 10 });
    if (!d.id) fail('discount needs an id');
    if (store.getDiscountByCode('SAVE10').value !== 10) fail('getDiscountByCode round-trip');
    if (store.listDiscounts().length !== 1) fail('listDiscounts');
    if (store.deleteDiscount('SAVE10') !== true) fail('deleteDiscount');
    if (store.getDiscountByCode('SAVE10') !== null) fail('deleted discount must be gone');
    const idx = await imp('src/store/index.js');
    if (typeof idx.createDiscountStore !== 'function') fail('store index must export createDiscountStore');
  } else if (n === 3) {
    const { createInvoiceService } = await imp('src/services/invoice-service.js');
    const { createDiscountStore } = await imp('src/store/discount-store.js');
    const discounts = createDiscountStore();
    discounts.createDiscount({ code: 'SAVE90', kind: 'percent', value: 90 });
    discounts.createDiscount({ code: 'FIVE', kind: 'fixed', value: 500 });
    const svc = createInvoiceService({ discountStore: discounts });
    const plain = svc.createInvoice({ customerId: 'c1', lines: [{ sku: 'A', qty: 1, unitPriceCents: 10000 }] });
    if (plain.totalCents !== 11000 || plain.discountCents !== 0) fail('no-code path changed: ' + JSON.stringify(plain));
    const capped = svc.createInvoice({ customerId: 'c1', lines: [{ sku: 'A', qty: 1, unitPriceCents: 10000 }], discountCode: 'SAVE90' });
    if (capped.discountCents !== 5000) fail('50% cap: expected discountCents 5000, got ' + capped.discountCents);
    if (capped.totalCents !== 5500) fail('capped total: expected 5500, got ' + capped.totalCents);
    const fixed = svc.createInvoice({ customerId: 'c1', lines: [{ sku: 'A', qty: 1, unitPriceCents: 10000 }], discountCode: 'FIVE' });
    if (fixed.discountCents !== 500 || fixed.totalCents !== 10450) fail('fixed discount path: ' + JSON.stringify(fixed));
    let threw = false;
    try { svc.createInvoice({ customerId: 'c1', lines: [{ sku: 'A', qty: 1, unitPriceCents: 100 }], discountCode: 'NOPE' }); } catch { threw = true; }
    if (!threw) fail('unknown discount code must throw');
  } else if (n === 4) {
    const { createDiscountsApi } = await imp('src/api/discounts-api.js');
    const { createDiscountStore } = await imp('src/store/discount-store.js');
    const api = createDiscountsApi({ discountStore: createDiscountStore() });
    const created = api.createDiscount({ code: 'API10', kind: 'percent', value: 10 });
    if (created.status !== 201 || created.body.code !== 'API10') fail('createDiscount handler: ' + JSON.stringify(created));
    const got = api.getDiscount('API10');
    if (got.status !== 200 || got.body.value !== 10) fail('getDiscount handler');
    if (api.getDiscount('MISSING').status !== 404) fail('missing code must 404');
    if (api.listDiscounts().body.length !== 1) fail('listDiscounts handler');
    const idx = await imp('src/api/index.js');
    if (typeof idx.createDiscountsApi !== 'function') fail('api index must export createDiscountsApi');
  } else if (n === 5) {
    if (!existsSync(resolve(root, 'docs/discounts.md'))) fail('docs/discounts.md missing');
    const doc = readFileSync(resolve(root, 'docs/discounts.md'), 'utf8');
    if (!doc.includes('##') || !/discount/i.test(doc)) fail('docs/discounts.md too thin');
    const r = spawnSync(process.execPath, [resolve(root, 'tools/run-tests.mjs')], { encoding: 'utf8' });
    if (r.status !== 0) fail('regression suite not green');
  } else {
    fail('unknown stage');
  }
} catch (e) {
  fail(String(e && e.message ? e.message : e));
}
console.log('STAGE_' + n + '_OK');
`;

// ─── Solution contents (what the scripted model writes, per stage) ──────────

export const SOLUTION_FILES: Record<string, string> = {
  'src/discounts/discount.js': `import { invalid } from '../core/errors.js';
// Pure discount math. Kinds: "percent" (value in (0,100]) and
// "fixed" (value in cents, > 0). applyDiscount never returns below 0.
export function validateDiscount(d) {
  if (!d || typeof d !== 'object') throw invalid('discount');
  if (d.kind === 'percent') {
    if (!(typeof d.value === 'number' && d.value > 0 && d.value <= 100)) throw invalid('percent discount value');
  } else if (d.kind === 'fixed') {
    if (!(typeof d.value === 'number' && d.value > 0)) throw invalid('fixed discount value');
  } else {
    throw invalid('discount kind');
  }
  return d;
}
export function applyDiscount(amountCents, discount) {
  validateDiscount(discount);
  if (discount.kind === 'percent') return amountCents - Math.floor((amountCents * discount.value) / 100);
  return Math.max(0, amountCents - discount.value);
}
export function discountAmountCents(amountCents, discount) {
  return amountCents - applyDiscount(amountCents, discount);
}
`,
  'src/discounts/index.js': `export * from './discount.js';
`,
  'src/store/discount-store.js': `import { nextId } from '../core/ids.js';
import { validateDiscount } from '../discounts/discount.js';
import { invalid, notFound } from '../core/errors.js';
// Discount persistence over an in-memory map, keyed by code.
export function createDiscountStore() {
  const byCode = new Map();
  return {
    createDiscount(input) {
      if (!input || !input.code) throw invalid('discount code');
      validateDiscount(input);
      if (byCode.has(input.code)) throw invalid('duplicate discount code');
      const discount = { id: nextId('disc'), code: input.code, kind: input.kind, value: input.value };
      byCode.set(discount.code, discount);
      return discount;
    },
    getDiscountByCode(code) { return byCode.get(code) ?? null; },
    listDiscounts() { return [...byCode.values()]; },
    deleteDiscount(code) { return byCode.delete(code); },
    requireDiscount(code) {
      const d = byCode.get(code);
      if (!d) throw notFound('discount ' + code);
      return d;
    },
  };
}
`,
  'src/store/index.js': `export * from './memory-store.js';
export * from './store.js';
export * from './discount-store.js';
`,
  'src/services/invoice-service.js': `import { nextId } from '../core/ids.js';
import { computeTaxCents } from '../core/tax.js';
import { mulMoney, addMoney } from '../core/money.js';
import { invalid } from '../core/errors.js';
import { discountAmountCents } from '../discounts/discount.js';

// Invoice totals: subtotal from line items; an optional discount code is
// resolved against the injected discount store and applied to the subtotal
// (total discount capped at 50% of the subtotal); tax is computed on the
// discounted subtotal.
export function createInvoiceService(deps = {}) {
  const invoices = new Map();
  const discountStore = deps.discountStore ?? null;
  function createInvoice(input) {
    if (!input || !Array.isArray(input.lines) || input.lines.length === 0) throw invalid('invoice lines');
    let subtotal = 0;
    for (const line of input.lines) {
      if (!line || !(line.qty > 0) || !(line.unitPriceCents >= 0)) throw invalid('invoice line');
      subtotal = addMoney(subtotal, mulMoney(line.unitPriceCents, line.qty));
    }
    let discountCents = 0;
    if (input.discountCode) {
      if (!discountStore) throw invalid('discount support not configured');
      const discount = discountStore.requireDiscount(input.discountCode);
      discountCents = Math.min(discountAmountCents(subtotal, discount), Math.floor(subtotal / 2));
    }
    const taxable = subtotal - discountCents;
    const taxCents = computeTaxCents(taxable);
    const invoice = {
      id: nextId('inv'),
      customerId: input.customerId,
      lines: input.lines,
      subtotalCents: subtotal,
      discountCents,
      taxCents,
      totalCents: taxable + taxCents,
      status: 'open',
    };
    invoices.set(invoice.id, invoice);
    return invoice;
  }
  function getInvoice(id) { return invoices.get(id) ?? null; }
  return { createInvoice, getInvoice };
}
`,
  'src/api/discounts-api.js': `// Discount handlers: {status, body} results over the discount store.
export function createDiscountsApi({ discountStore }) {
  if (!discountStore) throw new Error('createDiscountsApi requires a discountStore');
  return {
    createDiscount(body) {
      try { return { status: 201, body: discountStore.createDiscount(body) }; }
      catch (e) { return { status: 400, body: { error: String(e.message ?? e) } }; }
    },
    getDiscount(code) {
      const d = discountStore.getDiscountByCode(code);
      return d ? { status: 200, body: d } : { status: 404, body: { error: 'discount not found' } };
    },
    listDiscounts() { return { status: 200, body: discountStore.listDiscounts() }; },
  };
}
`,
  'src/api/index.js': `export * from './invoices-api.js';
export * from './customers-api.js';
export * from './reports-api.js';
export * from './health-api.js';
export * from './discounts-api.js';
`,
  'docs/discounts.md': `# Discounts

Ledgerline supports percentage and fixed-amount discounts end to end.

## Concepts

A discount has a \`code\`, a \`kind\` (\`percent\` or \`fixed\`) and a \`value\`.
Percent values must be in (0, 100]; fixed values are cents and the result
of applying one is floored at zero. Validation lives in
\`src/discounts/discount.js\`.

## Invoices

Pass \`discountCode\` to \`createInvoice\`. The discount is applied to the
subtotal, tax is computed on the discounted subtotal, and the total
discount on one invoice is capped at 50% of the subtotal.

## API

\`createDiscountsApi\` exposes \`createDiscount\`, \`getDiscount\` and
\`listDiscounts\` handlers returning \`{status, body}\` results.
`,
};

export const FAQ_CONTENT = `# Discount FAQ

## Can a discount exceed half an invoice?

No. The total discount on an invoice is capped at 50% of the subtotal,
no matter which code is used.

## What happens with an unknown discount code?

Creating an invoice with an unknown code throws — discounts are never
silently ignored.

## Can a fixed discount make a total negative?

No. Applying a fixed discount floors the discounted amount at zero.
`;

/** writeFileSync with a few quick retries for transient EPERM blips.
 *  Longer EPERM windows (a documented host hazard, AGENTS.md 2026-10-22)
 *  are handled by the driver's batch-level pause-and-retry: failing fast
 *  here keeps a dead window from stretching one fixture write to minutes. */
export function writeFileRetry(path: string, content: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try { writeFileSync(path, content); return; } catch (e) {
      lastErr = e;
      const until = Date.now() + 300 * (attempt + 1);
      while (Date.now() < until) { /* brief spin-wait; sync context */ }
    }
  }
  throw lastErr;
}

/** True when an error is the host's transient write EPERM. */
export function isEperm(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'EPERM';
}

/** Generate the pristine fixture project into `dir`. Returns file count. */
export function generateFixture(dir: string): number {
  const rand = mulberry32(0xC0FFEE);
  void rand; // (seeded for future generated content; layout is fixed today)
  const files: Record<string, string> = {
    ...CORE,
    ...UTILS,
    ...domainFiles(),
    ...STORE_ORIGINAL,
    ...SERVICES,
    ...API,
    ...CONFIG,
    ...TESTS,
    'tools/run-tests.mjs': RUN_TESTS,
    'tools/check-stage.mjs': CHECK_STAGE,
    'package.json': JSON.stringify({ name: 'ledgerline', version: '0.1.0', type: 'module', scripts: { test: 'node tools/run-tests.mjs' } }, null, 2) + '\n',
    'README.md': '# Ledgerline\n\nA small invoicing library: core money/tax helpers, domain entities, an in-memory store, services and a thin API layer.\n\nRun the regression suite with `node tools/run-tests.mjs`.\n',
  };
  let count = 0;
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileRetry(abs, content);
    count++;
  }
  return count;
}
