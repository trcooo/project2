const SETTINGS_KEY="tt.settings.v4";
const settings=(()=>{try{return{sort:"due",theme:"auto",...(JSON.parse(localStorage.getItem(SETTINGS_KEY)||"{}"))}}catch{return{sort:"due",theme:"auto"}}})();
const save=()=>localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));
const $=id=>document.getElementById(id);
const on=(el,ev,fn)=>el&&el.addEventListener(ev,fn);

function applyTheme(){
  const sysDark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme=settings.theme==="auto"?(sysDark?"dark":"light"):settings.theme;
  if(theme==="dark")document.documentElement.setAttribute("data-theme","dark");
  else document.documentElement.removeAttribute("data-theme");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme==="dark"?"#0b1220":"#eef1f6");
}
function cycleTheme(){
  settings.theme=settings.theme==="auto"?"dark":(settings.theme==="dark"?"light":"auto");
  save(); applyTheme();
}
applyTheme();
window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change",()=>{if(settings.theme==="auto")applyTheme()});

if("serviceWorker"in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}))}

const API_BASE="";
async function api(path,opt){const r=await fetch(API_BASE+path,opt);if(!r.ok)throw new Error(await r.text());return r.json()}
const apiGetFolders=()=>api("/api/folders");
const apiCreateFolder=p=>api("/api/folders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});
const apiGetLists=()=>api("/api/lists");
const apiCreateList=p=>api("/api/lists",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});
const apiGetTasks=params=>api("/api/tasks?"+new URLSearchParams(params).toString());
const apiCreateTask=p=>api("/api/tasks",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});
const apiPatchTask=(id,p)=>api("/api/tasks/"+encodeURIComponent(id),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});
const apiDeleteTask=id=>api("/api/tasks/"+encodeURIComponent(id),{method:"DELETE"});
const apiReorder=p=>api("/api/tasks/reorder",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});

const state={activeKind:"smart",activeId:"all",folders:[],lists:[],tasks:[],done:[],collapsed:new Set(),doneCollapsed:true,openSwipeId:null,composer:{listId:"inbox",dueDate:null,priority:0}};
const iso=d=>{const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),dd=String(d.getDate()).padStart(2,"0");return `${y}-${m}-${dd}`};
const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x};
const fmtDue=s=>{if(!s)return"";const t=iso(new Date()),tm=iso(addDays(new Date(),1));if(s===t)return"Сегодня";if(s===tm)return"Завтра";const [y,m,d]=s.split("-");return `${d}.${m}`};
const bucket=s=>{if(!s)return"Без даты";const t=iso(new Date()),tm=iso(addDays(new Date(),1));if(s===t)return"Сегодня";if(s===tm)return"Завтра";return"Позже"};
const parseQuick=raw=>{const tags=[],kept=[];let pr=null;for(const p of raw.trim().split(/\s+/)){if(/^#\S+/.test(p)){tags.push(p.replace(/^#/,""));continue}const m=p.match(/^!([1-3])$/);if(m){pr=parseInt(m[1],10);continue}kept.push(p)}return{title:kept.join(" ").trim(),tags,priority:pr}};

function applyResponsive(){
  const desktop=window.matchMedia("(min-width: 1024px)").matches;
  if(desktop){$("drawer").hidden=false;$("drawerBackdrop").hidden=true}
  else{ if(!$("drawerBackdrop").hidden) return; $("drawer").hidden=true }
}
window.addEventListener("resize",applyResponsive);

function openDrawer(){ if(window.matchMedia("(min-width: 1024px)").matches) return; $("drawer").hidden=false; $("drawerBackdrop").hidden=false }
function closeDrawer(){ if(window.matchMedia("(min-width: 1024px)").matches) return; $("drawer").hidden=true; $("drawerBackdrop").hidden=true }

function setActive(kind,id){
  state.activeKind=kind; state.activeId=id;
  document.querySelectorAll(".drawer-item").forEach(b=>b.classList.toggle("active", b.dataset.kind===kind && b.dataset.id===id));
  if(kind==="list") state.composer.listId=id;
  closeDrawer();
  $("pageTitle").textContent = kind==="smart"?(id==="all"?"Все":id==="today"?"Сегодня":"Следующие 7"):(state.lists.find(l=>l.id===id)?.title||"Входящие");
  loadTasks();
}

function renderLists(){
  const el=$("listsContainer"); if(!el) return; el.innerHTML="";
  // no folder grouping for this compact build; just list
  for(const l of state.lists){
    const b=document.createElement("button");
    b.className="drawer-item"; b.dataset.kind="list"; b.dataset.id=l.id;
    b.innerHTML=`<span class="di-emoji">${l.emoji||"📌"}</span><span class="di-title">${l.title}</span><span class="di-count" data-count="${l.id}">—</span>`;
    b.addEventListener("click",()=>setActive("list",l.id));
    el.appendChild(b);
  }
}

function renderFolderSelect(){
  const sel=$("folderSelect"); if(!sel) return;
  sel.innerHTML='<option value="">Без папки</option>';
  for(const f of state.folders){const o=document.createElement("option");o.value=f.id;o.textContent=`${f.emoji||"📁"} ${f.title}`;sel.appendChild(o)}
}

function openSheet(b,s){$(b).hidden=false;$(s).hidden=false}
function closeSheet(b,s){$(b).hidden=true;$(s).hidden=true}

function closeOpenSwipe(except=null){
  if(!state.openSwipeId) return;
  if(except && state.openSwipeId===except) return;
  document.querySelector(`.task[data-id="${state.openSwipeId}"] .task-card`)?.style.setProperty("transform","translateX(0)");
  state.openSwipeId=null;
}
document.addEventListener("click",(e)=>{
  if(!state.openSwipeId) return;
  const row=document.querySelector(`.task[data-id="${state.openSwipeId}"]`);
  if(row && !row.contains(e.target)) closeOpenSwipe();
});

function attachSwipe(li,card,t){
  let sx=0,sy=0,dx=0,dy=0,drag=false,pid=null; const OPEN=110,TH=60;
  const down=e=>{pid=e.pointerId;sx=e.clientX;sy=e.clientY;dx=dy=0;drag=true;card.style.transition="none";card.setPointerCapture(pid);closeOpenSwipe(t.id)};
  const move=e=>{if(!drag)return;dx=e.clientX-sx;dy=e.clientY-sy;if(Math.abs(dy)>14&&Math.abs(dy)>Math.abs(dx)){up(e,true);return}const x=Math.max(-OPEN,Math.min(OPEN,dx));card.style.transform=`translateX(${x}px)`};
  const reset=()=>{card.style.transition="transform 160ms ease";card.style.transform="translateX(0)"};
  const openL=()=>{card.style.transition="transform 160ms ease";card.style.transform=`translateX(${OPEN}px)`;state.openSwipeId=t.id};
  const openR=()=>{card.style.transition="transform 160ms ease";card.style.transform=`translateX(${-OPEN}px)`;state.openSwipeId=t.id};
  const up=(e,c=false)=>{if(!drag)return;drag=false;try{card.releasePointerCapture(pid)}catch{}card.style.transition="transform 160ms ease";if(c){reset();return}if(dx>TH){openL();return}if(dx<-TH){openR();return}reset()};
  on(card,"pointerdown",down);on(card,"pointermove",move);on(card,"pointerup",up);on(card,"pointercancel",e=>up(e,true));
}

function enableDrag(li,card,id){
  card.draggable=true;
  on(card,"dragstart",(e)=>{li.classList.add("dragging");e.dataTransfer.setData("text/plain",id);e.dataTransfer.effectAllowed="move"});
  on(card,"dragend",()=>li.classList.remove("dragging"));
}

function getAfter(container,y){
  const els=[...container.querySelectorAll(".task:not(.dragging)")];
  let best={o:-1e9,el:null};
  for(const el of els){
    const b=el.getBoundingClientRect();
    const off=y-b.top-b.height/2;
    if(off<0 && off>best.o) best={o:off,el};
  }
  return best.el;
}
async function persistOrder(){
  if(!(settings.sort==="manual" && state.activeKind==="list")) return;
  const ids=[...document.querySelectorAll("#groups .task")].map(x=>x.dataset.id).filter(Boolean);
  if(!ids.length) return;
  await apiReorder({listId:state.activeId,orderedIds:ids});
  await loadTasks();
}
function setupDrop(){
  if(!(settings.sort==="manual" && state.activeKind==="list")) return;
  document.querySelectorAll("#groups .tasks").forEach(ul=>{
    on(ul,"dragover",(e)=>{e.preventDefault();const drag=document.querySelector(".task.dragging");if(!drag)return;const after=getAfter(ul,e.clientY);if(!after)ul.appendChild(drag);else ul.insertBefore(drag,after)});
    on(ul,"drop",(e)=>{e.preventDefault();persistOrder()});
  });
}

function taskRow(t){
  const li=document.createElement("li"); li.className="task"+(t.completed?" completed":""); li.dataset.id=t.id;
  const actions=document.createElement("div"); actions.className="swipe-actions";
  const ok=document.createElement("button"); ok.className="action-btn complete"; ok.textContent="✓";
  const del=document.createElement("button"); del.className="action-btn delete"; del.textContent="🗑";
  actions.appendChild(ok); actions.appendChild(del);

  const card=document.createElement("div"); card.className="task-card";
  const cb=document.createElement("div"); cb.className="checkbox"+(t.completed?" checked":"");
  const main=document.createElement("div"); main.className="task-main";
  const title=document.createElement("div"); title.className="task-title";
  if(t.priority>0){const f=document.createElement("span");f.className="flag";f.textContent=t.priority===3?"!!!":t.priority===2?"!!":"!";title.appendChild(f)}
  const tt=document.createElement("span"); tt.textContent=t.title; title.appendChild(tt);
  const meta=document.createElement("div"); meta.className="task-meta";
  const list=state.lists.find(l=>l.id===t.listId);
  if(list){const s=document.createElement("span");s.textContent=`${list.emoji} ${list.title}`;meta.appendChild(s)}
  (t.tags||[]).slice(0,3).forEach(tag=>{const c=document.createElement("span");c.className="chipTag";c.textContent="#"+tag;meta.appendChild(c)});
  main.appendChild(title); if(meta.childNodes.length) main.appendChild(meta);
  const due=document.createElement("div"); due.className="due"; due.textContent=fmtDue(t.dueDate);
  const right=document.createElement("div"); right.className="task-actions";
  const bE=document.createElement("button"); bE.className="small-btn"; bE.textContent="✎";
  const bD=document.createElement("button"); bD.className="small-btn"; bD.textContent="🗑";
  right.appendChild(bE); right.appendChild(bD);
  card.appendChild(cb); card.appendChild(main); card.appendChild(due); card.appendChild(right);
  li.appendChild(actions); li.appendChild(card);

  attachSwipe(li,card,t);
  on(ok,"click",async(e)=>{e.stopPropagation();await apiPatchTask(t.id,{completed:true});closeOpenSwipe();await refreshCounts();await loadTasks()});
  on(del,"click",async(e)=>{e.stopPropagation();if(!confirm("Удалить?"))return;await apiDeleteTask(t.id);closeOpenSwipe();await refreshCounts();await loadTasks()});
  on(cb,"click",async(e)=>{e.stopPropagation();await apiPatchTask(t.id,{completed:!t.completed});await refreshCounts();await loadTasks()});
  on(bD,"click",async(e)=>{e.stopPropagation();if(!confirm("Удалить?"))return;await apiDeleteTask(t.id);await refreshCounts();await loadTasks()});
  on(bE,"click",(e)=>{e.stopPropagation();const nt=prompt("Изменить",t.title);if(nt===null)return;const val=nt.trim();if(!val)return;apiPatchTask(t.id,{title:val}).then(loadTasks)});

  if(settings.sort==="manual" && state.activeKind==="list" && !t.completed) enableDrag(li,card,t.id);
  return li;
}

function groupTasks(ts){
  if(settings.sort==="manual") return [{key:"all",title:"Все",items:ts}];
  const m=new Map();
  ts.forEach(t=>{const k=bucket(t.dueDate); if(!m.has(k))m.set(k,[]); m.get(k).push(t)});
  const order=["Сегодня","Завтра","Позже","Без даты"];
  return order.filter(k=>m.has(k)).map(k=>({key:k,title:k,items:m.get(k)}));
}

function render(){
  const groups=$("groups"); const done=$("completedTasks"); const empty=$("emptyState");
  groups.innerHTML=""; done.innerHTML="";
  empty.hidden=!(state.tasks.length===0 && state.done.length===0);
  groupTasks(state.tasks).forEach(g=>{
    const sec=document.createElement("section");
    const head=document.createElement("div"); head.className="section-head"; head.textContent=g.title;
    const ul=document.createElement("ul"); ul.className="tasks";
    if(!state.collapsed.has(g.key)) g.items.forEach(t=>ul.appendChild(taskRow(t)));
    sec.appendChild(head); sec.appendChild(ul); groups.appendChild(sec);
  });
  $("completedCount").textContent=String(state.done.length);
  $("completedChevron").textContent=state.doneCollapsed?"▸":"▾";
  if(!state.doneCollapsed) state.done.forEach(t=>done.appendChild(taskRow(t)));
  setupDrop();
}

on($("completedHead"),"click",()=>{state.doneCollapsed=!state.doneCollapsed;render()});

async function loadTasks(){
  closeOpenSwipe();
  const q=$("searchInput").value.trim();
  const base={filter:"active",sort:settings.sort};
  const done={filter:"completed",sort:settings.sort};
  if(q){base.q=q;done.q=q}
  const today=iso(new Date()), nextTo=iso(addDays(new Date(),6));
  if(state.activeKind==="smart"){
    if(state.activeId==="today"){base.due=today;done.due=today}
    if(state.activeId==="next7"){base.due_from=today;base.due_to=nextTo;done.due_from=today;done.due_to=nextTo}
  } else { base.list_id=state.activeId; done.list_id=state.activeId }
  const [a,d]=await Promise.all([apiGetTasks(base), apiGetTasks(done)]);
  state.tasks=a; state.done=d;
  render();
}

async function refreshCounts(){
  const today=iso(new Date()), nextTo=iso(addDays(new Date(),6));
  const [all,todayArr,next7Arr]=await Promise.all([
    apiGetTasks({filter:"active",sort:"created"}),
    apiGetTasks({filter:"active",due:today,sort:"created"}),
    apiGetTasks({filter:"active",due_from:today,due_to:nextTo,sort:"created"})
  ]);
  $("countAll").textContent=String(all.length);
  $("countToday").textContent=String(todayArr.length);
  $("countNext7").textContent=String(next7Arr.length);
  for(const l of state.lists){
    const r=await apiGetTasks({filter:"active",list_id:l.id,sort:"created"});
    document.querySelector(`[data-count="${l.id}"]`)?.replaceChildren(document.createTextNode(String(r.length)));
  }
}

async function loadMeta(){
  state.folders=await apiGetFolders();
  state.lists=await apiGetLists();
  renderLists();
  renderFolderSelect();
}

function setSort(s){settings.sort=s;save();closeSheet("sortBackdrop","sortSheet");loadTasks()}
function setSortLabel(){ /* icon only */ }

on($("btnTheme"),"click",cycleTheme);
on($("btnMenu"),"click",openDrawer);
on($("drawerBackdrop"),"click",closeDrawer);

document.querySelectorAll('.drawer-item[data-kind="smart"]').forEach(b=>on(b,"click",()=>setActive("smart",b.dataset.id)));

on($("btnSort"),"click",()=>openSheet("sortBackdrop","sortSheet"));
on($("sortBackdrop"),"click",()=>closeSheet("sortBackdrop","sortSheet"));
on($("sortCancel"),"click",()=>closeSheet("sortBackdrop","sortSheet"));
document.querySelectorAll('.sheet-option[data-sort]').forEach(b=>on(b,"click",()=>{settings.sort=b.dataset.sort;save();closeSheet("sortBackdrop","sortSheet");loadTasks()}));

on($("btnAdd"),"click",()=>openSheet("addBackdrop","addSheet"));
on($("addBackdrop"),"click",()=>closeSheet("addBackdrop","addSheet"));
on($("addCancel"),"click",()=>closeSheet("addBackdrop","addSheet"));

on($("addListBtn"),"click",()=>{closeSheet("addBackdrop","addSheet");openSheet("listBackdrop","listSheet");$("listTitle").focus()});
on($("btnListCancel"),"click",()=>closeSheet("listBackdrop","listSheet"));
on($("listBackdrop"),"click",()=>closeSheet("listBackdrop","listSheet"));
on($("listForm"),"submit",async(e)=>{e.preventDefault();const title=$("listTitle").value.trim();const emoji=($("listEmoji").value||"📌").trim()||"📌";const folderId=$("folderSelect").value||null;if(!title){$("listHint").hidden=false;return}await apiCreateList({title,emoji,folderId});closeSheet("listBackdrop","listSheet");await loadMeta();await refreshCounts()});

on($("addFolderBtn"),"click",()=>{closeSheet("addBackdrop","addSheet");openSheet("folderBackdrop","folderSheet");$("folderTitle").focus()});
on($("btnFolderCancel"),"click",()=>closeSheet("folderBackdrop","folderSheet"));
on($("folderBackdrop"),"click",()=>closeSheet("folderBackdrop","folderSheet"));
on($("folderForm"),"submit",async(e)=>{e.preventDefault();const title=$("folderTitle").value.trim();const emoji=($("folderEmoji").value||"📁").trim()||"📁";if(!title){$("folderHint").hidden=false;return}await apiCreateFolder({title,emoji});closeSheet("folderBackdrop","folderSheet");await loadMeta();await refreshCounts()});

on($("compListBtn"),"click",()=>{const pl=$("pickList");pl.innerHTML="";state.lists.forEach(l=>{const btn=document.createElement("button");btn.className="sheet-option";btn.textContent=`${l.emoji} ${l.title}`;btn.onclick=()=>{state.composer.listId=l.id;closeSheet("pickBackdrop","pickSheet")};pl.appendChild(btn)});openSheet("pickBackdrop","pickSheet")});
on($("pickBackdrop"),"click",()=>closeSheet("pickBackdrop","pickSheet"));
on($("pickCancel"),"click",()=>closeSheet("pickBackdrop","pickSheet"));

on($("compDueBtn"),"click",()=>$("compDueDate").click());
on($("compDueDate"),"change",()=>state.composer.dueDate=$("compDueDate").value||null);
on($("compFlagBtn"),"click",()=>{state.composer.priority=(state.composer.priority+1)%4; $("compFlagBtn").style.opacity=state.composer.priority? "1":"0.75"});
$("compFlagBtn").style.opacity="0.75";

async function addTask(){
  const raw=$("compInput").value.trim(); if(!raw) return;
  const p=parseQuick(raw); if(!p.title) return;
  let due=state.composer.dueDate;
  if(state.activeKind==="smart" && state.activeId==="today" && !due) due=iso(new Date());
  const listId=state.activeKind==="list"?state.activeId:(state.composer.listId||"inbox");
  const priority=p.priority ?? state.composer.priority;
  await apiCreateTask({title:p.title,listId,dueDate:due,tags:p.tags,priority,notes:null});
  $("compInput").value=""; state.composer.dueDate=null; $("compDueDate").value=""; state.composer.priority=0; $("compFlagBtn").style.opacity="0.75";
  await refreshCounts(); await loadTasks();
}
on($("compAddBtn"),"click",addTask);
on($("compInput"),"keydown",(e)=>{if(e.key==="Enter"){e.preventDefault();addTask()}});
on($("searchInput"),"input",loadTasks);

document.querySelectorAll(".bn-item").forEach(b=>on(b,"click",()=>{document.querySelectorAll(".bn-item").forEach(x=>x.classList.toggle("active",x===b));document.querySelectorAll(".view").forEach(v=>v.classList.remove("view-active")); if(b.dataset.view==="search"){$("viewSearch").classList.add("view-active");$("globalSearchInput").focus();} else {$("viewTasks").classList.add("view-active"); loadTasks();}}));

on($("globalSearchInput"),"input",async()=>{const q=$("globalSearchInput").value.trim();$("searchResults").innerHTML=""; if(!q){$("searchEmpty").hidden=true;return}const res=await apiGetTasks({filter:"all",q,sort:"created"}); if(!res.length){$("searchEmpty").hidden=false;return} $("searchEmpty").hidden=true; res.slice(0,50).forEach(t=>$("searchResults").appendChild(taskRow(t)))});

(async()=>{try{applyResponsive();await loadMeta();await refreshCounts();setActive("smart","all")}catch(e){alert("Ошибка: "+(e.message||e))}})();
