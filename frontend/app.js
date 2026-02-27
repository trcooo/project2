// TickTick-like UI v2 (no frameworks)

const API_BASE = "";

// ---------- State ----------
const state = {
  view: "tasks",          // tasks | calendar | search | focus
  activeKind: "list",     // list | smart
  activeId: "inbox",      // list id or smart id
  lists: [],
  tasks: [],              // active tasks for current screen
  completed: [],
  collapsed: new Set(),   // collapsed group keys
  completedCollapsed: true,
  editingTaskId: null,
  editingTask: null,
  calendar: {
    year: new Date().getFullYear(),
    month: new Date().getMonth(), // 0-11
    selected: new Date(),         // Date object
  }
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

const drawer = $("drawer");
const drawerBackdrop = $("drawerBackdrop");
const listsContainer = $("listsContainer");
const countToday = $("countToday");

const btnMenu = $("btnMenu");
const pageTitle = $("pageTitle");
const pageSub = $("pageSub");

const viewTasks = $("viewTasks");
const viewCalendar = $("viewCalendar");
const viewSearch = $("viewSearch");
const viewFocus = $("viewFocus");

const groupsEl = $("groups");
const completedHead = $("completedHead");
const completedChevron = $("completedChevron");
const completedCount = $("completedCount");
const completedTasksEl = $("completedTasks");
const emptyState = $("emptyState");

const fabAdd = $("fabAdd");
const btnQuickAdd = $("btnQuickAdd");

const sheetBackdrop = $("sheetBackdrop");
const sheet = $("sheet");
const taskForm = $("taskForm");
const taskTitle = $("taskTitle");
const hint = $("hint");
const toolToday = $("toolToday");
const toolTomorrow = $("toolTomorrow");
const toolDate = $("toolDate");
const toolClearDue = $("toolClearDue");
const listSelect = $("listSelect");
const btnCancel = $("btnCancel");

const searchInput = $("searchInput");

const bnItems = Array.from(document.querySelectorAll(".bn-item"));

const calTitle = $("calTitle");
const calPrev = $("calPrev");
const calNext = $("calNext");
const calToday = $("calToday");
const calendarGrid = $("calendarGrid");
const calSheetTitle = $("calSheetTitle");
const calTasks = $("calTasks");
const calEmpty = $("calEmpty");

const globalSearchInput = $("globalSearchInput");
const searchResults = $("searchResults");
const searchEmpty = $("searchEmpty");

const btnAddList = $("btnAddList");
const listBackdrop = $("listBackdrop");
const listSheet = $("listSheet");
const listForm = $("listForm");
const listEmoji = $("listEmoji");
const listTitle = $("listTitle");
const listHint = $("listHint");
const btnListCancel = $("btnListCancel");

// ---------- Utils ----------
function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtDue(dueStr) {
  if (!dueStr) return "";
  const t = iso(new Date());
  const tm = iso(addDays(new Date(), 1));
  if (dueStr === t) return "Сегодня";
  if (dueStr === tm) return "Завтра";
  // DD.MM
  const [y,m,d] = dueStr.split("-");
  return `${d}.${m}`;
}
function weekdayTitle(dueStr) {
  if (!dueStr) return "Без даты";
  const t = iso(new Date());
  const tm = iso(addDays(new Date(), 1));
  if (dueStr === t) return "Сегодня";
  if (dueStr === tm) return "Завтра";
  return "Позже";
}
function monthName(monthIdx) {
  const names = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
  return names[monthIdx] || "";
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
}

// ---------- API ----------
async function api(path, options) {
  const r = await fetch(`${API_BASE}${path}`, options);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || `HTTP ${r.status}`);
  }
  return r.json();
}
const apiGetLists = () => api("/api/lists");
const apiCreateList = (payload) => api("/api/lists", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
const apiGetTasks = (params) => {
  const usp = new URLSearchParams(params);
  return api(`/api/tasks?${usp.toString()}`);
};
const apiCreateTask = (payload) => api("/api/tasks", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
const apiPatchTask = (id, payload) => api(`/api/tasks/${encodeURIComponent(id)}`, { method:"PATCH", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
const apiDeleteTask = (id) => api(`/api/tasks/${encodeURIComponent(id)}`, { method:"DELETE" });

// ---------- Drawer ----------
function openDrawer() {
  drawer.hidden = false;
  drawerBackdrop.hidden = false;
}
function closeDrawer() {
  drawer.hidden = true;
  drawerBackdrop.hidden = true;
}
btnMenu.addEventListener("click", openDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);

// ---------- Views ----------
function setView(view) {
  state.view = view;
  bnItems.forEach(b => b.classList.toggle("active", b.dataset.view === view));

  [viewTasks, viewCalendar, viewSearch, viewFocus].forEach(v => v.classList.remove("view-active"));
  if (view === "tasks") viewTasks.classList.add("view-active");
  if (view === "calendar") viewCalendar.classList.add("view-active");
  if (view === "search") viewSearch.classList.add("view-active");
  if (view === "focus") viewFocus.classList.add("view-active");

  // Update top title depending on view
  if (view === "calendar") {
    pageTitle.textContent = monthName(state.calendar.month);
    pageSub.textContent = "";
    renderCalendar();
    loadCalendarTasks();
  } else if (view === "search") {
    pageTitle.textContent = "Поиск";
    pageSub.textContent = "";
    globalSearchInput.focus();
  } else if (view === "focus") {
    pageTitle.textContent = "Фокус";
    pageSub.textContent = "";
  } else {
    updateHeaderTitle();
    loadTasksForCurrent();
  }
}
bnItems.forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));

// ---------- Lists UI ----------
function updateHeaderTitle() {
  if (state.activeKind === "smart" && state.activeId === "today") {
    pageTitle.textContent = "Сегодня";
    pageSub.textContent = "";
    return;
  }
  const l = state.lists.find(x => x.id === state.activeId);
  pageTitle.textContent = l ? l.title : "Входящие";
  pageSub.textContent = "";
}

function setActiveDrawerItem(kind, id) {
  state.activeKind = kind;
  state.activeId = id;

  const items = Array.from(document.querySelectorAll(".drawer-item"));
  items.forEach(it => {
    const match = it.dataset.kind === kind && it.dataset.id === id;
    it.classList.toggle("active", match);
  });

  updateHeaderTitle();
  closeDrawer();
  setView("tasks");
}

function renderLists() {
  // Build list buttons (exclude smart)
  listsContainer.innerHTML = "";
  for (const l of state.lists) {
    const btn = document.createElement("button");
    btn.className = "drawer-item";
    btn.dataset.kind = "list";
    btn.dataset.id = l.id;
    btn.innerHTML = `
      <span class="di-emoji">${escapeHtml(l.emoji || "📌")}</span>
      <span class="di-title">${escapeHtml(l.title)}</span>
      <span class="di-count" data-count="${l.id}">—</span>
    `;
    btn.addEventListener("click", () => setActiveDrawerItem("list", l.id));
    listsContainer.appendChild(btn);
  }

  // Update active highlight
  setTimeout(() => {
    const active = document.querySelector(`.drawer-item[data-kind="${state.activeKind}"][data-id="${state.activeId}"]`);
    if (active) active.classList.add("active");
  }, 0);
}

function renderListSelect() {
  listSelect.innerHTML = "";
  for (const l of state.lists) {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = `${l.emoji || "📌"} ${l.title}`;
    listSelect.appendChild(opt);
  }
}

// ---------- Task sheet ----------
function openTaskSheet(mode, task = null) {
  state.editingTaskId = mode === "edit" ? task.id : null;
  state.editingTask = task;

  taskTitle.value = task ? task.title : "";
  hint.hidden = true;

  const due = task ? task.dueDate : null;
  toolDate.value = due || "";

  // default list for create
  let lid = "inbox";
  if (mode === "edit") {
    lid = task.listId;
  } else if (state.activeKind === "list") {
    lid = state.activeId;
  }
  listSelect.value = lid;

  sheetBackdrop.hidden = false;
  sheet.hidden = false;
  setTimeout(() => taskTitle.focus(), 0);
}

function closeTaskSheet() {
  sheetBackdrop.hidden = true;
  sheet.hidden = true;
  state.editingTaskId = null;
  state.editingTask = null;
  taskTitle.value = "";
  toolDate.value = "";
  hint.hidden = true;
}

sheetBackdrop.addEventListener("click", closeTaskSheet);
btnCancel.addEventListener("click", closeTaskSheet);

fabAdd.addEventListener("click", () => openTaskSheet("create"));
btnQuickAdd.addEventListener("click", () => openTaskSheet("create"));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!sheet.hidden) closeTaskSheet();
    if (!listSheet.hidden) closeListSheet();
    if (!drawer.hidden) closeDrawer();
  }
});

toolToday.addEventListener("click", () => { toolDate.value = iso(new Date()); });
toolTomorrow.addEventListener("click", () => { toolDate.value = iso(addDays(new Date(), 1)); });
toolClearDue.addEventListener("click", () => { toolDate.value = ""; });

taskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = taskTitle.value.trim();
  if (!title) {
    hint.hidden = false;
    taskTitle.focus();
    return;
  }

  const dueDate = toolDate.value ? toolDate.value : null;
  const listId = listSelect.value;

  try {
    if (state.editingTaskId) {
      await apiPatchTask(state.editingTaskId, { title, dueDate, listId });
    } else {
      // If user is in smart "today", auto set due today unless user chose another
      let finalDue = dueDate;
      if (state.activeKind === "smart" && state.activeId === "today" && !finalDue) {
        finalDue = iso(new Date());
      }
      await apiCreateTask({ title, dueDate: finalDue, listId });
    }
    closeTaskSheet();
    await refreshSidebarCounts();
    await loadTasksForCurrent();
    // calendar markers update
    if (state.view === "calendar") renderCalendar();
  } catch (err) {
    alert(err.message || "Ошибка сохранения");
  }
});

// ---------- List sheet ----------
function openListSheet() {
  listEmoji.value = "📌";
  listTitle.value = "";
  listHint.hidden = true;
  listBackdrop.hidden = false;
  listSheet.hidden = false;
  setTimeout(() => listTitle.focus(), 0);
}
function closeListSheet() {
  listBackdrop.hidden = true;
  listSheet.hidden = true;
  listHint.hidden = true;
}
btnAddList.addEventListener("click", openListSheet);
listBackdrop.addEventListener("click", closeListSheet);
btnListCancel.addEventListener("click", closeListSheet);

listForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = listTitle.value.trim();
  const emoji = (listEmoji.value || "📌").trim() || "📌";
  if (!title) {
    listHint.hidden = false;
    listTitle.focus();
    return;
  }
  try {
    const created = await apiCreateList({ title, emoji });
    closeListSheet();
    await loadLists();
    setActiveDrawerItem("list", created.id);
  } catch (err) {
    alert(err.message || "Ошибка создания списка");
  }
});

// ---------- Tasks rendering ----------
function groupTasks(tasks) {
  const groups = new Map(); // key -> {title, tasks}
  for (const t of tasks) {
    const key = weekdayTitle(t.dueDate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  // Order: Сегодня, Завтра, Позже, Без даты
  const order = ["Сегодня", "Завтра", "Позже", "Без даты"];
  return order
    .filter(k => groups.has(k))
    .map(k => ({ key: k, title: k, items: groups.get(k) }));
}

function createTaskLi(t, compact = false) {
  const li = document.createElement("li");
  li.className = "task" + (t.completed ? " completed" : "");
  if (compact) li.classList.add("compact");

  const cb = document.createElement("div");
  cb.className = "checkbox" + (t.completed ? " checked" : "");
  cb.title = "Отметить выполненным";

  const main = document.createElement("div");
  main.className = "task-main";

  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = t.title;

  const meta = document.createElement("div");
  meta.className = "task-meta";
  const list = state.lists.find(l => l.id === t.listId);
  meta.textContent = list ? `${list.emoji} ${list.title}` : "";

  main.appendChild(title);
  if (meta.textContent) main.appendChild(meta);

  const due = document.createElement("div");
  due.className = "due";
  due.textContent = fmtDue(t.dueDate);

  const actions = document.createElement("div");
  actions.className = "task-actions";

  const btnEdit = document.createElement("button");
  btnEdit.className = "small-btn";
  btnEdit.textContent = "✎";
  btnEdit.title = "Редактировать";

  const btnDel = document.createElement("button");
  btnDel.className = "small-btn";
  btnDel.textContent = "🗑";
  btnDel.title = "Удалить";

  actions.appendChild(btnEdit);
  actions.appendChild(btnDel);

  li.appendChild(cb);
  li.appendChild(main);
  li.appendChild(due);
  li.appendChild(actions);

  cb.addEventListener("click", async () => {
    await apiPatchTask(t.id, { completed: !t.completed });
    await refreshSidebarCounts();
    await loadTasksForCurrent();
    if (state.view === "calendar") loadCalendarTasks();
  });

  btnEdit.addEventListener("click", () => openTaskSheet("edit", t));
  title.addEventListener("dblclick", () => openTaskSheet("edit", t));

  btnDel.addEventListener("click", async () => {
    const ok = confirm("Удалить задачу?");
    if (!ok) return;
    await apiDeleteTask(t.id);
    await refreshSidebarCounts();
    await loadTasksForCurrent();
    if (state.view === "calendar") loadCalendarTasks();
  });

  return li;
}

function renderTasksScreen() {
  groupsEl.innerHTML = "";
  completedTasksEl.innerHTML = "";

  const active = state.tasks;
  const completed = state.completed;

  const grouped = groupTasks(active);

  if (active.length === 0 && completed.length === 0) {
    emptyState.hidden = false;
  } else {
    emptyState.hidden = true;
  }

  for (const g of grouped) {
    const section = document.createElement("section");
    section.className = "section";

    const head = document.createElement("button");
    head.className = "section-head";
    head.innerHTML = `
      <span>${g.title === "Сегодня" ? "Пн, Сегодня" : g.title}</span>
      <span class="section-right">${g.items.length} <span>${state.collapsed.has(g.key) ? "▸" : "▾"}</span></span>
    `;
    head.addEventListener("click", () => {
      if (state.collapsed.has(g.key)) state.collapsed.delete(g.key);
      else state.collapsed.add(g.key);
      renderTasksScreen();
    });

    const ul = document.createElement("ul");
    ul.className = "tasks";
    if (!state.collapsed.has(g.key)) {
      for (const t of g.items) ul.appendChild(createTaskLi(t));
    }

    section.appendChild(head);
    section.appendChild(ul);
    groupsEl.appendChild(section);
  }

  // Completed section
  completedCount.textContent = String(completed.length);
  completedChevron.textContent = state.completedCollapsed ? "▸" : "▾";
  if (!state.completedCollapsed) {
    for (const t of completed) completedTasksEl.appendChild(createTaskLi(t));
  }
}

completedHead.addEventListener("click", () => {
  state.completedCollapsed = !state.completedCollapsed;
  renderTasksScreen();
});

// ---------- Loading tasks ----------
async function loadLists() {
  state.lists = await apiGetLists();
  renderLists();
  renderListSelect();
}

async function loadTasksForCurrent() {
  if (state.view !== "tasks") return;

  const q = searchInput.value.trim();
  const baseParams = { filter: "active" };
  const completedParams = { filter: "completed" };

  if (q) {
    baseParams.q = q;
    completedParams.q = q;
  }

  if (state.activeKind === "smart" && state.activeId === "today") {
    const d = iso(new Date());
    baseParams.due = d;
    completedParams.due = d;
  } else {
    baseParams.list_id = state.activeId;
    completedParams.list_id = state.activeId;
  }

  const [active, done] = await Promise.all([
    apiGetTasks(baseParams),
    apiGetTasks(completedParams),
  ]);

  state.tasks = active;
  state.completed = done;

  renderTasksScreen();
}

searchInput.addEventListener("input", () => loadTasksForCurrent());

// ---------- Sidebar counts ----------
async function refreshSidebarCounts() {
  // Today count
  const today = iso(new Date());
  const todayActive = await apiGetTasks({ filter: "active", due: today });
  countToday.textContent = String(todayActive.length);

  // Count per list
  // (simple: fetch active tasks for list)
  for (const l of state.lists) {
    const res = await apiGetTasks({ filter: "active", list_id: l.id });
    const el = document.querySelector(`[data-count="${l.id}"]`);
    if (el) el.textContent = String(res.length);
  }
}

// ---------- Calendar ----------
function startOfMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const dow = first.getDay(); // 0=Sun
  // TickTick grid starts with Sunday (В)
  return addDays(first, -dow);
}

function renderCalendar() {
  const y = state.calendar.year;
  const m = state.calendar.month;

  calTitle.textContent = `${monthName(m)}`;

  calendarGrid.innerHTML = "";
  const start = startOfMonthGrid(y, m);
  const selectedIso = iso(state.calendar.selected);

  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const cell = document.createElement("div");
    cell.className = "day";
    const inMonth = d.getMonth() === m;
    if (!inMonth) cell.classList.add("muted");
    if (iso(d) === selectedIso) cell.classList.add("selected");
    cell.textContent = String(d.getDate());

    if (inMonth) {
      cell.addEventListener("click", () => {
        state.calendar.selected = d;
        renderCalendar();
        loadCalendarTasks();
      });
    }

    calendarGrid.appendChild(cell);
  }
}

calPrev.addEventListener("click", () => {
  const d = new Date(state.calendar.year, state.calendar.month - 1, 1);
  state.calendar.year = d.getFullYear();
  state.calendar.month = d.getMonth();
  renderCalendar();
  loadCalendarTasks();
});
calNext.addEventListener("click", () => {
  const d = new Date(state.calendar.year, state.calendar.month + 1, 1);
  state.calendar.year = d.getFullYear();
  state.calendar.month = d.getMonth();
  renderCalendar();
  loadCalendarTasks();
});
calToday.addEventListener("click", () => {
  const d = new Date();
  state.calendar.year = d.getFullYear();
  state.calendar.month = d.getMonth();
  state.calendar.selected = d;
  renderCalendar();
  loadCalendarTasks();
});

async function loadCalendarTasks() {
  if (state.view !== "calendar") return;
  const d = iso(state.calendar.selected);
  const tasks = await apiGetTasks({ filter: "active", due: d });
  calTasks.innerHTML = "";
  if (tasks.length === 0) {
    calEmpty.hidden = false;
  } else {
    calEmpty.hidden = true;
    for (const t of tasks) {
      const li = createTaskLi(t);
      // calendar list: hide meta + actions for compact feel
      li.querySelector(".task-actions").remove();
      li.querySelector(".task-meta")?.remove();
      calTasks.appendChild(li);
    }
  }
  calSheetTitle.textContent = d === iso(new Date()) ? "СЕГОДНЯ" : d.split("-").reverse().join(".");
}

// ---------- Global search ----------
let searchTimer = null;
globalSearchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runGlobalSearch, 150);
});

async function runGlobalSearch() {
  if (state.view !== "search") return;
  const q = globalSearchInput.value.trim();
  searchResults.innerHTML = "";
  if (!q) {
    searchEmpty.hidden = true;
    return;
  }
  const res = await apiGetTasks({ filter: "all", q });
  if (res.length === 0) {
    searchEmpty.hidden = false;
    return;
  }
  searchEmpty.hidden = true;
  for (const t of res) {
    const li = createTaskLi(t);
    searchResults.appendChild(li);
  }
}

// ---------- Init ----------
async function init() {
  try {
    await loadLists();
    await refreshSidebarCounts();
    // default active list
    setActiveDrawerItem("list", "inbox");
  } catch (e) {
    alert("Ошибка загрузки. Проверь, что backend запущен. " + (e.message || ""));
  }
}

document.querySelector('.drawer-item[data-kind="smart"][data-id="today"]').addEventListener("click", () => setActiveDrawerItem("smart", "today"));

init();
