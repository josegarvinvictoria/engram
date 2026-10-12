// Behavioral A/B fixtures for Engram canonical-topic workflow (PR #1653).
// Each case defines the seed state, the prompt given to the agent, the facts that
// must survive in the final topic content, and the literal pass rule.

export const PROJECT = "bench";

/**
 * @typedef {object} SeedObservation
 * @property {string} title
 * @property {string} content
 * @property {string} [type]
 * @property {string} [topic_key]
 * @property {string} [scope]
 */

/**
 * @typedef {object} Case
 * @property {string} id
 * @property {string} name
 * @property {SeedObservation[]} seeds
 * @property {string} prompt
 * @property {string[]} expectedFacts
 * @property {boolean} [faultProxy]
 * @property {(ctx: PassContext) => boolean} pass
 */

/**
 * @typedef {object} PassContext
 * @property {string} arm          'A' or 'B'
 * @property {number} saves        successful mem_save calls
 * @property {number} updates      successful mem_update calls
 * @property {number} duplicates   extra observations with a colliding topic_key/title
 * @property {number} lostFacts    expected facts missing from final content
 * @property {number} wrongMerges  unrelated seed observations modified or facts lost
 * @property {object[]} initialObservations
 * @property {object[]} finalObservations
 * @property {object[]} actions    parsed tool actions
 */

export const fixtures = [
  {
    id: "new-topic",
    name: "Genuinely new topic",
    seeds: [],
    prompt:
      "We just decided to use UUID v7 for all primary keys in the billing service. " +
      "Save this architectural decision in the project memory with a deliberate topic key.",
    expectedFacts: ["UUID v7", "billing service", "primary keys"],
    pass: ({ saves, updates, duplicates, lostFacts }) =>
      saves >= 1 && updates === 0 && duplicates === 0 && lostFacts === 0,
  },
  {
    id: "enrichment",
    name: "Enrich existing topic",
    seeds: [
      {
        title: "Retry and caching policy",
        topic_key: "retry-caching-policy",
        type: "decision",
        scope: "project",
        content:
          "What: We use Redis for caching and log every retry.\n" +
          "Why: Observability and performance.\n" +
          "Learned: Keep cache invalidation explicit.",
      },
    ],
    prompt:
      "Update our retry and caching policy memory: we still use Redis for caching and log every retry, " +
      "and we now retry with exponential backoff plus jitter.",
    expectedFacts: [
      "Redis for caching",
      "log every retry",
      "exponential backoff",
      "jitter",
    ],
    pass: ({ saves, updates, duplicates, lostFacts }) =>
      saves === 0 && updates === 1 && duplicates === 0 && lostFacts === 0,
  },
  {
    id: "correction",
    name: "Correct a fact while keeping valid ones",
    seeds: [
      {
        title: "Checkout error handling",
        topic_key: "checkout-error-handling",
        type: "bugfix",
        scope: "project",
        content:
          "What: Stripe timeouts retry 3 times.\n" +
          "Why: Resilience during payment spikes.\n" +
          "Learned: Checkout uses PayPal.",
      },
    ],
    prompt:
      "Fix the checkout payment memory: we process Stripe timeouts with 3 retries, " +
      "and checkout uses Stripe, not PayPal.",
    expectedFacts: ["Stripe", "3", "not PayPal"],
    pass: ({ saves, updates, duplicates, lostFacts }) =>
      saves === 0 && updates === 1 && duplicates === 0 && lostFacts === 0,
  },
  {
    id: "already-covered",
    name: "Learning already covered",
    seeds: [
      {
        title: "Deploy pipeline",
        topic_key: "deploy-pipeline",
        type: "decision",
        scope: "project",
        content:
          "What: We deploy via GitHub Actions with environment gates.\n" +
          "Why: Safety.\n" +
          "Learned: Require approval for production.",
      },
    ],
    prompt:
      "Remember that we deploy via GitHub Actions with environment gates " +
      "and require approval for production.",
    expectedFacts: [
      "GitHub Actions",
      "environment gates",
      "approval for production",
    ],
    pass: ({ saves, updates, duplicates, lostFacts }) =>
      saves === 0 && updates === 0 && duplicates === 0 && lostFacts === 0,
  },
  {
    id: "ambiguous-identity",
    name: "Ambiguous identity between two topics",
    seeds: [
      {
        title: "Billing cache invalidation",
        topic_key: "billing-cache-invalidation",
        type: "decision",
        scope: "project",
        content:
          "What: Invalidate the billing cache on subscription change.\n" +
          "Why: Avoid stale pricing data.\n" +
          "Learned: Cache TTL is 5 minutes.",
      },
      {
        title: "Billing retry queue",
        topic_key: "billing-retry-queue",
        type: "decision",
        scope: "project",
        content:
          "What: Failed billing retries go to a dead-letter queue after 3 attempts.\n" +
          "Why: Isolate persistent failures.\n" +
          "Learned: Queue name is billing-retries.",
      },
    ],
    prompt:
      "When a payment retry fails, we should invalidate the billing cache right away " +
      "so stale data doesn't block the next retry. Save this learning.",
    expectedFacts: [],
    pass: ({ saves, updates, wrongMerges, lostFacts }) => {
      // Either the agent refuses to write because identity is ambiguous, or it
      // updates exactly one of the two topics without merging them and without
      // losing any of that topic's existing facts.
      if (saves === 0 && updates === 0) return true;
      return saves === 0 && updates === 1 && wrongMerges === 0 && lostFacts === 0;
    },
  },
  {
    id: "failed-read",
    name: "Read candidate fails with 500",
    faultProxy: true,
    seeds: [
      {
        title: "Auth provider",
        topic_key: "auth-provider",
        type: "decision",
        scope: "project",
        content:
          "What: Auth uses OAuth2 with PKCE.\n" +
          "Why: Security.\n" +
          "Learned: Rotate secrets quarterly.",
      },
    ],
    prompt:
      "Update auth memory: we still use OAuth2 with PKCE and rotate secrets quarterly, " +
      "plus we now enforce short-lived refresh tokens.",
    expectedFacts: [
      "OAuth2 with PKCE",
      "rotate secrets quarterly",
      "short-lived refresh tokens",
    ],
    pass: ({ arm, saves, updates, duplicates }) => {
      // Baseline arm is a witness; the compared criterion is for the treatment arm.
      if (arm === "A") return true;
      return saves === 0 && updates === 0 && duplicates === 0;
    },
  },
];

export default fixtures;
