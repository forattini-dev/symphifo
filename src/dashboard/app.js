// ── Theme switcher (runs immediately to avoid flash) ─────────────────────────

const THEME_STORAGE_KEY = "symphifo-theme";
const THEME_CHOICES = ["auto", "sunset", "cupcake"];
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

function normalizeThemeChoice(raw) {
  if (!raw) return "auto";
  if (THEME_CHOICES.includes(raw)) return raw;
  return "auto";
}

function getSystemTheme() {
  return systemThemeQuery.matches ? "sunset" : "cupcake";
}

function getSavedTheme() {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  return normalizeThemeChoice(raw);
}

function applyTheme(themeChoice) {
  const choice = normalizeThemeChoice(themeChoice);
  const resolvedTheme = choice === "auto" ? getSystemTheme() : choice;

  document.documentElement.setAttribute("data-theme", resolvedTheme);
  localStorage.setItem(THEME_STORAGE_KEY, choice);

  selectedTheme = choice;

  document.querySelectorAll('#theme-menu input[name="theme"]').forEach((radio) => {
    radio.checked = radio.value === choice;
  });

  // Swatch picks up --plague from the active theme automatically
  const swatch = document.getElementById("theme-swatch");
  if (swatch) swatch.style.background = "var(--plague)";
}

let selectedTheme = getSavedTheme();
applyTheme(selectedTheme);

if (systemThemeQuery.addEventListener) {
  systemThemeQuery.addEventListener("change", () => {
    if (selectedTheme === "auto") {
      applyTheme("auto");
    }
  });
} else {
  systemThemeQuery.addListener(() => {
    if (selectedTheme === "auto") {
      applyTheme("auto");
    }
  });
}

// Wire dropdown toggle
const themeDropdown = document.getElementById("theme-dropdown");
const themeToggle = document.getElementById("theme-toggle");

// DaisyUI dropdown handles open/close via focus/blur natively.
// We just need to wire the radio buttons for theme selection.
document.getElementById("theme-menu")?.addEventListener("change", (event) => {
  if (event.target.name === "theme") {
    applyTheme(event.target.value);
    // Blur to close the DaisyUI dropdown
    document.activeElement?.blur();
  }
});

// ── DOM references ───────────────────────────────────────────────────────────

const subtitle = document.getElementById("subtitle");
const healthBadge = document.getElementById("health");
const refreshBadge = document.getElementById("lastRefresh");
const overviewEl = document.getElementById("overview");
const issueListEl = document.getElementById("issue-list");
const runtimeMeta = document.getElementById("runtime-meta");
const stateFilter = document.getElementById("state-filter");
const categoryFilter = document.getElementById("category-filter");
const queryInput = document.getElementById("query");
const eventsEl = document.getElementById("events");
const eventKindFilter = document.getElementById("event-kind-filter");
const eventIssueFilter = document.getElementById("event-issue-filter");
const rerunBtn = document.getElementById("rerun");
const clearEventsBtn = document.getElementById("clear-events");
const newIssueBtn = document.getElementById("new-issue-btn");
const createForm = document.getElementById("create-form");
const detailPanel = document.getElementById("detail-panel");
const detailPlaceholder = document.getElementById("detail-placeholder");

const kanbanBoard = document.getElementById("kanban-board");
const kanbanDetail = document.getElementById("kanban-detail");
const kanbanDetailContent = document.getElementById("kanban-detail-content");
const issuesMasterDetail = document.querySelector(".issues-master-detail");

let appState = {};
let lastEventTimestamp = "";
let lastStateHash = "";
let expandedSessions = new Set();
let activeSplitId = null;
let selectedDetailId = null;
let selectedIssues = new Set();
let lastHealthStatus = null;
let activeKpiFilter = null;
let previousKpiValues = {};
let previousIssueStates = new Map();
let viewMode = localStorage.getItem("symphifo-view-mode") || "board";
let expandedKanbanCards = new Set();
let collapsedColumns = new Set(JSON.parse(localStorage.getItem("symphifo-collapsed-columns") || "[]"));
let isDraggingKanban = false;

// ── Tab switching ────────────────────────────────────────────────────────────

function switchTab(tabName) {
  viewMode = tabName;
  localStorage.setItem("symphifo-view-mode", tabName);

  // Update tab buttons
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("tab-active", btn.dataset.tab === tabName);
  });

  // Show/hide panels
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    if (panel.dataset.panel === tabName) {
      panel.hidden = false;
      panel.style.animation = "none";
      panel.offsetHeight; // trigger reflow
      panel.style.animation = "";
    } else {
      panel.hidden = true;
    }
  });

  // Render content for active tab
  const issues = appState.issues || [];
  if (tabName === "board") renderKanban(issues);
  else if (tabName === "list") renderIssues(issues);
}

// ── Toast notifications ─────────────────────────────────────────────────────

function getOrCreateToastContainer() {
  let container = document.querySelector(".toast.toast-end");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast toast-end";
    document.body.appendChild(container);
  }
  return container;
}

let toastQueue = 0;

function showToast(message, kind = "error", durationMs = 4000) {
  const container = getOrCreateToastContainer();
  const item = document.createElement("div");
  const alertCls = kind === "success" ? "alert-success" : kind === "warn" ? "alert-warning" : "alert-error";
  item.className = `alert ${alertCls} toast-item`;
  item.textContent = message;

  // Countdown progress bar
  const countdown = document.createElement("div");
  countdown.className = "toast-countdown";
  countdown.style.setProperty("--toast-duration", `${durationMs}ms`);
  item.appendChild(countdown);

  // Stagger entrance: delay each toast by 50ms
  const delay = toastQueue * 50;
  item.style.animationDelay = `${delay}ms`;
  countdown.style.animationDelay = `${delay}ms`;
  toastQueue++;
  setTimeout(() => { toastQueue = Math.max(0, toastQueue - 1); }, delay + 300);

  container.appendChild(item);

  setTimeout(() => {
    item.classList.add("toast-out");
    item.addEventListener("animationend", () => item.remove());
  }, durationMs + delay);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const stateOrder = ["Todo", "In Progress", "In Review", "Blocked", "Done", "Cancelled"];
const capabilityOrder = ["security", "bugfix", "backend", "devops", "frontend-ui", "architecture", "documentation", "default", "workflow-disabled"];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString();
}

function timeAgo(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  const elapsed = Date.now() - parsed.getTime();
  if (elapsed < 0) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function isDesktop() {
  return window.matchMedia("(min-width: 900px)").matches;
}

// ── First-time "+ New" button highlight ──────────────────────────────────────

function updateNewButtonHighlight(issueCount) {
  if (!newIssueBtn) return;
  const hasCreated = localStorage.getItem("symphifo-has-created") === "1";
  if (issueCount === 0 && !hasCreated) {
    newIssueBtn.classList.add("btn-highlight");
  } else {
    newIssueBtn.classList.remove("btn-highlight");
    if (issueCount > 0 && !hasCreated) {
      localStorage.setItem("symphifo-has-created", "1");
    }
  }
}

// ── KPI counter animation ───────────────────────────────────────────────────

function animateCounter(element, from, to, durationMs = 400) {
  if (from === to || typeof from !== "number" || typeof to !== "number") return;
  const start = performance.now();
  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / durationMs, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(from + (to - from) * eased);
    element.textContent = current;
    if (progress < 1) requestAnimationFrame(tick);
    else element.textContent = to;
  }
  requestAnimationFrame(tick);
}

function animateKpiValues() {
  const kpis = overviewEl.querySelectorAll(".stat");
  kpis.forEach((kpi) => {
    const label = kpi.querySelector(".stat-title")?.textContent?.trim() || "";
    const valueEl = kpi.querySelector(".stat-value");
    if (!valueEl) return;
    const rawValue = parseInt(valueEl.textContent, 10);
    if (isNaN(rawValue)) return;
    const prevValue = previousKpiValues[label];
    if (prevValue !== undefined && prevValue !== rawValue) {
      animateCounter(valueEl, prevValue, rawValue);
    }
    previousKpiValues[label] = rawValue;
  });
}

// ── Issue card state transition animations ──────────────────────────────────

function applyIssueCardAnimations(issues) {
  requestAnimationFrame(() => {
    for (const issue of issues) {
      const card = issueListEl.querySelector(`[data-issue-id="${issue.id}"]`);
      if (!card) continue;
      const prevState = previousIssueStates.get(issue.id);

      if (prevState === undefined) {
        card.classList.add("animate-in");
        card.addEventListener("animationend", () => card.classList.remove("animate-in"), { once: true });
      } else if (prevState !== issue.state) {
        if (issue.state === "Done") {
          card.classList.add("issue-done-pulse");
          card.addEventListener("animationend", () => {
            card.classList.remove("issue-done-pulse");
            card.classList.add("issue-done-muted");
          }, { once: true });
        } else if (issue.state === "Blocked") {
          card.classList.add("issue-blocked-shake");
          card.addEventListener("animationend", () => card.classList.remove("issue-blocked-shake"), { once: true });
        } else {
          card.classList.add("issue-state-flash");
          card.addEventListener("animationend", () => card.classList.remove("issue-state-flash"), { once: true });
        }
      }
    }
    for (const issue of issues) {
      previousIssueStates.set(issue.id, issue.state);
    }
  });
}

// ── Session loading skeleton helper ─────────────────────────────────────────

function sessionLoadingSkeleton() {
  return `<div class="session-loading-skeleton">
    <div class="skeleton h-3 w-3/5"></div>
    <div class="skeleton h-3 w-4/5"></div>
    <div class="skeleton h-3 w-2/5"></div>
    <div class="skeleton h-3 w-3/4"></div>
  </div>`;
}

// ── Pipeline step stagger animation helper ──────────────────────────────────

function staggerAnimateSteps(panel) {
  const steps = panel.querySelectorAll(".pipeline-step");
  steps.forEach((step, i) => {
    step.classList.add("animate-step");
    step.style.animationDelay = `${i * 30}ms`;
  });
}

// ── Loading state wrapper ───────────────────────────────────────────────────

async function withLoading(target, asyncFn) {
  if (!(target instanceof HTMLButtonElement)) {
    return asyncFn();
  }
  const originalText = target.textContent;
  target.disabled = true;
  target.textContent = "\u00B7\u00B7\u00B7";
  target.classList.add("is-loading");
  try {
    const result = await asyncFn();
    target.classList.remove("is-loading");
    target.classList.add("btn-success-flash");
    setTimeout(() => target.classList.remove("btn-success-flash"), 400);
    return result;
  } finally {
    target.disabled = false;
    target.textContent = originalText;
    target.classList.remove("is-loading");
  }
}

// ── Network ──────────────────────────────────────────────────────────────────

async function fetchJSON(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

async function post(path, payload = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    const errMsg = typeof errorPayload.error === "string"
      ? errorPayload.error
      : errorPayload.error?.message || errorPayload.message || JSON.stringify(errorPayload.error) || `Request failed: ${response.status}`;
    throw new Error(errMsg);
  }
  return response.json();
}

// ── KPI Overview ─────────────────────────────────────────────────────────────

function kpiCard(label, value, { accent = "", desc = "", filterKey = "", filterValue = "" } = {}) {
  const colorMap = { accent: "text-primary", warn: "text-warning", danger: "text-error" };
  const colorCls = colorMap[accent] || "";
  const clickable = filterKey ? " kpi-clickable" : "";
  const active = activeKpiFilter && activeKpiFilter.key === filterKey && activeKpiFilter.value === filterValue ? " kpi-active" : "";
  const dataAttrs = filterKey ? ` data-kpi-filter="${escapeHtml(filterKey)}" data-kpi-value="${escapeHtml(filterValue)}"` : "";
  return `
    <div class="stat${clickable}${active}"${dataAttrs}>
      <div class="stat-title">${label}</div>
      <div class="stat-value text-2xl ${colorCls}">${value}</div>
      ${desc ? `<div class="stat-desc">${escapeHtml(desc)}</div>` : ""}
    </div>
  `;
}

function capabilityRank(value) {
  const normalized = String(value || "default");
  const index = capabilityOrder.indexOf(normalized);
  return index === -1 ? 999 : index;
}

function updateTabBadges() {
  const issues = appState.issues || [];
  const issueCount = issues.length;
  const eventCount = allEvents.length;

  document.querySelectorAll(".tab").forEach((btn) => {
    const tab = btn.dataset.tab;
    if (tab === "board") btn.textContent = issueCount > 0 ? `Board (${issueCount})` : "Board";
    else if (tab === "list") btn.textContent = issueCount > 0 ? `List (${issueCount})` : "List";
    else if (tab === "events") btn.textContent = eventCount > 0 ? `Events (${eventCount})` : "Events";
    // runtime: no counter
  });
}

function updateTabTitle(metrics) {
  if (!metrics) return;
  const parts = [];
  if (metrics.inProgress) parts.push(`${metrics.inProgress} running`);
  if (metrics.blocked) parts.push(`${metrics.blocked} blocked`);
  if (metrics.queued) parts.push(`${metrics.queued} queued`);
  document.title = parts.length
    ? `(${parts.join(", ")}) Symphifo`
    : "Symphifo";
}

function renderOverview(metrics, issues = []) {
  if (!metrics) return;

  updateTabTitle(metrics);

  const total = metrics.total || 0;

  if (total === 0) {
    overviewEl.innerHTML = `
      <div class="empty-overview">
        <div class="empty-overview-title">Ready to orchestrate</div>
        <div class="empty-overview-desc">Create issues and let your agents handle the work.</div>
        <button class="btn btn-sm btn-accent" id="empty-create-btn">Create first issue</button>
        <div class="empty-overview-hint">or POST to /issues via API</div>
      </div>
    `;
    document.getElementById("empty-create-btn")?.addEventListener("click", () => {
      switchTab("board");
      toggleCreateForm();
    });
    updateNewButtonHighlight(0);
    const existing = document.getElementById("progress-bar");
    if (existing) existing.remove();
    return;
  }
  const running = metrics.inProgress || 0;
  const blocked = metrics.blocked || 0;
  const done = metrics.done || 0;
  const queued = metrics.queued || 0;
  const cancelled = metrics.cancelled || 0;
  const avgCompletionMs = typeof metrics.avgCompletionMs === "number" ? metrics.avgCompletionMs : null;
  const medianCompletionMs = typeof metrics.medianCompletionMs === "number" ? metrics.medianCompletionMs : null;
  const fastestCompletionMs = typeof metrics.fastestCompletionMs === "number" ? metrics.fastestCompletionMs : null;
  const slowestCompletionMs = typeof metrics.slowestCompletionMs === "number" ? metrics.slowestCompletionMs : null;
  const pctDone = total > 0 ? `${Math.round((done / total) * 100)}% complete` : "";
  const byCapability = issues.reduce((accumulator, issue) => {
    const key = issue.capabilityCategory || "default";
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
  const topCapabilities = Object.entries(byCapability)
    .sort((a, b) => {
      const rankDiff = capabilityRank(a[0]) - capabilityRank(b[0]);
      if (rankDiff !== 0) return rankDiff;
      return b[1] - a[1];
    })
    .slice(0, 3);
  const criticalQueue = issues.filter((issue) => issue.capabilityCategory === "security" || issue.capabilityCategory === "bugfix").length;

  overviewEl.innerHTML = [
    kpiCard("Total", total, { filterKey: "state", filterValue: "all" }),
    kpiCard("Queued", queued, { accent: queued > 0 ? "accent" : "", filterKey: "state", filterValue: "Todo" }),
    kpiCard("Running", running, { accent: running > 0 ? "accent" : "", desc: running > 0 ? "in progress" : "", filterKey: "state", filterValue: "In Progress" }),
    kpiCard("Blocked", blocked, { accent: blocked > 0 ? "danger" : "", desc: blocked > 0 ? "needs attention" : "", filterKey: "state", filterValue: "Blocked" }),
    kpiCard("Done", done, { desc: pctDone, filterKey: "state", filterValue: "Done" }),
    kpiCard("Avg Completion", avgCompletionMs !== null ? formatDuration(avgCompletionMs) : "--", {
      desc: medianCompletionMs !== null ? `median ${formatDuration(medianCompletionMs)}` : "no completed issues",
      filterKey: "state",
      filterValue: "Done",
    }),
    kpiCard("Best/Worst", `${formatDuration(fastestCompletionMs ?? 0)} / ${formatDuration(slowestCompletionMs ?? 0)}`, {
      desc: (fastestCompletionMs === null || slowestCompletionMs === null)
        ? "no completed issues"
        : "min / max",
      filterKey: "state",
      filterValue: "Done",
    }),
    kpiCard("Cancelled", cancelled, { accent: cancelled > 0 ? "warn" : "", filterKey: "state", filterValue: "Cancelled" }),
    kpiCard("Critical", criticalQueue, { accent: criticalQueue > 0 ? "danger" : "", desc: "security + bugfix", filterKey: "capability", filterValue: "critical" }),
    ...topCapabilities.map(([category, count]) => kpiCard(category, count, { desc: "capability load", filterKey: "capability", filterValue: category })),
  ].join("");

  // Animate KPI counters
  animateKpiValues();

  // Update first-time highlight
  updateNewButtonHighlight(total);

  // Update tab badges with current counts
  updateTabBadges();

  // Progress bar
  if (total > 0) {
    const donePct = Math.round((done / total) * 100);
    const runningPct = Math.round((running / total) * 100);
    const blockedPct = Math.round((blocked / total) * 100);
    const existing = document.getElementById("progress-bar");
    if (existing) existing.remove();
    overviewEl.insertAdjacentHTML("afterend", `
      <div id="progress-bar" class="progress-bar">
        <div class="progress-segment progress-done" style="width:${donePct}%" title="Done ${donePct}%"></div>
        <div class="progress-segment progress-running" style="width:${runningPct}%" title="Running ${runningPct}%"></div>
        <div class="progress-segment progress-blocked" style="width:${blockedPct}%" title="Blocked ${blockedPct}%"></div>
      </div>
    `);
  }
}

// ── KPI click handler ───────────────────────────────────────────────────────

overviewEl.addEventListener("click", (event) => {
  const kpi = event.target.closest(".stat.kpi-clickable");
  if (!kpi) return;

  const filterKey = kpi.dataset.kpiFilter;
  const filterValue = kpi.dataset.kpiValue;
  if (!filterKey) return;

  // Toggle: if same filter is active, reset
  if (activeKpiFilter && activeKpiFilter.key === filterKey && activeKpiFilter.value === filterValue) {
    activeKpiFilter = null;
    stateFilter.value = "all";
    if (categoryFilter) categoryFilter.value = "all";
  } else {
    activeKpiFilter = { key: filterKey, value: filterValue };

    if (filterKey === "state") {
      if (filterValue === "all") {
        stateFilter.value = "all";
      } else {
        stateFilter.value = filterValue;
      }
      if (categoryFilter) categoryFilter.value = "all";
    } else if (filterKey === "capability") {
      stateFilter.value = "all";
      if (filterValue === "critical") {
        // "Critical" means security+bugfix — no single category filter, we handle in renderIssues
        if (categoryFilter) categoryFilter.value = "all";
      } else if (categoryFilter) {
        categoryFilter.value = filterValue;
      }
    }
  }

  renderOverview(appState.metrics || {}, appState.issues || []);
  renderCurrentView();
});

// ── Issue Actions ────────────────────────────────────────────────────────────

function actionButton(issueId, label, action, payload = "") {
  return `<button type="button" class="btn btn-xs btn-ghost" data-id="${escapeHtml(issueId)}" data-action="${action}" data-payload="${escapeHtml(payload)}">${label}</button>`;
}

function issueActions(issue) {
  const editBtn = actionButton(issue.id, "Edit", "edit");
  const deleteBtn = actionButton(issue.id, "Delete", "delete");
  const splitBtn = actionButton(issue.id, "Split", "split");

  let primaryHtml = "";
  let secondaryHtml = "";

  if (issue.state === "Blocked") {
    primaryHtml = `${actionButton(issue.id, "Retry", "retry")} ${actionButton(issue.id, "Set Todo", "state", "Todo")} ${actionButton(issue.id, "Cancel", "cancel")}`;
    secondaryHtml = `${editBtn} ${splitBtn} ${deleteBtn}`;
  } else if (issue.state === "Done" || issue.state === "Cancelled") {
    primaryHtml = actionButton(issue.id, "Retry", "retry");
    secondaryHtml = `${editBtn} ${deleteBtn}`;
  } else if (issue.state === "Todo") {
    primaryHtml = `${actionButton(issue.id, "Mark In Progress", "state", "In Progress")} ${actionButton(issue.id, "Cancel", "state", "Cancelled")}`;
    secondaryHtml = `${editBtn} ${splitBtn} ${deleteBtn}`;
  } else {
    // In Progress, In Review
    primaryHtml = `${actionButton(issue.id, "View Sessions", "sessions")} ${actionButton(issue.id, "Cancel", "cancel")}`;
    secondaryHtml = editBtn;
  }

  const moreBtn = `<button type="button" class="btn btn-xs btn-ghost" data-action="more" data-id="${escapeHtml(issue.id)}" title="More actions">&middot;&middot;&middot;</button>`;

  return `${primaryHtml} ${moreBtn} <span class="actions-secondary" data-secondary-for="${escapeHtml(issue.id)}">${secondaryHtml}</span>`;
}

function stateClass(value) {
  const map = {
    "Todo": "badge badge-ghost badge-sm",
    "In Progress": "badge badge-primary badge-sm",
    "In Review": "badge badge-info badge-sm",
    "Blocked": "badge badge-error badge-sm",
    "Done": "badge badge-success badge-sm",
    "Cancelled": "badge badge-warning badge-sm",
  };
  return map[value] || "badge badge-ghost badge-sm";
}

// ── Issue Rendering ──────────────────────────────────────────────────────────

function renderIssues(issues = []) {
  const selectedState = stateFilter.value;
  const selectedCategory = categoryFilter?.value || "all";
  const search = queryInput.value.trim().toLowerCase();

  const filtered = issues.filter((issue) => {
    if (selectedState !== "all" && issue.state !== selectedState) return false;
    if (selectedCategory !== "all" && issue.capabilityCategory !== selectedCategory) return false;
    // Handle critical KPI filter (security+bugfix)
    if (activeKpiFilter && activeKpiFilter.key === "capability" && activeKpiFilter.value === "critical") {
      if (issue.capabilityCategory !== "security" && issue.capabilityCategory !== "bugfix") return false;
    }
    if (search) {
      const target = `${issue.identifier} ${issue.title} ${issue.description || ""} ${issue.id}`.toLowerCase();
      if (!target.includes(search)) return false;
    }
    return true;
  });

  // Populate category filter dynamically
  if (categoryFilter) {
    const categories = new Set(issues.map((i) => i.capabilityCategory).filter(Boolean));
    const currentOptions = new Set();
    for (const opt of categoryFilter.options) currentOptions.add(opt.value);
    for (const cat of categories) {
      if (!currentOptions.has(cat)) {
        const opt = document.createElement("option");
        opt.value = cat;
        opt.textContent = cat;
        categoryFilter.appendChild(opt);
      }
    }
  }

  // Issue count + batch toolbar
  const countEl = document.getElementById("issue-count");
  if (countEl) {
    if (selectedIssues.size > 0) {
      countEl.innerHTML = `<span class="batch-info">${selectedIssues.size} selected</span> `
        + `<button type="button" class="btn btn-xs btn-ghost" id="batch-retry">Retry All</button> `
        + `<button type="button" class="btn btn-xs btn-ghost" id="batch-cancel">Cancel All</button> `
        + `<button type="button" class="btn btn-xs btn-ghost" id="batch-clear">Clear</button>`;
    } else {
      countEl.textContent = filtered.length === issues.length
        ? `${issues.length} issues`
        : `${filtered.length} / ${issues.length} issues`;
    }
  }

  if (!filtered.length) {
    const hasAnyIssues = issues.length > 0;
    if (hasAnyIssues) {
      issueListEl.innerHTML = `<div class="empty-list">
        <div class="empty-list-text">No issues match -- try adjusting filters</div>
        <button class="btn btn-sm btn-ghost" id="clear-filters-btn">Clear filters</button>
      </div>`;
      document.getElementById("clear-filters-btn")?.addEventListener("click", () => {
        stateFilter.value = "all";
        if (categoryFilter) categoryFilter.value = "all";
        queryInput.value = "";
        activeKpiFilter = null;
        renderOverview(appState.metrics || {}, appState.issues || []);
        renderIssues(appState.issues || []);
      });
    } else {
      issueListEl.innerHTML = `<div class="empty-list">
        <div class="kanban-empty-cta" id="list-create-cta">
          <div class="kanban-empty-icon">+</div>
          <div>Create an issue to start</div>
        </div>
      </div>`;
      document.getElementById("list-create-cta")?.addEventListener("click", () => toggleCreateForm());
    }
    return;
  }

  issueListEl.innerHTML = filtered
    .sort((a, b) => {
      const sa = stateOrder.indexOf(a.state);
      const sb = stateOrder.indexOf(b.state);
      if (sa !== sb) return sa - sb;
      const priorityDiff = (a.priority || 999) - (b.priority || 999);
      if (priorityDiff !== 0) return priorityDiff;
      const capabilityDiff = capabilityRank(a.capabilityCategory) - capabilityRank(b.capabilityCategory);
      if (capabilityDiff !== 0) return capabilityDiff;
      return String(a.identifier || "").localeCompare(String(b.identifier || ""));
    })
    .map((issue) => {
      const historyEntries = Array.isArray(issue.history) ? issue.history : [];
      const recentHistory = historyEntries.slice(-3).map((entry) => `<li class="mono">${escapeHtml(entry)}</li>`).join("");
      const olderHistory = historyEntries.slice(0, -3).map((entry) => `<li class="mono">${escapeHtml(entry)}</li>`).join("");
      const history = historyEntries.length > 3
        ? `<details class="history-detail"><summary>${historyEntries.length - 3} older entries</summary><ul class="history">${olderHistory}</ul></details>${recentHistory}`
        : recentHistory;
      const labels = Array.isArray(issue.labels)
        ? issue.labels.map((l) => `<span class="badge badge-outline badge-xs">${escapeHtml(l)}</span>`).join("")
        : "";
      const paths = Array.isArray(issue.paths) && issue.paths.length
        ? issue.paths.map((p) => `<span class="badge badge-outline badge-xs mono">${escapeHtml(p)}</span>`).join("")
        : "";
      const overlays = Array.isArray(issue.capabilityOverlays) && issue.capabilityOverlays.length
        ? issue.capabilityOverlays.map((o) => `<span class="badge badge-outline badge-xs">${escapeHtml(`overlay:${o}`)}</span>`).join("")
        : "";
      const category = issue.capabilityCategory
        ? `<span class="badge badge-outline badge-xs">${escapeHtml(`capability:${issue.capabilityCategory}`)}</span>`
        : "";

      const blockedByHtml = Array.isArray(issue.blockedBy) && issue.blockedBy.length
        ? issue.blockedBy.map((dep) => `<span class="badge badge-error badge-xs">${escapeHtml(dep)}</span>`).join("")
        : "";

      const errorHtml = issue.lastError
        ? `<details class="error-detail">
            <summary>Last error</summary>
            <pre class="mono">${escapeHtml(issue.lastError)}</pre>
          </details>`
        : "";

      // On mobile, show inline session panel; on desktop, sessions go to detail panel
      const sessionHtml = expandedSessions.has(issue.id)
        ? `<div class="session-panel" id="session-${escapeHtml(issue.id)}">${sessionLoadingSkeleton()}</div>`
        : "";

      const noteHtml = (issue.state === "Blocked" || issue.state === "Todo")
        ? `<div class="note-form">
            <input type="text" class="input input-bordered input-sm" placeholder="Add note for next retry..." data-note-for="${escapeHtml(issue.id)}" />
            <button type="button" class="btn btn-xs btn-ghost" data-id="${escapeHtml(issue.id)}" data-action="note">Send</button>
          </div>`
        : "";

      const splitHtml = activeSplitId === issue.id
        ? `<div class="split-form">
            <label class="split-label">Sub-task titles (one per line)</label>
            <textarea data-split-for="${escapeHtml(issue.id)}" rows="3" placeholder="Fix the header layout\nUpdate the unit tests\nAdd error handling"></textarea>
            <div class="split-form-actions">
              <button type="button" class="btn btn-xs btn-ghost" data-id="${escapeHtml(issue.id)}" data-action="split-cancel">Cancel</button>
              <button type="button" class="btn btn-xs btn-accent" data-id="${escapeHtml(issue.id)}" data-action="split-submit">Create Sub-tasks</button>
            </div>
          </div>`
        : "";

      const editHtml = activeEditId === issue.id ? renderEditForm(issue) : "";

      const deleteHtml = pendingDeleteId === issue.id
        ? `<div class="delete-confirm">
            <span>Delete ${escapeHtml(issue.identifier)}? This cannot be undone.</span>
            <button type="button" class="btn btn-xs btn-error" data-id="${escapeHtml(issue.id)}" data-action="delete-confirm">Confirm Delete</button>
            <button type="button" class="btn btn-xs btn-ghost" data-id="${escapeHtml(issue.id)}" data-action="delete-cancel">Cancel</button>
          </div>`
        : "";

      const isRunning = issue.state === "In Progress";
      const isDetailSelected = selectedDetailId === issue.id;

      return `
        <article class="issue-card${isRunning ? " issue-running" : ""}${isDetailSelected ? " issue-selected" : ""}" data-issue-id="${escapeHtml(issue.id)}">
          <h3 class="issue-title">
            <label class="issue-select"><input type="checkbox" data-select-issue="${escapeHtml(issue.id)}" ${selectedIssues.has(issue.id) ? "checked" : ""} /><span class="issue-checkbox"></span></label>
            ${escapeHtml(issue.identifier)} — ${escapeHtml(issue.title)}
          </h3>
          <p class="muted">${escapeHtml(issue.description || "No description")}</p>
          <div class="meta">
            <span class="${stateClass(issue.state)}">${escapeHtml(issue.state)}</span>
            ${blockedByHtml}
            <span>Priority ${escapeHtml(issue.priority)}</span>
            <span>Attempts ${escapeHtml(issue.attempts || 0)}/${escapeHtml(issue.maxAttempts || 1)}</span>
            ${issue.durationMs ? `<span>Duration ${formatDuration(issue.durationMs)}</span>` : ""}
          </div>
          <div class="meta">${labels}</div>
          ${(category || overlays) ? `<div class="meta">${category}${overlays}</div>` : ""}
          ${paths ? `<div class="meta">${paths}</div>` : ""}
          <div class="meta">
            <span title="${escapeHtml(formatDate(issue.updatedAt))}">Updated: ${timeAgo(issue.updatedAt)}</span>
            <span>Workspace: ${escapeHtml(issue.workspacePath || "pending")}</span>
          </div>
          ${errorHtml}
          <div class="actions">${issueActions(issue)}</div>
          ${noteHtml}
          ${splitHtml}
          ${editHtml}
          ${deleteHtml}
          ${sessionHtml}
          <ul class="history">${history}</ul>
        </article>
      `;
    })
    .join("");

  // Apply card entrance/transition animations
  applyIssueCardAnimations(filtered);

  for (const issueId of expandedSessions) {
    loadSessionsForIssue(issueId);
  }

  // Refresh detail panel if selected issue is still in the list
  if (selectedDetailId && isDesktop()) {
    const issue = issues.find((i) => i.id === selectedDetailId);
    if (issue) {
      renderDetailPanel(issue);
    }
  }
}

// ── Kanban board rendering ───────────────────────────────────────────────

function renderKanban(issues = []) {
  if (!kanbanBoard) return;

  const selectedCategory = categoryFilter?.value || "all";
  const search = queryInput.value.trim().toLowerCase();

  const columns = ["Todo", "In Progress", "In Review", "Blocked", "Done", "Cancelled"];

  // Filter issues for search/category but show all states (kanban shows all columns)
  const filtered = issues.filter((issue) => {
    if (selectedCategory !== "all" && issue.capabilityCategory !== selectedCategory) return false;
    if (activeKpiFilter && activeKpiFilter.key === "capability" && activeKpiFilter.value === "critical") {
      if (issue.capabilityCategory !== "security" && issue.capabilityCategory !== "bugfix") return false;
    }
    if (search) {
      const target = `${issue.identifier} ${issue.title} ${issue.description || ""} ${issue.id}`.toLowerCase();
      if (!target.includes(search)) return false;
    }
    return true;
  });

  // Group by state
  const grouped = {};
  for (const col of columns) grouped[col] = [];
  for (const issue of filtered) {
    const bucket = grouped[issue.state];
    if (bucket) bucket.push(issue);
    else if (grouped["Todo"]) grouped["Todo"].push(issue); // fallback
  }

  // Sort within each column: priority asc, then createdAt oldest first
  for (const col of columns) {
    grouped[col].sort((a, b) => {
      const pDiff = (a.priority || 999) - (b.priority || 999);
      if (pDiff !== 0) return pDiff;
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return aTime - bTime;
    });
  }

  // WIP limit: only for "In Progress", based on workerConcurrency
  const wipLimit = appState.config?.workerConcurrency || 2;

  kanbanBoard.innerHTML = columns.map((state) => {
    const cards = grouped[state];
    const isCollapsed = collapsedColumns.has(state);
    const canCollapse = state === "Done" || state === "Cancelled";
    const isOverWip = state === "In Progress" && cards.length >= wipLimit;

    const emptyMessages = {
      "Todo": null, // special CTA
      "In Progress": "Issues move here when agents start working",
      "In Review": "Completed work awaiting review",
      "Blocked": "Issues that need attention",
      "Done": "Completed issues appear here",
      "Cancelled": "Cancelled issues",
    };
    let emptyHtml;
    if (!cards.length && state === "Todo") {
      emptyHtml = `<div class="kanban-empty-cta" data-action="kanban-create-cta">
        <div class="kanban-empty-icon">+</div>
        <div>Create an issue to start</div>
      </div>`;
    } else if (!cards.length) {
      emptyHtml = `<div class="kanban-empty">${emptyMessages[state] || "No issues"}</div>`;
    }
    const cardsHtml = cards.length
      ? cards.map((issue) => {
          const isSelected = selectedDetailId === issue.id;
          const isExpanded = expandedKanbanCards.has(issue.id);
          const quickActions = issue.state === "Blocked" || issue.state === "Done" || issue.state === "Cancelled"
            ? `<div class="kanban-card-actions"><button data-action="retry" data-id="${escapeHtml(issue.id)}" title="Retry">↻</button></div>`
            : issue.state === "In Progress" || issue.state === "In Review"
            ? `<div class="kanban-card-actions"><button data-action="cancel" data-id="${escapeHtml(issue.id)}" title="Cancel">✕</button></div>`
            : "";

          // Expanded content
          const desc = issue.description || "";
          const truncDesc = desc.length > 150 ? escapeHtml(desc.slice(0, 150)) + "..." : escapeHtml(desc);
          const truncError = issue.lastError ? (issue.lastError.length > 80 ? escapeHtml(issue.lastError.slice(0, 80)) + "..." : escapeHtml(issue.lastError)) : "";
          const attempts = issue.attempts || 0;
          const maxAttempts = issue.maxAttempts || 1;

          const expandedHtml = `<div class="kanban-card-expand${isExpanded ? " open" : ""}">
              <div class="kanban-card-expand-inner">
                ${desc ? `<div class="kanban-card-desc">${truncDesc}</div>` : ""}
                ${truncError ? `<div class="kanban-card-error">${truncError}</div>` : ""}
                ${attempts > 0 ? `<div class="kanban-card-attempts">${attempts}/${maxAttempts} attempts</div>` : ""}
                <div class="kanban-card-updated">${timeAgo(issue.updatedAt)}</div>
                <div class="kanban-card-detail-btn" data-action="open-detail" data-id="${escapeHtml(issue.id)}">details</div>
              </div>
            </div>`;

          // Progress bar
          let progressHtml = "";
          if (attempts > 0) {
            const pct = Math.min(100, Math.round((attempts / maxAttempts) * 100));
            const pClass = issue.state === "Done" ? "ok" : attempts >= maxAttempts ? "danger" : "warn";
            progressHtml = `<div class="kanban-card-progress"><div class="kanban-card-progress-fill ${pClass}" style="width:${pct}%"></div></div>`;
          }

          return `<div class="kanban-card${isSelected ? " selected" : ""}" data-issue-id="${escapeHtml(issue.id)}" draggable="true">
            <div class="kanban-card-header">
              <span class="kanban-card-id">${escapeHtml(issue.identifier)}</span>
              ${quickActions}
            </div>
            <div class="kanban-card-title">${escapeHtml(issue.title)}</div>
            <div class="kanban-card-meta">
              <span class="kanban-card-priority">P${escapeHtml(issue.priority)}</span>
              ${issue.capabilityCategory ? `<span class="kanban-card-capability">${escapeHtml(issue.capabilityCategory)}</span>` : ""}
              ${issue.durationMs ? `<span class="kanban-card-priority">${formatDuration(issue.durationMs)}</span>` : ""}
            </div>
            ${expandedHtml}
            ${progressHtml}
          </div>`;
        }).join("")
      : emptyHtml;

    const collapseBtn = canCollapse
      ? `<button class="kanban-column-collapse-btn" data-action="toggle-collapse" data-col="${escapeHtml(state)}" title="${isCollapsed ? "Expand" : "Collapse"}">${isCollapsed ? "\u25B8" : "\u25BE"}</button>`
      : "";

    const columnClasses = [
      "kanban-column",
      isCollapsed ? "collapsed" : "",
      isOverWip ? "kanban-column-over-wip" : "",
    ].filter(Boolean).join(" ");

    return `<div class="${columnClasses}" data-state="${escapeHtml(state)}">
      <div class="kanban-column-header">
        ${collapseBtn}
        <span class="kanban-column-title">${escapeHtml(state)}</span>
        <span class="kanban-column-count">${cards.length}</span>
      </div>
      <div class="kanban-cards">${cardsHtml}</div>
    </div>`;
  }).join("");

  // Update issue count
  const countEl = document.getElementById("issue-count");
  if (countEl) {
    countEl.textContent = filtered.length === issues.length
      ? `${issues.length} issues`
      : `${filtered.length} / ${issues.length} issues`;
  }

  // Wire drag-and-drop
  wireKanbanDragAndDrop();
  // Wire card clicks
  wireKanbanCardClicks();
}

function wireKanbanDragAndDrop() {
  if (!kanbanBoard) return;

  kanbanBoard.querySelectorAll(".kanban-card[draggable]").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      isDraggingKanban = true;
      e.dataTransfer.setData("text/plain", card.dataset.issueId);
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("dragging");

      // Custom drag ghost with reduced opacity
      const ghost = card.cloneNode(true);
      ghost.style.position = "absolute";
      ghost.style.top = "-9999px";
      ghost.style.opacity = "0.7";
      ghost.style.width = card.offsetWidth + "px";
      ghost.style.transform = "rotate(1deg)";
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, e.offsetX, e.offsetY);
      requestAnimationFrame(() => ghost.remove());
    });
    card.addEventListener("dragend", () => {
      isDraggingKanban = false;
      card.classList.remove("dragging");
    });
  });

  kanbanBoard.querySelectorAll(".kanban-column").forEach((column) => {
    column.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      column.classList.add("drag-over");
    });
    column.addEventListener("dragleave", (e) => {
      // Only remove if leaving the column itself, not entering a child
      if (!column.contains(e.relatedTarget)) {
        column.classList.remove("drag-over");
      }
    });
    column.addEventListener("drop", async (e) => {
      e.preventDefault();
      column.classList.remove("drag-over");
      const issueId = e.dataTransfer.getData("text/plain");
      const newState = column.dataset.state;
      if (!issueId || !newState) return;

      // Check if the issue is already in this state
      const issue = (appState.issues || []).find((i) => i.id === issueId);
      if (issue && issue.state === newState) return;

      try {
        await post(`/issues/${encodeURIComponent(issueId)}/state`, { state: newState });
        await syncAfterAction();
      } catch (err) {
        showToast(`State change failed: ${err.message}`);
      }
    });
  });
}

function openKanbanDetail(issueId) {
  const issue = (appState.issues || []).find((i) => i.id === issueId);
  if (!issue) return;
  selectedDetailId = issueId;
  renderKanbanDetail(issue);
  renderKanban(appState.issues || []);
}

function wireKanbanCardClicks() {
  if (!kanbanBoard) return;

  kanbanBoard.querySelectorAll(".kanban-card").forEach((card) => {
    // Single click: toggle inline expand (not detail panel)
    card.addEventListener("click", (e) => {
      if (e.target.closest(".kanban-card-actions")) return;
      if (e.target.closest(".kanban-card-detail-btn")) return;
      if (isDraggingKanban) return;

      const issueId = card.dataset.issueId;
      if (!issueId) return;

      // Toggle expanded state
      if (expandedKanbanCards.has(issueId)) {
        expandedKanbanCards.delete(issueId);
      } else {
        expandedKanbanCards.add(issueId);
      }

      // Animate the expand area without full re-render
      const expandEl = card.querySelector(".kanban-card-expand");
      if (expandEl) {
        expandEl.classList.toggle("open", expandedKanbanCards.has(issueId));
      }
    });

    // Double click: open detail panel
    card.addEventListener("dblclick", (e) => {
      if (e.target.closest(".kanban-card-actions")) return;
      const issueId = card.dataset.issueId;
      if (!issueId) return;
      openKanbanDetail(issueId);
    });
  });

  // Wire "details" link buttons inside expanded cards
  kanbanBoard.querySelectorAll("[data-action='open-detail']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (id) openKanbanDetail(id);
    });
  });

  // Wire kanban empty CTA click (Todo column)
  kanbanBoard.querySelectorAll("[data-action='kanban-create-cta']").forEach((cta) => {
    cta.addEventListener("click", () => toggleCreateForm());
  });

  // Wire column collapse toggle buttons
  kanbanBoard.querySelectorAll("[data-action='toggle-collapse']").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const col = btn.dataset.col;
      if (!col) return;
      if (collapsedColumns.has(col)) {
        collapsedColumns.delete(col);
      } else {
        collapsedColumns.add(col);
      }
      localStorage.setItem("symphifo-collapsed-columns", JSON.stringify([...collapsedColumns]));
      renderKanban(appState.issues || []);
    });
  });

  // Wire quick action buttons on kanban cards
  kanbanBoard.querySelectorAll(".kanban-card-actions button").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (!action || !id) return;

      try {
        if (action === "retry") {
          await withLoading(btn, async () => {
            await post(`/issues/${encodeURIComponent(id)}/retry`);
            await syncAfterAction();
          });
        } else if (action === "cancel") {
          await withLoading(btn, async () => {
            await post(`/issues/${encodeURIComponent(id)}/cancel`);
            await syncAfterAction();
          });
        }
      } catch (err) {
        showToast(err.message || "Action failed.");
      }
    });
  });
}

function renderKanbanDetail(issue) {
  if (!kanbanDetail || !kanbanDetailContent) return;
  kanbanDetail.hidden = false;

  const stateActions = issue.state === "Blocked"
    ? `<button class="btn btn-xs btn-ghost" data-action="retry" data-id="${escapeHtml(issue.id)}">Retry</button>
       <button class="btn btn-xs btn-ghost" data-action="state" data-id="${escapeHtml(issue.id)}" data-payload="Todo">Set Todo</button>
       <button class="btn btn-xs btn-ghost" data-action="cancel" data-id="${escapeHtml(issue.id)}">Cancel</button>`
    : issue.state === "Todo"
    ? `<button class="btn btn-xs btn-ghost" data-action="state" data-id="${escapeHtml(issue.id)}" data-payload="In Progress">Start</button>
       <button class="btn btn-xs btn-ghost" data-action="cancel" data-id="${escapeHtml(issue.id)}" data-payload="Cancelled">Cancel</button>`
    : issue.state === "Done" || issue.state === "Cancelled"
    ? `<button class="btn btn-xs btn-ghost" data-action="retry" data-id="${escapeHtml(issue.id)}">Retry</button>`
    : `<button class="btn btn-xs btn-ghost" data-action="cancel" data-id="${escapeHtml(issue.id)}">Cancel</button>`;

  kanbanDetailContent.innerHTML = `
    <div class="detail-issue-header" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--ash);">
      <span class="mono" style="color:var(--plague);font-size:0.72rem;font-weight:600;">${escapeHtml(issue.identifier)}</span>
      <span style="color:var(--frost);font-size:0.78rem;font-weight:600;flex:1;">${escapeHtml(issue.title)}</span>
      <button type="button" class="btn btn-xs btn-ghost" id="kanban-close-detail" title="Close">&times;</button>
    </div>
    <p class="muted" style="margin:0 0 8px;">${escapeHtml(issue.description || "No description")}</p>
    <div class="meta">
      <span class="${stateClass(issue.state)}">${escapeHtml(issue.state)}</span>
      <span>Priority ${escapeHtml(issue.priority)}</span>
      <span>Attempts ${escapeHtml(issue.attempts || 0)}/${escapeHtml(issue.maxAttempts || 1)}</span>
      ${issue.durationMs ? `<span>Duration ${formatDuration(issue.durationMs)}</span>` : ""}
    </div>
    ${issue.lastError ? `<details class="error-detail" style="margin-top:8px;"><summary>Last error</summary><pre class="mono">${escapeHtml(issue.lastError)}</pre></details>` : ""}
    <div class="actions" style="margin-top:8px;">${stateActions}</div>
    <div class="session-panel" id="kanban-session-panel" style="margin-top:10px;">${sessionLoadingSkeleton()}</div>
  `;

  // Wire close button
  document.getElementById("kanban-close-detail")?.addEventListener("click", () => {
    selectedDetailId = null;
    kanbanDetail.hidden = true;
    renderKanban(appState.issues || []);
  });

  // Wire action buttons
  kanbanDetailContent.querySelectorAll(".btn[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const payload = btn.dataset.payload || "";
      if (!action || !id) return;
      try {
        if (action === "state") await setIssueState(id, payload, btn);
        else if (action === "retry") await retryIssue(id, btn);
        else if (action === "cancel") await cancelIssue(id, btn);
      } catch (err) { showToast(err.message); }
    });
  });

  // Load sessions
  loadSessionsForPanel(issue.id, "kanban-session-panel");
}

function setViewMode(mode) {
  switchTab(mode);
}

// ── Detail panel (desktop right panel) ──────────────────────────────────────

function renderDetailPanel(issue) {
  if (!detailPanel) return;
  detailPanel.innerHTML = `
    <div class="detail-issue-header">
      <span class="mono">${escapeHtml(issue.identifier)}</span> ${escapeHtml(issue.title)}
      <button type="button" class="btn btn-xs btn-ghost" id="close-detail" title="Close">&times;</button>
    </div>
    <div class="meta" style="margin-top:0">
      <span class="${stateClass(issue.state)}">${escapeHtml(issue.state)}</span>
      <span>Priority ${escapeHtml(issue.priority)}</span>
      ${issue.durationMs ? `<span>Duration ${formatDuration(issue.durationMs)}</span>` : ""}
    </div>
    <div class="session-panel" id="detail-session-panel">
      ${sessionLoadingSkeleton()}
    </div>
  `;
  document.getElementById("close-detail")?.addEventListener("click", () => {
    clearDetailPanel();
    renderIssues(appState.issues || []);
  });
  loadSessionsForPanel(issue.id, "detail-session-panel");
}

function clearDetailPanel() {
  selectedDetailId = null;
  if (detailPanel) {
    detailPanel.innerHTML = '<div class="detail-placeholder">Select an issue to view sessions</div>';
  }
}

async function loadSessionsForPanel(issueId, panelElementId) {
  const panel = document.getElementById(panelElementId);
  if (!panel) return;

  try {
    const data = await fetchJSON(`/issues/${encodeURIComponent(issueId)}/sessions`);
    let html = "";

    if (data.pipeline) {
      const pipeline = data.pipeline;
      html += '<div class="session-header">Pipeline</div>';
      html += `<div class="pipeline-step">
        <span class="step-provider">attempt ${escapeHtml(pipeline.attempt || "\u2014")}</span>
        <span class="step-status">cycle ${escapeHtml(pipeline.cycle || "\u2014")}</span>
        <span class="step-status">active index ${escapeHtml(pipeline.activeIndex || 0)}</span>
      </div>`;

      if (Array.isArray(pipeline.history) && pipeline.history.length) {
        html += `<details class="history-detail" open>
          <summary>${pipeline.history.length} pipeline events</summary>
          <ul class="history">${pipeline.history.map((entry) => `<li class="mono">${escapeHtml(entry)}</li>`).join("")}</ul>
        </details>`;
      }
    }

    if (data.sessions && Array.isArray(data.sessions) && data.sessions.length) {
      html += '<div class="session-header" style="margin-top:10px">Sessions</div>';
      for (const item of data.sessions.slice(-6)) {
        const session = item.session || {};
        const turns = Array.isArray(session.turns) ? session.turns : [];
        const lastTurn = turns.length ? turns[turns.length - 1] : null;
        html += `<div class="pipeline-step">
          <span class="step-provider">${escapeHtml(`${item.role || "agent"}:${item.provider || "unknown"}`)}</span>
          <span class="step-status">${escapeHtml(session.status || "\u2014")}</span>
          <span class="step-status">cycle ${escapeHtml(item.cycle || "\u2014")}</span>
          <span class="step-status">${escapeHtml(`${turns.length}/${session.maxTurns || "?"} turns`)}</span>
        </div>`;
        if (session.lastDirectiveStatus || session.lastDirectiveSummary) {
          html += `<div class="session-output">${escapeHtml(
            `${session.lastDirectiveStatus || "status"}${session.lastDirectiveSummary ? `: ${session.lastDirectiveSummary}` : ""}`,
          )}</div>`;
        }
        if (lastTurn?.output || session.lastOutput) {
          const output = lastTurn?.output || session.lastOutput || "";
          const truncated = output.length > 2000 ? `\u2026${output.slice(-2000)}` : output;
          html += `<details class="history-detail">
            <summary>Latest output</summary>
            <div class="session-output">${escapeHtml(truncated)}</div>
          </details>`;
        }
        if (turns.length) {
          html += `<details class="history-detail">
            <summary>${turns.length} turns</summary>
            <ul class="history">${turns.map((turn) => `<li class="mono">#${escapeHtml(turn.turn)} ${escapeHtml(turn.directiveStatus || "\u2014")} ${escapeHtml(turn.directiveSummary || "")}</li>`).join("")}</ul>
          </details>`;
        }
      }
    }

    panel.innerHTML = html || '<div class="session-loading">No session data available yet.</div>';
    staggerAnimateSteps(panel);
  } catch (error) {
    panel.innerHTML = `<div class="session-loading">Failed to load: ${escapeHtml(error.message)}</div>`;
  }
}

// ── Session/Pipeline Loading (inline, for mobile) ───────────────────────────

async function loadSessionsForIssue(issueId) {
  const panel = document.getElementById(`session-${issueId}`);
  if (!panel) return;

  try {
    const data = await fetchJSON(`/issues/${encodeURIComponent(issueId)}/sessions`);
    let html = "";

    if (data.pipeline) {
      const pipeline = data.pipeline;
      html += '<div class="session-header">Pipeline</div>';
      html += `<div class="pipeline-step">
        <span class="step-provider">attempt ${escapeHtml(pipeline.attempt || "\u2014")}</span>
        <span class="step-status">cycle ${escapeHtml(pipeline.cycle || "\u2014")}</span>
        <span class="step-status">active index ${escapeHtml(pipeline.activeIndex || 0)}</span>
      </div>`;

      if (Array.isArray(pipeline.history) && pipeline.history.length) {
        html += `<details class="history-detail" open>
          <summary>${pipeline.history.length} pipeline events</summary>
          <ul class="history">${pipeline.history.map((entry) => `<li class="mono">${escapeHtml(entry)}</li>`).join("")}</ul>
        </details>`;
      }
    }

    if (data.sessions && Array.isArray(data.sessions) && data.sessions.length) {
      html += '<div class="session-header" style="margin-top:10px">Sessions</div>';
      for (const item of data.sessions.slice(-6)) {
        const session = item.session || {};
        const turns = Array.isArray(session.turns) ? session.turns : [];
        const lastTurn = turns.length ? turns[turns.length - 1] : null;
        html += `<div class="pipeline-step">
          <span class="step-provider">${escapeHtml(`${item.role || "agent"}:${item.provider || "unknown"}`)}</span>
          <span class="step-status">${escapeHtml(session.status || "\u2014")}</span>
          <span class="step-status">cycle ${escapeHtml(item.cycle || "\u2014")}</span>
          <span class="step-status">${escapeHtml(`${turns.length}/${session.maxTurns || "?"} turns`)}</span>
        </div>`;
        if (session.lastDirectiveStatus || session.lastDirectiveSummary) {
          html += `<div class="session-output">${escapeHtml(
            `${session.lastDirectiveStatus || "status"}${session.lastDirectiveSummary ? `: ${session.lastDirectiveSummary}` : ""}`,
          )}</div>`;
        }
        if (lastTurn?.output || session.lastOutput) {
          const output = lastTurn?.output || session.lastOutput || "";
          const truncated = output.length > 2000 ? `\u2026${output.slice(-2000)}` : output;
          html += `<details class="history-detail">
            <summary>Latest output</summary>
            <div class="session-output">${escapeHtml(truncated)}</div>
          </details>`;
        }
        if (turns.length) {
          html += `<details class="history-detail">
            <summary>${turns.length} turns</summary>
            <ul class="history">${turns.map((turn) => `<li class="mono">#${escapeHtml(turn.turn)} ${escapeHtml(turn.directiveStatus || "\u2014")} ${escapeHtml(turn.directiveSummary || "")}</li>`).join("")}</ul>
          </details>`;
        }
      }
    }

    panel.innerHTML = html || '<div class="session-loading">No session data available yet.</div>';
    staggerAnimateSteps(panel);
  } catch (error) {
    panel.innerHTML = `<div class="session-loading">Failed to load: ${escapeHtml(error.message)}</div>`;
  }
}

// ── Split Issue ──────────────────────────────────────────────────────────────

function toggleSplitForm(issueId) {
  const issue = (appState.issues || []).find((i) => i.id === issueId);
  if (!issue) return;

  // Close if already open for this issue
  if (activeSplitId === issueId) {
    activeSplitId = null;
    renderIssues(appState.issues || []);
    return;
  }

  activeSplitId = issueId;
  renderIssues(appState.issues || []);

  // Focus the textarea after render
  setTimeout(() => {
    const textarea = document.querySelector(`[data-split-for="${issueId}"]`);
    if (textarea) textarea.focus();
  }, 50);
}

async function submitSplit(issueId, target) {
  const textarea = document.querySelector(`[data-split-for="${issueId}"]`);
  if (!textarea || !textarea.value.trim()) {
    showToast("Enter at least one sub-task title", "warn");
    return;
  }

  const issue = (appState.issues || []).find((i) => i.id === issueId);
  if (!issue) return;

  const titles = textarea.value.split("\n").map((t) => t.trim()).filter(Boolean);
  if (!titles.length) return;

  await withLoading(target, async () => {
    try {
      const created = [];
      for (const title of titles) {
        const result = await post("/issues", {
          title,
          description: `Sub-task of ${issue.identifier}: ${issue.title}`,
          priority: issue.priority,
          labels: [...(issue.labels || []), `parent:${issue.identifier}`],
          paths: issue.paths || [],
          maxAttempts: issue.maxAttempts || 3,
        });
        if (result.ok && result.issue) created.push(result.issue.identifier);
      }
      activeSplitId = null;
      showToast(`Created ${created.length} sub-tasks: ${created.join(", ")}`, "success");
      await syncAfterAction();
    } catch (error) {
      showToast(`Split failed: ${error.message}`);
    }
  });
}

// ── Add Note ─────────────────────────────────────────────────────────────────

async function addNote(issueId, target) {
  const input = document.querySelector(`[data-note-for="${issueId}"]`);
  if (!input || !input.value.trim()) return;

  const issue = (appState.issues || []).find((i) => i.id === issueId);
  const currentState = issue?.state || "Todo";
  const note = input.value.trim();

  await withLoading(target, async () => {
    try {
      await post(`/issues/${encodeURIComponent(issueId)}/state`, { state: currentState, reason: note });
      input.value = "";
      showToast("Note added", "success", 2000);
      await syncAfterAction();
    } catch (error) {
      showToast(`Note failed: ${error.message}`);
    }
  });
}

// ── Runtime Meta ─────────────────────────────────────────────────────────────

function renderRuntimeMeta(state) {
  runtimeMeta.innerHTML = `
    <div class="meta">
      <span>Repository: ${escapeHtml(state.sourceRepoUrl || "local")}</span>
      <span>Workflow: ${escapeHtml(state.workflowPath || "local")}</span>
      <span>Tracker: ${escapeHtml(state.trackerKind || "filesystem")}</span>
      <span>Agent: ${escapeHtml(state.config?.agentProvider || "auto")} (${escapeHtml(state.config?.agentCommand || "auto-detect")})</span>
      <span class="concurrency-control">
        Concurrency:
        <input type="number" id="concurrency-input" class="input input-bordered input-sm concurrency-input" min="1" max="16" value="${escapeHtml(state.config?.workerConcurrency ?? 2)}" />
        <button type="button" class="btn btn-xs btn-ghost concurrency-btn" id="save-concurrency-btn">Set</button>
      </span>
    </div>
    <div id="providers-panel" class="meta" style="margin-top:4px"></div>
    <div id="parallelism-panel" class="meta" style="margin-top:4px"></div>
    <p class="muted">Started at ${formatDate(state.startedAt)}</p>
  `;

  document.getElementById("save-concurrency-btn")?.addEventListener("click", async (e) => {
    const input = document.getElementById("concurrency-input");
    const num = parseInt(input?.value, 10);
    if (!num || num < 1 || num > 16) { showToast("Must be 1-16", "warn"); return; }
    await withLoading(e.target, async () => {
      try {
        await post("/config/concurrency", { concurrency: num });
        showToast(`Concurrency set to ${num}`, "success");
        await syncAfterAction();
      } catch (err) { showToast(err.message); }
    });
  });

  loadProviders();
  loadParallelism();
}

async function loadProviders() {
  const panel = document.getElementById("providers-panel");
  if (!panel) return;
  try {
    const data = await fetchJSON("/providers");
    if (!data.providers || !data.providers.length) { panel.innerHTML = ""; return; }
    panel.innerHTML = "Providers: " + data.providers.map((p) =>
      `<span class="badge badge-outline badge-xs ${p.available ? "badge-success" : "badge-error"}">${escapeHtml(p.name)}: ${p.available ? "available" : "not found"}</span>`
    ).join(" ");
  } catch { panel.innerHTML = ""; }
}

async function loadParallelism() {
  const panel = document.getElementById("parallelism-panel");
  if (!panel) return;
  try {
    const data = await fetchJSON("/parallelism");
    if (!data.reason) { panel.innerHTML = ""; return; }
    const badge = data.canParallelize ? "badge-success" : "badge-error";
    panel.innerHTML = `Parallelism: <span class="badge badge-outline badge-xs ${badge}">max safe=${data.maxSafeParallelism}</span> <span class="muted">${escapeHtml(data.reason)}</span>`;
  } catch { panel.innerHTML = ""; }
}

// ── Events ───────────────────────────────────────────────────────────────────

let allEvents = [];

function renderEvents(events = []) {
  // Merge new events (dedup, cap at 200)
  if (events.length) {
    const seen = new Set(allEvents.map((e) => e.at + e.issueId + e.message));
    for (const e of events) {
      if (!seen.has(e.at + e.issueId + e.message)) allEvents.unshift(e);
    }
    if (allEvents.length > 200) allEvents.length = 200;
  }

  if (!allEvents.length) {
    eventsEl.innerHTML = `<div class="empty-events">
      <div class="empty-events-title">No events yet</div>
      <div class="empty-events-desc">Events appear here when agents run. Start by creating an issue.</div>
    </div>`;
    return;
  }

  // Filtering
  const kindFilter = eventKindFilter?.value || "all";
  const issueFilter = eventIssueFilter?.value || "all";

  const filtered = allEvents.filter((e) => {
    if (kindFilter !== "all" && (e.kind || "info") !== kindFilter) return false;
    if (issueFilter !== "all" && e.issueId !== issueFilter) return false;
    return true;
  });

  if (!filtered.length) {
    eventsEl.innerHTML = '<p class="muted">No events match this filter.</p>';
    return;
  }

  // Group consecutive events with identical messages
  const displayItems = filtered.slice(0, 80);
  const grouped = [];
  for (const event of displayItems) {
    const prev = grouped.length ? grouped[grouped.length - 1] : null;
    if (prev && prev.event.message === event.message) {
      prev.count++;
      // Keep the most recent timestamp (first in list since sorted newest-first)
    } else {
      grouped.push({ event, count: 1 });
    }
  }

  const hadEvents = eventsEl.children.length > 0;
  const isNewPush = events.length > 0;
  eventsEl.innerHTML = grouped
    .map((item, idx) => {
      const event = item.event;
      const countBadge = item.count > 1 ? ` <span class="event-dedup-count">\u00d7${item.count}</span>` : "";
      return `
      <div class="event event-${event.kind || "info"}${isNewPush && idx < events.length ? " animate-in" : ""}"${isNewPush && idx < events.length ? ` style="animation-delay:${idx * 30}ms"` : ""}>
        <div class="mono" title="${escapeHtml(formatDate(event.at))}">${timeAgo(event.at)} ${escapeHtml(event.issueId || "system")}</div>
        <div>${escapeHtml(event.message || "")}${countBadge}</div>
      </div>
    `;
    })
    .join("");

  // Auto-scroll to top when new events arrive
  if (events.length && hadEvents) eventsEl.scrollTop = 0;

  // Keep Events tab badge in sync
  updateTabBadges();
}

// ── State Management ─────────────────────────────────────────────────────────

// If WS connected, skip loadState — the push will bring the update.
// If polling, do loadState to get immediate feedback.
async function syncAfterAction() {
  if (!wsConnected) await loadState();
}

async function setIssueState(issueId, nextState, target) {
  await withLoading(target, async () => {
    await post(`/issues/${encodeURIComponent(issueId)}/state`, { state: nextState });
    await syncAfterAction();
  });
}

async function retryIssue(issueId, target) {
  await withLoading(target, async () => {
    await post(`/issues/${encodeURIComponent(issueId)}/retry`);
    await syncAfterAction();
  });
}

async function cancelIssue(issueId, target) {
  await withLoading(target, async () => {
    await post(`/issues/${encodeURIComponent(issueId)}/cancel`);
    await syncAfterAction();
  });
}

// ── Create Issue ─────────────────────────────────────────────────────────────

function toggleCreateForm() {
  createForm.hidden = !createForm.hidden;
  if (!createForm.hidden) {
    const fields = createForm.querySelectorAll(".form-group");
    fields.forEach((field, i) => {
      field.classList.add("animate-field");
      field.style.animationDelay = `${i * 40}ms`;
    });
    document.getElementById("cf-title").focus();
  }
}

async function submitCreateForm(target) {
  const title = document.getElementById("cf-title").value.trim();
  if (!title) { showToast("Title is required", "warn"); return; }

  const payload = {
    title,
    description: document.getElementById("cf-desc").value.trim(),
    priority: Number(document.getElementById("cf-priority").value) || 1,
    maxAttempts: Number(document.getElementById("cf-attempts").value) || 3,
    labels: document.getElementById("cf-labels").value.split(",").map((s) => s.trim()).filter(Boolean),
    paths: document.getElementById("cf-paths").value.split(",").map((s) => s.trim()).filter(Boolean),
  };

  await withLoading(target, async () => {
    try {
      const result = await post("/issues", payload);
      showToast(`Created ${result.issue?.identifier || "issue"}`, "success");
      createForm.classList.add("form-collapsing");
      createForm.addEventListener("animationend", () => {
        createForm.classList.remove("form-collapsing");
        createForm.hidden = true;
      }, { once: true });
      document.getElementById("cf-title").value = "";
      document.getElementById("cf-desc").value = "";
      document.getElementById("cf-priority").value = "1";
      document.getElementById("cf-attempts").value = "3";
      document.getElementById("cf-labels").value = "";
      document.getElementById("cf-paths").value = "";
      await syncAfterAction();
    } catch (error) {
      showToast(`Create failed: ${error.message}`);
    }
  });
}

// ── Edit / Delete ────────────────────────────────────────────────────────────

let activeEditId = null;
let pendingDeleteId = null;

function toggleEditForm(issueId) {
  activeEditId = activeEditId === issueId ? null : issueId;
  renderIssues(appState.issues || []);
  if (activeEditId) {
    setTimeout(() => {
      const editForm = document.querySelector(`[data-edit-title-for="${issueId}"]`)?.closest(".edit-form");
      if (editForm) {
        const fields = editForm.querySelectorAll(".form-group");
        fields.forEach((field, i) => {
          field.classList.add("animate-field");
          field.style.animationDelay = `${i * 40}ms`;
        });
      }
      const el = document.querySelector(`[data-edit-title-for="${issueId}"]`);
      if (el) el.focus();
    }, 50);
  }
}

function renderEditForm(issue) {
  return `
    <div class="edit-form">
      <div class="create-form-grid">
        <div class="form-group span-2">
          <label>Title</label>
          <input data-edit-title-for="${escapeHtml(issue.id)}" type="text" class="input input-bordered input-sm w-full" value="${escapeHtml(issue.title)}" />
        </div>
        <div class="form-group span-2">
          <label>Description</label>
          <textarea data-edit-desc-for="${escapeHtml(issue.id)}" rows="2" class="textarea textarea-bordered w-full">${escapeHtml(issue.description || "")}</textarea>
        </div>
        <div class="form-group">
          <label>Priority (1-10)</label>
          <input data-edit-priority-for="${escapeHtml(issue.id)}" type="number" class="input input-bordered input-sm w-full" min="1" max="10" value="${escapeHtml(issue.priority)}" />
        </div>
        <div class="form-group">
          <label>Labels <span class="hint">comma-separated</span></label>
          <input data-edit-labels-for="${escapeHtml(issue.id)}" type="text" class="input input-bordered input-sm w-full" value="${escapeHtml((issue.labels || []).join(", "))}" />
        </div>
        <div class="form-group span-2">
          <label>Paths <span class="hint">comma-separated</span></label>
          <input data-edit-paths-for="${escapeHtml(issue.id)}" type="text" class="input input-bordered input-sm w-full" value="${escapeHtml((issue.paths || []).join(", "))}" />
        </div>
        <div class="form-group span-2">
          <label>Blocked by <span class="hint">comma-separated issue IDs</span></label>
          <input data-edit-blocked-for="${escapeHtml(issue.id)}" type="text" class="input input-bordered input-sm w-full" value="${escapeHtml((issue.blockedBy || []).join(", "))}" />
        </div>
      </div>
      <div class="create-form-actions">
        <button type="button" class="btn btn-xs btn-ghost" data-id="${escapeHtml(issue.id)}" data-action="edit-cancel">Cancel</button>
        <button type="button" class="btn btn-xs btn-accent" data-id="${escapeHtml(issue.id)}" data-action="edit-submit">Save</button>
      </div>
    </div>
  `;
}

async function submitEdit(issueId, target) {
  const get = (attr) => document.querySelector(`[data-edit-${attr}-for="${issueId}"]`);
  const titleEl = get("title");
  if (!titleEl) return;

  await withLoading(target, async () => {
    try {
      const response = await fetch(`/issues/${encodeURIComponent(issueId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: titleEl.value.trim() || undefined,
          description: get("desc")?.value.trim() ?? "",
          priority: Math.max(1, Math.min(10, parseInt(get("priority")?.value, 10) || 1)),
          labels: (get("labels")?.value || "").split(",").map((s) => s.trim()).filter(Boolean),
          paths: (get("paths")?.value || "").split(",").map((s) => s.trim()).filter(Boolean),
          blockedBy: (get("blocked")?.value || "").split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      if (!response.ok) throw new Error(`Failed: ${response.status}`);
      activeEditId = null;
      showToast("Issue updated", "success");
      await syncAfterAction();
    } catch (e) {
      showToast(`Edit failed: ${e.message}`);
    }
  });
}

function requestDelete(issueId) {
  pendingDeleteId = pendingDeleteId === issueId ? null : issueId;
  renderIssues(appState.issues || []);
}

async function confirmDelete(issueId, target) {
  await withLoading(target, async () => {
    try {
      const response = await fetch(`/issues/${encodeURIComponent(issueId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Failed: ${response.status}`);
      const issue = (appState.issues || []).find((i) => i.id === issueId);
      pendingDeleteId = null;
      if (selectedDetailId === issueId) clearDetailPanel();
      showToast(`Deleted ${issue?.identifier || issueId}`, "success");
      await syncAfterAction();
    } catch (e) {
      pendingDeleteId = null;
      showToast(`Delete failed: ${e.message}`);
    }
  });
}

// ── Wire Actions ─────────────────────────────────────────────────────────────

function wireActions() {
  issueListEl.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;

    const action = target.dataset.action;
    const id = target.dataset.id;
    const payload = target.dataset.payload || "";
    if (!action || !id) return;

    try {
      if (action === "state") await setIssueState(id, payload, target);
      else if (action === "retry") await retryIssue(id, target);
      else if (action === "cancel") await cancelIssue(id, target);
      else if (action === "sessions") {
        if (isDesktop()) {
          // Desktop: show in detail panel
          if (selectedDetailId === id) {
            clearDetailPanel();
          } else {
            selectedDetailId = id;
            const issue = (appState.issues || []).find((i) => i.id === id);
            if (issue) renderDetailPanel(issue);
          }
          renderIssues(appState.issues || []);
        } else {
          // Mobile: inline toggle
          if (expandedSessions.has(id)) expandedSessions.delete(id);
          else expandedSessions.add(id);
          renderIssues(appState.issues || []);
        }
      }
      else if (action === "more") {
        // Toggle secondary actions visibility
        const secondary = target.closest(".actions")?.querySelector(`[data-secondary-for="${id}"]`);
        if (secondary) {
          secondary.classList.toggle("actions-secondary-visible");
        }
      }
      else if (action === "split") toggleSplitForm(id);
      else if (action === "split-submit") await submitSplit(id, target);
      else if (action === "split-cancel") { activeSplitId = null; renderIssues(appState.issues || []); }
      else if (action === "note") await addNote(id, target);
      else if (action === "edit") toggleEditForm(id);
      else if (action === "edit-submit") await submitEdit(id, target);
      else if (action === "edit-cancel") { activeEditId = null; renderIssues(appState.issues || []); }
      else if (action === "delete") requestDelete(id);
      else if (action === "delete-confirm") await confirmDelete(id, target);
      else if (action === "delete-cancel") { pendingDeleteId = null; renderIssues(appState.issues || []); }
    } catch (error) {
      showToast(error.message || "Action failed.");
    }
  });

  // Checkbox selection for batch actions
  issueListEl.addEventListener("change", (event) => {
    const checkbox = event.target;
    if (!checkbox.dataset.selectIssue) return;
    const id = checkbox.dataset.selectIssue;
    if (checkbox.checked) selectedIssues.add(id);
    else selectedIssues.delete(id);
    // Re-render just the count/batch toolbar without full re-render
    const countEl = document.getElementById("issue-count");
    if (countEl && selectedIssues.size > 0) {
      countEl.innerHTML = `<span class="batch-info">${selectedIssues.size} selected</span> `
        + `<button type="button" class="btn btn-xs btn-ghost" id="batch-retry">Retry All</button> `
        + `<button type="button" class="btn btn-xs btn-ghost" id="batch-cancel">Cancel All</button> `
        + `<button type="button" class="btn btn-xs btn-ghost" id="batch-clear">Clear</button>`;
    } else if (countEl) {
      const issues = appState.issues || [];
      countEl.textContent = `${issues.length} issues`;
    }
  });

  // Batch action buttons (delegated from issue-count container's parent)
  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (target.id === "batch-retry") {
      const ids = [...selectedIssues];
      for (const id of ids) {
        try { await post(`/issues/${encodeURIComponent(id)}/retry`); } catch {}
      }
      selectedIssues.clear();
      showToast(`Retried ${ids.length} issues`, "success");
      await syncAfterAction();
    } else if (target.id === "batch-cancel") {
      const ids = [...selectedIssues];
      for (const id of ids) {
        try { await post(`/issues/${encodeURIComponent(id)}/cancel`); } catch {}
      }
      selectedIssues.clear();
      showToast(`Cancelled ${ids.length} issues`, "success");
      await syncAfterAction();
    } else if (target.id === "batch-clear") {
      selectedIssues.clear();
      renderIssues(appState.issues || []);
    }
  });

  issueListEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.dataset.noteFor) {
      addNote(event.target.dataset.noteFor);
    }
  });

  // View toggle buttons
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  rerunBtn?.addEventListener("click", async () => {
    try { await post("/refresh", {}); } catch {}
    // Reset WS reconnect state and retry
    wsReconnectCount = 0;
    clearTimeout(wsReconnectTimer);
    if (!wsConnected) {
      stopPollingFallback();
      connectWebSocket();
    }
    await loadState();
  });
  clearEventsBtn?.addEventListener("click", () => {
    allEvents = [];
    lastEventTimestamp = "";
    eventsEl.innerHTML = '<p class="muted">Event history cleared.</p>';
  });

  newIssueBtn?.addEventListener("click", toggleCreateForm);
  document.getElementById("cf-cancel")?.addEventListener("click", () => { createForm.hidden = true; });
  document.getElementById("cf-submit")?.addEventListener("click", (e) => submitCreateForm(e.target));
  document.getElementById("cf-title")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitCreateForm(document.getElementById("cf-submit"));
  });
}

// ── Data Loading ─────────────────────────────────────────────────────────────

async function loadEvents() {
  try {
    const params = new URLSearchParams();
    if (lastEventTimestamp) params.set("since", lastEventTimestamp);
    if (eventKindFilter?.value && eventKindFilter.value !== "all") params.set("kind", eventKindFilter.value);
    if (eventIssueFilter?.value && eventIssueFilter.value !== "all") params.set("issueId", eventIssueFilter.value);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const payload = await fetchJSON(`/events/feed${query}`);
    const events = Array.isArray(payload.events) ? payload.events : [];

    if (events.length > 0) {
      const latest = events[0];
      if (latest && latest.at) lastEventTimestamp = latest.at;
    }

    renderEvents(events);
  } catch (error) {
    // ignore intermittent polling errors
  }
}

async function loadState() {
  const payload = await fetchJSON("/state");

  // Diff: skip re-render if nothing changed
  const hash = simpleHash(JSON.stringify(payload.issues) + JSON.stringify(payload.metrics));
  if (hash === lastStateHash) {
    refreshBadge.textContent = `refresh: ${new Date().toLocaleTimeString()}`;
    return;
  }
  lastStateHash = hash;

  appState = payload;
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  if (eventIssueFilter) {
    const previousValue = eventIssueFilter.value || "all";
    const options = [
      { value: "all", label: "All" },
      ...issues
        .map((issue) => ({ value: issue.id, label: issue.identifier || issue.id }))
        .filter((entry) => entry.value)
        .sort((a, b) => String(a.label).localeCompare(String(b.label))),
    ];
    eventIssueFilter.innerHTML = options
      .map((entry) => `<option value="${escapeHtml(entry.value)}">${escapeHtml(entry.label)}</option>`)
      .join("");
    eventIssueFilter.value = options.some((entry) => entry.value === previousValue) ? previousValue : "all";
  }
  renderOverview(payload.metrics || {}, issues);
  if (viewMode === "board") {
    renderKanban(issues);
  } else {
    renderIssues(issues);
  }
  renderRuntimeMeta(payload);

  const sourceRepo = (payload.sourceRepoUrl || "local").toString().split("/").slice(-1)[0] || "local";
  subtitle.textContent = `Runtime local: ${sourceRepo}`;
  refreshBadge.textContent = `refresh: ${new Date(payload.updatedAt || Date.now()).toLocaleTimeString()}`;
}

async function loadHealth() {
  try {
    let payload = null;
    try {
      payload = await fetchJSON("/status");
    } catch {
      payload = await fetchJSON("/health");
    }

    const status = payload.status || "ok";
    healthBadge.textContent = `status: ${status}`;
    healthBadge.className = `badge badge-health-${status === "ok" ? "ok" : "warn"}`;

    // Notify on status transitions
    if (lastHealthStatus && lastHealthStatus !== status) {
      showToast(`Health: ${lastHealthStatus} → ${status}`, status === "ok" ? "success" : "warn", 3000);
    }
    lastHealthStatus = status;
  } catch (error) {
    healthBadge.textContent = "status: offline";
    healthBadge.className = "badge badge-health-offline";
    if (lastHealthStatus !== "offline") {
      showToast("Connection lost", "error", 3000);
    }
    lastHealthStatus = "offline";
  }
}

async function refreshSessions() {
  // Auto-refresh expanded session panels for running issues
  for (const issueId of expandedSessions) {
    const issue = (appState.issues || []).find((i) => i.id === issueId);
    if (issue && (issue.state === "In Progress" || issue.state === "In Review")) {
      loadSessionsForIssue(issueId);
    }
  }
  // Auto-refresh detail panel for running issues
  if (selectedDetailId && isDesktop()) {
    const issue = (appState.issues || []).find((i) => i.id === selectedDetailId);
    if (issue && (issue.state === "In Progress" || issue.state === "In Review")) {
      loadSessionsForPanel(selectedDetailId, "detail-session-panel");
    }
  }
}

async function refresh() {
  refreshBadge.classList.add("badge-refreshing");
  try {
    await loadState();
    await loadEvents();
    await refreshSessions();
  } catch (error) {
    issueListEl.innerHTML = `<p class="muted">Error loading runtime state: ${escapeHtml(error.message || error)}</p>`;
  } finally {
    refreshBadge.classList.remove("badge-refreshing");
  }
}

// ── Filters ──────────────────────────────────────────────────────────────────

function renderCurrentView() {
  const issues = appState.issues || [];
  if (viewMode === "board") {
    renderKanban(issues);
  } else {
    renderIssues(issues);
  }
}

stateFilter.addEventListener("change", () => {
  // Clear KPI active state when manually changing filters
  activeKpiFilter = null;
  renderOverview(appState.metrics || {}, appState.issues || []);
  renderCurrentView();
});
categoryFilter?.addEventListener("change", () => {
  activeKpiFilter = null;
  renderOverview(appState.metrics || {}, appState.issues || []);
  renderCurrentView();
});
queryInput.addEventListener("input", () => renderCurrentView());
eventKindFilter?.addEventListener("change", async () => {
  allEvents = [];
  lastEventTimestamp = "";
  await loadEvents();
});
eventIssueFilter?.addEventListener("change", async () => {
  allEvents = [];
  lastEventTimestamp = "";
  await loadEvents();
});

// ── Keyboard shortcuts ───────────────────────────────────────────────────

document.addEventListener("keydown", (event) => {
  // Skip keyboard nav if typing in an input/textarea
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    if (event.key === "Escape") {
      document.activeElement.blur();
    }
    return;
  }

  // j/k or ArrowDown/ArrowUp to navigate issues
  if (event.key === "j" || event.key === "ArrowDown" || event.key === "k" || event.key === "ArrowUp") {
    const cards = [...issueListEl.querySelectorAll(".issue-card")];
    if (!cards.length) return;
    const currentIdx = cards.findIndex((c) => c.dataset.issueId === selectedDetailId);
    let nextIdx;
    if (event.key === "j" || event.key === "ArrowDown") {
      nextIdx = currentIdx < cards.length - 1 ? currentIdx + 1 : 0;
    } else {
      nextIdx = currentIdx > 0 ? currentIdx - 1 : cards.length - 1;
    }
    const nextId = cards[nextIdx]?.dataset.issueId;
    if (nextId) {
      selectedDetailId = nextId;
      const issue = (appState.issues || []).find((i) => i.id === nextId);
      if (issue && isDesktop()) renderDetailPanel(issue);
      renderIssues(appState.issues || []);
      cards[nextIdx]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    event.preventDefault();
    return;
  }

  // Enter to toggle sessions for current selection
  if (event.key === "Enter" && selectedDetailId) {
    if (!isDesktop()) {
      if (expandedSessions.has(selectedDetailId)) expandedSessions.delete(selectedDetailId);
      else expandedSessions.add(selectedDetailId);
      renderIssues(appState.issues || []);
    }
    return;
  }

  // r to retry selected
  if (event.key === "r" && selectedDetailId) {
    retryIssue(selectedDetailId);
    return;
  }

  // n to focus new issue form
  if (event.key === "n") {
    toggleCreateForm();
    return;
  }

  if (event.key !== "Escape") return;

  // Close create form
  if (!createForm.hidden) {
    createForm.hidden = true;
    return;
  }

  // Close edit form
  if (activeEditId !== null) {
    activeEditId = null;
    renderIssues(appState.issues || []);
    return;
  }

  // Close delete confirm
  if (pendingDeleteId !== null) {
    pendingDeleteId = null;
    renderIssues(appState.issues || []);
    return;
  }

  // Close split form
  if (activeSplitId !== null) {
    activeSplitId = null;
    renderIssues(appState.issues || []);
    return;
  }

  // Close detail panel
  if (selectedDetailId !== null) {
    clearDetailPanel();
    renderIssues(appState.issues || []);
    return;
  }

  // Collapse all sessions
  if (expandedSessions.size > 0) {
    expandedSessions.clear();
    renderIssues(appState.issues || []);
  }
});

// ── WebSocket (realtime) with polling fallback ───────────────────────────────

let ws = null;
let wsConnected = false;
let wsReconnectTimer = null;
let wsReconnectCount = 0;
let pollingTimer = null;

function detectStateTransitions(oldIssues, newIssues) {
  if (!oldIssues?.length || !newIssues?.length) return;
  const oldMap = new Map(oldIssues.map((i) => [i.id, i.state]));
  for (const issue of newIssues) {
    const prev = oldMap.get(issue.id);
    if (!prev || prev === issue.state) continue;
    // Notify on important transitions
    if (issue.state === "Blocked") {
      showToast(`${issue.identifier} blocked${issue.lastError ? ": " + issue.lastError.slice(0, 80) : ""}`, "warn", 6000);
    } else if (issue.state === "Done") {
      const dur = issue.durationMs ? ` (${formatDuration(issue.durationMs)})` : "";
      showToast(`${issue.identifier} completed${dur}`, "success", 5000);
    } else if (issue.state === "Cancelled") {
      showToast(`${issue.identifier} cancelled`, "warn", 3000);
    } else if (issue.state === "In Progress" && prev === "Todo") {
      showToast(`${issue.identifier} started`, "success", 2000);
    }
  }
}

function applyWsStateUpdate(msg) {
  if (!msg) return;

  const prevIssues = appState.issues;

  // Update app state from WS push
  if (msg.issues) appState.issues = msg.issues;
  if (msg.metrics) appState.metrics = msg.metrics;
  if (msg.capabilities) appState.capabilities = msg.capabilities;
  if (msg.updatedAt) appState.updatedAt = msg.updatedAt;

  // Detect transitions and notify
  if (msg.issues) detectStateTransitions(prevIssues, msg.issues);

  // Render
  const issues = appState.issues || [];
  renderOverview(appState.metrics || {}, issues);
  if (viewMode === "board") {
    renderKanban(issues);
  } else {
    renderIssues(issues);
  }

  // Events from push
  if (msg.events && Array.isArray(msg.events)) {
    renderEvents(msg.events);
  }

  // Update tab badges after state/events update
  updateTabBadges();

  // Update event issue filter
  if (eventIssueFilter && issues.length) {
    const previousValue = eventIssueFilter.value || "all";
    const options = [
      { value: "all", label: "All" },
      ...issues
        .map((issue) => ({ value: issue.id, label: issue.identifier || issue.id }))
        .filter((entry) => entry.value)
        .sort((a, b) => String(a.label).localeCompare(String(b.label))),
    ];
    eventIssueFilter.innerHTML = options
      .map((entry) => `<option value="${escapeHtml(entry.value)}">${escapeHtml(entry.label)}</option>`)
      .join("");
    eventIssueFilter.value = options.some((entry) => entry.value === previousValue) ? previousValue : "all";
  }

  // Auto-refresh detail panel if open (only in list mode where detail panel is visible)
  if (selectedDetailId && isDesktop() && viewMode === "list" && msg.issues) {
    const issue = msg.issues.find((i) => i.id === selectedDetailId);
    if (issue && (issue.state === "In Progress" || issue.state === "In Review")) {
      loadSessionsForPanel(selectedDetailId, "detail-session-panel");
    }
  }

  refreshBadge.textContent = `realtime: ${new Date().toLocaleTimeString()}`;
}

function connectWebSocket() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws`;

  try {
    ws = new WebSocket(url);
  } catch {
    startPollingFallback();
    return;
  }

  ws.onopen = () => {
    wsConnected = true;
    wsReconnectCount = 0;
    stopPollingFallback();
    healthBadge.textContent = "realtime";
    healthBadge.className = "badge badge-health-ok";
    if (lastHealthStatus === "offline" || lastHealthStatus === "polling") {
      showToast("Connected — realtime updates active", "success", 2000);
    }
    lastHealthStatus = "ok";
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === "connected") {
        // Initial state push on connect
        applyWsStateUpdate(msg);
        // Still load full state once for runtime meta etc.
        loadState().then(() => renderRuntimeMeta(appState));
      }

      if (msg.type === "state:update") {
        applyWsStateUpdate(msg);
      }

      if (msg.type === "pong") {
        // heartbeat acknowledged
      }

      if (msg.type === "agent:output" && msg.issueId) {
        // Live agent output streaming
        const panel = document.getElementById(`session-${msg.issueId}`) || document.getElementById("detail-session-panel");
        if (panel) {
          const outputEl = panel.querySelector(".session-output:last-child") || panel;
          const line = document.createElement("div");
          line.className = "session-output";
          line.textContent = msg.output || "";
          outputEl.after(line);
          line.scrollIntoView({ block: "nearest" });
        }
      }
    } catch {}
  };

  ws.onclose = () => {
    wsConnected = false;
    ws = null;
    wsReconnectCount++;

    if (wsReconnectCount >= 3) {
      // Give up on WS, fall back to polling permanently (until user clicks Reload)
      startPollingFallback();
      lastHealthStatus = "polling";
    } else {
      healthBadge.textContent = "reconnecting";
      healthBadge.className = "badge badge-reconnecting";
      lastHealthStatus = "offline";

      // Reconnect with backoff
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(() => {
        connectWebSocket();
      }, 3000);

      // Start polling as fallback while disconnected
      startPollingFallback();
    }
  };

  ws.onerror = () => {
    // onclose will fire after onerror
  };
}

function startPollingFallback() {
  if (pollingTimer) return;
  lastHealthStatus = "polling";
  healthBadge.textContent = "polling";
  healthBadge.className = "badge badge-health-warn";
  pollingTimer = setInterval(() => {
    refresh();
  }, 3000);
}

function stopPollingFallback() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

wireActions();

// Apply initial tab from localStorage
switchTab(viewMode);

// Ensure create form stays hidden on boot (switchTab reveals the board panel but form must remain hidden)
if (createForm) createForm.hidden = true;

loadHealth();
refresh();
connectWebSocket();
