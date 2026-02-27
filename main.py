from __future__ import annotations

import os
from datetime import datetime, timezone, date
from typing import Optional, List, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import (
    create_engine, MetaData, Table, Column,
    String, Boolean, BigInteger, Integer,
    select, insert, update, delete, and_, case
)
from sqlalchemy.engine import Engine

# -----------------------------
# Database (PostgreSQL on Railway)
# -----------------------------
def normalize_database_url(url: str) -> str:
    # Railway may provide postgres:// ... SQLAlchemy wants postgresql://
    if url.startswith("postgres://"):
        return "postgresql://" + url[len("postgres://"):]
    return url

def get_engine() -> Engine:
    db_url = os.getenv("DATABASE_URL", "").strip()
    if db_url:
        db_url = normalize_database_url(db_url)
        if db_url.startswith("postgresql://") and "+psycopg2" not in db_url:
            db_url = db_url.replace("postgresql://", "postgresql+psycopg2://", 1)
    else:
        # Local fallback
        db_url = "sqlite:///./tasks.db"
    return create_engine(db_url, future=True, pool_pre_ping=True)

engine = get_engine()
metadata = MetaData()

lists = Table(
    "lists",
    metadata,
    Column("id", String, primary_key=True),
    Column("title", String, nullable=False),
    Column("emoji", String, nullable=False, server_default="📌"),
    Column("sort_order", Integer, nullable=False, server_default="0"),
    Column("created_at", BigInteger, nullable=False),
)

tasks = Table(
    "tasks",
    metadata,
    Column("id", String, primary_key=True),
    Column("title", String, nullable=False),
    Column("completed", Boolean, nullable=False, server_default="false"),
    Column("created_at", BigInteger, nullable=False),
    Column("updated_at", BigInteger, nullable=False),
    Column("completed_at", BigInteger, nullable=True),
    Column("list_id", String, nullable=False),
    Column("due_date", String, nullable=True),  # YYYY-MM-DD
)

def now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())

def today_str() -> str:
    return date.today().isoformat()

def gen_id() -> str:
    return f"{now_ts()}_{os.urandom(4).hex()}"

def init_db() -> None:
    metadata.create_all(engine)

def seed_default_lists() -> None:
    defaults = [
        ("inbox", "Входящие", "📥", 10),
        ("welcome", "Добро пожаловать", "👋", 20),
        ("work", "Работа", "💼", 30),
        ("personal", "Личный", "🏠", 40),
    ]
    with engine.begin() as conn:
        for lid, title, emoji, order in defaults:
            exists = conn.execute(select(lists.c.id).where(lists.c.id == lid)).first()
            if exists:
                continue
            conn.execute(
                insert(lists).values(
                    id=lid,
                    title=title,
                    emoji=emoji,
                    sort_order=order,
                    created_at=now_ts(),
                )
            )

init_db()
seed_default_lists()

# -----------------------------
# FastAPI
# -----------------------------
app = FastAPI(title="TickTick-like ToDo (UI v3)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

Filter = Literal["all", "active", "completed"]
Sort = Literal["due", "created"]

# -----------------------------
# Schemas
# -----------------------------
class ListCreate(BaseModel):
    title: str = Field(min_length=1, max_length=60)
    emoji: str = Field(default="📌", min_length=1, max_length=4)

class ListOut(BaseModel):
    id: str
    title: str
    emoji: str
    sortOrder: int

class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    listId: str = Field(default="inbox", min_length=1, max_length=60)
    dueDate: Optional[str] = Field(default=None, description="YYYY-MM-DD")

class TaskUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    completed: Optional[bool] = None
    listId: Optional[str] = Field(default=None, min_length=1, max_length=60)
    dueDate: Optional[Optional[str]] = Field(default=None, description="YYYY-MM-DD or null")

class TaskOut(BaseModel):
    id: str
    title: str
    completed: bool
    createdAt: int
    updatedAt: int
    completedAt: Optional[int] = None
    listId: str
    dueDate: Optional[str] = None

def to_list_out(row) -> ListOut:
    return ListOut(
        id=row["id"],
        title=row["title"],
        emoji=row["emoji"],
        sortOrder=int(row["sort_order"]),
    )

def to_task_out(row) -> TaskOut:
    return TaskOut(
        id=row["id"],
        title=row["title"],
        completed=bool(row["completed"]),
        createdAt=int(row["created_at"]),
        updatedAt=int(row["updated_at"]),
        completedAt=(int(row["completed_at"]) if row["completed_at"] is not None else None),
        listId=row["list_id"],
        dueDate=row["due_date"],
    )

def validate_due(due: Optional[str]) -> Optional[str]:
    if due is None:
        return None
    due = due.strip()
    if due == "":
        return None
    try:
        datetime.strptime(due, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid dueDate format. Use YYYY-MM-DD.")
    return due

def ensure_list_exists(list_id: str) -> None:
    with engine.connect() as conn:
        exists = conn.execute(select(lists.c.id).where(lists.c.id == list_id)).first()
    if not exists:
        raise HTTPException(status_code=400, detail=f"List not found: {list_id}")

# -----------------------------
# API
# -----------------------------
@app.get("/api/health")
def health():
    return {"ok": True, "today": today_str()}

# ---- Lists ----
@app.get("/api/lists", response_model=List[ListOut])
def get_lists():
    stmt = select(lists).order_by(lists.c.sort_order.asc(), lists.c.created_at.asc())
    with engine.connect() as conn:
        rows = conn.execute(stmt).mappings().all()
    return [to_list_out(r) for r in rows]

@app.post("/api/lists", response_model=ListOut)
def create_list(payload: ListCreate):
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is empty")

    lid = gen_id()
    emoji = payload.emoji.strip() or "📌"

    with engine.begin() as conn:
        conn.execute(
            insert(lists).values(
                id=lid,
                title=title,
                emoji=emoji,
                sort_order=50,
                created_at=now_ts(),
            )
        )
        row = conn.execute(select(lists).where(lists.c.id == lid)).mappings().first()

    return to_list_out(row)

# ---- Tasks ----
@app.get("/api/tasks", response_model=List[TaskOut])
def list_tasks(
    filter: Filter = "all",
    sort: Sort = "due",
    list_id: Optional[str] = None,
    due: Optional[str] = None,
    q: Optional[str] = None,
):
    conds = []
    if filter == "active":
        conds.append(tasks.c.completed.is_(False))
    elif filter == "completed":
        conds.append(tasks.c.completed.is_(True))

    if list_id:
        conds.append(tasks.c.list_id == list_id)

    if due is not None:
        due = validate_due(due)
        conds.append(tasks.c.due_date == due)

    if q:
        conds.append(tasks.c.title.ilike(f"%{q.strip()}%"))

    stmt = select(tasks)
    if conds:
        stmt = stmt.where(and_(*conds))

    if sort == "created":
        stmt = stmt.order_by(tasks.c.created_at.desc())
    else:
        # Cross-dialect "NULLS LAST": CASE when due_date is NULL then 1 else 0
        nulls_last_key = case((tasks.c.due_date.is_(None), 1), else_=0)
        stmt = stmt.order_by(nulls_last_key.asc(), tasks.c.due_date.asc(), tasks.c.created_at.desc())

    with engine.connect() as conn:
        rows = conn.execute(stmt).mappings().all()
    return [to_task_out(r) for r in rows]

@app.post("/api/tasks", response_model=TaskOut)
def create_task(payload: TaskCreate):
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is empty")

    list_id = payload.listId.strip() or "inbox"
    ensure_list_exists(list_id)

    due = validate_due(payload.dueDate)

    tid = gen_id()
    ts = now_ts()

    stmt = insert(tasks).values(
        id=tid,
        title=title,
        completed=False,
        created_at=ts,
        updated_at=ts,
        completed_at=None,
        list_id=list_id,
        due_date=due,
    ).returning(tasks)

    with engine.begin() as conn:
        row = conn.execute(stmt).mappings().first()

    return to_task_out(row)

@app.patch("/api/tasks/{task_id}", response_model=TaskOut)
def update_task(task_id: str, payload: TaskUpdate):
    with engine.connect() as conn:
        current = conn.execute(select(tasks).where(tasks.c.id == task_id)).mappings().first()
    if not current:
        raise HTTPException(status_code=404, detail="Task not found")

    values = {}
    if payload.title is not None:
        t = payload.title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="Title is empty")
        values["title"] = t

    if payload.completed is not None:
        completed = bool(payload.completed)
        values["completed"] = completed
        values["completed_at"] = now_ts() if completed else None

    if payload.listId is not None:
        lid = payload.listId.strip()
        if not lid:
            raise HTTPException(status_code=400, detail="listId is empty")
        ensure_list_exists(lid)
        values["list_id"] = lid

    if payload.dueDate is not None:
        values["due_date"] = validate_due(payload.dueDate)

    if not values:
        raise HTTPException(status_code=400, detail="Nothing to update")

    values["updated_at"] = now_ts()

    stmt = update(tasks).where(tasks.c.id == task_id).values(**values).returning(tasks)
    with engine.begin() as conn:
        row = conn.execute(stmt).mappings().first()

    return to_task_out(row)

@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: str):
    with engine.begin() as conn:
        res = conn.execute(delete(tasks).where(tasks.c.id == task_id))
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Task not found")
    return {"deleted": True}

# -----------------------------
# Serve frontend (single service)
# -----------------------------
FRONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
if os.path.isdir(FRONT_DIR):
    app.mount("/", StaticFiles(directory=FRONT_DIR, html=True), name="frontend")
