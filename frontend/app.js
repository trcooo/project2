// TickTick-like UI v3 (no frameworks)

const API_BASE = "";

// ---------- Local settings ----------
const SETTINGS_KEY = "tt.settings.v1";
function loadSettings(){
  try{
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  }catch{ return {}; }
}
function saveSettings(s){
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
const settings = { sort: "due", ...loadSettings() };

// ---------- State ----------
const state = {
  view: "tasks",
  activeKind: "list",
  activeId: "inbox",
  lists: [],
  tasks: [],
  completed: [],
  collapsed: new Set(),
  completedCollapsed: true,
  editingTaskId: null,
  editingTask: null,
  calendar: {
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
    selected: new Date(),
  },
  composer: {
    listId: "inbox",
    dueDate: null,
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

const btnSort = $("btnSort");
const btnQuickAdd = $("btnQuickAdd");

const groupsEl = $("groups");
const completedHead = $("completedHead");
const completedChevron = $("completedChevron");
const completedCount = $("completedCount");
const completedTasksEl = $("completedTasks");
const emptyState = $("emptyState");

const fabAdd = $("fabAdd");

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

// Sort sheet
const sortBackdrop = $("sortBackdrop");
const sortSheet = $("sortSheet");
const sortCancel = $("sortCancel");
const sortOptions = Array.from(document.querySelectorAll(".sheet-option[data-sort]"));

// Composer
const composer = $("composer");
const compInput = $("compInput");
const compListBtn = $("compListBtn");
const compDueBtn = $("compDueBtn");
const compAddBtn = $("compAddBtn");
const compDueDate = $("compDueDate");

// List picker for composer
const pickBackdrop = $("pickBackdrop");
const pickSheet = $("pickSheet");
const pickList = $("pickList");
const pickCancel = $("pickCancel");

// ---------- Utils ----------
function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }

function fmtDue(dueStr) {
  if (!dueStr) return "";
  const t = iso(new Date());
  const tm = iso(addDays(new Date(), 1));
  if (dueStr === t) return "Сегодня";
  if (dueStr === tm) return "Завтра";
  const [y,m,d] = dueStr.split("-");
  return `${d}.${m}`;
}
function bucketTitle(dueStr) {
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
function setBtnSortLabel(){
  btnSort.textContent = settings.sort === "created" ? "по созданию…" : "по дате…";
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

// ---------- Responsive: persistent drawer on desktop ----------
function applyResponsiveLayout() {
  const desktop = window.matchMedia("(min-width: 1024px)").matches;
  if (desktop) {
    drawer.hidden = false;
    drawerBackdrop.hidden = true;
  } else {
    // keep hidden by default unless opened
    if (!drawerBackdrop.hidden) return;
    drawer.hidden = true;
  }
}
window.addEventListener("resize", applyResponsiveLayout);

// ---------- Drawer ----------
function openDrawer() {
  if (window.matchMedia("(min-width: 1024px)").matches) return;
  drawer.hidden = false;
  drawerBackdrop.hidden = false;
}
function closeDrawer() {
  if (window.matchMedia("(min-width: 1024px)").matches) return;
  drawer.hidden = true;
  drawerBackdrop.hidden = true;
}
btnMenu.addEventListener("click", openDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);

// ---------- Views ----------
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

function setView(view) {
  state.view = view;
  bnItems.forEach(b => b.classList.toggle("active", b.dataset.view === view));

  [viewTasks, viewCalendar, viewSearch, viewFocus].forEach(v => v.classList.remove("view-active"));
  if (view === "tasks") viewTasks.classList.add("view-active");
  if (view === "calendar") viewCalendar.classList.add("view-active");
  if (view === "search") viewSearch.classList.add("view-active");
  if (view === "focus") viewFocus.classList.add("view-active");

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
function setActiveDrawerItem(kind, id) {
  state.activeKind = kind;
  state.activeId = id;

  const items = Array.from(document.querySelectorAll(".drawer-item"));
  items.forEach(it => {
    const match = it.dataset.kind === kind && it.dataset.id === id;
    it.classList.toggle("active", match);
  });

  // default composer list = current list
  if (kind === "list") state.composer.listId = id;

  updateHeaderTitle();
  closeDrawer();
  setView("tasks");
}

function renderLists() {
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

  const active = document.querySelector(\`.drawer-item[data-kind="\${state.activeKind}"][data-id="\${state.activeId}"]\`);
  if (active) active.classList.add("active");
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

function renderPickList(){
  pickList.innerHTML = "";
  for (const l of state.lists) {
    const b = document.createElement("button");
    b.className = "sheet-option";
    b.textContent = `${l.emoji || "📌"} ${l.title}`;
    b.addEventListener("click", () => {
      state.composer.listId = l.id;
      closePickSheet();
    });
    pickList.appendChild(b);
  }
}

// ---------- Sort sheet ----------
function openSortSheet(){
  sortBackdrop.hidden = false;
  sortSheet.hidden = false;
}
function closeSortSheet(){
  sortBackdrop.hidden = true;
  sortSheet.hidden = true;
}
btnSort.addEventListener("click", openSortSheet);
sortBackdrop.addEventListener("click", closeSortSheet);
sortCancel.addEventListener("click", closeSortSheet);

sortOptions.forEach(btn => {
  btn.addEventListener("click", async () => {
    settings.sort = btn.dataset.sort;
    saveSettings(settings);
    setBtnSortLabel();
    closeSortSheet();
    await loadTasksForCurrent();
  });
});

// ---------- Quick composer (TickTick-like) ----------
function openPickSheet(){
  renderPickList();
  pickBackdrop.hidden = false;
  pickSheet.hidden = false;
}
function closePickSheet(){
  pickBackdrop.hidden = true;
  pickSheet.hidden = true;
}
compListBtn.addEventListener("click", openPickSheet);
pickBackdrop.addEventListener("click", closePickSheet);
pickCancel.addEventListener("click", closePickSheet);

compDueBtn.addEventListener("click", () => {
  // open browser date picker
  compDueDate.click();
});
compDueDate.addEventListener("change", () => {
  state.composer.dueDate = compDueDate.value ? compDueDate.value : null;
});

async function addFromComposer(){
  const title = compInput.value.trim();
  if (!title) return;

  let due = state.composer.dueDate;
  // If smart today active, default to today
  if (state.activeKind === "smart" && state.activeId === "today" && !due) {
    due = iso(new Date());
  }

  const listId = state.activeKind === "list" ? state.activeId : (state.composer.listId || "inbox");

  await apiCreateTask({ title, listId, dueDate: due });
  compInput.value = "";
  state.composer.dueDate = null;
  compDueDate.value = "";
  await refreshSidebarCounts();
  await loadTasksForCurrent();
  if (state.view === "calendar") loadCalendarTasks();
}
compAddBtn.addEventListener("click", () => addFromComposer());
compInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addFromComposer();
  }
});

btnQuickAdd.addEventListener("click", () => compInput.focus());
fabAdd.addEventListener("click", () => compInput.focus());

// ---------- Edit task sheet ----------
function openEditSheet(task) {
  state.editingTaskId = task.id;
  state.editingTask = task;

  taskTitle.value = task.title;
  hint.hidden = true;

  toolDate.value = task.dueDate || "";
  listSelect.value = task.listId;

  sheetBackdrop.hidden = false;
  sheet.hidden = false;
  setTimeout(() => taskTitle.focus(), 0);
}

function closeEditSheet() {
  sheetBackdrop.hidden = true;
  sheet.hidden = true;
  state.editingTaskId = null;
  state.editingTask = null;
  taskTitle.value = "";
  toolDate.value = "";
  hint.hidden = true;
}

sheetBackdrop.addEventListener("click", closeEditSheet);
btnCancel.addEventListener("click", closeEditSheet);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!sheet.hidden) closeEditSheet();
    if (!listSheet.hidden) closeListSheet();
    if (!sortSheet.hidden) closeSortSheet();
    if (!pickSheet.hidden) closePickSheet();
    closeDrawer();
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
    await apiPatchTask(state.editingTaskId, { title, dueDate, listId });
    closeEditSheet();
    await refreshSidebarCounts();
    await loadTasksForCurrent();
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
  const groups = new Map();
  for (const t of tasks) {
    const key = bucketTitle(t.dueDate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const order = ["Сегодня", "Завтра", "Позже", "Без даты"];
  return order.filter(k => groups.has(k)).map(k => ({ key: k, title: k, items: groups.get(k) }));
}

// Swipe handling
function attachSwipe(li, card, task) {
  let startX = 0, startY = 0, dragging = false, dx = 0, dy = 0;
  let pointerId = null;

  const THRESH = 90;
  const CLAMP = 140;

  function onDown(e){
    // only primary button / touch
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    dx = 0; dy = 0;
    card.style.transition = "none";
    card.setPointerCapture(pointerId);
  }
  function onMove(e){
    if (!dragging) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;

    // If vertical scroll dominates, cancel swipe
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
      onUp(e, true);
      return;
    }
    // clamp horizontal
    const x = Math.max(-CLAMP, Math.min(CLAMP, dx));
    card.style.transform = `translateX(${x}px)`;
  }

  async function complete(){
    await apiPatchTask(task.id, { completed: true });
  }
  async function remove(){
    await apiDeleteTask(task.id);
  }

  function reset(){
    card.style.transition = "transform 140ms ease";
    card.style.transform = "translateX(0)";
  }

  async function onUp(e, cancel=false){
    if (!dragging) return;
    dragging = false;
    try { card.releasePointerCapture(pointerId); } catch {}
    card.style.transition = "transform 140ms ease";

    if (cancel) { reset(); return; }

    if (dx > THRESH) {
      card.style.transform = `translateX(${CLAMP}px)`;
      await complete();
      await refreshSidebarCounts();
      await loadTasksForCurrent();
      if (state.view === "calendar") loadCalendarTasks();
      reset();
      return;
    }
    if (dx < -THRESH) {
      card.style.transform = `translateX(${-CLAMP}px)`;
      await remove();
      await refreshSidebarCounts();
      await loadTasksForCurrent();
      if (state.view === "calendar") loadCalendarTasks();
      reset();
      return;
    }
    reset();
  }

  card.addEventListener("pointerdown", onDown);
  card.addEventListener("pointermove", onMove);
  card.addEventListener("pointerup", onUp);
  card.addEventListener("pointercancel", (e) => onUp(e, true));
}

function createTaskLi(t, compact = false) {
  const li = document.createElement("li");
  li.className = "task" + (t.completed ? " completed" : "");

  const bg = document.createElement("div");
  bg.className = "swipe-bg";
  bg.innerHTML = `<div class="left">✓ Выполнить</div><div class="right">🗑 Удалить</div>`;

  const card = document.createElement("div");
  card.className = "task-card";

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

  card.appendChild(cb);
  card.appendChild(main);
  card.appendChild(due);
  card.appendChild(actions);

  li.appendChild(bg);
  li.appendChild(card);

  // click handlers
  cb.addEventListener("click", async (e) => {
    e.stopPropagation();
    await apiPatchTask(t.id, { completed: !t.completed });
    await refreshSidebarCounts();
    await loadTasksForCurrent();
    if (state.view === "calendar") loadCalendarTasks();
  });

  btnEdit.addEventListener("click", (e) => { e.stopPropagation(); openEditSheet(t); });
  title.addEventListener("dblclick", () => openEditSheet(t));

  btnDel.addEventListener("click", async (e) => {
    e.stopPropagation();
    const ok = confirm("Удалить задачу?");
    if (!ok) return;
    await apiDeleteTask(t.id);
    await refreshSidebarCounts();
    await loadTasksForCurrent();
    if (state.view === "calendar") loadCalendarTasks();
  });

  // swipe only for active tasks (feel free to allow also for completed)
  attachSwipe(li, card, t);

  return li;
}

function renderTasksScreen() {
  groupsEl.innerHTML = "";
  completedTasksEl.innerHTML = "";

  const active = state.tasks;
  const completed = state.completed;

  if (active.length === 0 && completed.length === 0) emptyState.hidden = false;
  else emptyState.hidden = true;

  const grouped = groupTasks(active);

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
    if (!state.collapsed.has(g.key)) for (const t of g.items) ul.appendChild(createTaskLi(t));

    section.appendChild(head);
    section.appendChild(ul);
    groupsEl.appendChild(section);
  }

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
  const baseParams = { filter: "active", sort: settings.sort };
  const completedParams = { filter: "completed", sort: settings.sort };

  if (q) { baseParams.q = q; completedParams.q = q; }

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
  const today = iso(new Date());
  const todayActive = await apiGetTasks({ filter: "active", due: today, sort: "created" });
  countToday.textContent = String(todayActive.length);

  // per list counts (sequential but small; can optimize later with /api/stats)
  for (const l of state.lists) {
    const res = await apiGetTasks({ filter: "active", list_id: l.id, sort: "created" });
    const el = document.querySelector(`[data-count="${l.id}"]`);
    if (el) el.textContent = String(res.length);
  }
}

// ---------- Calendar ----------
function startOfMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const dow = first.getDay(); // 0=Sun
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
  const tasks = await apiGetTasks({ filter: "active", due: d, sort: "created" });
  calTasks.innerHTML = "";
  if (tasks.length === 0) {
    calEmpty.hidden = false;
  } else {
    calEmpty.hidden = true;
    for (const t of tasks) {
      const li = createTaskLi(t);
      li.querySelector(".task-actions")?.remove();
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
  const res = await apiGetTasks({ filter: "all", q, sort: "created" });
  if (res.length === 0) {
    searchEmpty.hidden = false;
    return;
  }
  searchEmpty.hidden = true;
  for (const t of res) searchResults.appendChild(createTaskLi(t));
}

// ---------- Init ----------
document.querySelector('.drawer-item[data-kind="smart"][data-id="today"]').addEventListener("click", () => setActiveDrawerItem("smart", "today"));

async function init() {
  setBtnSortLabel();
  applyResponsiveLayout();

  try {
    await loadLists();
    await refreshSidebarCounts();
    setActiveDrawerItem("list", "inbox");
  } catch (e) {
    alert("Ошибка загрузки. " + (e.message || ""));
  }
}
init();
