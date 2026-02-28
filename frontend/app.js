const SETTINGS_KEY="tt.settings.v4";
const COLLAPSE_KEY="tt.collapse.v1";
const SUMMARY_KEY="tt.summary.html.v1";
const TOKEN_KEY="tt.auth.token.v1";
const USER_KEY="tt.auth.user.v1";

// Build marker (helps verify Railway deployed the latest bundle)
console.log("ClockTime build v10");

const settings = (() => {
  try {
    return { sort: "due", theme: "dark", ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")) };
  } catch {
    return { sort: "due", theme: "dark" };
  }
})();
const save = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

const $ = (id) => document.getElementById(id);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
const isDesktop = () => window.matchMedia && window.matchMedia("(min-width: 900px)").matches;
const isSplit = () => isDesktop() && window.matchMedia && window.matchMedia("(min-width: 1120px)").matches;

function applyTheme() {
  const sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = settings.theme === "auto" ? (sysDark ? "dark" : "light") : (settings.theme || "dark");

  // Default CSS is dark; light uses data-theme="light"
  if (resolved === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");

  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#141414" : "#eef1f6");
}

function toggleTheme() {
  settings.theme = (settings.theme === "light") ? "dark" : "light";
  save();
  applyTheme();
  updateThemeIcon();
}

applyTheme();
window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
  if (settings.theme === "auto") applyTheme();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// Auth
let auth = (() => {
  const token = localStorage.getItem(TOKEN_KEY) || "";
  let user = null;
  try { user = JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { user = null; }
  return { token, user };
})();

function setAuth(token, user) {
  auth = { token, user };
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_KEY);
  updateAccountUI();
}

function logout() {
  setAuth("", null);
  _started = false;
  showWelcome(true);
}

function showWelcome(home = true) {
  const w = $("welcome");
  const app = $("appShell");
  if (w) w.hidden = false;
  if (app) app.hidden = true;

  // switch between home (main menu) and forms
  const homeEl = $("welcomeHome");
  const card = $("authCard");
  if (homeEl) homeEl.hidden = !home;
  if (card) card.hidden = home;
}

function hideWelcome() {
  const w = $("welcome");
  const app = $("appShell");
  if (w) w.hidden = true;
  if (app) app.hidden = false;
}

function openAuth(mode) {
  showWelcome(false);
  switchAuthTab(mode);
  // focus first field
  setTimeout(() => {
    if (mode === "register") $("regEmail")?.focus?.();
    else $("loginEmail")?.focus?.();
  }, 0);
}

function updateAccountUI() {
  const email = auth.user?.email || "";
  const initial = email ? email.trim()[0]?.toUpperCase() : "●";
  if ($("btnAccount")) $("btnAccount").textContent = initial || "●";
  // settings modal static demo email
  document.querySelectorAll(".modal-content .muted").forEach((el) => {
    if (el.textContent === "demo@local" && email) el.textContent = email;
  });
}

function updateThemeIcon() {
  const use = $("themeIcon")?.querySelector?.("use");
  if (!use) return;
  use.setAttribute("href", settings.theme === "light" ? "#i-sun" : "#i-moon");
}
updateThemeIcon();

// API
const API_BASE = "";
async function api(path, opt) {
  const o = opt ? { ...opt } : {};
  o.headers = { ...(o.headers || {}) };
  // Attach token for every /api/* request except public auth endpoints.
  // This avoids the "Not authenticated" error on /api/auth/me and makes behavior predictable.
  const isPublicAuth = path === "/api/auth/login" || path === "/api/auth/register";
  if (path.startsWith("/api/") && auth.token && !isPublicAuth) {
    o.headers["Authorization"] = "Bearer " + auth.token;
  }
  const r = await fetch(API_BASE + path, o);

  // IMPORTANT:
  // Never read the response body twice (json() then text()).
  // If the server returns a non‑JSON error body, json() consumes the stream,
  // and calling text() afterwards throws: "body stream already read".
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const raw = await r.text();

  if (r.status === 401) {
    logout();
    throw new Error("Требуется вход");
  }

  if (!r.ok) {
    let msg = raw || "Ошибка запроса";
    if (raw && (ct.includes("application/json") || raw.trim().startsWith("{"))) {
      try {
        const j = JSON.parse(raw);
        msg = j?.detail || j?.message || msg;
      } catch {
        // keep raw
      }
    }
    throw new Error(msg);
  }

  if (r.status === 204) return null;
  if (!raw) return null;

  if (ct.includes("application/json") || raw.trim().startsWith("{") || raw.trim().startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through
    }
  }
  return raw;
}

const apiAuthRegister = (p) => api("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiAuthLogin = (p) => api("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiAuthMe = () => api("/api/auth/me");

const apiGetFolders = () => api("/api/folders");
const apiCreateFolder = (p) => api("/api/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiPatchFolder = (id, p) => api("/api/folders/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiDeleteFolder = (id) => api("/api/folders/" + encodeURIComponent(id), { method: "DELETE" });

const apiGetLists = () => api("/api/lists");
const apiCreateList = (p) => api("/api/lists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiPatchList = (id, p) => api("/api/lists/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiDeleteList = (id) => api("/api/lists/" + encodeURIComponent(id), { method: "DELETE" });

const apiGetTasks = (params) => api("/api/tasks?" + new URLSearchParams(params).toString());
const apiCreateTask = (p) => api("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiPatchTask = (id, p) => api("/api/tasks/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiDeleteTask = (id) => api("/api/tasks/" + encodeURIComponent(id), { method: "DELETE" });
const apiReorder = (p) => api("/api/tasks/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });

// Helpers
const _collapse = (() => {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}"); } catch { return {}; }
})();

const state = {
  module: "tasks", // tasks | calendar | search
  view: "tasks",   // tasks | calendar | search | summary
  activeKind: "smart",
  activeId: "all",
  folders: [],
  lists: [],
  tasks: [],
  done: [],
  collapsed: new Set(_collapse.groups || []),
  folderCollapsed: new Set(_collapse.folders || []),
  doneCollapsed: true,
  openSwipeId: null,
  selectedTaskId: null,
  editing: { listId: null, folderId: null, taskId: null },
  composer: { listId: null, dueDate: null, priority: 0 },
  system: { inboxId: null },
  calendarCursor: new Date(),
  calendarTasks: [],
  calendarRangeKey: "",
};

const saveCollapse = () => localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ groups: [...state.collapsed], folders: [...state.folderCollapsed] }));
const iso = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
};
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

const MONTHS_RU = ["январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"];
const MONTHS_RU_SHORT = ["янв.","февр.","мар.","апр.","мая","июн.","июл.","авг.","сент.","окт.","нояб.","дек."];

const fmtDueShort = (s) => {
  if (!s) return "";
  const t = iso(new Date());
  const tm = iso(addDays(new Date(), 1));
  if (s === t) return "Сегодня";
  if (s === tm) return "Завтра";
  const [y, m, d] = s.split("-");
  return `${d}.${m}`;
};

const bucket = (s) => {
  if (!s) return "Без даты";
  const t = iso(new Date());
  const tm = iso(addDays(new Date(), 1));
  if (s === t) return "Сегодня";
  if (s === tm) return "Завтра";
  return "Позже";
};

const parseQuick = (raw) => {
  const tags = [], kept = [];
  let pr = null;
  for (const p of raw.trim().split(/\s+/)) {
    if (/^#\S+/.test(p)) { tags.push(p.replace(/^#/, "")); continue; }
    const m = p.match(/^!([1-3])$/);
    if (m) { pr = parseInt(m[1], 10); continue; }
    kept.push(p);
  }
  return { title: kept.join(" ").trim(), tags, priority: pr };
};

const parseTagsInput = (s) => {
  const tags = [];
  for (const t of (s || "").split(/\s+/)) {
    const tt = t.trim();
    if (!tt) continue;
    tags.push(tt.replace(/^#/, ""));
  }
  return [...new Set(tags.filter(Boolean))];
};

function openSheet(b, s) { $(b).hidden = false; $(s).hidden = false; }
function closeSheet(b, s) { $(b).hidden = true; $(s).hidden = true; }

// Layout / modules
function applyLayout() {
  document.body.dataset.module = state.module;

  // Sidebar behavior
  if (isDesktop()) {
    $("drawerBackdrop").hidden = true;
    $("drawer").hidden = state.module !== "tasks";
  } else {
    // mobile: sidebar is overlay only in tasks module
    if (state.module !== "tasks") {
      $("drawer").hidden = true;
      $("drawerBackdrop").hidden = true;
    }
  }

  // Topbar
  $("calbar").hidden = state.view !== "calendar";
  $("btnSort").style.display = state.view === "tasks" ? "" : "none";

  // Views
  ["viewTasks", "viewSearch", "viewCalendar", "viewSummary"].forEach((id) => $(id)?.classList.remove("view-active"));
  if (state.view === "tasks") $("viewTasks")?.classList.add("view-active");
  if (state.view === "search") $("viewSearch")?.classList.add("view-active");
  if (state.view === "calendar") $("viewCalendar")?.classList.add("view-active");
  if (state.view === "summary") $("viewSummary")?.classList.add("view-active");

  // Right panel
  $("rightPanel").hidden = state.view !== "summary";

  // Mobile composer
  $("composer").style.display = state.view === "tasks" ? "flex" : "none";

  // Active rail
  document.querySelectorAll(".rail-item[data-module]").forEach((b) => {
    b.classList.toggle("active", b.dataset.module === state.module);
  });

  // Calendar title
  if (state.view === "calendar") {
    $("pageTitle").textContent = MONTHS_RU[state.calendarCursor.getMonth()];
    $("calTitle").textContent = MONTHS_RU[state.calendarCursor.getMonth()];
  }
}

function setView(view) {
  state.view = view;
  applyLayout();

  if (view === "tasks") {
    updatePageTitle();
    updateAddPlaceholder();
    loadTasks();
  }
  if (view === "search") {
    $("pageTitle").textContent = "Поиск";
    $("globalSearchInput").focus?.();
  }
  if (view === "calendar") {
    renderCalendar();
  }
  if (view === "summary") {
    $("pageTitle").textContent = "Сводка";
    initSummary();
  }
}

function setModule(module) {
  state.module = module;
  closeDrawer();

  if (module === "calendar") return setView("calendar");
  if (module === "search") return setView("search");

  // back to tasks
  if (state.activeKind === "smart" && state.activeId === "summary") return setView("summary");
  return setView("tasks");
}

// Sidebar open/close (mobile)
function openDrawer() {
  if (isDesktop()) return;
  if (state.module !== "tasks") return;
  $("drawer").hidden = false;
  $("drawerBackdrop").hidden = false;
}
function closeDrawer() {
  if (isDesktop()) return;
  $("drawer").hidden = true;
  $("drawerBackdrop").hidden = true;
}

function updatePageTitle() {
  if (state.view !== "tasks") return;

  if (state.activeKind === "smart") {
    if (state.activeId === "all") $("pageTitle").textContent = "Все";
    else if (state.activeId === "today") $("pageTitle").textContent = "Сегодня";
    else if (state.activeId === "next7") $("pageTitle").textContent = "Следующие 7";
    else if (state.activeId === "inbox") $("pageTitle").textContent = "Входящие";
    else $("pageTitle").textContent = "Все";
    return;
  }

  const list = state.lists.find((l) => l.id === state.activeId);
  $("pageTitle").textContent = list?.title || "Входящие";
}

function updateAddPlaceholder() {
  const listId = state.activeKind === "list" ? state.activeId : (state.composer.listId || state.system.inboxId);
  const list = state.lists.find((l) => l.id === listId);
  const name = list?.title || "Входящие";
  const el = $("deskAddInput");
  if (el) el.placeholder = "+ Добавить задачу";
  const lb = $("deskListBtn");
  if (lb) lb.title = name;
}

function setActive(kind, id) {
  state.activeKind = kind;
  state.activeId = id;

  document.querySelectorAll(".drawer-item").forEach((b) => {
    const ok = b.dataset.kind === kind && b.dataset.id === id;
    b.classList.toggle("active", !!ok);
  });

  if (kind === "list") state.composer.listId = id;

  // Summary is a special smart view inside tasks module
  if (kind === "smart" && id === "summary") {
    setModule("tasks");
    setView("summary");
    return;
  }

  setModule("tasks");
  setView("tasks");
}

// Sidebar lists
function renderLists() {
  const el = $("listsContainer");
  if (!el) return;
  el.innerHTML = "";

  const folderMap = new Map(state.folders.map((f) => [f.id, f]));
  const grouped = new Map();
  for (const l of state.lists) {
    // Inbox is shown in smart nav; don't duplicate in lists section
    if (l.systemKey === "inbox" || l.id === state.system.inboxId || l.id === "inbox") continue;

    const k = l.folderId || "";
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(l);
  }
  for (const [, arr] of grouped) arr.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  const renderListItem = (l) => {
    const row = document.createElement("div");
    row.className = "drawer-item";
    row.dataset.kind = "list";
    row.dataset.id = l.id;
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.innerHTML = `<span class="di-emoji">${l.emoji || "📌"}</span><span class="di-title">${l.title}</span><span class="di-count" data-count="${l.id}">—</span><button class="di-more" type="button" aria-label="Управление">⋯</button>`;

    row.addEventListener("click", () => setActive("list", l.id));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActive("list", l.id); }
    });

    row.querySelector(".di-more")?.addEventListener("click", (e) => { e.stopPropagation(); openEditList(l.id); });
    return row;
  };

  const renderFolder = (fid, listsArr) => {
    const group = document.createElement("div");
    group.className = "drawer-group";

    if (fid) {
      const f = folderMap.get(fid);
      const head = document.createElement("div");
      head.className = "folder-head";
      head.innerHTML = `<span class="di-emoji">${(f?.emoji) || "📁"}</span><span class="fh-title">${(f?.title) || "Папка"}</span><span class="fh-count" data-folder-count="${fid}">—</span><span class="fh-chevron">${state.folderCollapsed.has(fid) ? "▸" : "▾"}</span><button class="di-more" type="button" aria-label="Управление">⋯</button>`;
      head.addEventListener("click", () => {
        state.folderCollapsed.has(fid) ? state.folderCollapsed.delete(fid) : state.folderCollapsed.add(fid);
        saveCollapse();
        renderLists();
        refreshCounts();
      });
      head.querySelector(".di-more")?.addEventListener("click", (e) => { e.stopPropagation(); openEditFolder(fid); });
      group.appendChild(head);
    }

    const wrap = document.createElement("div");
    wrap.className = "folder-lists";
    if (!fid || !state.folderCollapsed.has(fid)) {
      listsArr.forEach((l) => wrap.appendChild(renderListItem(l)));
    }
    group.appendChild(wrap);
    el.appendChild(group);
  };

  for (const f of state.folders) {
    const arr = grouped.get(f.id);
    if (arr && arr.length) renderFolder(f.id, arr);
  }
  const ungrouped = grouped.get("") || [];
  if (ungrouped.length) renderFolder("", ungrouped);
}

function renderFolderSelect() {
  const sel = $("folderSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">Без папки</option>';
  for (const f of state.folders) {
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = `${f.emoji || "📁"} ${f.title}`;
    sel.appendChild(o);
  }
}

function renderEditListFolderSelect() {
  const sel = $("editListFolderSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">Без папки</option>';
  for (const f of state.folders) {
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = `${f.emoji || "📁"} ${f.title}`;
    sel.appendChild(o);
  }
}

function renderTaskListSelect() {
  const sel = $("taskListSelect");
  if (!sel) return;
  sel.innerHTML = "";
  for (const l of state.lists) {
    const o = document.createElement("option");
    o.value = l.id;
    o.textContent = `${l.emoji || "📌"} ${l.title}`;
    sel.appendChild(o);
  }
}

// Edit list/folder sheets
function openEditList(listId) {
  const l = state.lists.find((x) => x.id === listId);
  if (!l) return;
  closeDrawer();
  state.editing.listId = listId;
  $("editListHint").hidden = true;
  $("editListTitle").value = l.title || "";
  $("editListEmoji").value = (l.emoji || "📌").trim();
  $("editListFolderSelect").value = l.folderId || "";
  openSheet("editListBackdrop", "editListSheet");
  $("editListTitle").focus();
}

function openEditFolder(folderId) {
  const f = state.folders.find((x) => x.id === folderId);
  if (!f) return;
  closeDrawer();
  state.editing.folderId = folderId;
  $("editFolderHint").hidden = true;
  $("editFolderTitle").value = f.title || "";
  $("editFolderEmoji").value = (f.emoji || "📁").trim();
  openSheet("editFolderBackdrop", "editFolderSheet");
  $("editFolderTitle").focus();
}

// Swipe helper
function closeOpenSwipe(except = null) {
  if (!state.openSwipeId) return;
  if (except && state.openSwipeId === except) return;
  document.querySelector(`.task[data-id="${state.openSwipeId}"] .task-card`)?.style.setProperty("transform", "translateX(0)");
  state.openSwipeId = null;
}

document.addEventListener("click", (e) => {
  // close swipe
  if (state.openSwipeId) {
    const row = document.querySelector(`.task[data-id="${state.openSwipeId}"]`);
    if (row && !row.contains(e.target)) closeOpenSwipe();
  }

  // close account menu
  const menu = $("accountMenu");
  if (!menu.hidden) {
    const btn = $("btnAccount");
    if (btn && !btn.contains(e.target) && !menu.contains(e.target)) menu.hidden = true;
  }
});

function attachSwipe(card, t) {
  if (isDesktop()) return;

  let sx = 0, sy = 0, dx = 0, dy = 0, drag = false, pid = null;
  const OPEN = 110, TH = 60;
  const down = (e) => { pid = e.pointerId; sx = e.clientX; sy = e.clientY; dx = dy = 0; drag = true; card.style.transition = "none"; card.setPointerCapture(pid); closeOpenSwipe(t.id); };
  const move = (e) => {
    if (!drag) return;
    dx = e.clientX - sx;
    dy = e.clientY - sy;
    if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { up(e, true); return; }
    const x = Math.max(-OPEN, Math.min(OPEN, dx));
    card.style.transform = `translateX(${x}px)`;
  };
  const reset = () => { card.style.transition = "transform 160ms ease"; card.style.transform = "translateX(0)"; };
  const openL = () => { card.style.transition = "transform 160ms ease"; card.style.transform = `translateX(${OPEN}px)`; state.openSwipeId = t.id; };
  const openR = () => { card.style.transition = "transform 160ms ease"; card.style.transform = `translateX(${-OPEN}px)`; state.openSwipeId = t.id; };
  const up = (e, c = false) => {
    if (!drag) return;
    drag = false;
    try { card.releasePointerCapture(pid); } catch {}
    card.style.transition = "transform 160ms ease";
    if (c) { reset(); return; }
    if (dx > TH) { openL(); return; }
    if (dx < -TH) { openR(); return; }
    reset();
  };

  on(card, "pointerdown", down);
  on(card, "pointermove", move);
  on(card, "pointerup", up);
  on(card, "pointercancel", (e) => up(e, true));
}

// Drag ordering (manual)
function enableDrag(li, card, id) {
  if (!isDesktop()) return;
  card.draggable = true;
  on(card, "dragstart", (e) => { li.classList.add("dragging"); e.dataTransfer.setData("text/plain", id); e.dataTransfer.effectAllowed = "move"; });
  on(card, "dragend", () => li.classList.remove("dragging"));
}

function getAfter(container, y) {
  const els = [...container.querySelectorAll(".task:not(.dragging)")];
  let best = { o: -1e9, el: null };
  for (const el of els) {
    const b = el.getBoundingClientRect();
    const off = y - b.top - b.height / 2;
    if (off < 0 && off > best.o) best = { o: off, el };
  }
  return best.el;
}

async function persistOrder() {
  if (!(settings.sort === "manual" && state.activeKind === "list")) return;
  const ids = [...document.querySelectorAll("#groups .task")].map((x) => x.dataset.id).filter(Boolean);
  if (!ids.length) return;
  await apiReorder({ listId: state.activeId, orderedIds: ids });
  await loadTasks();
}

function setupDrop() {
  if (!(settings.sort === "manual" && state.activeKind === "list")) return;
  document.querySelectorAll("#groups .tasks").forEach((ul) => {
    on(ul, "dragover", (e) => {
      e.preventDefault();
      const drag = document.querySelector(".task.dragging");
      if (!drag) return;
      const after = getAfter(ul, e.clientY);
      if (!after) ul.appendChild(drag);
      else ul.insertBefore(drag, after);
    });
    on(ul, "drop", (e) => { e.preventDefault(); persistOrder(); });
  });
}

// Task row
function taskRow(t) {
  const li = document.createElement("li");
  li.className = "task" + (t.completed ? " completed" : "") + (state.selectedTaskId === t.id ? " selected" : "");
  li.dataset.id = t.id;

  const actions = document.createElement("div");
  actions.className = "swipe-actions";
  const ok = document.createElement("button");
  ok.className = "action-btn complete";
  ok.textContent = "✓";
  const del = document.createElement("button");
  del.className = "action-btn delete";
  del.innerHTML = '<svg class="ico sm"><use href="#i-trash"></use></svg>';
  actions.appendChild(ok);
  actions.appendChild(del);

  const card = document.createElement("div");
  card.className = "task-card";

  const cb = document.createElement("div");
  cb.className = "checkbox" + (t.completed ? " checked" : "");

  const main = document.createElement("div");
  main.className = "task-main";

  const title = document.createElement("div");
  title.className = "task-title";
  if ((t.priority || 0) > 0) {
    const f = document.createElement("span");
    f.className = "flag";
    f.textContent = t.priority === 3 ? "!!!" : t.priority === 2 ? "!!" : "!";
    title.appendChild(f);
  }
  const tt = document.createElement("span");
  tt.textContent = t.title;
  title.appendChild(tt);

  const meta = document.createElement("div");
  meta.className = "task-meta";
  const list = state.lists.find((l) => l.id === t.listId);
  if (list) {
    const s = document.createElement("span");
    s.textContent = `${list.emoji || "📌"} ${list.title}`;
    meta.appendChild(s);
  }
  (t.tags || []).slice(0, 3).forEach((tag) => {
    const c = document.createElement("span");
    c.className = "chipTag";
    c.textContent = "#" + tag;
    meta.appendChild(c);
  });

  main.appendChild(title);
  if (meta.childNodes.length && !isDesktop()) main.appendChild(meta);

  const due = document.createElement("div");
  due.className = "due";
  const dueTxt = fmtDueShort(t.dueDate);
  if (isDesktop()) {
    const rn = document.createElement("span");
    rn.className = "rm-list";
    rn.textContent = list?.title || "Входящие";
    const rd = document.createElement("span");
    rd.className = "rm-due";
    rd.textContent = dueTxt || "";
    due.appendChild(rn);
    if (dueTxt) {
      due.appendChild(document.createTextNode(" "));
      due.appendChild(rd);
    }
  } else {
    due.textContent = dueTxt;
  }

  const right = document.createElement("div");
  right.className = "task-actions";
  const bE = document.createElement("button");
  bE.className = "small-btn";
  bE.innerHTML = '<svg class="ico sm"><use href="#i-edit"></use></svg>';
  const bD = document.createElement("button");
  bD.className = "small-btn";
  bD.innerHTML = '<svg class="ico sm"><use href="#i-trash"></use></svg>';
  right.appendChild(bE);
  right.appendChild(bD);

  card.appendChild(cb);
  card.appendChild(main);
  card.appendChild(due);
  card.appendChild(right);

  li.appendChild(actions);
  li.appendChild(card);

  attachSwipe(card, t);

  on(ok, "click", async (e) => { e.stopPropagation(); await apiPatchTask(t.id, { completed: true }); closeOpenSwipe(); await refreshCounts(); await loadTasks(); });
  on(del, "click", async (e) => { e.stopPropagation(); if (!confirm("Удалить?")) return; await apiDeleteTask(t.id); closeOpenSwipe(); await refreshCounts(); await loadTasks(); });
  on(cb, "click", async (e) => { e.stopPropagation(); await apiPatchTask(t.id, { completed: !t.completed }); await refreshCounts(); await loadTasks(); });
  on(bD, "click", async (e) => { e.stopPropagation(); if (!confirm("Удалить?")) return; await apiDeleteTask(t.id); await refreshCounts(); await loadTasks(); });
  on(bE, "click", (e) => { e.stopPropagation(); openTask(t); });
  on(card, "click", () => openTask(t));

  if (settings.sort === "manual" && state.activeKind === "list" && !t.completed) enableDrag(li, card, t.id);
  return li;
}

function groupTasks(ts) {
  if (settings.sort === "manual") return [{ key: "all", title: "Все", items: ts }];
  const m = new Map();
  ts.forEach((t) => { const k = bucket(t.dueDate); if (!m.has(k)) m.set(k, []); m.get(k).push(t); });
  const order = ["Сегодня", "Завтра", "Позже", "Без даты"];
  return order.filter((k) => m.has(k)).map((k) => ({ key: k, title: k, items: m.get(k) }));
}

function render() {
  const groups = $("groups");
  const done = $("completedTasks");
  const empty = $("emptyState");

  groups.innerHTML = "";
  done.innerHTML = "";

  empty.hidden = !(state.tasks.length === 0 && state.done.length === 0);

  // pane header (TickTick-like)
  if ($("paneTitle")) {
    $("paneTitle").textContent = $("pageTitle")?.textContent || "";
    $("paneCount").textContent = String(state.tasks.length);
  }

  groupTasks(state.tasks).forEach((g) => {
    const sec = document.createElement("section");
    const head = document.createElement("button");
    head.className = "section-head";
    head.textContent = `${g.title} ${g.items.length}`;
    head.insertAdjacentText("beforeend", ` ${state.collapsed.has(g.key) ? "▸" : "▾"}`);
    head.addEventListener("click", () => {
      state.collapsed.has(g.key) ? state.collapsed.delete(g.key) : state.collapsed.add(g.key);
      saveCollapse();
      render();
    });

    const ul = document.createElement("ul");
    ul.className = "tasks";
    if (!state.collapsed.has(g.key)) g.items.forEach((t) => ul.appendChild(taskRow(t)));

    sec.appendChild(head);
    sec.appendChild(ul);
    groups.appendChild(sec);
  });

  $("completedCount").textContent = String(state.done.length);
  $("completedChevron").textContent = state.doneCollapsed ? "▸" : "▾";
  if (!state.doneCollapsed) state.done.forEach((t) => done.appendChild(taskRow(t)));

  setupDrop();

  // keep desktop editor in sync
  renderTaskEditor();
}

on($("completedHead"), "click", () => { state.doneCollapsed = !state.doneCollapsed; render(); });

async function loadTasks() {
  if (state.view !== "tasks") return;
  closeOpenSwipe();

  const q = ($("searchInput")?.value || "").trim();
  const base = { filter: "active", sort: settings.sort };
  const done = { filter: "completed", sort: settings.sort };

  if (q) { base.q = q; done.q = q; }

  const today = iso(new Date());
  const nextTo = iso(addDays(new Date(), 6));

  if (state.activeKind === "smart") {
    if (state.activeId === "today") { base.due = today; done.due = today; }
    if (state.activeId === "next7") { base.due_from = today; base.due_to = nextTo; done.due_from = today; done.due_to = nextTo; }
    if (state.activeId === "inbox") {
      const inboxId = state.system.inboxId;
      if (inboxId) { base.list_id = inboxId; done.list_id = inboxId; }
    }
  } else {
    base.list_id = state.activeId;
    done.list_id = state.activeId;
  }

  const [a, d] = await Promise.all([apiGetTasks(base), apiGetTasks(done)]);
  state.tasks = a;
  state.done = d;
  render();
}

async function refreshCounts() {
  const today = iso(new Date());
  const nextTo = iso(addDays(new Date(), 6));

  const all = await apiGetTasks({ filter: "active", sort: "created" });

  const byList = {};
  const byFolder = {};
  let cToday = 0, cNext7 = 0;

  for (const t of all) {
    byList[t.listId] = (byList[t.listId] || 0) + 1;
    const dd = t.dueDate;
    if (dd === today) cToday++;
    if (dd && dd >= today && dd <= nextTo) cNext7++;
  }

  for (const l of state.lists) {
    const c = byList[l.id] || 0;
    document.querySelector(`[data-count="${l.id}"]`)?.replaceChildren(document.createTextNode(String(c)));
    if (l.folderId) byFolder[l.folderId] = (byFolder[l.folderId] || 0) + c;
  }

  for (const f of state.folders) {
    const c = byFolder[f.id] || 0;
    document.querySelector(`[data-folder-count="${f.id}"]`)?.replaceChildren(document.createTextNode(String(c)));
  }

  $("countAll").textContent = String(all.length);
  $("countToday").textContent = String(cToday);
  $("countNext7").textContent = String(cNext7);
  $("countInbox").textContent = String(byList[state.system.inboxId] || 0);
}

async function loadMeta() {
  state.folders = await apiGetFolders();
  state.lists = await apiGetLists();
  // resolve system lists
  state.system.inboxId = (state.lists.find((l) => l.systemKey === "inbox")?.id) || (state.lists.find((l) => l.id === "inbox")?.id) || (state.lists[0]?.id || null);
  if (!state.composer.listId) state.composer.listId = state.system.inboxId;
  renderLists();
  renderFolderSelect();
  renderEditListFolderSelect();
  renderTaskListSelect();
  updateAddPlaceholder();
}

function openTask(t) {
  if (!t) return;
  // Desktop split editor (TickTick-like)
  if (isSplit()) {
    state.selectedTaskId = t.id;
    render();
    renderTaskEditor();
    return;
  }

  // Mobile / narrow: bottom sheet
  state.editing.taskId = t.id;
  $("taskTitle").value = t.title || "";
  $("taskNotes").value = t.notes || "";
  $("taskDueDate").value = t.dueDate || "";
  $("taskTags").value = (t.tags || []).map((x) => "#" + x).join(" ");
  $("taskListSelect").value = t.listId || state.system.inboxId || "";
  document.querySelectorAll("#taskPrio .prio-btn").forEach((b) => b.classList.toggle("active", Number(b.dataset.p) === Number(t.priority || 0)));
  $("btnTaskToggle").textContent = t.completed ? "Вернуть" : "Готово";
  $("btnTaskToggle").dataset.completed = t.completed ? "1" : "0";
  openSheet("taskBackdrop", "taskSheet");
  $("taskTitle").focus();
}

function setTasksSplitUI(on) {
  const layout = $("tasksLayout");
  if (layout) layout.classList.toggle("split", !!on);
}

function getTaskById(id) {
  if (!id) return null;
  return state.tasks.find((x) => x.id === id) || state.done.find((x) => x.id === id) || null;
}

function fmtDueLong(s) {
  if (!s) return "Без даты";
  const t = iso(new Date());
  const tm = iso(addDays(new Date(), 1));
  const [y, m, d] = s.split("-");
  const mm = MONTHS_RU_SHORT[Math.max(0, Math.min(11, Number(m) - 1))] || m;
  if (s === t) return `Сегодня, ${Number(d)} ${mm}`;
  if (s === tm) return `Завтра, ${Number(d)} ${mm}`;
  return `${Number(d)} ${mm}`;
}

let teTimer = null;
async function patchSelectedTask(patch, { reload = false } = {}) {
  const id = state.selectedTaskId;
  if (!id) return;
  await apiPatchTask(id, patch);
  const applyLocal = (arr) => {
    const i = arr.findIndex((x) => x.id === id);
    if (i >= 0) arr[i] = { ...arr[i], ...patch };
  };
  applyLocal(state.tasks);
  applyLocal(state.done);
  if (reload) {
    await refreshCounts();
    await loadTasks();
    return;
  }
  render();
  renderTaskEditor();
}

function patchSelectedDebounced(patch, opts) {
  clearTimeout(teTimer);
  teTimer = setTimeout(() => patchSelectedTask(patch, opts).catch(() => {}), 450);
}

function closeTaskEditor() {
  state.selectedTaskId = null;
  setTasksSplitUI(false);
  $("taskEditor") && ($("taskEditor").hidden = true);
  render();
}

function renderTaskEditor() {
  const ed = $("taskEditor");
  if (!ed) return;
  if (state.view !== "tasks") {
    ed.hidden = true;
    setTasksSplitUI(false);
    return;
  }
  if (!isSplit() || !state.selectedTaskId) {
    ed.hidden = true;
    setTasksSplitUI(false);
    return;
  }
  const t = getTaskById(state.selectedTaskId);
  if (!t) {
    state.selectedTaskId = null;
    ed.hidden = true;
    setTasksSplitUI(false);
    return;
  }
  ed.hidden = false;
  setTasksSplitUI(true);

  $("teTitle").value = t.title || "";
  $("teNotes").value = t.notes || "";
  $("teDueText").textContent = fmtDueLong(t.dueDate);
  $("teDueDate").value = t.dueDate || "";
  const list = state.lists.find((l) => l.id === t.listId) || state.lists.find((l) => l.systemKey === "inbox") || null;
  $("teListText").textContent = list?.title || "Входящие";
  $("teToggle").classList.toggle("done", !!t.completed);
}

// Composer
async function addTaskFromRaw(raw, explicitListId = null, explicitDue = null, explicitPriority = null) {
  const p = parseQuick(raw);
  if (!p.title) return;

  let due = explicitDue ?? state.composer.dueDate;
  if (state.activeKind === "smart" && state.activeId === "today" && !due) due = iso(new Date());

  const inboxId = state.system.inboxId;
  const listId = explicitListId ?? (state.activeKind === "list" ? state.activeId : (state.activeId === "inbox" ? inboxId : (state.composer.listId || inboxId)));
  const priority = p.priority ?? (explicitPriority ?? state.composer.priority);

  await apiCreateTask({ title: p.title, listId, dueDate: due || null, tags: p.tags, priority, notes: null });
  await refreshCounts();
  await loadTasks();
}

async function addTask() {
  const raw = $("compInput").value.trim();
  if (!raw) return;
  await addTaskFromRaw(raw);
  $("compInput").value = "";
  state.composer.dueDate = null;
  $("compDueDate").value = "";
  state.composer.priority = 0;
  $("compFlagBtn").style.opacity = "0.75";
}

async function addTaskDesktop() {
  const raw = $("deskAddInput").value.trim();
  if (!raw) return;
  await addTaskFromRaw(raw);
  $("deskAddInput").value = "";
}

// Calendar
function colorForList(listId) {
  // deterministic HSL
  let h = 0;
  for (let i = 0; i < listId.length; i++) h = (h * 31 + listId.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 45%)`;
}

function monthRangeKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

async function ensureCalendarTasks() {
  const key = monthRangeKey(state.calendarCursor);
  if (state.calendarRangeKey === key) return;

  const first = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth(), 1);
  const last = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() + 1, 0);

  const due_from = iso(first);
  const due_to = iso(last);

  state.calendarTasks = await apiGetTasks({ filter: "active", sort: "due", due_from, due_to });
  state.calendarRangeKey = key;
}

async function renderCalendar() {
  if (state.view !== "calendar") return;
  await ensureCalendarTasks();

  $("pageTitle").textContent = MONTHS_RU[state.calendarCursor.getMonth()];
  $("calTitle").textContent = MONTHS_RU[state.calendarCursor.getMonth()];

  const grid = $("calGrid");
  grid.innerHTML = "";

  const year = state.calendarCursor.getFullYear();
  const month = state.calendarCursor.getMonth();

  const first = new Date(year, month, 1);
  const start = new Date(first);
  // week starts Sunday
  start.setDate(first.getDate() - first.getDay());

  const tasksByDate = new Map();
  for (const t of state.calendarTasks) {
    if (!t.dueDate) continue;
    if (!tasksByDate.has(t.dueDate)) tasksByDate.set(t.dueDate, []);
    tasksByDate.get(t.dueDate).push(t);
  }

  for (let i = 0; i < 42; i++) {
    const day = addDays(start, i);
    const dayIso = iso(day);
    const cell = document.createElement("div");
    cell.className = "cal-cell";

    const head = document.createElement("div");
    head.className = "cal-day" + (day.getMonth() !== month ? " muted" : "");
    head.textContent = String(day.getDate());
    cell.appendChild(head);

    const events = document.createElement("div");
    events.className = "cal-events";

    const tasks = (tasksByDate.get(dayIso) || []).slice().sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    const shown = tasks.slice(0, 4);
    for (const t of shown) {
      const ev = document.createElement("div");
      ev.className = "cal-event";
      const list = state.lists.find((l) => l.id === t.listId);
      const col = colorForList(t.listId || state.system.inboxId || "inbox");
      ev.style.borderLeftColor = col;
      ev.style.background = "rgba(255,255,255,.05)";
      ev.textContent = t.title;
      ev.title = `${t.title} (${list?.title || "Входящие"})`;
      ev.addEventListener("click", (e) => { e.stopPropagation(); openTask(t); });
      events.appendChild(ev);
    }

    if (tasks.length > 4) {
      const more = document.createElement("div");
      more.className = "cal-more";
      more.textContent = `ещё ${tasks.length - 4}`;
      events.appendChild(more);
    }

    cell.appendChild(events);
    grid.appendChild(cell);
  }
}

// Summary
let _summarySaveTimer = null;
let _summaryInited = false;

function initSummary() {
  if (!_summaryInited) {
    _summaryInited = true;

    const ed = $("summaryEditor");
    const saved = localStorage.getItem(SUMMARY_KEY);
    ed.innerHTML = saved || "<h2>Сводка</h2><p>Нажмите ↻ чтобы сгенерировать сводку за неделю.</p>";

    on(ed, "input", () => {
      clearTimeout(_summarySaveTimer);
      _summarySaveTimer = setTimeout(() => {
        localStorage.setItem(SUMMARY_KEY, ed.innerHTML);
      }, 250);
    });

    document.querySelectorAll("#editorToolbar .tbbtn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const cmd = btn.dataset.cmd;
        const action = btn.dataset.action;

        if (action === "gen") {
          await generateWeeklySummary();
          return;
        }

        if (!cmd) return;
        if (cmd === "createLink") {
          const url = prompt("Ссылка:");
          if (!url) return;
          document.execCommand("createLink", false, url);
          return;
        }
        if (cmd === "formatBlock") {
          const val = btn.dataset.val || "H2";
          document.execCommand("formatBlock", false, `<${val}>`);
          return;
        }
        document.execCommand(cmd, false, null);
      });
    });

    on($("summaryCopy"), "click", async () => {
      try {
        const text = $("summaryEditor").innerText;
        await navigator.clipboard.writeText(text);
        alert("Скопировано");
      } catch {
        alert("Не удалось скопировать");
      }
    });

    on($("summarySaveAs"), "click", () => alert("Сохранение как шаблон — заглушка"));
  }
}

function startOfWeek(d) {
  const x = new Date(d);
  const day = x.getDay(); // 0..6 (Sun..)
  // TickTick обычно считает неделю с понедельника; делаем Monday
  const diff = (day === 0 ? -6 : 1) - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

async function generateWeeklySummary() {
  const s = startOfWeek(new Date());
  const e = addDays(s, 6);
  const from = iso(s);
  const to = iso(e);

  $("rpDate").textContent = `На этой неделе (${from} — ${to})`;

  // В базе нет completed_at, поэтому берём выполненные задачи по dueDate.
  const done = await apiGetTasks({ filter: "completed", sort: "due", due_from: from, due_to: to });

  const byDate = new Map();
  for (const t of done) {
    const k = t.dueDate || "";
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(t);
  }

  const keys = [...byDate.keys()].sort();

  let html = `<h2>${s.getDate()} ${MONTHS_RU[s.getMonth()].slice(0,3)}. - ${e.getDate()} ${MONTHS_RU[e.getMonth()].slice(0,3)}.</h2>`;
  html += `<p><b>Выполнено</b></p>`;

  for (const k of keys) {
    const label = k ? fmtDueShort(k) : "Без даты";
    const items = byDate.get(k);
    html += `<ul>`;
    for (const t of items) {
      html += `<li>[${label}] ${escapeHtml(t.title)}</li>`;
    }
    html += `</ul>`;
  }

  if (!keys.length) html += `<p class="muted">Нет выполненных задач за неделю</p>`;

  $("summaryEditor").innerHTML = html;
  localStorage.setItem(SUMMARY_KEY, $("summaryEditor").innerHTML);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Account menu & settings modal
function toggleAccountMenu() {
  const menu = $("accountMenu");
  menu.hidden = !menu.hidden;
}

function openSettings() {
  $("settingsBackdrop").hidden = false;
  $("settingsModal").hidden = false;
}
function closeSettings() {
  $("settingsBackdrop").hidden = true;
  $("settingsModal").hidden = true;
}

// Event bindings
on($("btnMenu"), "click", openDrawer);
on($("drawerBackdrop"), "click", closeDrawer);

document.querySelectorAll('.drawer-item[data-kind="smart"]').forEach((b) => {
  on(b, "click", () => setActive("smart", b.dataset.id));
});

on($("btnSort"), "click", () => openSheet("sortBackdrop", "sortSheet"));
on($("sortBackdrop"), "click", () => closeSheet("sortBackdrop", "sortSheet"));
on($("sortCancel"), "click", () => closeSheet("sortBackdrop", "sortSheet"));
document.querySelectorAll('.sheet-option[data-sort]').forEach((b) => on(b, "click", () => { settings.sort = b.dataset.sort; save(); closeSheet("sortBackdrop", "sortSheet"); loadTasks(); }));

on($("btnAdd"), "click", () => openSheet("addBackdrop", "addSheet"));
on($("addBackdrop"), "click", () => closeSheet("addBackdrop", "addSheet"));
on($("addCancel"), "click", () => closeSheet("addBackdrop", "addSheet"));

on($("addListBtn"), "click", () => { closeSheet("addBackdrop", "addSheet"); openSheet("listBackdrop", "listSheet"); $("listTitle").focus(); });
on($("btnListCancel"), "click", () => closeSheet("listBackdrop", "listSheet"));
on($("listBackdrop"), "click", () => closeSheet("listBackdrop", "listSheet"));
on($("listForm"), "submit", async (e) => {
  e.preventDefault();
  const title = $("listTitle").value.trim();
  const emoji = ($("listEmoji").value || "📌").trim() || "📌";
  const folderId = $("folderSelect").value || null;
  if (!title) { $("listHint").hidden = false; return; }
  await apiCreateList({ title, emoji, folderId });
  closeSheet("listBackdrop", "listSheet");
  await loadMeta();
  await refreshCounts();
});

on($("addFolderBtn"), "click", () => { closeSheet("addBackdrop", "addSheet"); openSheet("folderBackdrop", "folderSheet"); $("folderTitle").focus(); });
on($("btnFolderCancel"), "click", () => closeSheet("folderBackdrop", "folderSheet"));
on($("folderBackdrop"), "click", () => closeSheet("folderBackdrop", "folderSheet"));
on($("folderForm"), "submit", async (e) => {
  e.preventDefault();
  const title = $("folderTitle").value.trim();
  const emoji = ($("folderEmoji").value || "📁").trim() || "📁";
  if (!title) { $("folderHint").hidden = false; return; }
  await apiCreateFolder({ title, emoji });
  closeSheet("folderBackdrop", "folderSheet");
  await loadMeta();
  await refreshCounts();
});

// edit list
on($("editListBackdrop"), "click", () => closeSheet("editListBackdrop", "editListSheet"));
on($("btnEditListCancel"), "click", () => closeSheet("editListBackdrop", "editListSheet"));
on($("editListForm"), "submit", async (e) => {
  e.preventDefault();
  const id = state.editing.listId;
  const title = $("editListTitle").value.trim();
  const emoji = ($("editListEmoji").value || "📌").trim() || "📌";
  const folderId = $("editListFolderSelect").value || null;
  if (!title) { $("editListHint").hidden = false; return; }
  await apiPatchList(id, { title, emoji, folderId });
  closeSheet("editListBackdrop", "editListSheet");
  await loadMeta();
  await refreshCounts();
  await loadTasks();
});
on($("btnEditListDelete"), "click", async () => {
  const id = state.editing.listId;
  if (!id) return;
  if (!confirm("Удалить список? Задачи будут перенесены во 'Входящие'.")) return;
  await apiDeleteList(id);
  closeSheet("editListBackdrop", "editListSheet");
  if (state.activeKind === "list" && state.activeId === id) setActive("smart", "all");
  await loadMeta();
  await refreshCounts();
  await loadTasks();
});

// edit folder
on($("editFolderBackdrop"), "click", () => closeSheet("editFolderBackdrop", "editFolderSheet"));
on($("btnEditFolderCancel"), "click", () => closeSheet("editFolderBackdrop", "editFolderSheet"));
on($("editFolderForm"), "submit", async (e) => {
  e.preventDefault();
  const id = state.editing.folderId;
  const title = $("editFolderTitle").value.trim();
  const emoji = ($("editFolderEmoji").value || "📁").trim() || "📁";
  if (!title) { $("editFolderHint").hidden = false; return; }
  await apiPatchFolder(id, { title, emoji });
  closeSheet("editFolderBackdrop", "editFolderSheet");
  await loadMeta();
  await refreshCounts();
});
on($("btnEditFolderDelete"), "click", async () => {
  const id = state.editing.folderId;
  if (!id) return;
  if (!confirm("Удалить папку? Списки останутся, но будут без папки.")) return;
  await apiDeleteFolder(id);
  closeSheet("editFolderBackdrop", "editFolderSheet");
  await loadMeta();
  await refreshCounts();
});

// pick list
on($("compListBtn"), "click", () => {
  const pl = $("pickList");
  pl.innerHTML = "";
  state.lists.forEach((l) => {
    const btn = document.createElement("button");
    btn.className = "sheet-option";
    btn.textContent = `${l.emoji || "📌"} ${l.title}`;
    btn.onclick = () => { state.composer.listId = l.id; updateAddPlaceholder(); closeSheet("pickBackdrop", "pickSheet"); };
    pl.appendChild(btn);
  });
  openSheet("pickBackdrop", "pickSheet");
});
on($("pickBackdrop"), "click", () => closeSheet("pickBackdrop", "pickSheet"));
on($("pickCancel"), "click", () => closeSheet("pickBackdrop", "pickSheet"));

// desktop task editor (split)
on($("teClose"), "click", closeTaskEditor);
on($("teDueBtn"), "click", () => $("teDueDate")?.click());
on($("teDueDate"), "change", async () => {
  const v = $("teDueDate").value || null;
  await patchSelectedTask({ dueDate: v }, { reload: true });
});
on($("teTitle"), "input", () => {
  const v = $("teTitle").value.trim();
  if (!v) return;
  patchSelectedDebounced({ title: v }, { reload: false });
});
on($("teNotes"), "input", () => {
  const v = $("teNotes").value.trim();
  patchSelectedDebounced({ notes: v || null }, { reload: false });
});
on($("teToggle"), "click", async () => {
  const t = getTaskById(state.selectedTaskId);
  if (!t) return;
  await patchSelectedTask({ completed: !t.completed }, { reload: true });
});
on($("teListBtn"), "click", () => {
  const id = state.selectedTaskId;
  if (!id) return;
  const pl = $("pickList");
  pl.innerHTML = "";
  state.lists.forEach((l) => {
    const btn = document.createElement("button");
    btn.className = "sheet-option";
    btn.textContent = `${l.emoji || "📌"} ${l.title}`;
    btn.onclick = async () => {
      await patchSelectedTask({ listId: l.id }, { reload: true });
      closeSheet("pickBackdrop", "pickSheet");
    };
    pl.appendChild(btn);
  });
  openSheet("pickBackdrop", "pickSheet");
});
on($("tePriority"), "click", async () => {
  const t = getTaskById(state.selectedTaskId);
  if (!t) return;
  const next = ((Number(t.priority || 0) + 1) % 4);
  await patchSelectedTask({ priority: next }, { reload: false });
});
on($("teTags"), "click", async () => {
  const t = getTaskById(state.selectedTaskId);
  if (!t) return;
  const cur = (t.tags || []).map((x) => "#" + x).join(" ");
  const raw = prompt("Теги (#tag #home)", cur);
  if (raw === null) return;
  const tags = parseTagsInput(raw);
  await patchSelectedTask({ tags }, { reload: false });
});
on($("teMore"), "click", async () => {
  const t = getTaskById(state.selectedTaskId);
  if (!t) return;
  if (!confirm("Удалить задачу?")) return;
  await apiDeleteTask(t.id);
  closeTaskEditor();
  await refreshCounts();
  await loadTasks();
});

// task sheet
on($("taskBackdrop"), "click", () => closeSheet("taskBackdrop", "taskSheet"));
on($("btnTaskCancel"), "click", () => closeSheet("taskBackdrop", "taskSheet"));
document.querySelectorAll("#taskPrio .prio-btn").forEach((b) => on(b, "click", () => { document.querySelectorAll("#taskPrio .prio-btn").forEach((x) => x.classList.toggle("active", x === b)); }));
on($("btnTaskDelete"), "click", async () => { const id = state.editing.taskId; if (!id) return; if (!confirm("Удалить задачу?")) return; await apiDeleteTask(id); closeSheet("taskBackdrop", "taskSheet"); await refreshCounts(); await loadTasks(); });
on($("btnTaskToggle"), "click", async () => { const id = state.editing.taskId; if (!id) return; const isDone = $("btnTaskToggle").dataset.completed === "1"; await apiPatchTask(id, { completed: !isDone }); closeSheet("taskBackdrop", "taskSheet"); await refreshCounts(); await loadTasks(); });
on($("taskForm"), "submit", async (e) => {
  e.preventDefault();
  const id = state.editing.taskId;
  if (!id) return;
  const title = $("taskTitle").value.trim();
  if (!title) return;
  const notes = $("taskNotes").value.trim() || null;
  const listId = $("taskListSelect").value || state.system.inboxId;
  const dueDate = $("taskDueDate").value || null;
  const tags = parseTagsInput($("taskTags").value);
  const prioBtn = [...document.querySelectorAll("#taskPrio .prio-btn")].find((b) => b.classList.contains("active"));
  const priority = prioBtn ? Number(prioBtn.dataset.p) : 0;
  await apiPatchTask(id, { title, listId, dueDate, tags, priority, notes });
  closeSheet("taskBackdrop", "taskSheet");
  await refreshCounts();
  await loadTasks();
});

// composer actions
on($("compDueBtn"), "click", () => $("compDueDate").click());
on($("compDueDate"), "change", () => state.composer.dueDate = $("compDueDate").value || null);
on($("compFlagBtn"), "click", () => { state.composer.priority = (state.composer.priority + 1) % 4; $("compFlagBtn").style.opacity = state.composer.priority ? "1" : "0.75"; });
$("compFlagBtn").style.opacity = "0.75";

on($("compAddBtn"), "click", addTask);
on($("compInput"), "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTask(); } });

on($("deskAddBtn"), "click", addTaskDesktop);
on($("deskAddInput"), "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTaskDesktop(); } });
on($("deskDueBtn"), "click", () => $("deskDueDate")?.click?.());
on($("deskDueDate"), "change", () => {
  state.composer.dueDate = $("deskDueDate").value || null;
});
on($("deskListBtn"), "click", () => $("compListBtn")?.click?.());
on($("paneAdd"), "click", () => $("deskAddInput")?.focus());
on($("newSectionBtn"), "click", () => alert("Секции — в разработке"));

on($("searchInput"), "input", loadTasks);

// search module
on($("globalSearchInput"), "input", async () => {
  const q = $("globalSearchInput").value.trim();
  $("searchResults").innerHTML = "";
  if (!q) { $("searchEmpty").hidden = true; return; }
  const res = await apiGetTasks({ filter: "all", q, sort: "created" });
  if (!res.length) { $("searchEmpty").hidden = false; return; }
  $("searchEmpty").hidden = true;
  res.slice(0, 50).forEach((t) => $("searchResults").appendChild(taskRow(t)));
});

// bottom nav (mobile)
document.querySelectorAll(".bn-item").forEach((b) => on(b, "click", () => {
  document.querySelectorAll(".bn-item").forEach((x) => x.classList.toggle("active", x === b));
  const v = b.dataset.view;
  if (v === "tasks") setModule("tasks");
  if (v === "search") setModule("search");
  if (v === "calendar") setModule("calendar");
}));

// rail
on($("btnAccount"), "click", toggleAccountMenu);
document.querySelectorAll(".rail-item[data-module]").forEach((b) => on(b, "click", () => setModule(b.dataset.module)));
on($("btnRailSettings"), "click", openSettings);

// account menu actions
on($("menuSettings"), "click", () => { $("accountMenu").hidden = true; openSettings(); });
on($("menuTheme"), "click", () => { $("accountMenu").hidden = true; toggleTheme(); });
on($("menuStats"), "click", () => { $("accountMenu").hidden = true; alert("Статистика — заглушка"); });
on($("menuPremium"), "click", () => { $("accountMenu").hidden = true; alert("Премиум — заглушка"); });
on($("menuLogout"), "click", () => { $("accountMenu").hidden = true; logout(); });

// settings modal
on($("settingsBackdrop"), "click", closeSettings);
on($("settingsClose"), "click", closeSettings);

// keep split editor responsive
window.addEventListener("resize", () => {
  if (!isSplit()) {
    $("taskEditor") && ($("taskEditor").hidden = true);
    setTasksSplitUI(false);
  } else {
    renderTaskEditor();
  }
});

// calendar controls
on($("calPrev"), "click", async () => { state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() - 1, 1); state.calendarRangeKey = ""; await renderCalendar(); });
on($("calNext"), "click", async () => { state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() + 1, 1); state.calendarRangeKey = ""; await renderCalendar(); });
on($("calToday"), "click", async () => { const now = new Date(); state.calendarCursor = new Date(now.getFullYear(), now.getMonth(), 1); state.calendarRangeKey = ""; await renderCalendar(); });
on($("calAdd"), "click", () => { setModule("tasks"); setActive("smart", "inbox"); $("deskAddInput")?.focus?.(); });

// Resize handler
window.addEventListener("resize", () => {
  applyLayout();
  updateAddPlaceholder();
});

// Auth UI
function switchAuthTab(which) {
  const isLogin = which === "login";
  $("tabLogin")?.classList.toggle("active", isLogin);
  $("tabRegister")?.classList.toggle("active", !isLogin);
  // Be explicit: some browsers/extensions can behave oddly with [hidden] + flex.
  // We set both the attribute AND inline display to guarantee only one form is visible.
  const fl = $("formLogin");
  const fr = $("formRegister");
  if (fl) {
    fl.hidden = !isLogin;
    fl.style.display = isLogin ? "flex" : "none";
  }
  if (fr) {
    fr.hidden = isLogin;
    fr.style.display = isLogin ? "none" : "flex";
  }
  $("loginError").hidden = true;
  $("regError").hidden = true;
}

on($("welcomeGoLogin"), "click", () => openAuth("login"));
on($("welcomeGoRegister"), "click", () => openAuth("register"));
on($("authBack"), "click", () => showWelcome(true));

on($("tabLogin"), "click", () => switchAuthTab("login"));
on($("tabRegister"), "click", () => switchAuthTab("register"));

on($("formLogin"), "submit", async (e) => {
  e.preventDefault();
  $("loginError").hidden = true;
  try {
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;
    const res = await apiAuthLogin({ email, password });
    setAuth(res.token, res.user);
    hideWelcome();
    await startApp();
  } catch (err) {
    $("loginError").textContent = err.message || String(err);
    $("loginError").hidden = false;
  }
});

on($("formRegister"), "submit", async (e) => {
  e.preventDefault();
  $("regError").hidden = true;
  try {
    const email = $("regEmail").value.trim();
    const p1 = $("regPassword").value;
    const p2 = $("regPassword2").value;
    if (p1 !== p2) throw new Error("Пароли не совпадают");
    const res = await apiAuthRegister({ email, password: p1 });
    setAuth(res.token, res.user);
    hideWelcome();
    await startApp();
  } catch (err) {
    $("regError").textContent = err.message || String(err);
    $("regError").hidden = false;
  }
});

let _started = false;
async function startApp() {
  if (_started) return;
  _started = true;
  try {
    await loadMeta();
    await refreshCounts();
    setActive("smart", "all");
    applyLayout();
  } catch (e) {
    _started = false;
    alert("Ошибка: " + (e.message || e));
  }
}

// Boot
(async () => {
  try {
    if (!auth.token) {
      showWelcome(true);
      return;
    }
    // validate token
    const me = await apiAuthMe();
    setAuth(auth.token, me);
    hideWelcome();
    await startApp();
  } catch {
    logout();
  }
})();
