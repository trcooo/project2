from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional, List, Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import (
    create_engine, MetaData, Table, Column,
    String, Boolean, BigInteger, select, insert, update, delete
)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import NoResultFound

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
        # psycopg2 driver
        if db_url.startswith("postgresql://") and "+psycopg2" not in db_url:
            db_url = db_url.replace("postgresql://", "postgresql+psycopg2://", 1)
    else:
        # Local fallback (no Postgres): SQLite file
        db_url = "sqlite:///./tasks.db"

    return create_engine(db_url, future=True, pool_pre_ping=True)

engine = get_engine()
metadata = MetaData()

tasks = Table(
    "tasks",
    metadata,
    Column("id", String, primary_key=True),
    Column("title", String, nullable=False),
    Column("completed", Boolean, nullable=False, server_default="false"),
    Column("created_at", BigInteger, nullable=False),
    Column("updated_at", BigInteger, nullable=False),
    Column("completed_at", BigInteger, nullable=True),
)

def init_db() -> None:
    metadata.create_all(engine)

def now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())

def gen_id() -> str:
    # timestamp + random bytes
    return f"{now_ts()}_{os.urandom(4).hex()}"

init_db()

# -----------------------------
# FastAPI
# -----------------------------
app = FastAPI(title="TickTick-like ToDo (Railway + Postgres)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

Filter = Literal["all", "active", "completed"]

# -----------------------------
# Schemas
# -----------------------------
class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)

class TaskUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    completed: Optional[bool] = None

class TaskOut(BaseModel):
    id: str
    title: str
    completed: bool
    createdAt: int
    updatedAt: int
    completedAt: Optional[int] = None

def to_out(row) -> TaskOut:
    return TaskOut(
        id=row["id"],
        title=row["title"],
        completed=bool(row["completed"]),
        createdAt=int(row["created_at"]),
        updatedAt=int(row["updated_at"]),
        completedAt=(int(row["completed_at"]) if row["completed_at"] is not None else None),
    )

# -----------------------------
# API
# -----------------------------
@app.get("/api/health")
def health():
    return {"ok": True}

@app.get("/api/tasks", response_model=List[TaskOut])
def list_tasks(filter: Filter = "all"):
    stmt = select(tasks)
    if filter == "active":
        stmt = stmt.where(tasks.c.completed.is_(False))
    elif filter == "completed":
        stmt = stmt.where(tasks.c.completed.is_(True))
    stmt = stmt.order_by(tasks.c.created_at.desc())

    with engine.connect() as conn:
        rows = conn.execute(stmt).mappings().all()
    return [to_out(r) for r in rows]

@app.post("/api/tasks", response_model=TaskOut)
def create_task(payload: TaskCreate):
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is empty")

    task_id = gen_id()
    ts = now_ts()

    stmt = insert(tasks).values(
        id=task_id,
        title=title,
        completed=False,
        created_at=ts,
        updated_at=ts,
        completed_at=None,
    ).returning(tasks)

    with engine.begin() as conn:
        row = conn.execute(stmt).mappings().first()

    return to_out(row)

@app.patch("/api/tasks/{task_id}", response_model=TaskOut)
def update_task(task_id: str, payload: TaskUpdate):
    with engine.connect() as conn:
        current = conn.execute(
            select(tasks).where(tasks.c.id == task_id)
        ).mappings().first()

    if not current:
        raise HTTPException(status_code=404, detail="Task not found")

    new_title = current["title"]
    new_completed = bool(current["completed"])
    new_completed_at = current["completed_at"]

    if payload.title is not None:
        t = payload.title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="Title is empty")
        new_title = t

    if payload.completed is not None:
        new_completed = bool(payload.completed)
        new_completed_at = now_ts() if new_completed else None

    ts = now_ts()

    stmt = (
        update(tasks)
        .where(tasks.c.id == task_id)
        .values(
            title=new_title,
            completed=new_completed,
            updated_at=ts,
            completed_at=new_completed_at,
        )
        .returning(tasks)
    )

    with engine.begin() as conn:
        row = conn.execute(stmt).mappings().first()

    return to_out(row)

@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: str):
    stmt = delete(tasks).where(tasks.c.id == task_id)
    with engine.begin() as conn:
        res = conn.execute(stmt)
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Task not found")
    return {"deleted": True}

@app.get("/api/export")
def export_all():
    stmt = select(tasks).order_by(tasks.c.created_at.desc())
    with engine.connect() as conn:
        rows = conn.execute(stmt).mappings().all()
    return {"version": 1, "tasks": [to_out(r).model_dump() for r in rows]}

# -----------------------------
# Serve frontend (single Railway service)
# -----------------------------
FRONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
if os.path.isdir(FRONT_DIR):
    app.mount("/", StaticFiles(directory=FRONT_DIR, html=True), name="frontend")
