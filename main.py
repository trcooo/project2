from __future__ import annotations
import os, json
from datetime import datetime, timezone, date
from typing import Optional, List, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import (
    create_engine, MetaData, Table, Column,
    String, Boolean, BigInteger, Integer, Text,
    select, insert, update, delete, and_, case, text
)
from sqlalchemy.engine import Engine
from sqlalchemy import inspect

def normalize_database_url(url: str) -> str:
    return "postgresql://" + url[len("postgres://"):] if url.startswith("postgres://") else url

def get_engine() -> Engine:
    db_url = os.getenv("DATABASE_URL", "").strip()
    if db_url:
        db_url = normalize_database_url(db_url)
        if db_url.startswith("postgresql://") and "+psycopg2" not in db_url:
            db_url = db_url.replace("postgresql://", "postgresql+psycopg2://", 1)
    else:
        db_url = "sqlite:///./tasks.db"
    return create_engine(db_url, future=True, pool_pre_ping=True)

engine = get_engine()
metadata = MetaData()

folders = Table(
    "folders", metadata,
    Column("id", String, primary_key=True),
    Column("title", String, nullable=False),
    Column("emoji", String, nullable=False, server_default="📁"),
    Column("sort_order", Integer, nullable=False, server_default="0"),
    Column("created_at", BigInteger, nullable=False),
)

lists = Table(
    "lists", metadata,
    Column("id", String, primary_key=True),
    Column("title", String, nullable=False),
    Column("emoji", String, nullable=False, server_default="📌"),
    Column("sort_order", Integer, nullable=False, server_default="0"),
    Column("created_at", BigInteger, nullable=False),
    Column("folder_id", String, nullable=True),
)

tasks = Table(
    "tasks", metadata,
    Column("id", String, primary_key=True),
    Column("title", String, nullable=False),
    Column("completed", Boolean, nullable=False, server_default="false"),
    Column("created_at", BigInteger, nullable=False),
    Column("updated_at", BigInteger, nullable=False),
    Column("completed_at", BigInteger, nullable=True),
    Column("list_id", String, nullable=False),
    Column("due_date", String, nullable=True),
    Column("order_index", BigInteger, nullable=True),
    Column("priority", Integer, nullable=False, server_default="0"),
    Column("notes", Text, nullable=True),
    Column("tags_json", Text, nullable=False, server_default="[]"),
)

def now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())

def gen_id() -> str:
    return f"{now_ts()}_{os.urandom(4).hex()}"

def today_str() -> str:
    return date.today().isoformat()

def validate_date_str(d: Optional[str]) -> Optional[str]:
    if d is None: return None
    d = d.strip()
    if not d: return None
    try:
        datetime.strptime(d, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")
    return d

def parse_tags_json(s: str) -> List[str]:
    try:
        v = json.loads(s or "[]")
        if isinstance(v, list):
            return [x.strip() for x in v if isinstance(x, str) and x.strip()]
    except Exception:
        pass
    return []

def dumps_tags(tags: List[str]) -> str:
    clean = []
    for t in tags:
        tt = t.strip().lstrip("#")
        if tt: clean.append(tt)
    seen=set(); out=[]
    for t in clean:
        if t not in seen:
            seen.add(t); out.append(t)
    return json.dumps(out, ensure_ascii=False)

def ensure_columns(table_name: str, required: dict[str, str]) -> None:
    insp = inspect(engine)
    cols = {c["name"] for c in insp.get_columns(table_name)} if insp.has_table(table_name) else set()
    with engine.begin() as conn:
        for col, ddl in required.items():
            if col not in cols:
                conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN {ddl}"))

def init_db():
    metadata.create_all(engine)
    insp = inspect(engine)
    if insp.has_table("lists"):
        ensure_columns("lists", {"folder_id": "folder_id TEXT"})
    if insp.has_table("tasks"):
        ensure_columns("tasks", {
            "order_index": "order_index BIGINT",
            "priority": "priority INTEGER NOT NULL DEFAULT 0",
            "notes": "notes TEXT",
            "tags_json": "tags_json TEXT NOT NULL DEFAULT '[]'",
        })
init_db()

def seed_defaults():
    defaults_lists = [
        ("inbox", "Входящие", "📥", 10, None),
        ("welcome", "Добро пожаловать", "👋", 20, None),
        ("work", "Работа", "💼", 30, None),
        ("personal", "Личный", "🏠", 40, None),
    ]
    with engine.begin() as conn:
        for lid, title, emoji, order, folder_id in defaults_lists:
            if conn.execute(select(lists.c.id).where(lists.c.id == lid)).first():
                continue
            conn.execute(insert(lists).values(
                id=lid, title=title, emoji=emoji, sort_order=order,
                created_at=now_ts(), folder_id=folder_id
            ))
seed_defaults()

app = FastAPI(title="TickTick-like ToDo (v4-fixed)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

Filter = Literal["all", "active", "completed"]
Sort = Literal["due", "created", "manual"]

class FolderCreate(BaseModel):
    title: str = Field(min_length=1, max_length=60)
    emoji: str = Field(default="📁", min_length=1, max_length=4)

class FolderOut(BaseModel):
    id: str; title: str; emoji: str; sortOrder: int

class ListCreate(BaseModel):
    title: str = Field(min_length=1, max_length=60)
    emoji: str = Field(default="📌", min_length=1, max_length=4)
    folderId: Optional[str] = None

class ListOut(BaseModel):
    id: str; title: str; emoji: str; sortOrder: int; folderId: Optional[str] = None

class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    listId: str = Field(default="inbox")
    dueDate: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    priority: int = Field(default=0, ge=0, le=3)
    notes: Optional[str] = None

class TaskUpdate(BaseModel):
    title: Optional[str] = None
    completed: Optional[bool] = None
    listId: Optional[str] = None
    dueDate: Optional[Optional[str]] = None
    tags: Optional[List[str]] = None
    priority: Optional[int] = Field(default=None, ge=0, le=3)
    notes: Optional[Optional[str]] = None

class ReorderPayload(BaseModel):
    listId: str
    orderedIds: List[str]

class TaskOut(BaseModel):
    id: str; title: str; completed: bool
    createdAt: int; updatedAt: int; completedAt: Optional[int] = None
    listId: str; dueDate: Optional[str] = None
    orderIndex: Optional[int] = None
    tags: List[str] = Field(default_factory=list)
    priority: int = 0
    notes: Optional[str] = None

def to_folder_out(r): return FolderOut(id=r["id"], title=r["title"], emoji=r["emoji"], sortOrder=int(r["sort_order"]))
def to_list_out(r): return ListOut(id=r["id"], title=r["title"], emoji=r["emoji"], sortOrder=int(r["sort_order"]), folderId=r.get("folder_id"))
def to_task_out(r): 
    return TaskOut(
        id=r["id"], title=r["title"], completed=bool(r["completed"]),
        createdAt=int(r["created_at"]), updatedAt=int(r["updated_at"]),
        completedAt=(int(r["completed_at"]) if r["completed_at"] is not None else None),
        listId=r["list_id"], dueDate=r["due_date"],
        orderIndex=(int(r["order_index"]) if r.get("order_index") is not None else None),
        tags=parse_tags_json(r.get("tags_json") or "[]"),
        priority=int(r.get("priority") or 0),
        notes=r.get("notes")
    )

def ensure_list_exists(list_id: str):
    with engine.connect() as conn:
        if not conn.execute(select(lists.c.id).where(lists.c.id == list_id)).first():
            raise HTTPException(status_code=400, detail=f"List not found: {list_id}")

def ensure_folder_exists(folder_id: str):
    with engine.connect() as conn:
        if not conn.execute(select(folders.c.id).where(folders.c.id == folder_id)).first():
            raise HTTPException(status_code=400, detail=f"Folder not found: {folder_id}")

@app.get("/api/health")
def health(): return {"ok": True, "today": today_str()}

@app.get("/api/folders", response_model=List[FolderOut])
def get_folders():
    stmt = select(folders).order_by(folders.c.sort_order.asc(), folders.c.created_at.asc())
    with engine.connect() as conn:
        rows = conn.execute(stmt).mappings().all()
    return [to_folder_out(r) for r in rows]

@app.post("/api/folders", response_model=FolderOut)
def create_folder(payload: FolderCreate):
    title = payload.title.strip()
    if not title: raise HTTPException(status_code=400, detail="Title is empty")
    fid = gen_id(); emoji = payload.emoji.strip() or "📁"
    with engine.begin() as conn:
        conn.execute(insert(folders).values(id=fid,title=title,emoji=emoji,sort_order=50,created_at=now_ts()))
        row = conn.execute(select(folders).where(folders.c.id==fid)).mappings().first()
    return to_folder_out(row)

@app.get("/api/lists", response_model=List[ListOut])
def get_lists():
    stmt = select(lists).order_by(lists.c.sort_order.asc(), lists.c.created_at.asc())
    with engine.connect() as conn:
        rows = conn.execute(stmt).mappings().all()
    return [to_list_out(r) for r in rows]

@app.post("/api/lists", response_model=ListOut)
def create_list(payload: ListCreate):
    title = payload.title.strip()
    if not title: raise HTTPException(status_code=400, detail="Title is empty")
    lid = gen_id(); emoji = payload.emoji.strip() or "📌"
    folder_id = payload.folderId.strip() if payload.folderId else None
    if folder_id: ensure_folder_exists(folder_id)
    with engine.begin() as conn:
        conn.execute(insert(lists).values(id=lid,title=title,emoji=emoji,sort_order=50,created_at=now_ts(),folder_id=folder_id))
        row = conn.execute(select(lists).where(lists.c.id==lid)).mappings().first()
    return to_list_out(row)

@app.get("/api/tasks", response_model=List[TaskOut])
def list_tasks(filter: Filter="all", sort: Sort="due", list_id: Optional[str]=None, due: Optional[str]=None,
              due_from: Optional[str]=None, due_to: Optional[str]=None, q: Optional[str]=None,
              tag: Optional[str]=None, priority: Optional[int]=None):
    conds=[]
    if filter=="active": conds.append(tasks.c.completed.is_(False))
    elif filter=="completed": conds.append(tasks.c.completed.is_(True))
    if list_id: conds.append(tasks.c.list_id==list_id)
    if due is not None:
        dd = validate_date_str(due)
        conds.append(tasks.c.due_date==dd)
    if due_from is not None or due_to is not None:
        df = validate_date_str(due_from) if due_from else None
        dt = validate_date_str(due_to) if due_to else None
        conds.append(tasks.c.due_date.is_not(None))
        if df: conds.append(tasks.c.due_date>=df)
        if dt: conds.append(tasks.c.due_date<=dt)
    if q: conds.append(tasks.c.title.ilike(f"%{q.strip()}%"))
    if tag:
        t=tag.strip().lstrip("#")
        if t: conds.append(tasks.c.tags_json.ilike(f'%"{t}"%'))
    if priority is not None: conds.append(tasks.c.priority==int(priority))

    stmt = select(tasks)
    if conds: stmt = stmt.where(and_(*conds))

    if sort=="created":
        stmt = stmt.order_by(tasks.c.created_at.desc())
    elif sort=="manual":
        nulls_last = case((tasks.c.order_index.is_(None),1), else_=0)
        stmt = stmt.order_by(nulls_last.asc(), tasks.c.order_index.asc(), tasks.c.created_at.desc())
    else:
        nulls_last = case((tasks.c.due_date.is_(None),1), else_=0)
        stmt = stmt.order_by(nulls_last.asc(), tasks.c.due_date.asc(), tasks.c.created_at.desc())

    with engine.connect() as conn:
        rows = conn.execute(stmt).mappings().all()
    return [to_task_out(r) for r in rows]

@app.post("/api/tasks", response_model=TaskOut)
def create_task(payload: TaskCreate):
    title = payload.title.strip()
    if not title: raise HTTPException(status_code=400, detail="Title is empty")
    list_id = (payload.listId or "inbox").strip() or "inbox"
    ensure_list_exists(list_id)
    due = validate_date_str(payload.dueDate)
    tid = gen_id(); ts = now_ts()
    order_index = ts*1000
    stmt = insert(tasks).values(
        id=tid,title=title,completed=False,created_at=ts,updated_at=ts,completed_at=None,
        list_id=list_id,due_date=due,order_index=order_index,
        priority=int(payload.priority or 0),
        notes=(payload.notes.strip() if payload.notes else None),
        tags_json=dumps_tags(payload.tags)
    ).returning(tasks)
    with engine.begin() as conn:
        row = conn.execute(stmt).mappings().first()
    return to_task_out(row)

@app.patch("/api/tasks/{task_id}", response_model=TaskOut)
def update_task(task_id: str, payload: TaskUpdate):
    with engine.connect() as conn:
        cur = conn.execute(select(tasks).where(tasks.c.id==task_id)).mappings().first()
    if not cur: raise HTTPException(status_code=404, detail="Task not found")
    values={}
    if payload.title is not None:
        t = payload.title.strip()
        if not t: raise HTTPException(status_code=400, detail="Title is empty")
        values["title"]=t
    if payload.completed is not None:
        c = bool(payload.completed)
        values["completed"]=c
        values["completed_at"]= now_ts() if c else None
    if payload.listId is not None:
        lid = payload.listId.strip()
        if not lid: raise HTTPException(status_code=400, detail="listId is empty")
        ensure_list_exists(lid); values["list_id"]=lid
    if payload.dueDate is not None: values["due_date"]=validate_date_str(payload.dueDate)
    if payload.tags is not None: values["tags_json"]=dumps_tags(payload.tags)
    if payload.priority is not None: values["priority"]=int(payload.priority)
    if payload.notes is not None: values["notes"]=payload.notes.strip() if payload.notes else None
    if not values: raise HTTPException(status_code=400, detail="Nothing to update")
    values["updated_at"]=now_ts()
    stmt = update(tasks).where(tasks.c.id==task_id).values(**values).returning(tasks)
    with engine.begin() as conn:
        row = conn.execute(stmt).mappings().first()
    return to_task_out(row)

@app.post("/api/tasks/reorder")
def reorder_tasks(payload: ReorderPayload):
    list_id = payload.listId.strip()
    if not list_id: raise HTTPException(status_code=400, detail="listId required")
    ensure_list_exists(list_id)
    ordered=[x for x in payload.orderedIds if isinstance(x,str) and x.strip()]
    if not ordered: raise HTTPException(status_code=400, detail="orderedIds required")
    base = now_ts()*1000; step=10
    with engine.begin() as conn:
        for i, tid in enumerate(ordered):
            conn.execute(update(tasks).where(and_(tasks.c.id==tid, tasks.c.list_id==list_id)).values(order_index=base+i*step))
    return {"ok": True}

@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: str):
    with engine.begin() as conn:
        res = conn.execute(delete(tasks).where(tasks.c.id==task_id))
        if res.rowcount==0: raise HTTPException(status_code=404, detail="Task not found")
    return {"deleted": True}

FRONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
if os.path.isdir(FRONT_DIR):
    app.mount("/", StaticFiles(directory=FRONT_DIR, html=True), name="frontend")
