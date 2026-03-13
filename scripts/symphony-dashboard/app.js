const stateEl = document.getElementById("subtitle");
const healthBadge = document.getElementById("health");
const refreshBadge = document.getElementById("lastRefresh");
const overviewEl = document.getElementById("overview");
const issueListEl = document.getElementById("issue-list");
const runtimeMeta = document.getElementById("runtime-meta");
const stateFilter = document.getElementById("state-filter");
const queryInput = document.getElementById("query");

const stateLabels = ["Todo", "In Progress", "In Review", "Blocked", "Done", "Cancelled"];
let currentState = {};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function labelValue(item, fallback = "-") {
  return item && item.length ? escapeHtml(item) : fallback;
}

function renderOverview(issues) {
  const total = issues.length;
  const byState = {};
  stateLabels.forEach((key) => {
    byState[key] = 0;
  });

  issues.forEach((issue) => {
    if (!byState[issue.state]) {
      byState[issue.state] = 0;
    }

    byState[issue.state] += 1;
  });

  const done = byState.Done || 0;
  const inProgress = (byState["In Progress"] || 0) + (byState["In Review"] || 0);
  const blocked = byState.Blocked || 0;

  overviewEl.innerHTML = `
    <div class="kpi">
      <p class="muted">Total</p>
      <p class="value">${total}</p>
    </div>
    <div class="kpi">
      <p class="muted">Done</p>
      <p class="value">${done}</p>
    </div>
    <div class="kpi">
      <p class="muted">In Progress</p>
      <p class="value">${inProgress}</p>
    </div>
    <div class="kpi">
      <p class="muted">Blocked</p>
      <p class="value">${blocked}</p>
    </div>
  `;
}

function renderFilters() {
  return;
}

function cardControls(identifier) {
  return stateLabels
    .map((targetState) => {
      return `<button type="button" onclick="setIssueState('${identifier}', '${targetState}')">${targetState}</button>`;
    })
    .join("");
}

function renderIssues(issues) {
  const filter = stateFilter.value;
  const query = queryInput.value.trim().toLowerCase();

  const filtered = issues.filter((issue) => {
    if (filter !== "all" && issue.state !== filter) {
      return false;
    }

    if (!query) {
      return true;
    }

    return (
      String(issue.identifier).toLowerCase().includes(query) ||
      String(issue.title).toLowerCase().includes(query) ||
      String(issue.description || "").toLowerCase().includes(query)
    );
  });

  if (!filtered.length) {
    issueListEl.innerHTML = '<p class="muted">No issues match this filter.</p>';
    return;
  }

  issueListEl.innerHTML = filtered
    .map((issue) => {
      const stateClass = `state-badge state-${escapeHtml(issue.state)}`;
      const labels = Array.isArray(issue.labels)
        ? issue.labels
            .map((label) => `<span class="tag">${escapeHtml(label)}</span>`)
            .join("")
        : "";

      const history = Array.isArray(issue.history)
        ? issue.history
            .slice(-4)
            .map((item) => `<li class="mono">${escapeHtml(item)}</li>`)
            .join("")
        : "";

      return `
        <article class="issue-card">
          <h3 class="issue-title">${escapeHtml(issue.identifier)} - ${escapeHtml(issue.title)}</h3>
          <p class="muted">${escapeHtml(issue.description || "No description")}</p>
          <div class="meta">
            <span class="state-badge ${stateClass}">${escapeHtml(issue.state)}</span>
            <span>Priority: ${issue.priority}</span>
            <span class="mono">${issue.id}</span>
          </div>
          <div class="meta">${labels}</div>
          <div class="actions">${cardControls(issue.id)}</div>
          <ul class="history">${history}</ul>
        </article>
      `;
    })
    .join("");
}

function renderRuntimeMeta(state) {
  runtimeMeta.innerHTML = `
    <div class="meta">
      <span>Repository: ${escapeHtml(state.sourceRepoUrl)}</span>
      <span>Workflow: ${escapeHtml(state.workflowPath)}</span>
      <span>Tracker: ${escapeHtml(state.trackerKind)}</span>
    </div>
    <p class="muted">Last updated: ${escapeHtml(state.startedAt)}</p>
  `;
}

async function setIssueState(issueId, nextState) {
  try {
    const response = await fetch(`/api/issue/${encodeURIComponent(issueId)}/state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state: nextState }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Failed to update issue state");
    }

    await loadState();
  } catch (error) {
    alert(error.message || "Failed to change issue state.");
  }
}

async function loadState() {
  const response = await fetch("/api/state");
  if (!response.ok) {
    throw new Error("Failed to load runtime state.");
  }

  const payload = await response.json();
  currentState = payload;

  const sourceRepo = (payload.sourceRepoUrl || "").split("/").slice(-1)[0] || "local";
  stateEl.textContent = `Runtime local: ${sourceRepo}`;
  renderOverview(payload.issues || []);
  renderIssues(payload.issues || []);
  renderRuntimeMeta(payload);

  const timestamp = new Date(payload.startedAt || Date.now()).toLocaleTimeString();
  refreshBadge.textContent = `refresh: ${timestamp}`;
}

async function loadHealth() {
  const response = await fetch("/api/health");
  if (!response.ok) {
    healthBadge.textContent = "status: offline";
    return;
  }

  const payload = await response.json();
  healthBadge.textContent = `status: ${payload.status}`;
}

stateFilter.addEventListener("change", () => {
  renderIssues(currentState.issues || []);
});

queryInput.addEventListener("input", () => {
  renderIssues(currentState.issues || []);
});

function tick() {
  loadHealth();
}

async function refresh() {
  try {
    await loadState();
  } catch (error) {
    issueListEl.innerHTML = `<p class="muted">Failed to load state: ${escapeHtml(error.message || error)}</p>`;
  }
}

tick();
loadState();
setInterval(() => {
  refresh();
  tick();
}, 1200);
