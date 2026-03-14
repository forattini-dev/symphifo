// ── Theme switcher (runs immediately to avoid flash) ─────────────────────────

const THEME_STORAGE_KEY = "symphifo-theme";
const THEME_CHOICES = ["auto", "halloween", "cupcake"];
const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

function normalizeThemeChoice(raw) {
  if (!raw) return "auto";
  if (THEME_CHOICES.includes(raw)) return raw;
  return "auto";
}

function getSystemTheme() {
  return systemThemeQuery.matches ? "halloween" : "cupcake";
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

themeToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  themeDropdown.classList.toggle("open");
});

// Close dropdown when clicking outside
document.addEventListener("click", (event) => {
  if (themeDropdown && !themeDropdown.contains(event.target)) {
    themeDropdown.classList.remove("open");
  }
});

// Wire radio buttons
document.getElementById("theme-menu")?.addEventListener("change", (event) => {
  if (event.target.name === "theme") {
    applyTheme(event.target.value);
    themeDropdown.classList.remove("open");
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

let appState = {};
let lastEventTimestamp = "";
let lastStateHash = "";
let expandedSessions = new Set();
let activeSplitId = null;
let selectedDetailId = null;
let selectedIssues = new Set();
let lastHealthStatus = null;
let activeKpiFilter = null;

// ── Toast notifications ─────────────────────────────────────────────────────

function getOrCreateToastContainer() {
  let container = document.querySelector(".toast");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast";
    document.body.appendChild(container);
  }
  return container;
}

function showToast(message, kind = "error", durationMs = 4000) {
  const container = getOrCreateToastContainer();
  const item = document.createElement("div");
  const cls = kind === "success" ? "toast-success" : kind === "warn" ? "toast-warn" : "";
  item.className = `toast-item ${cls}`.trim();
  item.textContent = message;
  container.appendChild(item);

  setTimeout(() => {
    item.classList.add("toast-out");
    item.addEventListener("animationend", () => item.remove());
  }, durationMs);
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

// ── Loading state wrapper ───────────────────────────────────────────────────

async function withLoading(target, asyncFn) {
  if (!(target instanceof HTMLButtonElement)) {
    return asyncFn();
  }
  const originalText = target.textContent;
  target.disabled = true;
  target.textContent = "\u00B7\u00B7\u00B7";
  try {
    return await asyncFn();
  } finally {
    target.disabled = false;
    target.textContent = originalText;
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
    throw new Error(errorPayload.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

// ── KPI Overview ─────────────────────────────────────────────────────────────

function kpiCard(label, value, { accent = "", desc = "", filterKey = "", filterValue = "" } = {}) {
  const cls = accent ? ` ${accent}` : "";
  const clickable = filterKey ? " kpi-clickable" : "";
  const active = activeKpiFilter && activeKpiFilter.key === filterKey && activeKpiFilter.value === filterValue ? " kpi-active" : "";
  const dataAttrs = filterKey ? ` data-kpi-filter="${escapeHtml(filterKey)}" data-kpi-value="${escapeHtml(filterValue)}"` : "";
  return `
    <div class="kpi${clickable}${active}"${dataAttrs}>
      <p class="label">${label}</p>
      <p class="value${cls}">${value}</p>
      ${desc ? `<p class="desc">${escapeHtml(desc)}</p>` : ""}
    </div>
  `;
}

function capabilityRank(value) {
  const normalized = String(value || "default");
  const index = capabilityOrder.indexOf(normalized);
  return index === -1 ? 999 : index;
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
      <div class="kpi" style="grid-column: 1 / -1; padding: 24px;">
        <p class="label">No Issues</p>
        <p class="value" style="font-size: 1.2rem;">Create your first issue to get started</p>
        <p class="desc">Use the "+ New" button above or POST to /issues</p>
      </div>
    `;
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
  const kpi = event.target.closest(".kpi-clickable");
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
  renderIssues(appState.issues || []);
});

// ── Issue Actions ────────────────────────────────────────────────────────────

function actionButton(issueId, label, action, payload = "") {
  return `<button type="button" class="action-button" data-id="${escapeHtml(issueId)}" data-action="${action}" data-payload="${escapeHtml(payload)}">${label}</button>`;
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

  const moreBtn = `<button type="button" class="btn-more" data-action="more" data-id="${escapeHtml(issue.id)}" title="More actions">&middot;&middot;&middot;</button>`;

  return `${primaryHtml} ${moreBtn} <span class="actions-secondary" data-secondary-for="${escapeHtml(issue.id)}">${secondaryHtml}</span>`;
}

function stateClass(value) {
  return `state-badge state-${String(value).replace(/\s+/g, "_")}`;
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
        + `<button type="button" class="action-button" id="batch-retry">Retry All</button> `
        + `<button type="button" class="action-button" id="batch-cancel">Cancel All</button> `
        + `<button type="button" class="action-button" id="batch-clear">Clear</button>`;
    } else {
      countEl.textContent = filtered.length === issues.length
        ? `${issues.length} issues`
        : `${filtered.length} / ${issues.length} issues`;
    }
  }

  if (!filtered.length) {
    issueListEl.innerHTML = '<p class="muted">No issues match this filter.</p>';
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
        ? issue.labels.map((l) => `<span class="tag">${escapeHtml(l)}</span>`).join("")
        : "";
      const paths = Array.isArray(issue.paths) && issue.paths.length
        ? issue.paths.map((p) => `<span class="tag mono">${escapeHtml(p)}</span>`).join("")
        : "";
      const overlays = Array.isArray(issue.capabilityOverlays) && issue.capabilityOverlays.length
        ? issue.capabilityOverlays.map((o) => `<span class="tag">${escapeHtml(`overlay:${o}`)}</span>`).join("")
        : "";
      const category = issue.capabilityCategory
        ? `<span class="tag">${escapeHtml(`capability:${issue.capabilityCategory}`)}</span>`
        : "";

      const blockedByHtml = Array.isArray(issue.blockedBy) && issue.blockedBy.length
        ? issue.blockedBy.map((dep) => `<span class="blocked-by">${escapeHtml(dep)}</span>`).join("")
        : "";

      const errorHtml = issue.lastError
        ? `<details class="error-detail">
            <summary>Last error</summary>
            <pre class="mono">${escapeHtml(issue.lastError)}</pre>
          </details>`
        : "";

      // On mobile, show inline session panel; on desktop, sessions go to detail panel
      const sessionHtml = expandedSessions.has(issue.id)
        ? `<div class="session-panel" id="session-${escapeHtml(issue.id)}"><div class="session-loading">Loading sessions...</div></div>`
        : "";

      const noteHtml = (issue.state === "Blocked" || issue.state === "Todo")
        ? `<div class="note-form">
            <input type="text" placeholder="Add note for next retry..." data-note-for="${escapeHtml(issue.id)}" />
            <button type="button" class="action-button" data-id="${escapeHtml(issue.id)}" data-action="note">Send</button>
          </div>`
        : "";

      const splitHtml = activeSplitId === issue.id
        ? `<div class="split-form">
            <label class="split-label">Sub-task titles (one per line)</label>
            <textarea data-split-for="${escapeHtml(issue.id)}" rows="3" placeholder="Fix the header layout\nUpdate the unit tests\nAdd error handling"></textarea>
            <div class="split-form-actions">
              <button type="button" class="action-button" data-id="${escapeHtml(issue.id)}" data-action="split-cancel">Cancel</button>
              <button type="button" class="action-button btn-accent" data-id="${escapeHtml(issue.id)}" data-action="split-submit">Create Sub-tasks</button>
            </div>
          </div>`
        : "";

      const editHtml = activeEditId === issue.id ? renderEditForm(issue) : "";

      const deleteHtml = pendingDeleteId === issue.id
        ? `<div class="delete-confirm">
            <span>Delete ${escapeHtml(issue.identifier)}? This cannot be undone.</span>
            <button type="button" class="action-button btn-danger" data-id="${escapeHtml(issue.id)}" data-action="delete-confirm">Confirm Delete</button>
            <button type="button" class="action-button" data-id="${escapeHtml(issue.id)}" data-action="delete-cancel">Cancel</button>
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

// ── Detail panel (desktop right panel) ──────────────────────────────────────

function renderDetailPanel(issue) {
  if (!detailPanel) return;
  detailPanel.innerHTML = `
    <div class="detail-issue-header">
      <span class="mono">${escapeHtml(issue.identifier)}</span> ${escapeHtml(issue.title)}
      <button type="button" class="btn-close-detail" id="close-detail" title="Close">&times;</button>
    </div>
    <div class="meta" style="margin-top:0">
      <span class="${stateClass(issue.state)}">${escapeHtml(issue.state)}</span>
      <span>Priority ${escapeHtml(issue.priority)}</span>
      ${issue.durationMs ? `<span>Duration ${formatDuration(issue.durationMs)}</span>` : ""}
    </div>
    <div class="session-panel" id="detail-session-panel">
      <div class="session-loading">Loading sessions...</div>
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
        <input type="number" id="concurrency-input" class="concurrency-input" min="1" max="16" value="${escapeHtml(state.config?.workerConcurrency ?? 2)}" />
        <button type="button" class="action-button concurrency-btn" id="save-concurrency-btn">Set</button>
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
      `<span class="tag ${p.available ? "tag-ok" : "tag-missing"}">${escapeHtml(p.name)}: ${p.available ? "available" : "not found"}</span>`
    ).join(" ");
  } catch { panel.innerHTML = ""; }
}

async function loadParallelism() {
  const panel = document.getElementById("parallelism-panel");
  if (!panel) return;
  try {
    const data = await fetchJSON("/parallelism");
    if (!data.reason) { panel.innerHTML = ""; return; }
    const badge = data.canParallelize ? "tag-ok" : "tag-missing";
    panel.innerHTML = `Parallelism: <span class="tag ${badge}">max safe=${data.maxSafeParallelism}</span> <span class="muted">${escapeHtml(data.reason)}</span>`;
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
    eventsEl.innerHTML = '<p class="muted">No events yet.</p>';
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

  const hadEvents = eventsEl.children.length > 0;
  eventsEl.innerHTML = filtered
    .slice(0, 80)
    .map((event) => `
      <div class="event event-${event.kind || "info"}">
        <div class="mono" title="${escapeHtml(formatDate(event.at))}">${timeAgo(event.at)} ${escapeHtml(event.issueId || "system")}</div>
        <div>${escapeHtml(event.message || "")}</div>
      </div>
    `)
    .join("");

  // Auto-scroll to top when new events arrive
  if (events.length && hadEvents) eventsEl.scrollTop = 0;
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
  if (!createForm.hidden) document.getElementById("cf-title").focus();
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
      createForm.hidden = true;
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
          <input data-edit-title-for="${escapeHtml(issue.id)}" type="text" value="${escapeHtml(issue.title)}" />
        </div>
        <div class="form-group span-2">
          <label>Description</label>
          <textarea data-edit-desc-for="${escapeHtml(issue.id)}" rows="2">${escapeHtml(issue.description || "")}</textarea>
        </div>
        <div class="form-group">
          <label>Priority (1-10)</label>
          <input data-edit-priority-for="${escapeHtml(issue.id)}" type="number" min="1" max="10" value="${escapeHtml(issue.priority)}" />
        </div>
        <div class="form-group">
          <label>Labels <span class="hint">comma-separated</span></label>
          <input data-edit-labels-for="${escapeHtml(issue.id)}" type="text" value="${escapeHtml((issue.labels || []).join(", "))}" />
        </div>
        <div class="form-group span-2">
          <label>Paths <span class="hint">comma-separated</span></label>
          <input data-edit-paths-for="${escapeHtml(issue.id)}" type="text" value="${escapeHtml((issue.paths || []).join(", "))}" />
        </div>
        <div class="form-group span-2">
          <label>Blocked by <span class="hint">comma-separated issue IDs</span></label>
          <input data-edit-blocked-for="${escapeHtml(issue.id)}" type="text" value="${escapeHtml((issue.blockedBy || []).join(", "))}" />
        </div>
      </div>
      <div class="create-form-actions">
        <button type="button" class="action-button" data-id="${escapeHtml(issue.id)}" data-action="edit-cancel">Cancel</button>
        <button type="button" class="action-button btn-accent" data-id="${escapeHtml(issue.id)}" data-action="edit-submit">Save</button>
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
        + `<button type="button" class="action-button" id="batch-retry">Retry All</button> `
        + `<button type="button" class="action-button" id="batch-cancel">Cancel All</button> `
        + `<button type="button" class="action-button" id="batch-clear">Clear</button>`;
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

  rerunBtn?.addEventListener("click", () => loadState());
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
  renderIssues(issues);
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

stateFilter.addEventListener("change", () => {
  // Clear KPI active state when manually changing filters
  activeKpiFilter = null;
  renderOverview(appState.metrics || {}, appState.issues || []);
  renderIssues(appState.issues || []);
});
categoryFilter?.addEventListener("change", () => {
  activeKpiFilter = null;
  renderOverview(appState.metrics || {}, appState.issues || []);
  renderIssues(appState.issues || []);
});
queryInput.addEventListener("input", () => renderIssues(appState.issues || []));
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
  renderIssues(issues);

  // Events from push
  if (msg.events && Array.isArray(msg.events)) {
    renderEvents(msg.events);
  }

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

  // Auto-refresh detail panel if open
  if (selectedDetailId && isDesktop() && msg.issues) {
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
    healthBadge.textContent = "reconnecting";
    healthBadge.className = "badge badge-health-warn";
    lastHealthStatus = "offline";

    // Reconnect with backoff
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, 3000);

    // Start polling as fallback while disconnected
    startPollingFallback();
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
loadHealth();
refresh();
connectWebSocket();
