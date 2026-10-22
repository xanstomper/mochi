// Synthetic monorepo fixture for retrieval benchmarking (Wave J).
//
// Generates a deterministic (seeded) tree of ~2,000 TypeScript files:
//   - 8 CONCEPTS, each implemented across 6 scattered files under
//     non-obvious names: a hub (core symbol, implementation vocabulary),
//     4 satellites in other packages that CALL the hub symbol (so the
//     codegraph has real edges), and 1 anchor whose names/comments use the
//     concept's canonical vocabulary.
//   - 2 DECOYS per concept: files using a canonical word in an unrelated
//     sense, calling nothing. Lexical ranking should bleed recall here.
//   - ~1,950 DISTRACTORS: generic service modules whose vocabulary is
//     disjoint from every concept's vocabulary (asserted in tests).
//
// Queries per concept: one LEXICAL (canonical vocabulary — grep's home
// turf) and one CONCEPTUAL: a plain-language paraphrase of the PROBLEM the
// concept solves, sharing as few content words with the code as an honest
// user query would. Ground truth = the 6 concept files. recall@10 is
// file-level.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface FixtureFileSpec {
  pkg: string;
  file: string;
  symbol: string;
  comment: string;
  /** Hub symbol this file calls (creates a codegraph call edge). */
  calls?: string;
  /** Extra vocabulary lines (doc comment body) beyond the one-liner. */
  body?: string[];
}

export interface FixtureConcept {
  id: string;
  hub: FixtureFileSpec;
  anchor: FixtureFileSpec;
  satellites: FixtureFileSpec[];
  decoys: FixtureFileSpec[];
  lexicalQuery: string;
  conceptualQuery: string;
}

export interface FixtureQuery {
  text: string;
  kind: 'lexical' | 'conceptual';
  conceptId: string;
  relevant: string[];
}

export interface MonorepoFixture {
  root: string;
  fileCount: number;
  concepts: FixtureConcept[];
  queries: FixtureQuery[];
  plantedFiles: string[];
  distractorFiles: string[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rel = (s: FixtureFileSpec): string => `packages/${s.pkg}/src/${s.file}`;

function renderModule(spec: FixtureFileSpec, hubImport?: { symbol: string; from: string }): string {
  const lines: string[] = [];
  if (hubImport) lines.push(`import { ${hubImport.symbol} } from '${hubImport.from}';`, '');
  lines.push('/**');
  lines.push(` * ${spec.comment}`);
  for (const b of spec.body ?? []) lines.push(` * ${b}`);
  lines.push(' */');
  lines.push(`export function ${spec.symbol}(input: Record<string, unknown>): Record<string, unknown> {`);
  if (hubImport) {
    lines.push(`  const gate = ${hubImport.symbol}(input);`);
    lines.push(`  if (!gate) return { skipped: true };`);
  }
  lines.push(`  const stamp = Date.now();`);
  lines.push(`  return { ...input, processedBy: '${spec.symbol}', stamp };`);
  lines.push('}');
  lines.push('');
  lines.push(`export function describe${spec.symbol}( ): string {`);
  lines.push(`  return '${spec.symbol} in ${spec.file}';`);
  lines.push('}');
  return lines.join('\n') + '\n';
}

function renderHub(spec: FixtureFileSpec): string {
  const lines: string[] = [
    '/**',
    ` * ${spec.comment}`,
    ...(spec.body ?? []).map((b) => ` * ${b}`),
    ' */',
    `export function ${spec.symbol}(input: Record<string, unknown>): Record<string, unknown> | null {`,
    '  const now = Date.now();',
    '  const state = (input.state as Record<string, unknown> | undefined) ?? {};',
    '  if (state.owner && state.expiresAt && Number(state.expiresAt) > now) return null;',
    '  return { ...state, owner: input.owner ?? "node", acquiredAt: now };',
    '}',
    '',
    `export function ${spec.symbol}Peek(input: Record<string, unknown>): boolean {`,
    '  const state = (input.state as Record<string, unknown> | undefined) ?? {};',
    '  return Boolean(state.owner);',
    '}',
    '',
  ];
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Concept definitions. Canonical vocabulary lives in the anchor + lexical
// query; implementation vocabulary lives in the hub, satellites and the
// conceptual query. The two vocabularies overlap as little as honest code
// allows.
// ---------------------------------------------------------------------------

export const FIXTURE_CONCEPTS: FixtureConcept[] = [
  {
    id: 'lease',
    hub: {
      pkg: 'cluster-core', file: 'fencing-lease.ts', symbol: 'acquireFencingLease',
      comment: 'Grants a fencing token to a single holder; the token carries a monotonic epoch and a ttl.',
      body: ['Renewal is a heartbeat that extends the expiry while the epoch still matches.', 'A stale holder is fenced off once a higher epoch appears.'],
    },
    anchor: {
      pkg: 'cluster-core', file: 'distributed-lock.ts', symbol: 'withDistributedLock', calls: 'acquireFencingLease',
      comment: 'Distributed lock with lease-based mutual exclusion so only one worker runs a critical section at a time.',
    },
    satellites: [
      { pkg: 'jobs', file: 'nightly-rollup-guard.ts', symbol: 'guardNightlyRollup', calls: 'acquireFencingLease', comment: 'Runs the rollup only while this node holds the fencing token; heartbeats extend the ttl during long batches.' },
      { pkg: 'jobs', file: 'billing-close-guard.ts', symbol: 'guardBillingClose', calls: 'acquireFencingLease', comment: 'Prevents two schedulers from closing the same period by fencing on the epoch counter.' },
      { pkg: 'stream', file: 'partition-owner.ts', symbol: 'claimPartition', calls: 'acquireFencingLease', comment: 'Claims a stream partition; the heartbeat keeps the claim alive and expiry hands it to another node.' },
      { pkg: 'cluster-core', file: 'leader-tick.ts', symbol: 'runLeaderTick', calls: 'acquireFencingLease', comment: 'Executes leader-only maintenance while the fencing epoch belongs to this process.' },
    ],
    decoys: [
      { pkg: 'web-ui', file: 'screen-lock.ts', symbol: 'showScreenLock', comment: 'Idle timeout overlay that locks the screen until the user re-enters a passcode.' },
      { pkg: 'billing', file: 'invoice-lock.ts', symbol: 'lockInvoicePeriod', comment: 'Marks an invoice period as locked so posted totals cannot be edited after close.' },
    ],
    lexicalQuery: 'distributed lock with a lease for mutual exclusion between workers',
    conceptualQuery: 'make sure a scheduled job runs on only one machine even when several schedulers try to start it at once',
  },
  {
    id: 'retry',
    hub: {
      pkg: 'net-core', file: 'jitter-schedule.ts', symbol: 'nextJitteredDelay',
      comment: 'Computes the next wait between attempts: the base delay doubles each round, is capped, and is decorrelated with random jitter.',
      body: ['The attempt budget is fixed by the caller; this helper owns only the spacing.', 'Full jitter keeps fleets of callers from synchronising their next attempts.'],
    },
    anchor: {
      pkg: 'net-core', file: 'retry-policy.ts', symbol: 'exponentialBackoffRetry', calls: 'nextJitteredDelay',
      comment: 'Retry policy with exponential backoff: failed calls are retried after growing delays until the attempt budget runs out.',
    },
    satellites: [
      { pkg: 'integrations', file: 'webhook-delivery-worker.ts', symbol: 'deliverWithSpacing', calls: 'nextJitteredDelay', comment: 'Spaces out webhook delivery attempts using the jittered schedule after a non-2xx response.' },
      { pkg: 'queue', file: 'consumer-requeue.ts', symbol: 'requeueWithDelay', calls: 'nextJitteredDelay', comment: 'Returns a failed message to the queue after a capped, decorrelated wait.' },
      { pkg: 'storage', file: 'blob-upload-driver.ts', symbol: 'uploadWithSpacing', calls: 'nextJitteredDelay', comment: 'Repeats chunk uploads whose checksums mismatch, waiting longer between each round.' },
      { pkg: 'net-core', file: 'dns-refresh.ts', symbol: 'refreshWithBackoffSpacing', calls: 'nextJitteredDelay', comment: 'Refreshes stale DNS answers; consecutive failures stretch the interval via the shared spacing helper.' },
    ],
    decoys: [
      { pkg: 'games', file: 'retry-level.ts', symbol: 'retryLevel', comment: 'Restarts the current game level from the last checkpoint when the player chooses retry.' },
      { pkg: 'web-ui', file: 'form-retry-banner.ts', symbol: 'showRetryBanner', comment: 'Shows a banner offering to retry submitting the form after a validation error.' },
    ],
    lexicalQuery: 'exponential backoff retry policy for failed calls',
    conceptualQuery: 'when a remote call keeps failing, wait longer and longer between tries and randomise the waits',
  },
  {
    id: 'idempotency',
    hub: {
      pkg: 'payments-core', file: 'submission-fingerprint.ts', symbol: 'fingerprintSubmission',
      comment: 'Hashes a normalised submission into a fingerprint; a repeat arrival with the same fingerprint replays the stored response instead of executing twice.',
      body: ['The fingerprint covers the amount, currency, account and client reference.', 'Stored responses are kept for a day so late duplicates still replay.'],
    },
    anchor: {
      pkg: 'payments-core', file: 'idempotency-key.ts', symbol: 'withIdempotencyKey', calls: 'fingerprintSubmission',
      comment: 'Idempotency key handling: a payment carrying an idempotency key is charged once even when the request is submitted twice.',
    },
    satellites: [
      { pkg: 'payments', file: 'charge-endpoint.ts', symbol: 'handleCharge', calls: 'fingerprintSubmission', comment: 'Charge endpoint: duplicate submissions are detected by fingerprint and answered with the original receipt.' },
      { pkg: 'orders', file: 'order-submit.ts', symbol: 'submitOrder', calls: 'fingerprintSubmission', comment: 'Order intake dedupes double-clicks and client retries by comparing the submission fingerprint.' },
      { pkg: 'payouts', file: 'payout-release.ts', symbol: 'releasePayout', calls: 'fingerprintSubmission', comment: 'Releases a payout once; a repeated release call replays the stored transfer record.' },
      { pkg: 'refunds', file: 'refund-issue.ts', symbol: 'issueRefund', calls: 'fingerprintSubmission', comment: 'Issues a refund guarded by the fingerprint store so a refund is never paid out twice.' },
    ],
    decoys: [
      { pkg: 'files', file: 'dedupe-upload.ts', symbol: 'dedupeUpload', comment: 'Skips uploading a file whose content hash already exists in the blob store.' },
      { pkg: 'web-ui', file: 'double-submit-guard.ts', symbol: 'guardDoubleSubmit', comment: 'Disables the submit button after the first click to prevent a double submission in the browser.' },
    ],
    lexicalQuery: 'idempotency key so a payment is only charged once',
    conceptualQuery: 'a customer who double-clicks pay, or whose app resubmits the form, must not end up charged twice',
  },
  {
    id: 'ratelimit',
    hub: {
      pkg: 'gateway-core', file: 'token-bucket.ts', symbol: 'consumeBucketToken',
      comment: 'Token bucket: each caller holds a bucket that refills on an interval; a request consumes one token and bursts are allowed up to the bucket size.',
      body: ['Refill is computed lazily from the elapsed time, no background timer.', 'Separate buckets per caller keep one noisy client from draining the others.'],
    },
    anchor: {
      pkg: 'gateway-core', file: 'rate-limiter.ts', symbol: 'rateLimit', calls: 'consumeBucketToken',
      comment: 'Rate limiting middleware: throttles requests per client once the quota for the window is exhausted.',
    },
    satellites: [
      { pkg: 'gateway', file: 'public-api-gate.ts', symbol: 'gatePublicApi', calls: 'consumeBucketToken', comment: 'Admits public API calls while the caller bucket has tokens; rejects with a refill hint otherwise.' },
      { pkg: 'gateway', file: 'search-endpoint-gate.ts', symbol: 'gateSearch', calls: 'consumeBucketToken', comment: 'Search is expensive, so it draws from a smaller bucket with a slower refill interval.' },
      { pkg: 'mailer', file: 'outbound-throttle.ts', symbol: 'throttleOutbound', calls: 'consumeBucketToken', comment: 'Paces outbound mail through the shared bucket so provider burst limits are respected.' },
      { pkg: 'gateway-core', file: 'partner-feed-gate.ts', symbol: 'gatePartnerFeed', calls: 'consumeBucketToken', comment: 'Partner feeds poll aggressively; the bucket smooths their polls into the allowed burst.' },
    ],
    decoys: [
      { pkg: 'web-ui', file: 'scroll-throttle.ts', symbol: 'throttleScroll', comment: 'Throttles scroll event handlers in the browser so repaints stay cheap.' },
      { pkg: 'media', file: 'bitrate-limiter.ts', symbol: 'limitBitrate', comment: 'Caps the encoding bitrate for uploaded video renditions.' },
    ],
    lexicalQuery: 'rate limiting and throttling of requests per client quota',
    conceptualQuery: 'keep any single client from flooding the api while still allowing short bursts of traffic',
  },
  {
    id: 'circuitbreaker',
    hub: {
      pkg: 'net-core', file: 'breaker-state.ts', symbol: 'recordOutcome',
      comment: 'Tracks a rolling error window per dependency; when failures cross the trip line the state opens, and after a cool-down a single half-open probe tests recovery.',
      body: ['While open, calls fail fast without touching the dependency.', 'A successful probe closes the state; a failed probe reopens it.'],
    },
    anchor: {
      pkg: 'net-core', file: 'circuit-breaker.ts', symbol: 'circuitBreaker', calls: 'recordOutcome',
      comment: 'Circuit breaker: stops calling a failing dependency once the failure threshold is crossed, protecting the caller from cascading failure.',
    },
    satellites: [
      { pkg: 'integrations', file: 'crm-client-guard.ts', symbol: 'guardedCrmCall', calls: 'recordOutcome', comment: 'Wraps CRM calls; outcomes feed the shared error window so a sick CRM trips fast.' },
      { pkg: 'search', file: 'index-client-guard.ts', symbol: 'guardedIndexCall', calls: 'recordOutcome', comment: 'Search index calls report into the breaker state and short-circuit while it is open.' },
      { pkg: 'payments', file: 'psp-client-guard.ts', symbol: 'guardedPspCall', calls: 'recordOutcome', comment: 'Payment provider calls are cut off after repeated timeouts until a probe succeeds.' },
      { pkg: 'net-core', file: 'grpc-channel-guard.ts', symbol: 'guardedChannelCall', calls: 'recordOutcome', comment: 'Channel calls record outcomes; an open state sheds load instead of queueing behind a dead peer.' },
    ],
    decoys: [
      { pkg: 'web-ui', file: 'error-boundary.ts', symbol: 'renderErrorBoundary', comment: 'React error boundary that renders a fallback panel when a subtree throws.' },
      { pkg: 'ops', file: 'fuse-panel.ts', symbol: 'inspectFusePanel', comment: 'Reports the state of electrical fuse panels in the facility checklist tooling.' },
    ],
    lexicalQuery: 'circuit breaker that stops calling a failing dependency after a failure threshold',
    conceptualQuery: 'when a downstream service is down, fail immediately instead of piling up waiting calls, then test it carefully later',
  },
  {
    id: 'saga',
    hub: {
      pkg: 'orders-core', file: 'step-compensation.ts', symbol: 'registerCompensation',
      comment: 'Registers an undo action for each completed step; when a later step fails, the registered actions run in reverse order to unwind the workflow.',
      body: ['Compensations must themselves be safe to repeat.', 'The log of completed steps is durable so a crash mid-unwind can resume.'],
    },
    anchor: {
      pkg: 'orders-core', file: 'saga-orchestrator.ts', symbol: 'runSaga', calls: 'registerCompensation',
      comment: 'Saga orchestration: a multi-step transaction with a compensating rollback for every step when the workflow cannot complete.',
    },
    satellites: [
      { pkg: 'orders', file: 'checkout-flow.ts', symbol: 'runCheckoutFlow', calls: 'registerCompensation', comment: 'Reserves stock, takes payment, books shipment; each step registers its undo so a failure unwinds cleanly.' },
      { pkg: 'travel', file: 'trip-booking-flow.ts', symbol: 'runTripBooking', calls: 'registerCompensation', comment: 'Books flight, hotel and car as one workflow; a failed leg triggers the compensations of the earlier legs.' },
      { pkg: 'accounts', file: 'account-opening-flow.ts', symbol: 'runAccountOpening', calls: 'registerCompensation', comment: 'Creates identity, wallet and card records step by step, unwinding earlier steps when verification fails.' },
      { pkg: 'orders-core', file: 'provisioning-flow.ts', symbol: 'runProvisioning', calls: 'registerCompensation', comment: 'Provisions tenant resources in sequence and releases them in reverse when a step errors.' },
    ],
    decoys: [
      { pkg: 'web-ui', file: 'undo-history.ts', symbol: 'pushUndoHistory', comment: 'Editor undo history: keeps a stack of document snapshots for ctrl-z.' },
      { pkg: 'db', file: 'migration-rollback.ts', symbol: 'rollbackMigration', comment: 'Runs the down migration that reverses the most recent schema change.' },
    ],
    lexicalQuery: 'saga with compensating rollback for a multi-step transaction',
    conceptualQuery: 'a booking that fails halfway must undo everything it already reserved, in the opposite order',
  },
  {
    id: 'cache',
    hub: {
      pkg: 'cache-core', file: 'tag-purge.ts', symbol: 'purgeByTag',
      comment: 'Invalidates cached entries by tag: every entry carries tags and a version stamp, and purging a tag evicts the whole group at once.',
      body: ['Version stamps let readers detect that an entry predates a purge.', 'Purges are broadcast so peer processes drop the same tags.'],
    },
    anchor: {
      pkg: 'cache-core', file: 'cache-invalidation.ts', symbol: 'invalidateCache', calls: 'purgeByTag',
      comment: 'Cache invalidation service: removes stale cache entries when the underlying records change.',
    },
    satellites: [
      { pkg: 'catalog', file: 'product-publisher.ts', symbol: 'publishProduct', calls: 'purgeByTag', comment: 'Publishing a product purges its tag group so storefront readers stop serving the old entry.' },
      { pkg: 'cms', file: 'page-publisher.ts', symbol: 'publishPage', calls: 'purgeByTag', comment: 'Page edits bump the version stamp and purge the page tag across edge caches.' },
      { pkg: 'pricing', file: 'price-updater.ts', symbol: 'updatePrices', calls: 'purgeByTag', comment: 'Price changes evict the affected tag groups instead of waiting for entries to age out.' },
      { pkg: 'cache-core', file: 'profile-cache-warmer.ts', symbol: 'warmProfileCache', calls: 'purgeByTag', comment: 'Warms profile entries after purging the user tag invalidated by a settings change.' },
    ],
    decoys: [
      { pkg: 'media', file: 'thumbnail-store.ts', symbol: 'storeThumbnail', comment: 'Stores generated thumbnails in a content-addressed cache directory.' },
      { pkg: 'web-ui', file: 'stale-banner.ts', symbol: 'showStaleBanner', comment: 'Banner warning that the page data may be stale and offering a refresh.' },
    ],
    lexicalQuery: 'cache invalidation for stale cache entries',
    conceptualQuery: 'after a product changes, shoppers must not keep seeing the old price from cached pages',
  },
  {
    id: 'webhook',
    hub: {
      pkg: 'integrations-core', file: 'hmac-verify.ts', symbol: 'verifyHmacDigest',
      comment: 'Verifies a delivery by recomputing the hmac digest over the raw body with the shared secret and comparing in constant time; the timestamp must fall inside the tolerance window.',
      body: ['Deliveries older than the window are rejected to close the replay gap.', 'The digest covers the timestamp as well as the body.'],
    },
    anchor: {
      pkg: 'integrations-core', file: 'webhook-signature.ts', symbol: 'checkWebhookSignature', calls: 'verifyHmacDigest',
      comment: 'Webhook signature verification: rejects any webhook whose signature does not match the payload.',
    },
    satellites: [
      { pkg: 'integrations', file: 'stripe-events.ts', symbol: 'handleStripeEvent', calls: 'verifyHmacDigest', comment: 'Inbound payment events are accepted only after the digest check passes.' },
      { pkg: 'integrations', file: 'github-events.ts', symbol: 'handleGithubEvent', calls: 'verifyHmacDigest', comment: 'Repository event deliveries are verified against the shared secret before any handler runs.' },
      { pkg: 'integrations', file: 'carrier-events.ts', symbol: 'handleCarrierEvent', calls: 'verifyHmacDigest', comment: 'Shipping carrier callbacks are dropped when the recomputed digest differs.' },
      { pkg: 'integrations-core', file: 'partner-events.ts', symbol: 'handlePartnerEvent', calls: 'verifyHmacDigest', comment: 'Partner event intake enforces the timestamp tolerance window to stop replayed deliveries.' },
    ],
    decoys: [
      { pkg: 'web-ui', file: 'signature-pad.ts', symbol: 'renderSignaturePad', comment: 'Canvas pad where a customer draws a signature with the pointer.' },
      { pkg: 'docs', file: 'signature-guide.ts', symbol: 'signatureGuide', comment: 'Renders the documentation page about email signature formatting.' },
    ],
    lexicalQuery: 'webhook signature verification for incoming webhooks',
    conceptualQuery: 'check that an incoming event notification really came from the provider and was not forged or resent later',
  },
];

/** Words that must never appear in distractor files: every concept's
 *  discriminative vocabulary, canonical and implementation alike. */
export const FIXTURE_FORBIDDEN_WORDS = [
  'lease', 'fencing', 'heartbeat', 'ttl', 'mutex', 'mutual', 'backoff', 'jitter',
  'idempotency', 'idempotent', 'fingerprint', 'dedupe', 'bucket', 'throttle',
  'quota', 'breaker', 'half-open', 'half', 'probe', 'saga', 'compensation',
  'compensating', 'rollback', 'purge', 'evict', 'invalidation', 'invalidate',
  'stale', 'hmac', 'digest', 'webhook', 'signature', 'replay',
];

const DISTRACTOR_DOMAINS = [
  'accounts', 'reports', 'catalog', 'inventory', 'shipping', 'analytics',
  'profiles', 'settings', 'media', 'comments', 'pricing', 'audit', 'geo',
  'imports', 'exports', 'templates', 'labels', 'reviews', 'coupons',
];
const DISTRACTOR_KINDS = ['service', 'handler', 'manager', 'planner', 'builder', 'reporter', 'loader', 'writer'];
const DISTRACTOR_PHRASES = [
  'Coordinates routine record keeping for the module and keeps identifiers consistent.',
  'Builds the summary view consumed by the operator console.',
  'Normalises incoming records and forwards them to the storage layer.',
  'Assembles the listing shown on the overview page.',
  'Keeps the module configuration in sync with the workspace defaults.',
  'Formats rows for export and applies the standard column ordering.',
  'Tracks counts and totals for the monthly summary.',
  'Resolves display names for records referenced by other modules.',
];

function renderDistractor(rng: () => number, domain: string, kind: string, n: number): string {
  const phrase = DISTRACTOR_PHRASES[Math.floor(rng() * DISTRACTOR_PHRASES.length)];
  const name = `${domain}${kind.charAt(0).toUpperCase()}${kind.slice(1)}${n}`;
  return [
    '/**',
    ` * ${phrase}`,
    ' */',
    `export class ${name} {`,
    '  private readonly entries = new Map<string, Record<string, unknown>>();',
    '',
    '  add(id: string, record: Record<string, unknown>): void {',
    '    this.entries.set(id, record);',
    '  }',
    '',
    '  get(id: string): Record<string, unknown> | undefined {',
    '    return this.entries.get(id);',
    '  }',
    '',
    '  count(): number {',
    '    return this.entries.size;',
    '  }',
    '}',
    '',
    `export function describe${name}(): string {`,
    `  return '${name} module';`,
    '}',
    '',
  ].join('\n');
}

export function generateMonorepoFixture(
  root: string,
  opts: { totalFiles?: number; seed?: number } = {},
): MonorepoFixture {
  const totalFiles = opts.totalFiles ?? 2048;
  const rng = mulberry32(opts.seed ?? 20261022);
  const plantedFiles: string[] = [];
  const write = (relPath: string, content: string) => {
    const abs = resolve(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  const queries: FixtureQuery[] = [];
  for (const concept of FIXTURE_CONCEPTS) {
    const hubRel = rel(concept.hub);
    const hubFrom = `../../${concept.hub.pkg}/src/${concept.hub.file.replace(/\.ts$/, '')}`;
    write(hubRel, renderHub(concept.hub));
    plantedFiles.push(hubRel);
    const anchorRel = rel(concept.anchor);
    write(anchorRel, renderModule(concept.anchor, { symbol: concept.hub.symbol, from: hubFrom }));
    plantedFiles.push(anchorRel);
    const satelliteRels: string[] = [];
    for (const sat of concept.satellites) {
      const satRel = rel(sat);
      write(satRel, renderModule(sat, { symbol: concept.hub.symbol, from: hubFrom }));
      plantedFiles.push(satRel);
      satelliteRels.push(satRel);
    }
    for (const decoy of concept.decoys) {
      const decoyRel = rel(decoy);
      write(decoyRel, renderModule(decoy));
      plantedFiles.push(decoyRel);
    }
    const relevant = [hubRel, anchorRel, ...satelliteRels];
    queries.push({ text: concept.lexicalQuery, kind: 'lexical', conceptId: concept.id, relevant });
    queries.push({ text: concept.conceptualQuery, kind: 'conceptual', conceptId: concept.id, relevant });
  }

  const distractorFiles: string[] = [];
  let n = 0;
  while (plantedFiles.length + distractorFiles.length < totalFiles) {
    const domain = DISTRACTOR_DOMAINS[n % DISTRACTOR_DOMAINS.length];
    const kind = DISTRACTOR_KINDS[Math.floor(rng() * DISTRACTOR_KINDS.length)];
    const pkg = `pkg-${String(n % 40).padStart(2, '0')}`;
    const fileRel = `packages/${pkg}/src/${domain}-${kind}-${n}.ts`;
    write(fileRel, renderDistractor(rng, domain, kind, n));
    distractorFiles.push(fileRel);
    n++;
  }

  return {
    root,
    fileCount: plantedFiles.length + distractorFiles.length,
    concepts: FIXTURE_CONCEPTS,
    queries,
    plantedFiles,
    distractorFiles,
  };
}
