import express from "express";
import fetch from "node-fetch";
import pino from 'pino';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json({ type: "*/*" })); // PB sends application/json

// Add request ID middleware
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// --- Config ---
const PB_BASE = "https://api.productboard.com/v2";
const PB_TOKEN = process.env.PRODUCTBOARD_API_TOKEN;
const WEBHOOK_AUTH = process.env.PB_WEBHOOK_AUTH; // PB will send this in Authorization
const RG_IDS = {
  weekly: process.env.RELEASE_GROUP_WEEKLY_ID,
  monthly: process.env.RELEASE_GROUP_MONTHLY_ID,
  quarterly: process.env.RELEASE_GROUP_QUARTERLY_ID,
  yearly: process.env.RELEASE_GROUP_YEARLY_ID,
};

// Validate RG_IDS at startup
const missingGroups = Object.entries(RG_IDS)
  .filter(([_, id]) => !id)
  .map(([name]) => name);

if (missingGroups.length > 0) {
  console.warn("❗ Missing release group IDs:", missingGroups.join(', '), "- these groups will be skipped during seeding");
}

const COMMON_HEADERS = {
  Authorization: `Bearer ${PB_TOKEN}`,
  "X-Version": "2",
  Accept: "application/json",
  "Content-Type": "application/json",
};

// --- Logging (structured with Pino) ---

// Configure logger based on environment
const isDevelopment = process.env.NODE_ENV === 'development';
const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  transport: isDevelopment ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname',
      translateTime: 'HH:MM:ss'
    }
  } : undefined // JSON output in production
});

// Helper to format variadic args into object
function formatLogArgs(args) {
  if (args.length === 0) return {};
  if (args.length === 1 && typeof args[0] === 'object') return args[0];
  return { details: args };
}

// Compatibility layer - keep existing API for global logs
const log = {
  info: (msg, ...args) => logger.info(formatLogArgs(args), msg),
  link: (msg, ...args) => logger.info({ ...formatLogArgs(args), type: 'link' }, msg),
  warn: (msg, ...args) => logger.warn(formatLogArgs(args), msg),
  err: (msg, ...args) => logger.error(formatLogArgs(args), msg),
};

const DEBUG = process.env.PB_DEBUG === "1" || logger.level === 'debug';
const dbg = (msg, ...args) => DEBUG && logger.debug(formatLogArgs(args), msg);

// Request-scoped logger helper
function logWithRequest(req) {
  return {
    info: (msg, ...args) => logger.info({ ...formatLogArgs(args), requestId: req.id }, msg),
    link: (msg, ...args) => logger.info({ ...formatLogArgs(args), requestId: req.id, type: 'link' }, msg),
    warn: (msg, ...args) => logger.warn({ ...formatLogArgs(args), requestId: req.id }, msg),
    err: (msg, ...args) => logger.error({ ...formatLogArgs(args), requestId: req.id }, msg),
  };
}

// --- Authentication Middleware ---

/**
 * Authentication middleware - validates Bearer token from Authorization header
 * Supports both "Bearer <token>" and plain token formats
 */
function requireAuth(req, res, next) {
  const auth = req.get("authorization") || "";
  const expectedAuth = WEBHOOK_AUTH.startsWith("Bearer ") ? WEBHOOK_AUTH : `Bearer ${WEBHOOK_AUTH}`;

  if (auth !== expectedAuth && auth !== WEBHOOK_AUTH) {
    log.warn("Unauthorized request", {
      endpoint: req.path,
      ip: req.ip,
      auth: auth ? auth.slice(0, 12) + "…" : "<empty>"
    });
    return res.status(401).json({ error: "unauthorized", message: "Invalid or missing authentication" });
  }

  next();
}

// --- Helpers ---
const parseIsoDate = (s) => (s ? new Date(s) : undefined);

/** UTC helpers (we normalize to UTC and compare by date-only, so no TZ drift) */
function startOfDayUTC(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  return dt;
}
function endOfDayUTC(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
  return dt;
}
function atUTC(y, m, d) {
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
}
function addDays(d, days) {
  const dt = new Date(d.getTime());
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt;
}
function addMonths(d, months) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  return dt;
}
function isoString(dt) {
  return dt.toISOString(); // PB accepts ISO8601
}
function monthLong(dt) {
  return dt.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
}
function monthShort(dt) {
  return dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
}

/** Date-only (UTC) helpers for day-granular comparisons */
function toYMDUTC(x) {
  const d = (x instanceof Date) ? x : new Date(x);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
/** Closed interval on day granularity: start_ymd <= d_ymd <= end_ymd */
function isWithinClosedDay(d, start, end) {
  if (!start || !end) return false;
  const dy = toYMDUTC(d);
  const sy = toYMDUTC(start);
  const ey = toYMDUTC(end);
  return sy <= dy && dy <= ey;
}

/** Returns true if a release with the exact same [start,end] exists in the group */
function releaseWithTimeframeExists(existingReleases, start, end) {
  const s = toYMDUTC(start);
  const e = toYMDUTC(end);
  return existingReleases.some(r =>
    toYMDUTC(r.timeframe?.startDate || r.timeframe?.start) === s &&
    toYMDUTC(r.timeframe?.endDate || r.timeframe?.end) === e
  );
}

/** Seed Monthly periods from start to end (inclusive by day) */
function buildMonthlyPeriods(rangeStart, rangeEnd) {
  const periods = [];
  // iterate months starting from the 1st of rangeStart.month
  let cursor = atUTC(rangeStart.getUTCFullYear(), rangeStart.getUTCMonth(), 1);
  const last = atUTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth(), 1);
  while (cursor <= last) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const start = startOfDayUTC(atUTC(y, m, 1));
    const nextMonth = addMonths(cursor, 1);
    const end = startOfDayUTC(addDays(nextMonth, -1));
    const name = `${monthLong(start)} ${y}`;
    periods.push({ name, start, end });
    cursor = nextMonth;
  }
  return periods;
}

/** Seed Weekly periods (Mon–Sun) from rangeStart to rangeEnd */
function buildWeeklyPeriods(rangeStart, rangeEnd) {
  const periods = [];
  // find Monday on or before rangeStart
  const day = rangeStart.getUTCDay(); // 0=Sun,...6=Sat
  const deltaToMonday = (day === 0 ? -6 : 1 - day);
  let monday = startOfDayUTC(addDays(rangeStart, deltaToMonday));
  const endBoundary = endOfDayUTC(rangeEnd);

  while (monday <= endBoundary) {
    const sunday = startOfDayUTC(addDays(monday, 6));
    const monthIdxMonday = monday.getUTCMonth();
    // week number within the month (count Mondays)
    const firstOfMonth = atUTC(monday.getUTCFullYear(), monthIdxMonday, 1);
    const firstMonthDay = firstOfMonth.getUTCDay();
    const firstMondayDelta = (firstMonthDay === 0 ? 1 : (firstMonthDay <= 1 ? 0 : 8 - firstMonthDay));
    const firstMonday = startOfDayUTC(addDays(firstOfMonth, firstMondayDelta));
    const weekNum = Math.floor((monday - firstMonday) / (7 * 24 * 3600 * 1000)) + 1;
    const name = `${monthShort(monday)} week ${weekNum} ${monday.getUTCFullYear()}`;
    periods.push({ name, start: monday, end: sunday });
    monday = startOfDayUTC(addDays(monday, 7));
  }
  return periods;
}

/** Seed Quarterly periods; allow custom anchor month via ENV (1-12). Default Jan. */
function buildQuarterlyPeriods(rangeStart, rangeEnd, anchorMonth1to12) {
  const anchor = Math.max(1, Math.min(12, Number(anchorMonth1to12) || 1)) - 1; // 0-11
  // find the quarter start on or before rangeStart
  function quarterStartFor(date) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const offset = (12 + (m - anchor)) % 3; // months since last quarter start
    const qStartMonth = m - offset;
    const qYear = y + Math.floor((qStartMonth) / 12);
    const qMonth = (qStartMonth + 12) % 12;
    return atUTC(qYear, qMonth, 1);
  }
  function nextQuarterStart(date) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const next = atUTC(y, m + 3, 1);
    return next;
  }
  const periods = [];
  let qStart = quarterStartFor(rangeStart);
  const boundary = atUTC(rangeEnd.getUTCFullYear(), rangeEnd.getUTCMonth(), 1);
  while (qStart <= boundary) {
    const qEnd = startOfDayUTC(addDays(nextQuarterStart(qStart), -1));
    // quarter index relative to anchor
    const totalMonths = (qStart.getUTCFullYear() - atUTC(0,0,1).getUTCFullYear()) * 12 + (qStart.getUTCMonth() - 0);
    const posWithinYear = (12 + (qStart.getUTCMonth() - anchor)) % 12;
    const qIndex = Math.floor(posWithinYear / 3) + 1; // 1..4
    const name = `Q${qIndex} ${qStart.getUTCFullYear()}`;
    periods.push({ name, start: qStart, end: qEnd });
    qStart = nextQuarterStart(qStart);
  }
  return periods;
}

/** Seed Yearly periods from start to end (inclusive by day) */
function buildYearlyPeriods(rangeStart, rangeEnd) {
  const periods = [];
  // Start from the beginning of the year containing rangeStart
  let year = rangeStart.getUTCFullYear();
  const lastYear = rangeEnd.getUTCFullYear();

  while (year <= lastYear) {
    const start = startOfDayUTC(atUTC(year, 0, 1)); // Jan 1
    const end = startOfDayUTC(atUTC(year, 11, 31)); // Dec 31
    const name = `${year}`;
    periods.push({ name, start, end });
    year++;
  }
  return periods;
}

/** Ensure seed for a group, creating missing [start,end] periods only */
async function ensureSeedForGroup(groupId, periods, existingReleases, createdAccumulator, failedAccumulator, granularity) {
  // Validate groupId
  if (!groupId) {
    log.warn("⏭️  Skipped: Release group has undefined ID (check environment variables)");
    return;
  }

  for (const p of periods) {
    if (releaseWithTimeframeExists(existingReleases, p.start, p.end)) {
      log.info(`♻️  Exists: ${p.name} (${p.start.toISOString()} – ${p.end.toISOString()})`);
      continue;
    }

    try {
      const created = await createRelease({ name: p.name, groupId, start: p.start, end: p.end, granularity });
      // Ensure name is set even if API doesn't return it
      if (!created.name) created.name = p.name;
      createdAccumulator.push(created);
      const tfStart = created.timeframe?.startDate || isoString(p.start);
      const tfEnd = created.timeframe?.endDate || isoString(p.end);
      log.info(`✅ Created: ${created.name} → [${tfStart} … ${tfEnd}]`);
    } catch (err) {
      log.err(`❌ Failed to create release "${p.name}": ${err.message}`);
      failedAccumulator.push({ name: p.name, error: err.message });
      // Continue with next period instead of throwing
    }
  }
}

/** Ensure exactly one assignment within a group based on feature.timeframe.end (day-only semantics) */
async function upsertAssignmentForGroup(feature, groupLabel, cache) {
  const featureEnd = parseIsoDate(feature.timeframe?.endDate || feature.timeframe?.end);
  if (!featureEnd) {
    log.warn(`🎯 ${groupLabel}: feature has no timeframe.end; skipping assignment`);
    return;
  }

  const groupId = RG_IDS[groupLabel];
  if (!groupId) {
    log.warn(`🎯 ${groupLabel}: Missing release group ID (check environment variables); skipping assignment`);
    return;
  }

  let releases = cache[groupId];
  if (!releases) {
    try {
      releases = await listReleasesForGroup(groupId);
      cache[groupId] = releases;
      dbg(`🎯 ${groupLabel}: Fetched ${releases.length} releases`);
    } catch (err) {
      log.warn(`🎯 ${groupLabel}: Failed to fetch releases (${err.message}); skipping assignment`);
      return; // Skip this group gracefully
    }
  }

  const target = releases.find(r =>
    isWithinClosedDay(featureEnd, r.timeframe?.startDate || r.timeframe?.start, r.timeframe?.endDate || r.timeframe?.end)
  );

  if (!target) {
    log.warn(`🎯 ${groupLabel}: no matching release for end=${feature.timeframe?.endDate || feature.timeframe?.end} (searched ${releases.length} releases)`);
    if (DEBUG && releases.length > 0) {
      dbg(`🎯 ${groupLabel}: Available release timeframes:`);
      releases.slice(0, 5).forEach(r => {
        dbg(`  - ${r.name}: ${r.timeframe?.startDate || r.timeframe?.start} to ${r.timeframe?.endDate || r.timeframe?.end}`);
      });
    }
    return;
  }

  // setFeatureAssignment with assigned=true automatically removes old assignments in this group
  await setFeatureAssignment(feature.id, target.id, true, groupId);
  log.info(`✅ Assigned to ${groupLabel} → ${target.name} (${target.id})`);
}

// --- API Functions ---

/** Get feature by ID */
async function getFeatureV2(id) {
  const r = await fetch(`${PB_BASE}/entities/${id}`, { headers: COMMON_HEADERS });
  if (!r.ok) throw new Error(`GET /entities/${id} -> ${r.status} ${await r.text()}`);
  const data = (await r.json()).data;
  // Flatten fields to top level for convenience
  return {
    id: data.id,
    type: data.type,
    name: data.fields?.name,
    timeframe: data.fields?.timeframe,
    status: data.fields?.status,
    owner: data.fields?.owner,
    links: data.links,
    ...data
  };
}

/** Create a PB release in a group */
async function createReleaseV2({ name, groupId, start, end, granularity }) {
  const r = await fetch(`${PB_BASE}/entities`, {
    method: "POST",
    headers: COMMON_HEADERS,
    body: JSON.stringify({
      data: {
        type: "release",
        fields: {
          name,
          description: "",
          timeframe: {
            startDate: isoString(start),
            endDate: isoString(end),
            granularity: granularity || "day"
          }
        },
        relationships: [
          {
            type: "parent",
            target: {
              id: groupId
            }
          }
        ]
      }
    })
  });
  if (!r.ok) throw new Error(`POST /entities -> ${r.status} ${await r.text()}`);
  const created = (await r.json()).data;

  // Flatten fields to top level for convenience
  return {
    ...created,
    name: created.fields?.name,
    timeframe: created.fields?.timeframe
  };
}

/** List all releases in a group */
async function listReleasesForGroupV2(groupId) {
  // Validate groupId
  if (!groupId) {
    dbg("listReleasesForGroup called with undefined groupId, returning empty array");
    return [];
  }

  const out = [];
  let cursor = null;
  do {
    const url = cursor ? `${PB_BASE}/entities/search?cursor=${cursor}` : `${PB_BASE}/entities/search`;
    const r = await fetch(url, {
      method: "POST",
      headers: COMMON_HEADERS,
      body: JSON.stringify({
        data: {
          type: "release",
          parent: { id: groupId }
        }
      })
    });

    // Graceful handling for 404/403
    if (r.status === 404) {
      dbg(`Release group ${groupId} not found (404), returning empty`);
      return [];
    }
    if (r.status === 403) {
      dbg(`Permission denied for release group ${groupId} (403), returning empty`);
      return [];
    }

    // Throw on other errors (400, 500, etc.)
    if (!r.ok) throw new Error(`POST /entities/search -> ${r.status} ${await r.text()}`);

    const j = await r.json();
    const releases = (j.data ?? []).map(rel => ({
      id: rel.id,
      name: rel.fields?.name,
      timeframe: rel.fields?.timeframe,
      ...rel
    }));
    out.push(...releases);
    cursor = j.pagination?.next;
  } while (cursor);
  return out;
}

/** Assign or unassign a feature to a release */
async function setFeatureAssignmentV2(featureId, releaseId, assigned, groupId) {
  if (assigned) {
    // First, remove any existing release links in this group
    const existingRels = await fetch(`${PB_BASE}/entities/${featureId}/relationships?type=link`, {
      headers: COMMON_HEADERS
    });
    if (existingRels.ok) {
      const rels = (await existingRels.json()).data || [];
      // Get all releases in this group to identify which relationships to remove
      const groupReleases = await listReleasesForGroupV2(groupId);
      const groupReleaseIds = new Set(groupReleases.map(r => r.id));

      for (const rel of rels) {
        if (groupReleaseIds.has(rel.target.id) && rel.target.id !== releaseId) {
          await fetch(`${PB_BASE}/entities/${featureId}/relationships/link/${rel.target.id}`, {
            method: "DELETE",
            headers: COMMON_HEADERS
          });
        }
      }
    }

    // Create new link
    const r = await fetch(`${PB_BASE}/entities/${featureId}/relationships`, {
      method: "POST",
      headers: COMMON_HEADERS,
      body: JSON.stringify({
        data: {
          type: "link",
          target: { id: releaseId }
        }
      })
    });
    if (!r.ok) throw new Error(`POST relationships -> ${r.status} ${await r.text()}`);
    return (await r.json()).data;
  } else {
    // Delete link
    const r = await fetch(`${PB_BASE}/entities/${featureId}/relationships/link/${releaseId}`, {
      method: "DELETE",
      headers: COMMON_HEADERS
    });
    if (!r.ok && r.status !== 404) throw new Error(`DELETE relationship -> ${r.status} ${await r.text()}`);
    return { deleted: true };
  }
}

// --- API Wrapper Functions ---

async function getFeature(id) {
  return getFeatureV2(id);
}

async function createRelease(params) {
  return createReleaseV2(params);
}

async function listReleasesForGroup(groupId) {
  return listReleasesForGroupV2(groupId);
}

async function setFeatureAssignment(featureId, releaseId, assigned, groupId) {
  return setFeatureAssignmentV2(featureId, releaseId, assigned, groupId);
}

// --- Webhook receiver ---
app.post("/pb-webhook", requireAuth, async (req, res) => {
  const reqLog = logWithRequest(req);
  const t0 = Date.now();
  try {
    // 1) Basic intake logs (size + top-level fields)
    const body = req.body || {};
    const size = Number(req.get("content-length") || 0);
    dbg("📥 Webhook received", { size, keys: Object.keys(body), requestId: req.id });

    // 2) Event & entity extraction (covering multiple payload shapes)
    const eventType = body?.data?.eventType || body?.data?.type || body?.type;
    const featureId =
      body?.data?.id ||
      body?.data?.attributes?.entity?.feature?.id ||
      body?.data?.attributes?.entity?.id ||
      body?.data?.entity?.id ||
      body?.entity?.id;

    reqLog.info(`📬 PB Webhook: type=${eventType ?? "<?>"} featureId=${featureId ?? "<?>"} size=${size}B`);

    // 3) Sanity: is it a feature change event?
    if (!eventType) {
      reqLog.warn("No event type in payload, ignoring");
      return res.status(204).send("no event type");
    }
    if (!["feature.updated", "feature.created"].includes(eventType)) {
      dbg("Ignoring non-feature event", { eventType, requestId: req.id });
      return res.status(204).send("ignored event");
    }

    // 3b) Prevent feedback loop: only process if timeframe was actually updated
    // When we assign features to releases, it triggers another webhook but without timeframe changes
    const updatedAttributes = body?.data?.updatedAttributes || [];
    if (eventType === "feature.updated" && Array.isArray(updatedAttributes)) {
      // Check if timeframe was actually updated (or if it's a create, always process)
      const isTimeframeUpdate = updatedAttributes.includes("timeframe");
      if (!isTimeframeUpdate) {
        dbg("Ignoring update without timeframe change", { updatedAttributes, requestId: req.id });
        return res.status(204).send("no timeframe update");
      }
    }

    // 4) Need a feature id
    if (!featureId) {
      reqLog.warn("No feature id in webhook payload", { snippet: JSON.stringify(body).slice(0, 400) });
      return res.status(400).send("bad payload (no feature id)");
    }

    // 5) All validation passed - respond immediately and process async
    const dt = Date.now() - t0;
    reqLog.info(`✅ Webhook accepted for processing (${dt} ms)`);

    // Respond immediately
    res.status(200).send("accepted");

    // Process asynchronously (don't await) - pass requestId for correlation
    processWebhookAsync(body, featureId, eventType, req.id).catch(err => {
      // Catch any unhandled errors from async processing
      reqLog.err("Unhandled error in async webhook processing:", err?.message);
    });
  } catch (err) {
    const dt = Date.now() - t0;
    reqLog.err("Handler error:", err?.message, `(${dt} ms)`);
    return res.status(500).send("internal");
  }
});

/**
 * Process webhook payload asynchronously (called without await)
 * This allows the HTTP response to return immediately while processing continues
 */
async function processWebhookAsync(body, featureId, eventType, requestId) {
  const t0 = Date.now();
  // Create request-scoped logger for async processing
  const reqLog = {
    info: (msg, ...args) => logger.info({ ...formatLogArgs(args), requestId }, msg),
    link: (msg, ...args) => logger.info({ ...formatLogArgs(args), requestId, type: 'link' }, msg),
    err: (msg, ...args) => logger.error({ ...formatLogArgs(args), requestId }, msg),
  };

  try {
    // 1) Fetch latest feature (thin payloads)
    const feature = await getFeature(featureId);
    reqLog.link(`🔗 Feature: ${feature.links?.html ?? feature.links?.self ?? feature.id}`);

    // 2) Assign within each group (day-only, closed interval)
    const cache = {};
    await upsertAssignmentForGroup(feature, "weekly", cache);
    await upsertAssignmentForGroup(feature, "monthly", cache);
    await upsertAssignmentForGroup(feature, "quarterly", cache);
    await upsertAssignmentForGroup(feature, "yearly", cache);

    const dt = Date.now() - t0;
    reqLog.info(`✅ Async processing complete in ${dt} ms`);
  } catch (err) {
    const dt = Date.now() - t0;
    reqLog.err("Async processing error:", err?.message, `(${dt} ms)`);
    // Note: We can't respond to webhook here since response was already sent
    // Error is logged but processing continues for other webhooks
  }
}

/**
 * Admin: seed weekly, monthly, quarterly, and yearly releases from "today".
 * - Weekly, monthly, quarterly: 1 year ahead
 * - Yearly: 5 years ahead
 * - Uses inclusive day bounds (closed intervals).
 * - Skips creation if a release with identical [start,end] already exists in the group.
 * - Quarterly anchor month can be overridden via env QUARTER_START_MONTH (1-12). Default Jan (1).
 * - Stores timeframe at 00:00:00Z for both start and end (day-only canonical form).
 */
app.post("/admin/seed-releases", requireAuth, async (req, res) => {
  const reqLog = logWithRequest(req);
  try {
    const now = new Date();
    const rangeStart = startOfDayUTC(now);
    const rangeEnd = endOfDayUTC(addDays(atUTC(now.getUTCFullYear() + 1, now.getUTCMonth(), now.getUTCDate()), 0));
    const rangeEnd5Years = endOfDayUTC(addDays(atUTC(now.getUTCFullYear() + 5, now.getUTCMonth(), now.getUTCDate()), 0));

    const anchorMonthEnv = process.env.QUARTER_START_MONTH || "1";

    // Fetch once per group - use Promise.allSettled for resilience
    const groupLabels = ['weekly', 'monthly', 'quarterly', 'yearly'];
    const fetchResults = await Promise.allSettled([
      listReleasesForGroup(RG_IDS.weekly),
      listReleasesForGroup(RG_IDS.monthly),
      listReleasesForGroup(RG_IDS.quarterly),
      listReleasesForGroup(RG_IDS.yearly),
    ]);

    // Track results per group
    const groupData = {
      weekly: { releases: [], status: 'pending', error: null, created: 0 },
      monthly: { releases: [], status: 'pending', error: null, created: 0 },
      quarterly: { releases: [], status: 'pending', error: null, created: 0 },
      yearly: { releases: [], status: 'pending', error: null, created: 0 }
    };

    // Process fetch results
    fetchResults.forEach((result, idx) => {
      const label = groupLabels[idx];
      if (result.status === 'fulfilled') {
        groupData[label].releases = result.value;
        groupData[label].status = 'fetched';
      } else {
        groupData[label].status = 'failed';
        groupData[label].error = result.reason?.message || 'Unknown error';
        reqLog.warn(`⏭️  Skipped ${label}: ${groupData[label].error}`);
      }
    });

    // Check if any groups are available
    const availableGroups = Object.values(groupData).filter(g => g.status === 'fetched').length;
    if (availableGroups === 0) {
      reqLog.err("❌ No release groups available for seeding");
      return res.status(424).json({
        status: "failed",
        error: "No release groups available",
        message: "All release groups failed to fetch. Check environment variables and API permissions.",
        groups: Object.fromEntries(
          Object.entries(groupData).map(([k, v]) => [k, { status: v.status, error: v.error }])
        )
      });
    }

    // Build periods
    const weekly = buildWeeklyPeriods(rangeStart, rangeEnd);
    const monthly = buildMonthlyPeriods(rangeStart, rangeEnd);
    const quarterly = buildQuarterlyPeriods(rangeStart, rangeEnd, anchorMonthEnv);
    const yearly = buildYearlyPeriods(rangeStart, rangeEnd5Years);

    // Seed each group (only if fetched successfully)
    const created = [];
    const failed = [];

    if (groupData.weekly.status === 'fetched') {
      reqLog.info(`📅 Seeding weekly releases...`);
      const beforeCount = created.length;
      await ensureSeedForGroup(RG_IDS.weekly, [...weekly].reverse(), groupData.weekly.releases, created, failed, "day");
      groupData.weekly.status = 'success';
      groupData.weekly.created = created.length - beforeCount;
    }

    if (groupData.monthly.status === 'fetched') {
      reqLog.info(`📅 Seeding monthly releases...`);
      const beforeCount = created.length;
      await ensureSeedForGroup(RG_IDS.monthly, [...monthly].reverse(), groupData.monthly.releases, created, failed, "month");
      groupData.monthly.status = 'success';
      groupData.monthly.created = created.length - beforeCount;
    }

    if (groupData.quarterly.status === 'fetched') {
      reqLog.info(`📅 Seeding quarterly releases...`);
      const beforeCount = created.length;
      await ensureSeedForGroup(RG_IDS.quarterly, [...quarterly].reverse(), groupData.quarterly.releases, created, failed, "quarter");
      groupData.quarterly.status = 'success';
      groupData.quarterly.created = created.length - beforeCount;
    }

    if (groupData.yearly.status === 'fetched') {
      reqLog.info(`📅 Seeding yearly releases...`);
      const beforeCount = created.length;
      await ensureSeedForGroup(RG_IDS.yearly, [...yearly].reverse(), groupData.yearly.releases, created, failed, "year");
      groupData.yearly.status = 'success';
      groupData.yearly.created = created.length - beforeCount;
    }

    // Calculate summary
    const successfulGroups = Object.values(groupData).filter(g => g.status === 'success').length;
    const failedGroups = 4 - successfulGroups;
    const totalCreated = created.length;
    const totalFailed = failed.length;

    // Determine overall status
    const overallStatus = successfulGroups === 4 ? 'success' :
                         successfulGroups > 0 ? 'partial_success' : 'failed';

    reqLog.info(`✅ Seeding complete: ${successfulGroups}/4 groups succeeded, ${totalCreated} releases created, ${totalFailed} failures`);

    // Return detailed response
    res.status(200).json({
      status: overallStatus,
      rangeStart: isoString(rangeStart),
      rangeEnd: isoString(rangeEnd),
      summary: {
        totalGroups: 4,
        successfulGroups,
        failedGroups,
        createdCount: totalCreated,
        failedCreations: totalFailed
      },
      groups: Object.fromEntries(
        Object.entries(groupData).map(([k, v]) => [
          k,
          {
            status: v.status,
            created: v.created || 0,
            error: v.error || null
          }
        ])
      ),
      createdNames: created.map(c => c.name),
      ...(totalFailed > 0 && { failedCreations: failed })
    });
  } catch (e) {
    reqLog.err("Seeder failed:", e?.message);
    res.status(500).json({
      status: "error",
      error: e?.message || "Internal server error"
    });
  }
});

// Bootstrap
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => log.info(`🟢 Listening on :${PORT}`));