const SETTINGS_KEY="tt.settings.v4";
const COLLAPSE_KEY="tt.collapse.v1";
const SUMMARY_KEY="tt.summary.html.v1";
const TOKEN_KEY="tt.auth.token.v1";
const USER_KEY="tt.auth.user.v1";

// Build marker (helps verify Railway deployed the latest bundle)
console.log("ClockTime build v24-theme-anim-calendar-fill");

const settings = (() => {
  const defaults = {
    sort: "due",
    theme: "dark",
    weekStart: "mon",           // mon|sun
    timeFormat: "24",           // 24|12
    denseUI: true,               // closer to TickTick list rows
    showHints: true,
    modules: { calendar: true, search: true, summary: true },
  };
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    const merged = { ...defaults, ...raw };
    merged.modules = { ...defaults.modules, ...(raw.modules || {}) };
    return merged;
  } catch {
    return defaults;
  }
})();
const save = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

const $ = (id) => document.getElementById(id);
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
const isDesktop = () => window.matchMedia && window.matchMedia("(min-width: 900px)").matches;
const isSplit = () => isDesktop() && window.matchMedia && window.matchMedia("(min-width: 1120px)").matches;

// Simple anchored popover (single instance)
function closePopover() {
  const p = $("popover");
  if (!p) return;
  p.hidden = true;
  p.innerHTML = "";
}

function openPopover(anchorEl, items, { title = null, width = 260 } = {}) {
  const p = $("popover");
  if (!p || !anchorEl) return;
  p.innerHTML = "";
  if (title) {
    const h = document.createElement("div");
    h.className = "pop-title";
    h.textContent = title;
    p.appendChild(h);
  }
  for (const it of items) {
    if (it === "sep") {
      const s = document.createElement("div");
      s.className = "pop-sep";
      p.appendChild(s);
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pop-item" + (it.active ? " active" : "");
    b.innerHTML = `${it.icon ? `<span class="pop-ico">${it.icon}</span>` : ""}<span class="pop-label">${it.label}</span>${it.right ? `<span class="pop-right">${it.right}</span>` : ""}`;
    b.addEventListener("click", () => {
      closePopover();
      it.onSelect && it.onSelect(it.value);
    });
    p.appendChild(b);
  }
  const r = anchorEl.getBoundingClientRect();
  const top = Math.min(window.innerHeight - 10, r.bottom + 8);
  const left = Math.min(window.innerWidth - 10, r.left);
  p.style.width = `${width}px`;
  p.style.top = `${top}px`;
  p.style.left = `${Math.max(10, left)}px`;
  p.hidden = false;

  // close on outside click
  setTimeout(() => {
    const onDoc = (e) => {
      if (!p.hidden && !p.contains(e.target) && !anchorEl.contains(e.target)) {
        closePopover();
        document.removeEventListener("mousedown", onDoc);
        document.removeEventListener("touchstart", onDoc);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
  }, 0);
}

function applyTheme() {
  const sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = settings.theme === "auto" ? (sysDark ? "dark" : "light") : (settings.theme || "dark");

  // Smooth transition for theme switching
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduceMotion) {
    document.documentElement.classList.add('theme-anim');
    clearTimeout(applyTheme._t);
    applyTheme._t = setTimeout(() => document.documentElement.classList.remove('theme-anim'), 260);
  }

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
document.body.dataset.dense = (settings.denseUI !== false) ? '1' : '0';
document.body.dataset.hints = (settings.showHints !== false) ? '1' : '0';
window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
  if (settings.theme === "auto") applyTheme();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// Auth
let auth = (() => {
  const token = (localStorage.getItem(TOKEN_KEY) || "").trim();
  let user = null;
  try { user = JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { user = null; }
  return { token, user };
})();

function setAuth(token, user) {
  token = (token || "").trim();
  auth = { token, user };
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_KEY);
  updateAccountUI();
}


function logout(){
  // End session (if any) and go back to guest workspace.
  (async () => {
    try { await api("/api/auth/logout", { method: "POST" }); } catch (_) {}
    setAuth("", null);
    _started = false;
    await startApp();
  })();
}

function openAuth(mode = "login"){
  const back = $("authBackdrop");
  const modal = $("authModal");
  if (!back || !modal) return;
  back.hidden = false;
  modal.hidden = false;

  const isReg = mode === "register";
  $("tabLogin")?.classList.toggle("active", !isReg);
  $("tabRegister")?.classList.toggle("active", isReg);
  $("formLogin") && ($("formLogin").hidden = isReg);
  $("formRegister") && ($("formRegister").hidden = !isReg);
  $("loginError") && ($("loginError").hidden = true);
  $("regError") && ($("regError").hidden = true);

  // alt link
  const alt = $("authAlt");
  if (alt) {
    alt.innerHTML = isReg
      ? 'Уже есть аккаунт? <button class="auth-link" id="authToLogin" type="button">Войти</button>'
      : 'Нет аккаунта? <button class="auth-link" id="authToRegister" type="button">Зарегистрироваться</button>';
    setTimeout(() => {
      $("authToRegister")?.addEventListener("click", () => openAuth("register"));
      $("authToLogin")?.addEventListener("click", () => openAuth("login"));
    }, 0);
  }

  setTimeout(() => {
    const el = isReg ? $("regEmail") : $("loginEmail");
    el?.focus?.();
  }, 0);
}

function hideWelcome(){
  // close auth modal
  $("authBackdrop") && ($("authBackdrop").hidden = true);
  $("authModal") && ($("authModal").hidden = true);
}

function showWelcome(){
  // keep app usable without forcing login
  openAuth("login");
}


function updateAccountUI() {
  const email = auth.user?.email || "";
  const isGuest = !auth.user || auth.user.id === "public";

  if ($("menuUserLabel")) $("menuUserLabel").textContent = isGuest ? "Гость" : (email || "Аккаунт");
  if ($("menuLogin")) $("menuLogin").hidden = !isGuest;
  if ($("menuRegister")) $("menuRegister").hidden = !isGuest;
  if ($("menuLogout")) $("menuLogout").hidden = isGuest;

  const initial = (email || (isGuest ? "Г" : "●")).trim()[0]?.toUpperCase() || "●";
  if ($("btnAccount")) $("btnAccount").textContent = initial;
}

function updateThemeIcon() {
  const use = $("themeIcon")?.querySelector?.("use");
  if (!use) return;
  use.setAttribute("href", settings.theme === "light" ? "#i-sun" : "#i-moon");
}
updateThemeIcon();

function setAuthBusy(formId, busy, busyText) {
  const form = $(formId);
  if (!form) return;
  form.querySelectorAll("input,button").forEach((el) => {
    el.disabled = !!busy;
  });
  const btn = form.querySelector('button[type="submit"]');
  if (btn) {
    if (!btn.dataset.origText) btn.dataset.origText = btn.textContent || "";
    btn.textContent = busy ? (busyText || "Подождите…") : btn.dataset.origText;
  }
}

// API
const API_BASE = "";
async function api(path, opt) {
  const o = opt ? { ...opt } : {};
  // Always include cookies. This is harmless for same-origin requests and
  // fixes cases where PWA / embedded browsers otherwise drop Set-Cookie.
  if (!o.credentials) o.credentials = "include";
  o.headers = { ...(o.headers || {}) };
  const r = await fetch(API_BASE + path, o);

  // IMPORTANT:
  // Never read the response body twice (json() then text()).
  // If the server returns a non‑JSON error body, json() consumes the stream,
  // and calling text() afterwards throws: "body stream already read".
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const raw = await r.text();

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
    const err = new Error(msg);
    err.code = r.status;
    throw err;
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
const apiReorderFolders = (p) => api("/api/folders/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });

const apiGetLists = () => api("/api/lists");
const apiCreateList = (p) => api("/api/lists", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiPatchList = (id, p) => api("/api/lists/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiDeleteList = (id) => api("/api/lists/" + encodeURIComponent(id), { method: "DELETE" });
const apiReorderLists = (p) => api("/api/lists/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });

const apiGetSections = (params) => api("/api/sections?" + new URLSearchParams(params).toString());
const apiCreateSection = (p) => api("/api/sections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiPatchSection = (id, p) => api("/api/sections/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiDeleteSection = (id) => api("/api/sections/" + encodeURIComponent(id), { method: "DELETE" });
const apiReorderSections = (p) => api("/api/sections/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });

const apiGetTasks = (params) => api("/api/tasks?" + new URLSearchParams(params).toString());
const apiCreateTask = (p) => api("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiPatchTask = (id, p) => api("/api/tasks/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
const apiDeleteTask = (id, { hard = false } = {}) => {
  const qs = hard ? ("?" + new URLSearchParams({ hard: "true" }).toString()) : "";
  return api("/api/tasks/" + encodeURIComponent(id) + qs, { method: "DELETE" });
};
const apiReorder = (p) => api("/api/tasks/reorder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });

const apiGetCounts = () => api("/api/counts");
const apiGetTags = (params={}) => api("/api/tags?" + new URLSearchParams(params).toString());
const apiEmptyTrash = () => api("/api/trash/empty", { method: "POST" });
const apiGetStats = (days=14) => api("/api/stats?" + new URLSearchParams({ days: String(days) }).toString());

// If any async code forgets to handle auth errors, bring user back to welcome.
window.addEventListener("unhandledrejection", (ev) => {
  const e = ev?.reason;
  if (e && (e.code === 401 || String(e.message || e).toLowerCase().includes("требуется вход"))) {
    ev.preventDefault?.();
    logout();
  }
});

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
  sections: [],
  tags: [],
  // cache: listId -> sections[] (used for editor dropdowns)
  sectionsCache: {},
  tasks: [],
  done: [],
  collapsed: new Set(_collapse.groups || []),
  folderCollapsed: new Set(_collapse.folders || []),
  sectionCollapsed: new Set(_collapse.sections || []),
  doneCollapsed: true,
  openSwipeId: null,
  selectedTaskId: null,
  draggingTask: null,
  draggingSectionId: null,
  draggingListId: null,
  draggingFolderId: null,
  editing: { listId: null, folderId: null, taskId: null },
  composer: { listId: null, dueDate: null, priority: 0, sectionId: null },
  system: { inboxId: null },
  calendarCursor: new Date(),
  calendarView: 'month', // month | week | day
  calendarDay: null,
  calendarTasks: [],
  calendarRangeKey: "",
  smartDue: null,
};

const saveCollapse = () => localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ groups: [...state.collapsed], folders: [...state.folderCollapsed], sections: [...state.sectionCollapsed] }));
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
  const yd = iso(addDays(new Date(), -1));
  if (s === t) return "Сегодня";
  if (s === tm) return "Завтра";
  if (s === yd) return "Вчера";
  const [yy, mm, dd] = s.split("-");
  return `${dd}.${mm}`;
};


const WEEKDAYS_RU = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];

function isoFromTs(ts){
  if (ts === null || ts === undefined) return null;
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return iso(new Date(n * 1000));
}

function relLabelForIso(isoDate){
  if (!isoDate) return "";
  const t = iso(new Date());
  const y = iso(addDays(new Date(), -1));
  if (isoDate === t) return "Сегодня";
  if (isoDate === y) return "Вчера";
  const [yy, mm, dd] = isoDate.split("-");
  const m = MONTHS_RU_SHORT[Math.max(0, Math.min(11, Number(mm) - 1))] || mm;
  return `${Number(dd)} ${m}`;
}

function headerTitleForIso(isoDate){
  if (!isoDate) return "Без даты";
  const d = new Date(isoDate + "T00:00:00");
  const wd = WEEKDAYS_RU[d.getDay()] || "";
  return `${wd}, ${relLabelForIso(isoDate)}`;
}

const bucket = (s) => {
  if (!s) return "Без даты";
  const t = iso(new Date());
  const tm = iso(addDays(new Date(), 1));
  if (s === t) return "Сегодня";
  if (s === tm) return "Завтра";
  if (s < t) return "Просрочено";
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
  document.body.dataset.view = state.view;

  applyModules();

  // Sidebar behavior
  if (isDesktop()) {
    $("drawerBackdrop").hidden = true;
    $("drawer").hidden = state.module !== "tasks";
  } else {
    // mobile: sidebar is overlay only in tasks module
    if (state.module !== "tasks") {
      const d = $("drawer");
      const b = $("drawerBackdrop");
      d && d.classList.remove("open");
      b && b.classList.remove("open");
      d && (d.hidden = true);
      b && (b.hidden = true);
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

  // Add is disabled for smart views like Completed/Trash
  const allowAdd = !(state.activeKind === "smart" && (state.activeId === "completed" || state.activeId === "trash"));

  // Mobile composer only (desktop uses top add bar like TickTick)
  $("composer").style.display = (!isDesktop() && state.view === "tasks" && allowAdd) ? "flex" : "none";
  const dab = $("deskAddbar");
  if (dab) dab.hidden = !(isDesktop() && state.view === "tasks" && allowAdd);

  // Active rail
  document.querySelectorAll(".rail-item[data-module]").forEach((b) => {
    b.classList.toggle("active", b.dataset.module === state.module);
  });

  // Calendar title
  if (state.view === "calendar") {
    $("pageTitle").textContent = MONTHS_RU[state.calendarCursor.getMonth()];
    $("calTitle").textContent = MONTHS_RU[state.calendarCursor.getMonth()];
  }

  // Pane header/sub only for list view on desktop (closer to TickTick)
  if ($("paneHead")) $("paneHead").hidden = !(isDesktop() && state.view === 'tasks' && state.activeKind === 'list');
  if ($("paneSub")) $("paneSub").hidden = !(isDesktop() && state.view === 'tasks' && state.activeKind === 'list');
}

function applyModules() {
  const mods = settings.modules || { calendar: true, search: true, summary: true };
  // rail
  document.querySelectorAll('.rail-item[data-module="calendar"]').forEach((b) => b.hidden = !mods.calendar);
  document.querySelectorAll('.rail-item[data-module="search"]').forEach((b) => b.hidden = !mods.search);
  // drawer smart items
  document.querySelectorAll('.drawer-item[data-kind="smart"][data-id="summary"]').forEach((b) => b.hidden = !mods.summary);
  // right panel
  if (!mods.summary && state.view === 'summary') {
    // fall back to tasks if summary disabled
    state.activeId = 'all';
    state.activeKind = 'smart';
    state.view = 'tasks';
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
  const d = $("drawer");
  const b = $("drawerBackdrop");
  if (!d || !b) return;
  d.hidden = false;
  b.hidden = false;
  requestAnimationFrame(() => {
    d.classList.add("open");
    b.classList.add("open");
  });
}
function closeDrawer() {
  if (isDesktop()) return;
  const d = $("drawer");
  const b = $("drawerBackdrop");
  if (!d || !b) return;
  d.classList.remove("open");
  b.classList.remove("open");
  setTimeout(() => {
    d.hidden = true;
    b.hidden = true;
  }, 190);
}

function updatePageTitle() {
  if (state.view !== "tasks") return;
  if (state.activeKind === "tag") {
    base.tag = state.activeId;
    done.tag = state.activeId;
  }

  if (state.activeKind === "smart") {
    if (state.activeId === "all") $("pageTitle").textContent = "Все";
    else if (state.activeId === "today") $("pageTitle").textContent = "Сегодня";
    else if (state.activeId === "next7") $("pageTitle").textContent = "Следующие 7";
    else if (state.activeId === "inbox") $("pageTitle").textContent = "Входящие";
    else if (state.activeId === "completed") $("pageTitle").textContent = "Выполнено";
    else if (state.activeId === "trash") $("pageTitle").textContent = "Корзина";
    else if (state.activeId === "day" && state.smartDue) $("pageTitle").textContent = fmtDueLong(state.smartDue);
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
  if (el) {
    if (state.activeKind === 'list' && state.composer.sectionId) {
      const sid = state.composer.sectionId;
      const sec = (state.sections || []).find((s) => s.id === sid) || null;
      const secName = sec?.title || 'секцию';
      el.placeholder = `+ Добавить задачу в "${name}" / ${secName}`;
    } else {
      el.placeholder = `+ Добавить задачу в "${name}"`;
    }
  }
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


function renderTags() {
  const el = $("tagsContainer");
  if (!el) return;
  el.innerHTML = "";

  const tags = Array.isArray(state.tags) ? state.tags : [];
  if (!tags.length) {
    const d = document.createElement('div');
    d.className = 'hint-card';
    d.textContent = 'Пока нет меток';
    el.appendChild(d);
    return;
  }

  for (const it of tags.slice(0, 30)) {
    const b = document.createElement('button');
    b.className = 'drawer-item';
    b.dataset.kind = 'tag';
    b.dataset.id = it.tag;
    b.innerHTML = `<span class="di-emoji"><svg class="ico sm"><use href="#i-tag"></use></svg></span><span class="di-title">#${it.tag}</span><span class="di-count">${it.count}</span>`;
    b.classList.toggle('active', state.activeKind === 'tag' && state.activeId === it.tag);
    b.addEventListener('click', () => setActive('tag', it.tag));
    el.appendChild(b);
  }
}
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
    row.dataset.folder = l.folderId || "";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.innerHTML = `<span class="di-handle" aria-hidden="true">⋮⋮</span><span class="di-emoji">${l.emoji || "📌"}</span><span class="di-title">${l.title}</span><span class="di-count" data-count="${l.id}">—</span><button class="di-more" type="button" aria-label="Управление">⋯</button>`;

    row.addEventListener("click", () => setActive("list", l.id));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActive("list", l.id); }
    });

    row.querySelector(".di-more")?.addEventListener("click", (e) => { e.stopPropagation(); openEditList(l.id); });

    // drag & drop reorder in sidebar (desktop)
    row.draggable = isDesktop();
    row.addEventListener("dragstart", (e) => {
      state.draggingListId = l.id;
      row.classList.add("dragging");
      e.dataTransfer.setData("text/plain", l.id);
      e.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      state.draggingListId = null;
    });
    return row;
  };

  const renderFolder = (fid, listsArr) => {
    const group = document.createElement("div");
    group.className = "drawer-group";
    group.dataset.fid = fid || "";

    if (fid) {
      const f = folderMap.get(fid);
      const head = document.createElement("div");
      head.className = "folder-head";
      const chev = state.folderCollapsed.has(fid)
        ? '<svg class="ico sm"><use href="#i-chevron-right"></use></svg>'
        : '<svg class="ico sm"><use href="#i-chevron-down"></use></svg>';
      head.innerHTML = `<span class="di-handle" aria-hidden="true">⋮⋮</span><span class="di-emoji">${(f?.emoji) || "📁"}</span><span class="fh-title">${(f?.title) || "Папка"}</span><span class="fh-count" data-folder-count="${fid}">—</span><span class="fh-chevron">${chev}</span><button class="di-more" type="button" aria-label="Управление">⋯</button>`;
      head.addEventListener("click", () => {
        state.folderCollapsed.has(fid) ? state.folderCollapsed.delete(fid) : state.folderCollapsed.add(fid);
        saveCollapse();
        renderLists();
        refreshCounts();
      });
      head.querySelector(".di-more")?.addEventListener("click", (e) => { e.stopPropagation(); openEditFolder(fid); });

      // drag folder group (desktop)
      head.draggable = isDesktop();
      head.addEventListener("dragstart", (e) => {
        state.draggingFolderId = fid;
        group.classList.add("folder-dragging");
        e.dataTransfer.setData("text/plain", fid);
        e.dataTransfer.effectAllowed = "move";
      });
      head.addEventListener("dragend", () => {
        group.classList.remove("folder-dragging");
        state.draggingFolderId = null;
      });
      group.appendChild(head);
    }

    const wrap = document.createElement("div");
    wrap.className = "folder-lists";
    wrap.dataset.fid = fid || "";
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

  setupSidebarDnD();
}

function sidebarListOrder() {
  const el = $("listsContainer");
  if (!el) return [];
  const ids = [];
  el.querySelectorAll('.drawer-group .drawer-item[data-kind="list"]').forEach((row) => {
    const id = row.dataset.id;
    if (id) ids.push(id);
  });
  return ids;
}

function sidebarFolderOrder() {
  const el = $("listsContainer");
  if (!el) return [];
  const ids = [];
  el.querySelectorAll('.drawer-group[data-fid]').forEach((g) => {
    const fid = g.dataset.fid;
    if (fid) ids.push(fid);
  });
  return ids;
}

function getAfterSidebar(container, y, selector) {
  const els = [...container.querySelectorAll(selector)].filter((x) => !x.classList.contains('dragging') && !x.classList.contains('folder-dragging'));
  let best = { o: -1e9, el: null };
  for (const el of els) {
    const b = el.getBoundingClientRect();
    const off = y - b.top - b.height / 2;
    if (off < 0 && off > best.o) best = { o: off, el };
  }
  return best.el;
}

function setupSidebarDnD() {
  const root = $("listsContainer");
  if (!root) return;

  // Folder reorder (drag the folder head)
  root.querySelectorAll('.drawer-group[data-fid]').forEach((g) => {
    const fid = g.dataset.fid;
    if (!fid) return;
    g.addEventListener('dragover', (e) => {
      if (!state.draggingFolderId) return;
      e.preventDefault();
      const drag = root.querySelector('.drawer-group.folder-dragging');
      if (!drag) return;
      const after = getAfterSidebar(root, e.clientY, '.drawer-group[data-fid]');
      if (!after) root.appendChild(drag);
      else root.insertBefore(drag, after);
    });
  });

  root.addEventListener('drop', async (e) => {
    if (!state.draggingFolderId) return;
    e.preventDefault();
    const ordered = sidebarFolderOrder();
    try { if (ordered.length) await apiReorderFolders({ orderedIds: ordered }); } catch (_) {}
    state.draggingFolderId = null;
    await loadMeta();
    await refreshCounts();
  });

  // List reorder + move between folders
  root.querySelectorAll('.folder-lists').forEach((wrap) => {
    wrap.addEventListener('dragover', (e) => {
      if (!state.draggingListId) return;
      e.preventDefault();
      const drag = root.querySelector('.drawer-item.dragging');
      if (!drag) return;
      const after = getAfterSidebar(wrap, e.clientY, '.drawer-item[data-kind="list"]');
      if (!after) wrap.appendChild(drag);
      else wrap.insertBefore(drag, after);
    });

    wrap.addEventListener('drop', async (e) => {
      if (!state.draggingListId) return;
      e.preventDefault();
      const listId = state.draggingListId;
      const targetFolder = wrap.dataset.fid || "";
      const l = state.lists.find((x) => x.id === listId);
      const fromFolder = l?.folderId || "";
      if (l && fromFolder !== targetFolder) {
        try {
          await apiPatchList(listId, { folderId: targetFolder || null });
        } catch (_) {}
      }
      const ordered = sidebarListOrder();
      try { if (ordered.length) await apiReorderLists({ orderedIds: ordered }); } catch (_) {}
      state.draggingListId = null;
      await loadMeta();
      await refreshCounts();
    });
  });
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

async function ensureSectionsForList(listId) {
  const lid = (listId || '').trim();
  if (!lid) return [];
  if (state.sectionsCache[lid]) return state.sectionsCache[lid];
  try {
    const secs = await apiGetSections({ list_id: lid });
    state.sectionsCache[lid] = secs || [];
    return state.sectionsCache[lid];
  } catch {
    state.sectionsCache[lid] = [];
    return [];
  }
}

function fillSectionSelect(selectEl, sectionsArr, selectedId) {
  if (!selectEl) return;
  selectEl.innerHTML = '';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = 'несгруппированный';
  selectEl.appendChild(opt0);
  (sectionsArr || []).forEach((s) => {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.title;
    selectEl.appendChild(o);
  });
  selectEl.value = selectedId || '';
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
  on(card, "dragstart", (e) => {
    li.classList.add("dragging");
    const wrap = li.closest('[data-section-wrap]');
    const sec = wrap ? (wrap.dataset.section || '') : '';
    state.draggingTask = { id, fromSection: sec };
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  });
  on(card, "dragend", () => { li.classList.remove("dragging"); state.draggingTask = null; });
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

function getAfterSection(container, y) {
  const els = [...container.querySelectorAll('section[data-section-wrap]')].filter((el) => !el.classList.contains('sec-dragging'));
  let best = { o: -1e9, el: null };
  for (const el of els) {
    const b = el.getBoundingClientRect();
    const off = y - b.top - b.height / 2;
    if (off < 0 && off > best.o) best = { o: off, el };
  }
  return best.el;
}

function setupSectionDrop() {
  if (!(settings.sort === 'manual' && state.activeKind === 'list')) return;
  const groups = $('groups');
  if (!groups) return;
  on(groups, 'dragover', (e) => {
    if (!state.draggingSectionId) return;
    e.preventDefault();
    const drag = document.querySelector('section.sec-dragging');
    if (!drag) return;
    const after = getAfterSection(groups, e.clientY);
    if (!after) groups.appendChild(drag);
    else groups.insertBefore(drag, after);
  });

  on(groups, 'drop', async (e) => {
    if (!state.draggingSectionId) return;
    e.preventDefault();
    const ids = [...groups.querySelectorAll('section[data-section-wrap]')].map((sec) => sec.dataset.section).filter((id) => id);
    if (ids.length) {
      try { await apiReorderSections({ orderedIds: ids }); } catch (_) {}
      await loadTasks();
    }
    state.draggingSectionId = null;
  });
}

async function persistOrder(sectionId) {
  if (!(settings.sort === "manual" && state.activeKind === "list")) return;
  const sid = sectionId || "";
  const ul = [...document.querySelectorAll('#groups .tasks')].find((u) => (u.dataset.section || '') === sid);
  const ids = ul ? [...ul.querySelectorAll('.task')].map((x) => x.dataset.id).filter(Boolean) : [];
  if (!ids.length) return;
  await apiReorder({ listId: state.activeId, sectionId: sid ? sid : null, orderedIds: ids });
}


function setupDrop() {
  if (!(settings.sort === "manual" && state.activeKind === "list")) return;
  document.querySelectorAll('#groups .tasks').forEach((ul) => {
    on(ul, 'dragover', (e) => {
      e.preventDefault();
      const drag = document.querySelector('.task.dragging');
      if (!drag) return;
      const after = getAfter(ul, e.clientY);
      if (!after) ul.appendChild(drag);
      else ul.insertBefore(drag, after);
    });

    on(ul, 'drop', async (e) => {
      e.preventDefault();
      const sid = ul.dataset.section || '';
      const info = state.draggingTask;
      const draggedId = info?.id || e.dataTransfer.getData('text/plain');
      const from = info?.fromSection || '';

      if (draggedId && from !== sid) {
        try { await apiPatchTask(draggedId, { sectionId: sid || '' }); } catch (_) {}
        try { await persistOrder(from); } catch (_) {}
      }
      try { await persistOrder(sid); } catch (_) {}
      await loadTasks();
    });
  });
}

// Task row
function taskRow(t) {
  const li = document.createElement("li");
  const isTrashMode = (state.activeKind === "smart" && state.activeId === "trash") || !!t.trashed;
  const isCompletedMode = (state.activeKind === "smart" && state.activeId === "completed");

  li.className = "task" + ((!isTrashMode && t.completed) ? " completed" : "") + (state.selectedTaskId === t.id ? " selected" : "");
  if (isTrashMode) li.classList.add("trashed");
  li.dataset.id = t.id;

  const actions = document.createElement("div");
  actions.className = "swipe-actions";

  const ok = document.createElement("button");
  ok.className = "action-btn complete";
  ok.textContent = isTrashMode ? "↩" : (t.completed ? "↩" : "✓");

  const del = document.createElement("button");
  del.className = "action-btn delete";
  del.innerHTML = '<svg class="ico sm"><use href="#i-trash"></use></svg>';

  actions.appendChild(ok);
  actions.appendChild(del);

  const card = document.createElement("div");
  card.className = "task-card";

  const cb = document.createElement("div");
  cb.className = "checkbox" + ((!isTrashMode && t.completed) ? " checked" : "");
  if (isTrashMode) cb.classList.remove("checked"); // trash isn't a completion state

  const main = document.createElement("div");
  main.className = "task-main";

  const title = document.createElement("div");
  title.className = "task-title";
  if (!isTrashMode && (t.priority || 0) > 0) {
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
  if (list && !isTrashMode) {
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

  // Right column labels (TickTick-like)
  if (isDesktop()) {
    if (!isTrashMode) {
      const rn = document.createElement("span");
      rn.className = "rm-list";
      rn.textContent = list?.title || "Входящие";
      due.appendChild(rn);
    }

    // date label
    let label = "";
    let cls = "";
    if (isTrashMode) {
      label = relLabelForIso(isoFromTs(t.trashedAt));
      cls = "trash-date";
    } else if (t.completed && t.completedAt) {
      label = relLabelForIso(isoFromTs(t.completedAt));
      cls = "done-date";
    } else {
      label = fmtDueShort(t.dueDate) || "";
      cls = "rm-due";
    }

    if (label) {
      const rd = document.createElement("span");
      rd.className = "rm-due" + (cls ? ` ${cls}` : "");
      rd.textContent = label;

      // due styling for active tasks
      if (!t.completed && !isTrashMode && t.dueDate) {
        const today = iso(new Date());
        if (t.dueDate < today) rd.classList.add('due-over');
        if (t.dueDate === today) rd.classList.add('due-today');
      }
      due.appendChild(document.createTextNode(isTrashMode ? "" : " "));
      due.appendChild(rd);
    }
  } else {
    // mobile: show compact date only
    if (isTrashMode) due.textContent = relLabelForIso(isoFromTs(t.trashedAt));
    else if (t.completed && t.completedAt) due.textContent = relLabelForIso(isoFromTs(t.completedAt));
    else due.textContent = fmtDueShort(t.dueDate);
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

  const doRestore = async () => {
    await apiPatchTask(t.id, { trashed: false });
    closeOpenSwipe();
    await refreshCounts();
    await loadTasks();
  };

  const doTrashOrDelete = async () => {
    if (isTrashMode) {
      if (!confirm("Удалить навсегда?")) return;
      await apiDeleteTask(t.id, { hard: true });
    } else {
      if (!confirm("Переместить в корзину?")) return;
      await apiDeleteTask(t.id);
    }
    closeOpenSwipe();
    await refreshCounts();
    await loadTasks();
  };

  const doToggleComplete = async () => {
    await apiPatchTask(t.id, { completed: !t.completed });
    closeOpenSwipe();
    await refreshCounts();
    await loadTasks();
  };

  on(ok, "click", async (e) => { e.stopPropagation(); isTrashMode ? await doRestore() : await doToggleComplete(); });
  on(del, "click", async (e) => { e.stopPropagation(); await doTrashOrDelete(); });
  on(cb, "click", async (e) => { e.stopPropagation(); isTrashMode ? await doRestore() : await doToggleComplete(); });
  on(bD, "click", async (e) => { e.stopPropagation(); await doTrashOrDelete(); });
  on(bE, "click", (e) => { e.stopPropagation(); openTask(t); });
  on(card, "click", () => openTask(t));

  if (settings.sort === "manual" && state.activeKind === "list" && !t.completed && !isTrashMode) enableDrag(li, card, t.id);
  return li;
}


function secKey(id){ return id ? ("sec:"+id) : "sec:"; }

function groupTasks(ts) {
  if (settings.sort === "manual") return [{ key: "all", title: "Все", items: ts }];
  const m = new Map();
  ts.forEach((t) => { const k = bucket(t.dueDate); if (!m.has(k)) m.set(k, []); m.get(k).push(t); });
  const order = ["Просрочено", "Сегодня", "Завтра", "Позже", "Без даты"];
  return order.filter((k) => m.has(k)).map((k) => ({ key: k, title: k, items: m.get(k) }));
}

function groupCompleted(ts) {
  // Group completed tasks by completion day (UTC timestamp stored, shown in local date)
  const m = new Map(); // isoDate -> items
  for (const t of (ts || [])) {
    const d = isoFromTs(t.completedAt);
    const k = d || "";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  const keys = [...m.keys()].filter(Boolean).sort().reverse();
  const out = [];
  for (const k of keys) {
    out.push({ key: k, title: headerTitleForIso(k), items: m.get(k) });
  }
  if (m.has("")) {
    out.push({ key: "", title: "Без даты", items: m.get("") });
  }
  return out;
}

function renderListWithSections(groupsEl) {
  const bySec = new Map();
  for (const t of state.tasks) {
    const k = t.sectionId || '';
    if (!bySec.has(k)) bySec.set(k, []);
    bySec.get(k).push(t);
  }

  const secs = (state.sections || []).slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const ordered = [''].concat(secs.map((x) => x.id));

  for (const sid of ordered) {
    const items = bySec.get(sid) || [];

    const title = sid === '' ? 'несгруппированный' : (secs.find((x) => x.id === sid)?.title || 'Секция');
    const key = secKey(sid);

    const wrap = document.createElement('section');
    wrap.dataset.sectionWrap = '1';
    wrap.dataset.section = sid;

    const head = document.createElement('div');
    head.className = 'sec-head';
    const chev = state.sectionCollapsed.has(key)
      ? '<svg class="ico sm"><use href="#i-chevron-right"></use></svg>'
      : '<svg class="ico sm"><use href="#i-chevron-down"></use></svg>';
    head.innerHTML = `
      <button class="sec-toggle" type="button" aria-label="Свернуть/развернуть">${chev}</button>
      <div class="sec-title">${title}</div>
      <div class="sec-count">${items.length}</div>
      <div class="sec-actions">
        <button class="icon-btn icon-btn-sm sec-add" type="button" title="Добавить задачу"><svg class="ico sm"><use href="#i-plus"></use></svg></button>
        ${sid ? '<button class="icon-btn icon-btn-sm sec-more" type="button" aria-label="Ещё">⋯</button>' : ''}
      </div>
    `;

    head.querySelector('.sec-toggle').addEventListener('click', () => {
      state.sectionCollapsed.has(key) ? state.sectionCollapsed.delete(key) : state.sectionCollapsed.add(key);
      saveCollapse();
      render();
    });

    head.querySelector('.sec-add')?.addEventListener('click', (e) => {
      e.stopPropagation();
      state.composer.sectionId = sid || null;
      updateAddPlaceholder();
      $("deskAddInput")?.focus?.();
    });

    if (sid) {
      // drag section (manual)
      if (settings.sort === 'manual' && isDesktop()) {
        head.draggable = true;
        head.addEventListener('dragstart', (e) => {
          state.draggingSectionId = sid;
          wrap.classList.add('sec-dragging');
          e.dataTransfer.setData('text/plain', sid);
          e.dataTransfer.effectAllowed = 'move';
        });
        head.addEventListener('dragend', () => {
          wrap.classList.remove('sec-dragging');
          state.draggingSectionId = null;
        });
      }

      head.querySelector('.sec-title').addEventListener('dblclick', async () => {
        const cur = secs.find((x) => x.id === sid);
        const name = prompt('Название секции', cur?.title || '');
        if (name === null) return;
        const t = name.trim();
        if (!t) return;
        await apiPatchSection(sid, { title: t });
        await loadTasks();
      });

      head.querySelector('.sec-more')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = prompt('Секция: 1) переименовать  2) удалить', '1');
        if (act === '2') {
          if (!confirm('Удалить секцию? Задачи перейдут в несгруппированный.')) return;
          await apiDeleteSection(sid);
          await loadTasks();
          return;
        }
        if (act === '1') {
          const cur = secs.find((x) => x.id === sid);
          const name = prompt('Название секции', cur?.title || '');
          if (name === null) return;
          const t = name.trim();
          if (!t) return;
          await apiPatchSection(sid, { title: t });
          await loadTasks();
        }
      });
    }

    const ul = document.createElement('ul');
    ul.className = 'tasks';
    ul.dataset.section = sid;

    if (!state.sectionCollapsed.has(key)) {
      items.forEach((t) => ul.appendChild(taskRow(t)));
    }

    wrap.appendChild(head);
    wrap.appendChild(ul);
    groupsEl.appendChild(wrap);
  }
}

function render() {
  const groups = $("groups");
  const done = $("completedTasks");
  const empty = $("emptyState");
  const completedHead = $("completedHead");

  const mode = (state.activeKind === "smart" && state.activeId === "completed") ? "completed"
    : (state.activeKind === "smart" && state.activeId === "trash") ? "trash"
    : "normal";

  groups.innerHTML = "";
  done.innerHTML = "";

  // Pane header (TickTick-like)
  if ($("paneTitle")) {
    $("paneTitle").textContent = $("pageTitle")?.textContent || "";
    $("paneCount").textContent = String(state.tasks.length);
  }

  // Empty state
  const hasAny = (state.tasks.length + state.done.length) > 0;
  empty.hidden = hasAny;

  if (mode === "trash") {
    // Flat list, like TickTick Trash
    if (completedHead) completedHead.hidden = true;
    done.hidden = true;

    const ul = document.createElement("ul");
    ul.className = "tasks";
    ul.dataset.section = "";
    state.tasks.forEach((t) => ul.appendChild(taskRow(t)));
    groups.appendChild(ul);

    // No drag & drop in trash
    renderTaskEditor();
    return;
  }

  if (mode === "completed") {
    // Group by completion day (Today/Yesterday/...)
    if (completedHead) completedHead.hidden = true;
    done.hidden = true;

    const grouped = groupCompleted(state.tasks);
    grouped.forEach((g) => {
      const sec = document.createElement('section');
      const head = document.createElement('button');
      head.className = 'section-head';
      const key = "done:" + g.key;
      const chev = state.collapsed.has(key)
        ? '<svg class="ico sm"><use href="#i-chevron-right"></use></svg>'
        : '<svg class="ico sm"><use href="#i-chevron-down"></use></svg>';
      head.innerHTML = `
        <span class="sh-chev">${chev}</span>
        <span class="sh-title">${g.title}</span>
        <span class="sh-count">${g.items.length}</span>
      `;
      head.addEventListener('click', () => {
        state.collapsed.has(key) ? state.collapsed.delete(key) : state.collapsed.add(key);
        saveCollapse();
        render();
      });

      const ul = document.createElement('ul');
      ul.className = 'tasks';
      ul.dataset.section = '';
      if (!state.collapsed.has(key)) g.items.forEach((t) => ul.appendChild(taskRow(t)));

      sec.appendChild(head);
      sec.appendChild(ul);
      groups.appendChild(sec);
    });

    renderTaskEditor();
    return;
  }

  // NORMAL mode (active + completed section)
  if (completedHead) completedHead.hidden = false;
  done.hidden = false;

  if (state.activeKind === 'list') {
    renderListWithSections(groups);
  } else {
    groupTasks(state.tasks).forEach((g) => {
      const sec = document.createElement('section');
      const head = document.createElement('button');
      head.className = 'section-head';
      const chev = state.collapsed.has(g.key)
        ? '<svg class="ico sm"><use href="#i-chevron-right"></use></svg>'
        : '<svg class="ico sm"><use href="#i-chevron-down"></use></svg>';
      head.innerHTML = `
        <span class="sh-chev">${chev}</span>
        <span class="sh-title">${g.title}</span>
        <span class="sh-count">${g.items.length}</span>
      `;
      head.addEventListener('click', () => {
        state.collapsed.has(g.key) ? state.collapsed.delete(g.key) : state.collapsed.add(g.key);
        saveCollapse();
        render();
      });

      const ul = document.createElement('ul');
      ul.className = 'tasks';
      ul.dataset.section = '';
      if (!state.collapsed.has(g.key)) g.items.forEach((t) => ul.appendChild(taskRow(t)));

      sec.appendChild(head);
      sec.appendChild(ul);
      groups.appendChild(sec);
    });
  }

  $("completedCount").textContent = String(state.done.length);
  $("completedChevron").textContent = state.doneCollapsed ? "▸" : "▾";
  if (!state.doneCollapsed) state.done.forEach((t) => done.appendChild(taskRow(t)));

  setupDrop();
  setupSectionDrop();

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

  // Special smart views
  if (state.activeKind === 'smart' && state.activeId === 'completed') {
    const params = { filter: 'completed', sort: 'completed' };
    if (q) params.q = q;
    state.tasks = await apiGetTasks(params);
    state.done = [];
    state.sections = [];
    render();
    return;
  }
  if (state.activeKind === 'smart' && state.activeId === 'trash') {
    const params = { filter: 'trash', sort: 'trashed' };
    if (q) params.q = q;
    state.tasks = await apiGetTasks(params);
    state.done = [];
    state.sections = [];
    render();
    return;
  }
  if (state.activeKind === "tag") {
    base.tag = state.activeId;
    done.tag = state.activeId;
  }

  if (state.activeKind === "smart") {
    if (state.activeId === "today") { base.due = today; done.due = today; }
    if (state.activeId === "day" && state.smartDue) { base.due = state.smartDue; done.due = state.smartDue; }
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
  if (state.activeKind === "list") {
    try {
      state.sections = await apiGetSections({ list_id: state.activeId });
    } catch {
      state.sections = [];
    }
    // keep cache in sync for editor dropdowns
    state.sectionsCache[state.activeId] = state.sections || [];
  } else {
    state.sections = [];
  }
  render();
}

async function refreshCounts() {
  const data = await apiGetCounts();
  const byList = data.byList || {};

  const byFolder = {};
  for (const l of state.lists) {
    const c = Number(byList[l.id] || 0);
    document.querySelector(`[data-count="${l.id}"]`)?.replaceChildren(document.createTextNode(String(c)));
    if (l.folderId) byFolder[l.folderId] = (byFolder[l.folderId] || 0) + c;
  }

  for (const f of state.folders) {
    const c = Number(byFolder[f.id] || 0);
    document.querySelector(`[data-folder-count="${f.id}"]`)?.replaceChildren(document.createTextNode(String(c)));
  }

  $("countAll").textContent = String(data.activeTotal ?? 0);
  $("countToday").textContent = String(data.today ?? 0);
  $("countNext7").textContent = String(data.next7 ?? 0);
  $("countInbox").textContent = String(data.inbox ?? 0);
  $("countCompleted") && ($("countCompleted").textContent = String(data.completedTotal ?? 0));
  $("countTrash") && ($("countTrash").textContent = String(data.trashTotal ?? 0));

  await loadTags();
}

async function loadTags() {
  try {
    state.tags = await apiGetTags({ include_completed: "0" });
  } catch {
    state.tags = [];
  }
  renderTags();
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
  if (t.trashed) {
    $("btnTaskToggle").textContent = "Восстановить";
    $("btnTaskToggle").dataset.mode = "restore";
  } else {
    $("btnTaskToggle").textContent = t.completed ? "Вернуть" : "Готово";
    $("btnTaskToggle").dataset.mode = "toggle";
    $("btnTaskToggle").dataset.completed = t.completed ? "1" : "0";
  }
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

  // Section label (may require async cache fill)
  $("teSectionText").textContent = t.sectionId ? "…" : "несгруппированный";
  ensureSectionsForList(t.listId).then((secs) => {
    if (state.selectedTaskId !== t.id) return;
    const s = t.sectionId ? secs.find((x) => x.id === t.sectionId) : null;
    $("teSectionText").textContent = s?.title || "несгруппированный";
  });

  // Visual hint on buttons
  $("tePriority")?.classList.toggle("active", Number(t.priority || 0) > 0);
  $("teTags")?.classList.toggle("active", (t.tags || []).length > 0);
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

  // If user clicked "＋" on a section header, we add into that section.
  const sectionId = (state.activeKind === "list") ? (state.composer.sectionId || null) : null;

  await apiCreateTask({ title: p.title, listId, sectionId, dueDate: due || null, tags: p.tags, priority, notes: null });
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
  state.composer.sectionId = null;
  updateAddPlaceholder();
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

async function ensureCalendarTasksRange(due_from, due_to, key) {
  if (state.calendarRangeKey === key) return;
  state.calendarTasks = await apiGetTasks({ filter: 'active', sort: 'due', due_from, due_to });
  state.calendarRangeKey = key;
}


async function ensureCalendarTasks() {
  // Month range by default
  const key = monthRangeKey(state.calendarCursor);
  if (state.calendarRangeKey === key) return;

  const first = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth(), 1);
  const last = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() + 1, 0);
  await ensureCalendarTasksRange(iso(first), iso(last), key);
}



async function renderCalendar() {
  if (state.view !== "calendar") return;

  const grid = $("calGrid");
  if (!grid) return;
  grid.innerHTML = "";
  grid.classList.remove("cal-weekview", "cal-dayview");

  const todayIso = iso(new Date());

  // Week header labels respect settings.weekStart
  const ws = (settings.weekStart || 'mon') === 'sun' ? 0 : 1;
  const labels = ws === 0
    ? ['Вск.','Пон.','Втр.','Срд.','Чтв.','Птн.','Сбт.']
    : ['Пон.','Втр.','Срд.','Чтв.','Птн.','Сбт.','Вск.'];
  document.querySelectorAll('.cal-head .cal-week').forEach((el, i) => { if (labels[i]) el.textContent = labels[i]; });

  // Decide range by view
  if (state.calendarView === 'month') {
    await ensureCalendarTasks();

    const y = state.calendarCursor.getFullYear();
    const m = state.calendarCursor.getMonth();
    $("pageTitle").textContent = MONTHS_RU[m];
    $("calTitle").textContent = `${MONTHS_RU[m]} ${y}`;
    $("calViewBtn").textContent = 'Месяц ▾';

    const first = new Date(y, m, 1);
    const start = new Date(first);
    const ws = (settings.weekStart || 'mon') === 'sun' ? 0 : 1;
    const shift = (first.getDay() - ws + 7) % 7;
    start.setDate(first.getDate() - shift);

    const tasksByDate = new Map();
    for (const t of state.calendarTasks) {
      if (!t.dueDate) continue;
      if (!tasksByDate.has(t.dueDate)) tasksByDate.set(t.dueDate, []); tasksByDate.get(t.dueDate).push(t);
    }

    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i);
      const dayIso = iso(day);
      const cell = document.createElement('div');
      cell.className = 'cal-cell' + (dayIso === todayIso ? ' today' : '');

      const head = document.createElement('div');
      head.className = 'cal-day' + (day.getMonth() !== m ? ' muted' : '') + (dayIso === todayIso ? ' today' : '');
      head.textContent = String(day.getDate());
      cell.appendChild(head);

      const events = document.createElement('div');
      events.className = 'cal-events';

      const tasks = (tasksByDate.get(dayIso) || []).slice().sort((a,b)=>(a.title||'').localeCompare(b.title||''));
      for (const t of tasks.slice(0,4)) {
        const ev = document.createElement('div');
        ev.className = 'cal-event';
        const col = colorForList(t.listId || state.system.inboxId || 'inbox');
        ev.style.borderLeftColor = col;
        ev.textContent = t.title;
        ev.addEventListener('click', (e)=>{ e.stopPropagation(); openTask(t); });
        events.appendChild(ev);
      }
      if (tasks.length > 4) {
        const more = document.createElement('div');
        more.className = 'cal-more';
        more.textContent = `ещё ${tasks.length-4}`;
        events.appendChild(more);
      }

      cell.appendChild(events);
      cell.addEventListener('click', ()=>{
        state.calendarView = 'day';
        state.calendarCursor = new Date(day);
        state.calendarRangeKey = '';
        renderCalendar();
      });
      grid.appendChild(cell);
    }
    return;
  }

  // Week/day: render 7 columns or one column list
  const base = state.calendarCursor instanceof Date ? state.calendarCursor : new Date();
  const start = new Date(base);
  if (state.calendarView === 'week') {
    const ws = (settings.weekStart || 'mon') === 'sun' ? 0 : 1;
    const shift = (base.getDay() - ws + 7) % 7;
    start.setDate(base.getDate() - shift);
  } else {
    // day
    start.setDate(base.getDate());
  }

  const from = iso(start);
  const to = iso(state.calendarView === 'week' ? addDays(start, 6) : start);
  const key = `${state.calendarView}:${from}:${to}`;
  await ensureCalendarTasksRange(from, to, key);

  if (state.calendarView === 'week') {
    $("calViewBtn").textContent = 'Неделя ▾';
    $("pageTitle").textContent = 'Календарь';
    $("calTitle").textContent = `${fmtDueShort(from)} — ${fmtDueShort(to)}`;

    grid.classList.add('cal-weekview');
    for (let i=0;i<7;i++) {
      const day = addDays(start, i);
      const dayIso = iso(day);
      const cell = document.createElement('div');
      cell.className = 'cal-cell' + (dayIso === todayIso ? ' today' : '');
      const head = document.createElement('div');
      head.className = 'cal-day' + (dayIso === todayIso ? ' today' : '');
      head.textContent = `${['Вск','Пон','Втр','Срд','Чтв','Птн','Сбт'][day.getDay()]} ${day.getDate()}`;
      cell.appendChild(head);

      const events = document.createElement('div');
      events.className='cal-events';
      const tasks = state.calendarTasks.filter((t)=>t.dueDate===dayIso);
      for (const t of tasks.slice(0,6)) {
        const ev=document.createElement('div');
        ev.className='cal-event';
        ev.style.borderLeftColor=colorForList(t.listId||state.system.inboxId||'inbox');
        ev.textContent=t.title;
        ev.addEventListener('click',(e)=>{e.stopPropagation();openTask(t);});
        events.appendChild(ev);
      }
      cell.appendChild(events);
      cell.addEventListener('click', ()=>{ state.calendarView='day'; state.calendarCursor=new Date(day); state.calendarRangeKey=''; renderCalendar(); });
      grid.appendChild(cell);
    }
    return;
  }

  // day view
  grid.classList.add("cal-dayview");
  $("calViewBtn").textContent = 'День ▾';
  $("pageTitle").textContent = 'Календарь';
  $("calTitle").textContent = fmtDueLong(from);

  const wrap = document.createElement('div');
  wrap.className = 'cal-daylist';

  const tasks = state.calendarTasks.filter((t)=>t.dueDate===from);
  if (!tasks.length) {
    const em=document.createElement('div');
    em.className='empty';
    em.textContent='Нет задач на этот день';
    wrap.appendChild(em);
  } else {
    for (const t of tasks) {
      const row = document.createElement('div');
      row.className='cal-event';
      row.style.borderLeftColor=colorForList(t.listId||state.system.inboxId||'inbox');
      row.style.padding='10px 12px';
      row.textContent=t.title;
      row.addEventListener('click', ()=>openTask(t));
      wrap.appendChild(row);
    }
  }
  grid.appendChild(wrap);
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
  const start = (settings.weekStart || 'mon') === 'sun' ? 0 : 1;
  const diff = start === 1 ? ((day === 0 ? -6 : 1) - day) : (0 - day);
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

  // Используем completedAt (выполненные задачи за неделю)
  const done = await apiGetTasks({ filter: "completed", sort: "completed", completed_from: from, completed_to: to });

  const byDate = new Map();
  for (const t of done) {
    const k = isoFromTs(t.completedAt) || "";
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(t);
  }

  const keys = [...byDate.keys()].filter(Boolean).sort();

  let html = `<h2>${s.getDate()} ${MONTHS_RU[s.getMonth()].slice(0,3)}. - ${e.getDate()} ${MONTHS_RU[e.getMonth()].slice(0,3)}.</h2>`;
  html += `<p><b>Выполнено</b></p>`;

  for (const k of keys) {
    const [yy, mm, dd] = k.split("-");
    const m = MONTHS_RU_SHORT[Math.max(0, Math.min(11, Number(mm) - 1))] || mm;
    const label = `${Number(dd)} ${m}`;
    const items = byDate.get(k) || [];
    html += `<ul>`;
    for (const t of items) {
      html += `<li>[${label}] ${escapeHtml(t.title)}</li>`;
    }
    html += `</ul>`;
  }

  if (!keys.length) html += `<p class="muted">Нет выполненных задач за неделю</p>`;

  // Незавершено (задачи на неделе по dueDate)
  const todo = await apiGetTasks({ filter: "active", sort: "due", due_from: from, due_to: to });

  html += `<h3>Незавершено</h3>`;
  if (!todo.length) {
    html += `<p class="muted">Нет незавершенных задач за неделю</p>`;
  } else {
    html += `<ul>`;
    for (const t of todo) {
      const d = t.dueDate ? (() => { const [yy,mm,dd]=t.dueDate.split("-"); const m=MONTHS_RU_SHORT[Math.max(0, Math.min(11, Number(mm)-1))]||mm; return `${Number(dd)} ${m}`; })() : "Без даты";
      html += `<li>[${d}] ${escapeHtml(t.title)}</li>`;
    }
    html += `</ul>`;
  }

  $("summaryEditor").innerHTML = html;
  localStorage.setItem(SUMMARY_KEY, $("summaryEditor").innerHTML);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Stats (TickTick-like)
let _statsLoaded = false;
let _statsLastDays = 14;

function closeStatsModal() {
  $("statsBackdrop") && ($("statsBackdrop").hidden = true);
  $("statsModal") && ($("statsModal").hidden = true);
}

function openStatsModal() {
  $("statsBackdrop") && ($("statsBackdrop").hidden = false);
  $("statsModal") && ($("statsModal").hidden = false);
  const sel = $("statsRange");
  const days = sel ? Number(sel.value || 14) : 14;
  setTimeout(() => loadStats(days).catch(() => {}), 0);
}

function chartColors() {
  const cs = getComputedStyle(document.documentElement);
  const get = (k, fb) => (cs.getPropertyValue(k) || "").trim() || fb;
  return {
    line: get("--blue2", "#6aa3ff"),
    fill: get("--blue", "#2f7bff"),
    grid: get("--line", "rgba(255,255,255,.07)"),
    text: get("--muted", "rgba(255,255,255,.62)"),
    danger: get("--danger", "#ff4d4d"),
    bg: get("--panel2", "#232323"),
  };
}

function prepCanvas(canvas) {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, canvas.clientWidth || canvas.width || 300);
  const h = Math.max(10, canvas.getAttribute("height") ? Number(canvas.getAttribute("height")) : (canvas.clientHeight || 160));
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawLineChart(canvas, values, { yMax = null, fill = false } = {}) {
  const prep = prepCanvas(canvas);
  if (!prep) return;
  const { ctx, w, h } = prep;
  const col = chartColors();

  ctx.clearRect(0, 0, w, h);

  const padL = 32, padR = 12, padT = 10, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const vals = (values || []).map((v) => (v === null || v === undefined) ? 0 : Number(v));
  const maxV = yMax !== null ? yMax : Math.max(1, ...vals);

  // grid
  ctx.strokeStyle = col.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
  }

  // line
  const n = vals.length;
  if (!n) return;

  const xAt = (i) => padL + (plotW * (n === 1 ? 0 : i / (n - 1)));
  const yAt = (v) => padT + plotH - (plotH * (v / maxV));

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xAt(i);
    const y = yAt(vals[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = col.line;
  ctx.lineWidth = 2.2;
  ctx.stroke();

  if (fill) {
    ctx.lineTo(xAt(n - 1), padT + plotH);
    ctx.lineTo(xAt(0), padT + plotH);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    g.addColorStop(0, col.line + "55");
    g.addColorStop(1, col.line + "00");
    ctx.fillStyle = g;
    ctx.fill();
  }
}

function drawBarChart(canvas, values, { yMax = 100 } = {}) {
  const prep = prepCanvas(canvas);
  if (!prep) return;
  const { ctx, w, h } = prep;
  const col = chartColors();
  ctx.clearRect(0, 0, w, h);

  const padL = 32, padR = 12, padT = 10, padB = 24;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  // grid
  ctx.strokeStyle = col.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
  }

  const vals = (values || []).map((v) => (v === null || v === undefined) ? null : Number(v));
  const n = vals.length;
  if (!n) return;

  const gap = 6;
  const barW = Math.max(6, (plotW - gap * (n - 1)) / n);

  for (let i = 0; i < n; i++) {
    const v = vals[i];
    const x = padL + i * (barW + gap);
    if (v === null) {
      ctx.fillStyle = col.grid;
      ctx.fillRect(x, padT + plotH - 2, barW, 2);
      continue;
    }
    const hh = Math.max(2, plotH * (v / yMax));
    ctx.fillStyle = col.line;
    ctx.fillRect(x, padT + plotH - hh, barW, hh);
  }
}

async function loadStats(days = 14) {
  const d = Math.max(7, Math.min(365, Number(days) || 14));
  _statsLastDays = d;

  // skeleton
  $("stTasks") && ($("stTasks").textContent = "…");
  $("stDone") && ($("stDone").textContent = "…");
  $("stLists") && ($("stLists").textContent = "…");
  $("stDays") && ($("stDays").textContent = "…");

  const data = await apiGetStats(d);
  const totals = data?.totals || {};
  const series = data?.series || {};

  $("stTasks") && ($("stTasks").textContent = String(totals.tasksTotal ?? 0));
  $("stDone") && ($("stDone").textContent = String(totals.completedTotal ?? 0));
  $("stLists") && ($("stLists").textContent = String(totals.listsTotal ?? 0));
  $("stDays") && ($("stDays").textContent = String(totals.daysActive ?? 0));

  $("stToday") && ($("stToday").textContent = String(totals.completedToday ?? 0));
  $("stTotalDone") && ($("stTotalDone").textContent = String(totals.completedTotal ?? 0));
  $("stPoints") && ($("stPoints").textContent = String(totals.points ?? 0));

  const doneCounts = series.completed || [];
  const rates = series.completionRate || [];

  // points curve (window-based)
  const pointsSeries = [];
  let acc = 0;
  for (const v of doneCounts) {
    acc += (Number(v) || 0) * 5;
    pointsSeries.push(acc);
  }

  drawLineChart($("chartPoints"), pointsSeries, { fill: true });
  drawLineChart($("chartDone"), doneCounts, { fill: true });
  drawBarChart($("chartRate"), rates, { yMax: 100 });

  _statsLoaded = true;
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

function setSettingsTab(label) {
  const nav = document.querySelectorAll('.modal-nav .mnav-item');
  nav.forEach((b) => b.classList.toggle('active', (b.textContent||'').trim() === label));

  const box = document.querySelector('.modal-content');
  if (!box) return;

  const email = auth.user?.email || 'guest@local';
  const isGuest = !auth.user || auth.user.id === 'public';

  if (label === 'Премиум') {
    box.innerHTML = `
      <h2 style="margin:0 0 12px;font-weight:950">Премиум</h2>
      <div class="card">
        <div class="row"><span>Статус</span><span class="muted">Бесплатный</span></div>
        <div class="row"><span class="muted">Функции</span><span class="muted">Скоро</span></div>
      </div>
      <div class="hint-card">Здесь можно будет подключить Pro‑функции (пример как в TickTick).</div>
    `;
    return;
  }

  if (label === 'Внешний вид') {
    box.innerHTML = `
      <h2 style="margin:0 0 12px;font-weight:950">Внешний вид</h2>
      <div class="card">
        <div class="row"><div>Тема</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn" id="setThemeDark">Тёмная</button>
            <button class="btn" id="setThemeLight">Светлая</button>
            <button class="btn" id="setThemeAuto">Авто</button>
          </div>
        </div>
      </div>
    `;
    setTimeout(() => {
      const cur = settings.theme || 'dark';
      const setBtnState = () => {
        $("setThemeDark")?.classList.toggle('primary', cur==='dark');
      };
      $("setThemeDark")?.addEventListener('click', () => { settings.theme='dark'; save(); applyTheme(); updateThemeIcon(); setSettingsTab('Внешний вид'); });
      $("setThemeLight")?.addEventListener('click', () => { settings.theme='light'; save(); applyTheme(); updateThemeIcon(); setSettingsTab('Внешний вид'); });
      $("setThemeAuto")?.addEventListener('click', () => { settings.theme='auto'; save(); applyTheme(); updateThemeIcon(); setSettingsTab('Внешний вид'); });
    }, 0);
    return;
  }

  if (label === 'Дата и время') {
    const ws = settings.weekStart || 'mon';
    const tf = settings.timeFormat || '24';
    box.innerHTML = `
      <h2 style="margin:0 0 12px;font-weight:950">Дата и время</h2>
      <div class="card">
        <div class="row"><div>Начало недели</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn ${ws==='mon'?'primary':''}" id="wkMon">Пн</button>
            <button class="btn ${ws==='sun'?'primary':''}" id="wkSun">Вс</button>
          </div>
        </div>
        <div class="row"><div>Формат времени</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn ${tf==='24'?'primary':''}" id="tf24">24ч</button>
            <button class="btn ${tf==='12'?'primary':''}" id="tf12">12ч</button>
          </div>
        </div>
      </div>
      <div class="hint-card">Параметры применяются к календарю и форматированию дат.</div>
    `;
    setTimeout(() => {
      $("wkMon")?.addEventListener('click', () => { settings.weekStart='mon'; save(); setSettingsTab('Дата и время'); renderCalendar?.(); });
      $("wkSun")?.addEventListener('click', () => { settings.weekStart='sun'; save(); setSettingsTab('Дата и время'); renderCalendar?.(); });
      $("tf24")?.addEventListener('click', () => { settings.timeFormat='24'; save(); setSettingsTab('Дата и время'); });
      $("tf12")?.addEventListener('click', () => { settings.timeFormat='12'; save(); setSettingsTab('Дата и время'); });
    }, 0);
    return;
  }

  if (label === 'Функциональные модули') {
    const mods = settings.modules || { calendar:true, search:true, summary:true };
    box.innerHTML = `
      <h2 style="margin:0 0 12px;font-weight:950">Функциональные модули</h2>
      <div class="card">
        <div class="row"><div>Календарь</div><button class="toggle ${mods.calendar?'on':''}" id="tgCal"><span class="knob"></span></button></div>
        <div class="row"><div>Поиск</div><button class="toggle ${mods.search?'on':''}" id="tgSearch"><span class="knob"></span></button></div>
        <div class="row"><div>Сводка</div><button class="toggle ${mods.summary?'on':''}" id="tgSummary"><span class="knob"></span></button></div>
      </div>
      <div class="hint-card">Отключенные модули скрываются из меню слева.</div>
    `;
    const flip = (k) => {
      settings.modules = { ...mods, [k]: !mods[k] };
      save();
      applyLayout();
      setSettingsTab('Функциональные модули');
    };
    setTimeout(() => {
      $("tgCal")?.addEventListener('click', () => flip('calendar'));
      $("tgSearch")?.addEventListener('click', () => flip('search'));
      $("tgSummary")?.addEventListener('click', () => flip('summary'));
    }, 0);
    return;
  }

  if (label === 'Уведомления') {
    const onVal = !!settings.reminders;
    box.innerHTML = `
      <h2 style="margin:0 0 12px;font-weight:950">Уведомления</h2>
      <div class="card">
        <div class="row"><div>Напоминания</div><button class="toggle ${onVal?'on':''}" id="tgRem"><span class="knob"></span></button></div>
        <div class="row"><div class="muted">Web‑уведомления</div><div class="muted">(в разработке)</div></div>
      </div>
      <div class="hint-card">Сейчас настройка сохраняется и влияет на будущие функции напоминаний.</div>
    `;
    setTimeout(() => {
      $("tgRem")?.addEventListener('click', () => { settings.reminders = !settings.reminders; save(); setSettingsTab('Уведомления'); });
    }, 0);
    return;
  }

  if (label === 'Умный список') {
    const dense = settings.denseUI !== false;
    const hints = settings.showHints !== false;
    box.innerHTML = `
      <h2 style="margin:0 0 12px;font-weight:950">Умный список</h2>
      <div class="card">
        <div class="row"><div>Компактный список задач</div><button class="toggle ${dense?'on':''}" id="tgDense"><span class="knob"></span></button></div>
        <div class="row"><div>Подсказки в сайдбаре</div><button class="toggle ${hints?'on':''}" id="tgHints"><span class="knob"></span></button></div>
      </div>
      <div class="hint-card">Компактный режим приближает вид к TickTick (строки + разделители).</div>
    `;
    setTimeout(() => {
      $("tgDense")?.addEventListener('click', () => { settings.denseUI = !(settings.denseUI !== false); save(); document.body.dataset.dense = (settings.denseUI !== false) ? '1':'0'; setSettingsTab('Умный список'); });
      $("tgHints")?.addEventListener('click', () => { settings.showHints = !(settings.showHints !== false); save(); document.body.dataset.hints = (settings.showHints !== false) ? '1':'0'; setSettingsTab('Умный список'); });
    }, 0);
    return;
  }

  if (label === 'Интеграции и импорт') {
    box.innerHTML = `
      <h2 style="margin:0 0 12px;font-weight:950">Интеграции и импорт</h2>
      <div class="card">
        <div class="row"><div>Экспорт данных</div><button class="btn" id="btnExport">Скачать JSON</button></div>
        <div class="row"><div class="muted">Импорт</div><button class="btn" id="btnImport" disabled>Скоро</button></div>
      </div>
      <div class="hint-card">Экспорт включает списки, папки, секции и задачи (активные + выполненные).</div>
    `;
    setTimeout(() => {
      $("btnExport")?.addEventListener('click', async () => {
        try {
          const [folders, lists, active, done] = await Promise.all([
            apiGetFolders(),
            apiGetLists(),
            apiGetTasks({ filter: 'active', sort: settings.sort || 'due' }),
            apiGetTasks({ filter: 'completed', sort: settings.sort || 'due' }),
          ]);
          const dump = { exportedAt: new Date().toISOString(), folders, lists, tasks: active, completed: done };
          const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `clocktime-export-${Date.now()}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(a.href);
        } catch (e) {
          alert('Не удалось экспортировать');
        }
      });
    }, 0);
    return;
  }

  if (label === 'Горячие клавиши') {
    box.innerHTML = `
      <h2 style="margin:0 0 12px;font-weight:950">Горячие клавиши</h2>
      <div class="card">
        <div class="row"><div><b>N</b></div><div class="muted">Добавить задачу</div></div>
        <div class="row"><div><b>/</b></div><div class="muted">Поиск</div></div>
        <div class="row"><div><b>Ctrl/Cmd + K</b></div><div class="muted">Поиск</div></div>
        <div class="row"><div><b>↑/↓</b></div><div class="muted">Навигация по задачам</div></div>
        <div class="row"><div><b>Enter</b></div><div class="muted">Открыть задачу</div></div>
        <div class="row"><div><b>Space</b></div><div class="muted">Выполнить/вернуть</div></div>
        <div class="row"><div><b>Esc</b></div><div class="muted">Закрыть панель/окно</div></div>
      </div>
    `;
    return;
  }

  if (label === 'О приложении') {
    box.innerHTML = `
      <h2 style="margin:0 0 12px;font-weight:950">О приложении</h2>
      <div class="card">
        <div class="row"><div>Версия</div><div class="muted">v20-ui-auth</div></div>
        <div class="row"><div>Хранилище</div><div class="muted">PostgreSQL (Railway)</div></div>
      </div>
    `;
    return;
  }

  // Simple placeholders for sections that are not implemented yet
  if (label !== 'Аккаунт') {
    box.innerHTML = `
      <h2 style="margin:0 0 12px;font-weight:950">${label}</h2>
      <div class="card">
        <div class="row"><div class="muted">Раздел в разработке</div><div class="muted">—</div></div>
      </div>
      <div class="hint-card">Если хочешь — скажи, какой именно функционал нужен в этом разделе, и я сделаю его рабочим.</div>
    `;
    return;
  }

  // Default: Аккаунт
  box.innerHTML = `
    <h2 style="margin:0 0 12px;font-weight:950">Аккаунт</h2>
    <div class="card">
      <div class="row"><div>Email</div><div class="muted">${email}</div></div>
      <div class="row"><div>Режим</div><div class="muted">${isGuest ? 'Гость' : 'Авторизован'}</div></div>
      <div class="row">
        <div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${isGuest ? '<button class="btn primary" id="settingsLogin">Войти</button>' : '<button class="btn" id="settingsLogout">Выйти</button>'}
        </div>
      </div>
    </div>
  `;
  setTimeout(() => {
    $("settingsLogin")?.addEventListener('click', () => { closeSettings(); openAuth('login'); });
    $("settingsLogout")?.addEventListener('click', () => { closeSettings(); logout(); });
  }, 0);
}


// Event bindings
on($("btnMenu"), "click", openDrawer);
on($("drawerBackdrop"), "click", closeDrawer);

document.querySelectorAll('.drawer-item[data-kind="smart"]').forEach((b) => {
  on(b, "click", () => setActive("smart", b.dataset.id));
});

function openSortSheet() {
  // In Trash we show an extra action like TickTick ("Empty Trash")
  const btn = $("sortEmptyTrash");
  if (btn) btn.hidden = !(state.activeKind === "smart" && state.activeId === "trash");
  openSheet("sortBackdrop", "sortSheet");
}

on($("btnSort"), "click", openSortSheet);
on($("sortBackdrop"), "click", () => closeSheet("sortBackdrop", "sortSheet"));
on($("sortCancel"), "click", () => closeSheet("sortBackdrop", "sortSheet"));
on($("sortEmptyTrash"), "click", async () => {
  if (!(state.activeKind === "smart" && state.activeId === "trash")) return;
  if (!confirm("Очистить корзину? Это удалит задачи навсегда.")) return;
  await apiEmptyTrash();
  closeSheet("sortBackdrop", "sortSheet");
  await refreshCounts();
  await loadTasks();
});
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
  const sheet = $("pickSheet");
  if (sheet) sheet.querySelector(".sheet-title").textContent = "Список";
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
  if (t.trashed) {
    await patchSelectedTask({ trashed: false }, { reload: true });
  } else {
    await patchSelectedTask({ completed: !t.completed }, { reload: true });
  }
});
on($("teListBtn"), "click", async (e) => {
  const t = getTaskById(state.selectedTaskId);
  if (!t) return;

  // Desktop: anchored popover (TickTick-like)
  if (isDesktop()) {
    const items = state.lists.map((l) => ({
      label: `${l.emoji || "📌"} ${l.title}`,
      value: l.id,
      active: l.id === t.listId,
      onSelect: async (val) => {
        // reset section when moving list
        await patchSelectedTask({ listId: val, sectionId: "" }, { reload: true });
        // refresh cache for new list
        await ensureSectionsForList(val);
      },
    }));
    openPopover($("teListBtn"), items, { title: "Список", width: 300 });
    return;
  }

  // Mobile/narrow: bottom sheet
  const pl = $("pickList");
  const sheet = $("pickSheet");
  if (sheet) sheet.querySelector(".sheet-title").textContent = "Список";
  pl.innerHTML = "";
  state.lists.forEach((l) => {
    const btn = document.createElement("button");
    btn.className = "sheet-option";
    btn.textContent = `${l.emoji || "📌"} ${l.title}`;
    btn.onclick = async () => {
      await patchSelectedTask({ listId: l.id, sectionId: "" }, { reload: true });
      closeSheet("pickBackdrop", "pickSheet");
    };
    pl.appendChild(btn);
  });
  openSheet("pickBackdrop", "pickSheet");
});

on($("teSectionBtn"), "click", async () => {
  const t = getTaskById(state.selectedTaskId);
  if (!t) return;
  const secs = await ensureSectionsForList(t.listId);
  const items = [
    { label: "несгруппированный", value: "", active: !t.sectionId, onSelect: async () => patchSelectedTask({ sectionId: "" }, { reload: true }) },
    "sep",
    ...secs.map((s) => ({
      label: s.title,
      value: s.id,
      active: s.id === t.sectionId,
      onSelect: async (val) => patchSelectedTask({ sectionId: val }, { reload: true }),
    })),
  ];
  openPopover($("teSectionBtn"), items, { title: "Секция", width: 280 });
});

on($("tePriority"), "click", async () => {
  const t = getTaskById(state.selectedTaskId);
  if (!t) return;
  const icons = {
    0: '<svg class="ico sm"><use href="#i-flag"></use></svg>',
    1: '<span class="prio-dot p1">!</span>',
    2: '<span class="prio-dot p2">!!</span>',
    3: '<span class="prio-dot p3">!!!</span>',
  };
  const items = [0,1,2,3].map((p) => ({
    label: p === 0 ? "Без приоритета" : `Приоритет ${p}`,
    value: p,
    active: Number(t.priority || 0) === p,
    icon: icons[p],
    onSelect: async (val) => patchSelectedTask({ priority: Number(val) }, { reload: false }),
  }));
  openPopover($("tePriority"), items, { title: "Приоритет", width: 240 });
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
  const items = [
    {
      label: "Удалить задачу",
      value: "delete",
      icon: '<svg class="ico sm"><use href="#i-trash"></use></svg>',
      onSelect: async () => {
        if (!confirm(t.trashed ? "Удалить навсегда?" : "Переместить в корзину?")) return;
        await apiDeleteTask(t.id, { hard: !!t.trashed });
        closeTaskEditor();
        await refreshCounts();
        await loadTasks();
      }
    }
  ];
  openPopover($("teMore"), items, { title: "Действия", width: 220 });
});

// task sheet
on($("taskBackdrop"), "click", () => closeSheet("taskBackdrop", "taskSheet"));
on($("btnTaskCancel"), "click", () => closeSheet("taskBackdrop", "taskSheet"));

on($("taskListSelect"), 'change', async () => {
  const lid = $("taskListSelect").value;
  const secs = await ensureSectionsForList(lid);
  fillSectionSelect($("taskSectionSelect"), secs, '');
});

document.querySelectorAll("#taskPrio .prio-btn").forEach((b) => on(b, "click", () => { document.querySelectorAll("#taskPrio .prio-btn").forEach((x) => x.classList.toggle("active", x === b)); }));
on($("btnTaskDelete"), "click", async () => {
  const id = state.editing.taskId;
  if (!id) return;
  const t = getTaskById(id);
  const isTrash = !!t?.trashed;
  if (!confirm(isTrash ? "Удалить навсегда?" : "Переместить в корзину?")) return;
  await apiDeleteTask(id, { hard: isTrash });
  closeSheet("taskBackdrop", "taskSheet");
  await refreshCounts();
  await loadTasks();
});
on($("btnTaskToggle"), "click", async () => {
  const id = state.editing.taskId;
  if (!id) return;
  const mode = $("btnTaskToggle").dataset.mode || "toggle";
  if (mode === "restore") {
    await apiPatchTask(id, { trashed: false });
  } else {
    const isDone = $("btnTaskToggle").dataset.completed === "1";
    await apiPatchTask(id, { completed: !isDone });
  }
  closeSheet("taskBackdrop", "taskSheet");
  await refreshCounts();
  await loadTasks();
});
on($("taskForm"), "submit", async (e) => {
  e.preventDefault();
  const id = state.editing.taskId;
  if (!id) return;
  const title = $("taskTitle").value.trim();
  if (!title) return;
  const notes = $("taskNotes").value.trim() || null;
  const listId = $("taskListSelect").value || state.system.inboxId;
  const dueDate = $("taskDueDate").value || null;
  const sectionId = $("taskSectionSelect") ? ($("taskSectionSelect").value || "") : "";
  const tags = parseTagsInput($("taskTags").value);
  const prioBtn = [...document.querySelectorAll("#taskPrio .prio-btn")].find((b) => b.classList.contains("active"));
  const priority = prioBtn ? Number(prioBtn.dataset.p) : 0;
  await apiPatchTask(id, { title, listId, sectionId, dueDate, tags, priority, notes });
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
on($("newSectionBtn"), "click", async () => {
  if (state.activeKind !== "list") {
    alert("Секции доступны только внутри списка");
    return;
  }
  const name = prompt("Название секции", "Новая секция");
  if (name === null) return;
  const title = name.trim();
  if (!title) return;
  await apiCreateSection({ listId: state.activeId, title });
  await loadTasks();
});

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
on($("menuLogin"), "click", () => { $("accountMenu").hidden = true; openAuth("login"); });
on($("menuRegister"), "click", () => { $("accountMenu").hidden = true; openAuth("register"); });
on($("menuLogout"), "click", () => { $("accountMenu").hidden = true; logout(); });
on($("menuSettings"), "click", () => { $("accountMenu").hidden = true; openSettings(); });
on($("menuStats"), "click", () => { $("accountMenu").hidden = true; openStatsModal(); });
on($("menuPremium"), "click", () => { $("accountMenu").hidden = true; openSettings(); setSettingsTab("Премиум"); });

on($("menuTheme"), "click", () => { $("accountMenu").hidden = true; toggleTheme(); });
on($("menuHotkeys"), "click", () => { $("accountMenu").hidden = true; openSettings(); setSettingsTab("Горячие клавиши"); });
on($("menuAbout"), "click", () => { $("accountMenu").hidden = true; openSettings(); setSettingsTab("О приложении"); });

// settings modal

on($("settingsBackdrop"), "click", closeSettings);
on($("settingsClose"), "click", closeSettings);

// stats modal
on($("statsBackdrop"), "click", closeStatsModal);
on($("statsClose"), "click", closeStatsModal);
on($("statsApply"), "click", async () => {
  const days = Number($("statsRange")?.value || 14);
  await loadStats(days);
});
on($("statsRange"), "change", async () => {
  if ($("statsModal")?.hidden) return;
  const days = Number($("statsRange")?.value || 14);
  await loadStats(days);
});
document.querySelectorAll(".stats-tab").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".stats-tab").forEach((x) => x.classList.toggle("active", x === b));
    // only "overview" is implemented; keep UI consistent
  });
});


// settings nav
document.querySelectorAll('.modal-nav .mnav-item').forEach((b)=>{
  b.addEventListener('click', ()=>{
    setSettingsTab((b.textContent||'').trim());
  });
});

// initialize default tab when opening
const _openSettingsOrig = openSettings;
openSettings = function(){ _openSettingsOrig(); setSettingsTab('Аккаунт'); };



// auth modal
on($("authBackdrop"), "click", hideWelcome);
on($("authClose"), "click", hideWelcome);
on($("tabLogin"), "click", () => openAuth("login"));
on($("tabRegister"), "click", () => openAuth("register"));

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
function calendarStep(dir){
  const now = state.calendarDay ? new Date(state.calendarDay) : new Date();
  if (state.calendarView === 'month') {
    state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() + dir, 1);
  } else if (state.calendarView === 'week') {
    const base = state.calendarCursor instanceof Date ? state.calendarCursor : new Date();
    state.calendarCursor = addDays(base, dir * 7);
  } else {
    const base = state.calendarCursor instanceof Date ? state.calendarCursor : new Date();
    state.calendarCursor = addDays(base, dir * 1);
  }
  state.calendarRangeKey = '';
}

on($("calPrev"), "click", async () => { calendarStep(-1); await renderCalendar(); });
on($("calNext"), "click", async () => { calendarStep(1); await renderCalendar(); });
on($("calToday"), "click", async () => {
  const now = new Date();
  state.calendarCursor = state.calendarView === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : now;
  state.calendarDay = null;
  state.calendarRangeKey = '';
  await renderCalendar();
});
on($("calAdd"), "click", () => { setModule("tasks"); setActive("smart", "inbox"); $("deskAddInput")?.focus?.(); });

on($("calViewBtn"), "click", () => {
  const items = [
    { label: 'Месяц', value: 'month', active: state.calendarView === 'month', onSelect: (v)=>{ state.calendarView=v; state.calendarRangeKey=''; renderCalendar(); }},
    { label: 'Неделя', value: 'week', active: state.calendarView === 'week', onSelect: (v)=>{ state.calendarView=v; state.calendarRangeKey=''; renderCalendar(); }},
    { label: 'День', value: 'day', active: state.calendarView === 'day', onSelect: (v)=>{ state.calendarView=v; state.calendarRangeKey=''; renderCalendar(); }},
  ];
  openPopover($("calViewBtn"), items, { title: 'Вид', width: 220 });
});


// Resize handler
window.addEventListener("resize", () => {
  applyLayout();
  updateAddPlaceholder();
});

function isTypingTarget(el){
  if (!el) return false;
  const tag = (el.tagName||'').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || el.isContentEditable) return true;
  return false;
}

document.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target) && e.key !== 'Escape') return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    setModule('search');
    setTimeout(() => $('globalSearchInput')?.focus?.(), 0);
    return;
  }

  if (e.key === '/') {
    e.preventDefault();
    setModule('search');
    setTimeout(() => $('globalSearchInput')?.focus?.(), 0);
    return;
  }

  if (e.key.toLowerCase() === 'n') {
    e.preventDefault();
    setModule('tasks');
    setTimeout(() => {
      const el = isDesktop() ? $('deskAddInput') : $('compInput');
      el?.focus?.();
    }, 0);
    return;
  }



// Task list keyboard navigation (desktop-friendly)
if (state.view === 'tasks' && state.module === 'tasks') {
  const ids = [...document.querySelectorAll('#groups .task')].map((el) => el.dataset.id).filter(Boolean);
  if (ids.length) {
    const cur = state.selectedTaskId;
    let i = ids.indexOf(cur);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      i = Math.min(ids.length - 1, i < 0 ? 0 : i + 1);
      state.selectedTaskId = ids[i];
      render();
      if (isSplit()) renderTaskEditor();
      document.querySelector(`.task[data-id="${state.selectedTaskId}"]`)?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      i = Math.max(0, i < 0 ? 0 : i - 1);
      state.selectedTaskId = ids[i];
      render();
      if (isSplit()) renderTaskEditor();
      document.querySelector(`.task[data-id="${state.selectedTaskId}"]`)?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter' && state.selectedTaskId) {
      e.preventDefault();
      const t = getTaskById(state.selectedTaskId);
      if (t) openTask(t);
      return;
    }
    if (e.key === ' ' && state.selectedTaskId) {
      e.preventDefault();
      const t = getTaskById(state.selectedTaskId);
      if (t) apiPatchTask(t.id, { completed: !t.completed }).then(() => loadTasks()).catch(() => {});
      return;
    }
  }
}
  if (e.key === 'Escape') {
    try { closeTaskEditor(); } catch {}
    try { closePopover(); } catch {}
    closeDrawer();
    ['taskBackdrop','taskSheet','pickBackdrop','pickSheet','editListBackdrop','editListSheet','editFolderBackdrop','editFolderSheet'].forEach((id)=>{
      const el = $(id);
      if (el) el.hidden = true;
    });
    $('accountMenu') && ($('accountMenu').hidden = true);
  }
});

// Auth UI
let _authMode = "login"; // login | register

function switchAuthMode(mode) {
  _authMode = mode === "register" ? "register" : "login";
  const isLogin = _authMode === "login";
  // Be explicit: set both [hidden] and display.
  const fl = $("formLogin");
  const fr = $("formRegister");
  if (fl) { fl.hidden = !isLogin; fl.style.display = isLogin ? "flex" : "none"; }
  if (fr) { fr.hidden = isLogin; fr.style.display = isLogin ? "none" : "flex"; }
  $("loginError") && ($("loginError").hidden = true);
  $("regError") && ($("regError").hidden = true);

  const t = $("btnAuthToggle");
  if (t) t.textContent = isLogin ? "Регистрация" : "Вход";
}

on($("btnAuthToggle"), "click", () => {
  switchAuthMode(_authMode === "login" ? "register" : "login");
  setTimeout(() => {
    if (_authMode === "register") $("regEmail")?.focus?.();
    else $("loginEmail")?.focus?.();
  }, 0);
});

on($("linkToRegister"), "click", () => switchAuthMode("register"));
on($("linkToLogin"), "click", () => switchAuthMode("login"));

// Some environments (PWA wrappers / certain mobile browsers) can be flaky with form submit.
// We route both `submit` and button `click` through the same functions.
let _authSubmitting = false;

async function doLogin() {
  if (_authSubmitting) return;
  _authSubmitting = true;
  $("loginError").hidden = true;
  setAuthBusy("formLogin", true, "Входим…");
  try {
    const email = $("loginEmail").value.trim();
    const password = $("loginPassword").value;
    const res = await apiAuthLogin({ email, password });
    if (!res || !res.token) throw new Error("Не удалось войти: сервер не вернул токен");
    // Persist token first, then verify session via /me (catches cases where
    // Authorization headers/cookies are blocked, so user sees a clear error).
    setAuth(res.token, res.user);
    const me = await apiAuthMe();
    setAuth(res.token, me);
    hideWelcome();
    await startApp();
  } catch (err) {
    $("loginError").textContent = err?.message || String(err);
    $("loginError").hidden = false;
  } finally {
    setAuthBusy("formLogin", false);
    _authSubmitting = false;
  }
}

async function doRegister() {
  if (_authSubmitting) return;
  _authSubmitting = true;
  $("regError").hidden = true;
  setAuthBusy("formRegister", true, "Создаём…");
  try {
    const email = $("regEmail").value.trim();
    const p1 = $("regPassword").value;
    const p2 = $("regPassword2").value;
    if (p1 !== p2) throw new Error("Пароли не совпадают");
    const res = await apiAuthRegister({ email, password: p1 });
    if (!res || !res.token) throw new Error("Не удалось зарегистрироваться: сервер не вернул токен");
    setAuth(res.token, res.user);
    const me = await apiAuthMe();
    setAuth(res.token, me);
    hideWelcome();
    await startApp();
  } catch (err) {
    $("regError").textContent = err?.message || String(err);
    $("regError").hidden = false;
  } finally {
    setAuthBusy("formRegister", false);
    _authSubmitting = false;
  }
}

on($("formLogin"), "submit", async (e) => {
  e.preventDefault();
  await doLogin();
});

on($("formRegister"), "submit", async (e) => {
  e.preventDefault();
  await doRegister();
});

// Direct button click handlers as a fallback (some browsers/extensions mess with submit events)
on($("btnLogin"), "click", (e) => {
  // If native validation fails, show it instead of silently doing nothing.
  const f = $("formLogin");
  if (f && !f.checkValidity()) { f.reportValidity(); return; }
  e.preventDefault();
  doLogin();
});
on($("btnRegister"), "click", (e) => {
  const f = $("formRegister");
  if (f && !f.checkValidity()) { f.reportValidity(); return; }
  e.preventDefault();
  doRegister();
});

let _started = false;
async function startApp() {
  if (_started) return;
  _started = true;
  try {
    try {
      const me = await apiAuthMe();
      if (me) setAuth(auth.token, me);
    } catch (_) {}
    await loadMeta();
    await refreshCounts();
    setActive("smart", "all");
    applyLayout();
  } catch (e) {
    _started = false;
alert("Ошибка: " + (e.message || e));
  }
}

// Boot (no auth)
(async () => {
  try {
    await startApp();
  } catch (e) {
    alert("Ошибка: " + (e?.message || e));
  }
})();
