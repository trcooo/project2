// Single service: frontend is served by FastAPI, API is same-origin
const API_BASE = "";

const state = {
  filter: "all",
  tasks: [],
  search: "",
  editingId: null,
};

const elTasks = document.getElementById("tasks");
const elEmpty = document.getElementById("emptyState");
const elCount = document.getElementById("countText");
const elSearch = document.getElementById("searchInput");

const elFab = document.getElementById("fabAdd");
const elSheet = document.getElementById("sheet");
const elBackdrop = document.getElementById("sheetBackdrop");
const elForm = document.getElementById("taskForm");
const elTitle = document.getElementById("taskTitle");
const elHint = document.getElementById("hint");
const btnCancel = document.getElementById("btnCancel");

const filterButtons = Array.from(document.querySelectorAll(".chip[data-filter]"));

function fmtDate(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function showSheet(mode, task = null) {
  state.editingId = mode === "edit" ? task.id : null;
  elTitle.value = task ? task.title : "";
  elHint.hidden = true;

  elBackdrop.hidden = false;
  elSheet.hidden = false;

  setTimeout(() => elTitle.focus(), 0);
}

function hideSheet() {
  elBackdrop.hidden = true;
  elSheet.hidden = true;
  state.editingId = null;
  elTitle.value = "";
  elHint.hidden = true;
}

function setActiveFilter(filter) {
  state.filter = filter;
  filterButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.filter === filter));
  loadAndRender();
}

async function apiGetTasks(filter) {
  const r = await fetch(`${API_BASE}/api/tasks?filter=${encodeURIComponent(filter)}`);
  if (!r.ok) throw new Error("Не удалось загрузить задачи");
  return r.json();
}

async function apiCreateTask(title) {
  const r = await fetch(`${API_BASE}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || "Не удалось создать задачу");
  }
  return r.json();
}

async function apiPatchTask(id, patch) {
  const r = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error("Не удалось обновить задачу");
  return r.json();
}

async function apiDeleteTask(id) {
  const r = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error("Не удалось удалить задачу");
  return r.json();
}

function getVisibleTasks() {
  const q = state.search.trim().toLowerCase();
  if (!q) return state.tasks;
  return state.tasks.filter(t => t.title.toLowerCase().includes(q));
}

function render() {
  const tasks = getVisibleTasks();

  const total = state.tasks.length;
  const active = state.tasks.filter(t => !t.completed).length;
  const completed = total - active;

  elCount.textContent =
    state.filter === "all" ? `Всего: ${total}` :
    state.filter === "active" ? `Активные: ${active}` :
    `Выполненные: ${completed}`;

  elTasks.innerHTML = "";

  if (tasks.length === 0) {
    elEmpty.hidden = false;
    return;
  }
  elEmpty.hidden = true;

  for (const t of tasks) {
    const li = document.createElement("li");
    li.className = "task" + (t.completed ? " completed" : "");

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
    meta.textContent = `Создано: ${fmtDate(t.createdAt)}` + (t.completedAt ? ` • Выполнено: ${fmtDate(t.completedAt)}` : "");

    main.appendChild(title);
    main.appendChild(meta);

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
    li.appendChild(actions);

    cb.addEventListener("click", async () => {
      await apiPatchTask(t.id, { completed: !t.completed });
      await loadAndRender(false);
    });

    btnDel.addEventListener("click", async () => {
      const ok = confirm("Удалить задачу?");
      if (!ok) return;
      await apiDeleteTask(t.id);
      await loadAndRender(false);
    });

    btnEdit.addEventListener("click", () => showSheet("edit", t));
    title.addEventListener("dblclick", () => showSheet("edit", t));

    elTasks.appendChild(li);
  }
}

async function loadAndRender(showErrors = true) {
  try {
    state.tasks = await apiGetTasks(state.filter);
    render();
  } catch (e) {
    if (showErrors) alert(e.message || "Ошибка");
  }
}

filterButtons.forEach(btn => btn.addEventListener("click", () => setActiveFilter(btn.dataset.filter)));

elSearch.addEventListener("input", () => { state.search = elSearch.value; render(); });

elFab.addEventListener("click", () => showSheet("create"));

elBackdrop.addEventListener("click", hideSheet);
btnCancel.addEventListener("click", hideSheet);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !elSheet.hidden) hideSheet;
});

elForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const titleText = elTitle.value.trim();
  if (!titleText) {
    elHint.hidden = false;
    elTitle.focus();
    return;
  }

  try {
    if (state.editingId) {
      await apiPatchTask(state.editingId, { title: titleText });
    } else {
      await apiCreateTask(titleText);
    }
    hideSheet();
    await loadAndRender(false);
  } catch (err) {
    alert(err.message || "Ошибка сохранения");
  }
});

setActiveFilter("all");
