const subtitle = document.getElementById("subtitle");
const healthBadge = document.getElementById("health");
const refreshBadge = document.getElementById("lastRefresh");
const overviewEl = document.getElementById("overview");
const issueListEl = document.getElementById("issue-list");
const runtimeMeta = document.getElementById("runtime-meta");
const stateFilter = document.getElementById("state-filter");
const queryInput = document.getElementById("query");
const eventsEl = document.getElementById("events");
const rerunBtn = document.getElementById("rerun");
const clearEventsBtn = document.getElementById("clear-events");

let appState = {};
let lastEventTimestamp = "";

const stateOrder = ["Todo", "In Progress", "In Review", "Blocked", "Done", "Cancelled"];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }
  return parsed.toLocaleString();
}

function badgeText(metricName, value) {
  return `
    <div class="kpi">
      <p class="muted">${metricName}</p>
      <p class="value">${value}</p>
    </div>
  `;
}

function renderOverview(metrics) {
  if (!metrics) {
    return;
  }

  overviewEl.innerHTML = [
    badgeText("Total", metrics.total || 0),
    badgeText("Queued", metrics.queued || 0),
    badgeText("Running", metrics.inProgress || 0),
    badgeText("Blocked", metrics.blocked || 0),
    badgeText("Done", metrics.done || 0),
    badgeText("Cancelled", metrics.cancelled || 0),
  ].join("");
}

function actionButton(issueId, label, action, payload = "") {
  return `<button type="button" class="action-button" data-id="${escapeHtml(issueId)}" data-action="${action}" data-payload="${escapeHtml(payload)}">${label}</button>`;
}

function issueActions(issue) {
  if (issue.state === "Blocked") {
    return `${actionButton(issue.id, "Retry", "retry")} ${actionButton(issue.id, "Set Todo", "state", "Todo")} ${actionButton(issue.id, "Cancel", "cancel")}`;
  }

  if (issue.state === "Done" || issue.state === "Cancelled") {
    return `${actionButton(issue.id, "Retry", "retry")}`;
  }

  if (issue.state === "Todo") {
    return `${actionButton(issue.id, "Mark In Progress", "state", "In Progress")} ${actionButton(issue.id, "Cancel", "state", "Cancelled")}`;
  }

  return `${actionButton(issue.id, "Cancel", "cancel")}`;
}

function stateClass(value) {
  const safe = String(value).replace(/\s+/g, "_");
  return `state-badge state-${safe}`;
}

function renderIssues(issues = []) {
  const selectedState = stateFilter.value;
  const search = queryInput.value.trim().toLowerCase();

  const filtered = issues.filter((issue) => {
    const matchesState = selectedState === "all" || issue.state === selectedState;
    const target = `${issue.identifier} ${issue.title} ${issue.description || ""} ${issue.id}`.toLowerCase();
    const matchesSearch = !search || target.includes(search);
    return matchesState && matchesSearch;
  });

  if (!filtered.length) {
    issueListEl.innerHTML = '<p class="muted">No issues match this filter.</p>';
    return;
  }

  issueListEl.innerHTML = filtered
    .sort((a, b) => {
      const sa = stateOrder.indexOf(a.state);
      const sb = stateOrder.indexOf(b.state);
      if (sa !== sb) {
        return sa - sb;
      }
      return (a.priority || 999) - (b.priority || 999);
    })
    .map((issue) => {
      const history = Array.isArray(issue.history)
        ? issue.history
            .slice(-4)
            .map((entry) => `<li class="mono">${escapeHtml(entry)}</li>`)
            .join("")
        : "";
      const labels = Array.isArray(issue.labels)
        ? issue.labels.map((label) => `<span class="tag">${escapeHtml(label)}</span>`).join("")
        : "";

      return `
        <article class="issue-card">
          <h3 class="issue-title">${escapeHtml(issue.identifier)} - ${escapeHtml(issue.title)}</h3>
          <p class="muted">${escapeHtml(issue.description || "No description")}</p>
          <div class="meta">
            <span class="${stateClass(issue.state)}">${escapeHtml(issue.state)}</span>
            <span>Priority ${escapeHtml(issue.priority)}</span>
            <span>Attempts ${escapeHtml(issue.attempts || 0)}/${escapeHtml(issue.maxAttempts || 1)}</span>
            <span>Last error: ${escapeHtml(issue.lastError ? "yes" : "no")}</span>
          </div>
          <div class="meta">${labels}</div>
          <div class="meta">
            <span>Updated: ${formatDate(issue.updatedAt)}</span>
            <span>Workspace: ${escapeHtml(issue.workspacePath || "pending")}</span>
          </div>
          <div class="actions">${issueActions(issue)}</div>
          <ul class="history">${history}</ul>
        </article>
      `;
    })
    .join("");
}

function renderRuntimeMeta(state) {
  runtimeMeta.innerHTML = `
    <div class="meta">
      <span>Repository: ${escapeHtml(state.sourceRepoUrl || "local")}</span>
      <span>Workflow: ${escapeHtml(state.workflowPath || "local")}</span>
      <span>Tracker: ${escapeHtml(state.trackerKind || "filesystem")}</span>
      <span>Agent: ${escapeHtml(state.config?.agentCommand ? "external" : "simulated")}</span>
    </div>
    <p class="muted">Started at ${formatDate(state.startedAt)}</p>
  `;
}

function renderEvents(events = []) {
  if (!events.length) {
    eventsEl.innerHTML = '<p class="muted">No events yet.</p>';
    return;
  }

  eventsEl.innerHTML = events
    .slice(0, 80)
    .map((event) => {
      const cls = `event event-${event.kind || "info"}`;
      return `
        <div class="${cls}">
          <div class="mono">${escapeHtml(event.at)} ${escapeHtml(event.issueId || "system")}</div>
          <div>${escapeHtml(event.message || "")}</div>
        </div>
      `;
    })
    .join("");
}

async function fetchJSON(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

async function post(path, payload = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}));
    throw new Error(errorPayload.error || `Request failed: ${response.status}`);
  }

  return response.json();
}

function getIssueMap(issues = []) {
  const map = new Map();
  for (const issue of issues) {
    map.set(issue.id, issue);
  }
  return map;
}

async function setIssueState(issueId, nextState) {
  await post(`/api/issue/${encodeURIComponent(issueId)}/state`, { state: nextState });
  await loadState();
}

async function retryIssue(issueId) {
  await post(`/api/issue/${encodeURIComponent(issueId)}/retry`);
  await loadState();
}

async function cancelIssue(issueId) {
  await post(`/api/issue/${encodeURIComponent(issueId)}/cancel`);
  await loadState();
}

function wireActions() {
  issueListEl.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }

    const action = target.dataset.action;
    const id = target.dataset.id;
    const payload = target.dataset.payload || "";

    if (!action || !id) {
      return;
    }

    try {
      if (action === "state") {
        await setIssueState(id, payload);
      }

      if (action === "retry") {
        await retryIssue(id);
      }

      if (action === "cancel") {
        await cancelIssue(id);
      }
    } catch (error) {
      alert(error.message || "Action failed.");
    }
  });

  rerunBtn?.addEventListener("click", () => {
    loadState();
  });

  clearEventsBtn?.addEventListener("click", () => {
    eventsEl.innerHTML = '<p class="muted">Event history cleared from view.</p>';
  });
}

async function loadEvents() {
  try {
    const query = lastEventTimestamp ? `?since=${encodeURIComponent(lastEventTimestamp)}` : "";
    const payload = await fetchJSON(`/api/events${query}`);
    const events = Array.isArray(payload.events) ? payload.events : [];

    if (events.length > 0) {
      renderEvents(events.concat(Array.isArray(appState.events) ? appState.events || [] : []));
      const latest = events[0];
      if (latest && latest.at) {
        lastEventTimestamp = latest.at;
      }
    }
  } catch (error) {
    // ignore intermittent event polling errors
  }
}

async function loadState() {
  const payload = await fetchJSON("/api/state");
  appState = payload;

  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  renderOverview(payload.metrics || {});
  renderIssues(issues);
  renderRuntimeMeta(payload);

  const sourceRepo = (payload.sourceRepoUrl || "local").toString().split("/").slice(-1)[0] || "local";
  subtitle.textContent = `Runtime local: ${sourceRepo}`;
  refreshBadge.textContent = `refresh: ${new Date(payload.updatedAt || Date.now()).toLocaleTimeString()}`;
}

async function loadHealth() {
  try {
    const payload = await fetchJSON("/api/health");
    healthBadge.textContent = `status: ${payload.status || "ok"}`;
  } catch (error) {
    healthBadge.textContent = "status: offline";
  }
}

async function refresh() {
  try {
    await loadState();
    await loadEvents();
  } catch (error) {
    issueListEl.innerHTML = `<p class="muted">Error loading runtime state: ${escapeHtml(error.message || error)}</p>`;
  }
}

stateFilter.addEventListener("change", () => {
  renderIssues(Array.isArray(appState.issues) ? appState.issues : []);
});

queryInput.addEventListener("input", () => {
  renderIssues(Array.isArray(appState.issues) ? appState.issues : []);
});

loadEvents();
wireActions();
loadHealth();
refresh();
setInterval(() => {
  refresh();
  loadHealth();
}, 1500);
