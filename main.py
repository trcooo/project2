from __future__ import annotations
import os, json
from datetime import datetime, timezone, date, timedelta
from typing import Optional, List, Literal

from fastapi import FastAPI, HTTPException, Depends, status, Response, Cookie, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from jose import jwt, JWTError
import bcrypt
import hashlib
from sqlalchemy import (
    create_engine, MetaData, Table, Column,
    String, Boolean, BigInteger, Integer, Text,
    select, insert, update, delete, and_, case, text, or_
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

# --- Auth / Users ---

bearer = HTTPBearer(auto_error=False)

JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret")
JWT_ALG = "HS256"
JWT_TTL_SECONDS = int(os.getenv("JWT_TTL_SECONDS", "2592000"))  # 30d

AUTH_COOKIE = os.getenv("AUTH_COOKIE", "ct_token")

def _set_auth_cookie(resp: Response, token: str):
    """Set session cookie with JWT.

    We keep secure=False so local HTTP dev works; Railway uses HTTPS anyway.
    """
    resp.set_cookie(
        key=AUTH_COOKIE,
        value=token,
        max_age=JWT_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        # Railway serves over HTTPS; Secure improves reliability across browsers.
        secure=True,
        path="/",
    )

def _clear_auth_cookie(resp: Response):
    resp.delete_cookie(key=AUTH_COOKIE, path="/")

def _pw_prehash(pw: str) -> bytes:
    """Pre-hash to avoid bcrypt's 72-byte input limit and keep runtime predictable."""
    return hashlib.sha256(pw.encode("utf-8")).digest()

def hash_password(pw: str) -> str:
    # bcrypt works on bytes; we pre-hash with SHA-256 so any password length is supported.
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(_pw_prehash(pw), salt).decode("utf-8")

def verify_password(pw: str, pw_hash: str) -> bool:
    """Verify password.

    Supports:
    - New hashes: bcrypt(sha256(password))
    - Legacy hashes (best effort): bcrypt(password[:72])
    """
    try:
        h = pw_hash.encode("utf-8")
    except Exception:
        return False

    def _check(pw_bytes: bytes) -> bool:
        try:
            return bcrypt.checkpw(pw_bytes, h)
        except Exception:
            return False

    if _check(_pw_prehash(pw)):
        return True

    # legacy fallback (in case any old accounts were created before the fix)
    raw = pw.encode("utf-8")[:72]
    return _check(raw)

def create_token(user_id: str) -> str:
    exp = now_ts() + JWT_TTL_SECONDS
    return jwt.encode({"sub": user_id, "exp": exp}, JWT_SECRET, algorithm=JWT_ALG)



def require_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    ct_token: str | None = Cookie(default=None, alias=AUTH_COOKIE),
) -> dict:
    """Return current user (or a stable guest user).

    - If a valid JWT is present (cookie or Authorization), return that user.
    - Otherwise return the shared guest workspace user_id=PUBLIC_UID.

    This keeps the app usable without forcing login.
    """
    def guest():
        return {"id": PUBLIC_UID, "email": "guest@local", "created_at": 0}

    token = None
    if ct_token:
        token = ct_token
    elif creds and creds.credentials:
        token = creds.credentials
    else:
        # Fallback header (some proxies strip Authorization)
        token = request.headers.get("x-auth-token")

    if not token:
        return guest()

    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        uid = payload.get("sub")
        if not uid:
            return guest()
    except JWTError:
        return guest()

    with engine.connect() as conn:
        u = conn.execute(select(users).where(users.c.id == uid)).mappings().first()
    if not u:
        return guest()
    return u


users = Table(
    "users", metadata,
    Column("id", String, primary_key=True),
    Column("email", String, nullable=False),
    Column("password_hash", String, nullable=False),
    Column("created_at", BigInteger, nullable=False),
)

folders = Table(
    "folders", metadata,
    Column("id", String, primary_key=True),
    Column("user_id", String, nullable=True),
    Column("title", String, nullable=False),
    Column("emoji", String, nullable=False, server_default="📁"),
    Column("sort_order", Integer, nullable=False, server_default="0"),
    Column("created_at", BigInteger, nullable=False),
)

lists = Table(
    "lists", metadata,
    Column("id", String, primary_key=True),
    Column("user_id", String, nullable=True),
    Column("system_key", String, nullable=True),
    Column("title", String, nullable=False),
    Column("emoji", String, nullable=False, server_default="📌"),
    Column("sort_order", Integer, nullable=False, server_default="0"),
    Column("created_at", BigInteger, nullable=False),
    Column("folder_id", String, nullable=True),
)



sections = Table(
    "sections", metadata,
    Column("id", String, primary_key=True),
    Column("user_id", String, nullable=True),
    Column("list_id", String, nullable=False),
    Column("title", String, nullable=False),
    Column("sort_order", Integer, nullable=False, server_default="0"),
    Column("created_at", BigInteger, nullable=False),
)

tasks = Table(
    "tasks", metadata,
    Column("id", String, primary_key=True),
    Column("user_id", String, nullable=True),
    Column("title", String, nullable=False),
    Column("completed", Boolean, nullable=False, server_default="false"),
    Column("created_at", BigInteger, nullable=False),
    Column("updated_at", BigInteger, nullable=False),
    Column("completed_at", BigInteger, nullable=True),
    Column("list_id", String, nullable=False),
    Column("section_id", String, nullable=True),
    Column("due_date", String, nullable=True),
    Column("due_time", String, nullable=True),
    Column("reminder_minutes", Integer, nullable=True),
    Column("repeat_rule", String, nullable=True),
    Column("pinned", Boolean, nullable=False, server_default="false"),
    Column("order_index", BigInteger, nullable=True),
    Column("priority", Integer, nullable=False, server_default="0"),
    Column("notes", Text, nullable=True),
    Column("tags_json", Text, nullable=False, server_default="[]"),
    Column("trashed", Boolean, nullable=False, server_default="false"),
    Column("trashed_at", BigInteger, nullable=True),
)

def now_ts() -> int:
    return int(datetime.now(tz=timezone.utc).timestamp())

def next_sort_order(table: Table, conn=None, user_id: str | None = None) -> int:
    """Return next sort_order (increments by 10). If table has user_id, compute per-user."""
    close = False
    if conn is None:
        conn = engine.connect()
        close = True
    try:
        stmt = select(table.c.sort_order)
        if user_id is not None and "user_id" in table.c:
            stmt = stmt.where(table.c.user_id == user_id)
        r = conn.execute(stmt.order_by(table.c.sort_order.desc())).first()
    finally:
        if close:
            conn.close()
    cur = int(r[0]) if r and r[0] is not None else 0
    # Keep room for inserts between items.
    return cur + 10

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


def validate_time_str(t: Optional[str]) -> Optional[str]:
    if t is None:
        return None
    t = t.strip()
    if not t:
        return None
    try:
        datetime.strptime(t, "%H:%M")
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid time format. Use HH:MM.")
    return t

ALLOWED_REPEAT_RULES = {"none", "daily", "weekdays", "weekly", "monthly", "yearly"}

def validate_repeat_rule(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    x = (v or "").strip().lower()
    if not x or x == "none":
        return None
    if x not in ALLOWED_REPEAT_RULES:
        raise HTTPException(status_code=400, detail=f"Invalid repeat rule: {x}")
    return x

def validate_reminder_minutes(v: Optional[int]) -> Optional[int]:
    if v is None:
        return None
    try:
        n = int(v)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid reminder value")
    if n < 0 or n > 60 * 24 * 365:
        raise HTTPException(status_code=400, detail="Reminder value out of range")
    return n

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
    """
    Create tables if missing and apply lightweight migrations for older schemas.

    Important (Railway/Postgres):
    - metadata.create_all() does NOT add missing columns to existing tables.
    - If you deployed an older version before, Postgres may have an old `tasks` table.
      We upgrade it in-place (ADD COLUMN) to avoid 500 errors.
    """
    metadata.create_all(engine)

    insp = inspect(engine)

    # lists migrations
    if insp.has_table("lists"):
        ensure_columns("lists", {
            "user_id": "user_id TEXT",
            "system_key": "system_key TEXT",
            "folder_id": "folder_id TEXT",
        })

    # tasks migrations (include core columns!)
    if insp.has_table("tasks"):
        ensure_columns("tasks", {
            "user_id": "user_id TEXT",
            # core (must exist)
            "list_id": "list_id TEXT",
            "due_date": "due_date TEXT",
            "section_id": "section_id TEXT",
            # scheduling / UX
            "due_time": "due_time TEXT",
            "reminder_minutes": "reminder_minutes INTEGER",
            "repeat_rule": "repeat_rule TEXT",
            "pinned": "pinned BOOLEAN NOT NULL DEFAULT false",
            # new features
            "order_index": "order_index BIGINT",
            "priority": "priority INTEGER NOT NULL DEFAULT 0",
            "notes": "notes TEXT",
            "completed_at": "completed_at BIGINT",
            "tags_json": "tags_json TEXT NOT NULL DEFAULT '[]'",
            "trashed": "trashed BOOLEAN NOT NULL DEFAULT false",
            "trashed_at": "trashed_at BIGINT",

        })

        # Backfill list_id for old rows (best-effort)
        with engine.begin() as conn:
            try:
                conn.execute(text("UPDATE tasks SET list_id = 'inbox' WHERE list_id IS NULL"))
            except Exception:
                pass

            # Ensure defaults/constraints in Postgres (ignore if not supported)
            try:
                conn.execute(text("ALTER TABLE tasks ALTER COLUMN list_id SET DEFAULT 'inbox'"))
            except Exception:
                pass
            try:
                conn.execute(text("ALTER TABLE tasks ALTER COLUMN list_id SET NOT NULL"))
            except Exception:
                pass

    # folders migrations
    if insp.has_table("folders"):
        ensure_columns("folders", {
            "user_id": "user_id TEXT",
        })

    # Users: best-effort unique email index (Postgres + SQLite)
    if insp.has_table("users"):
        with engine.begin() as conn:
            try:
                conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email)"))
            except Exception:
                pass

init_db()

# No-auth mode: shared workspace identifier (all data belongs to this id).
PUBLIC_UID = os.getenv("PUBLIC_UID", "public")


def ensure_user_defaults(conn, user_id: str) -> None:
    """Create default lists for a user if missing."""
    defaults = [
        ("inbox", "Входящие", "📥", 10),
        ("welcome", "Добро пожаловать", "👋", 20),
        ("work", "Работа", "💼", 30),
        ("personal", "Личный", "🏠", 40),
    ]
    for key, title, emoji, order in defaults:
        exists = conn.execute(
            select(lists.c.id).where(and_(lists.c.user_id == user_id, lists.c.system_key == key))
        ).first()
        if exists:
            continue
        conn.execute(
            insert(lists).values(
                id=gen_id(),
                user_id=user_id,
                system_key=key,
                title=title,
                emoji=emoji,
                sort_order=order,
                created_at=now_ts(),
                folder_id=None,
            )
        )

def is_first_user(conn) -> bool:
    try:
        c = conn.execute(select(text("COUNT(*)")).select_from(users)).scalar_one()
        return int(c) == 0
    except Exception:
        return True


# Guest workspace: attach legacy rows (user_id IS NULL) to PUBLIC_UID and ensure default lists exist.
with engine.begin() as conn:
    try:
        conn.execute(update(lists).where(lists.c.user_id.is_(None)).values(user_id=PUBLIC_UID))
        conn.execute(update(folders).where(folders.c.user_id.is_(None)).values(user_id=PUBLIC_UID))
        conn.execute(update(tasks).where(tasks.c.user_id.is_(None)).values(user_id=PUBLIC_UID))
        try:
            conn.execute(update(sections).where(sections.c.user_id.is_(None)).values(user_id=PUBLIC_UID))
        except Exception:
            pass
    except Exception:
        pass
    try:
        ensure_user_defaults(conn, PUBLIC_UID)
    except Exception:
        pass

app = FastAPI(title="TickTick-like ToDo (v4-fixed)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

Filter = Literal["all", "active", "completed", "trash"]
Sort = Literal["due", "created", "manual", "completed", "trashed"]

class FolderCreate(BaseModel):
    title: str = Field(min_length=1, max_length=60)
    emoji: str = Field(default="📁", min_length=1, max_length=4)

class FolderOut(BaseModel):
    id: str; title: str; emoji: str; sortOrder: int

class FolderUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=60)
    emoji: Optional[str] = Field(default=None, min_length=1, max_length=4)

class ListCreate(BaseModel):
    title: str = Field(min_length=1, max_length=60)
    emoji: str = Field(default="📌", min_length=1, max_length=4)
    folderId: Optional[str] = None

class ListOut(BaseModel):
    id: str; title: str; emoji: str; sortOrder: int; folderId: Optional[str] = None; systemKey: Optional[str] = None

class ListUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=60)
    emoji: Optional[str] = Field(default=None, min_length=1, max_length=4)
    folderId: Optional[Optional[str]] = None

class SectionCreate(BaseModel):
    listId: str
    title: str = Field(min_length=1, max_length=120)

class SectionOut(BaseModel):
    id: str
    listId: str
    title: str
    sortOrder: int

class SectionUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)

class ReorderSimple(BaseModel):
    orderedIds: List[str]

class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    listId: Optional[str] = Field(default=None)
    sectionId: Optional[str] = Field(default=None)
    dueDate: Optional[str] = None
    dueTime: Optional[str] = None
    reminderMinutes: Optional[int] = None
    repeatRule: Optional[str] = None
    pinned: bool = False
    tags: List[str] = Field(default_factory=list)
    priority: int = Field(default=0, ge=0, le=3)
    notes: Optional[str] = None

class TaskUpdate(BaseModel):
    title: Optional[str] = None
    completed: Optional[bool] = None
    listId: Optional[str] = None
    sectionId: Optional[str] = None
    dueDate: Optional[Optional[str]] = None
    dueTime: Optional[Optional[str]] = None
    reminderMinutes: Optional[Optional[int]] = None
    repeatRule: Optional[Optional[str]] = None
    pinned: Optional[bool] = None
    tags: Optional[List[str]] = None
    priority: Optional[int] = Field(default=None, ge=0, le=3)
    notes: Optional[Optional[str]] = None
    trashed: Optional[bool] = None

class ReorderPayload(BaseModel):
    listId: str
    sectionId: Optional[str] = None
    orderedIds: List[str]

class TaskOut(BaseModel):
    id: str; title: str; completed: bool
    createdAt: int; updatedAt: int; completedAt: Optional[int] = None
    listId: str; sectionId: Optional[str] = None; dueDate: Optional[str] = None
    dueTime: Optional[str] = None
    reminderMinutes: Optional[int] = None
    repeatRule: Optional[str] = None
    pinned: bool = False
    orderIndex: Optional[int] = None
    tags: List[str] = Field(default_factory=list)
    priority: int = 0
    notes: Optional[str] = None
    trashed: bool = False
    trashedAt: Optional[int] = None

def to_folder_out(r): return FolderOut(id=r["id"], title=r["title"], emoji=r["emoji"], sortOrder=int(r["sort_order"]))
def to_list_out(r): return ListOut(id=r["id"], title=r["title"], emoji=r["emoji"], sortOrder=int(r["sort_order"]), folderId=r.get("folder_id"), systemKey=r.get("system_key"))
def to_section_out(r): return SectionOut(id=r["id"], listId=r["list_id"], title=r["title"], sortOrder=int(r["sort_order"]))
def to_task_out(r): 
    return TaskOut(
        id=r["id"], title=r["title"], completed=bool(r["completed"]),
        createdAt=int(r["created_at"]), updatedAt=int(r["updated_at"]),
        completedAt=(int(r["completed_at"]) if r["completed_at"] is not None else None),
        listId=r["list_id"], sectionId=r.get("section_id"), dueDate=r["due_date"],
        dueTime=r.get("due_time"),
        reminderMinutes=(int(r.get("reminder_minutes")) if r.get("reminder_minutes") is not None else None),
        repeatRule=(r.get("repeat_rule") or None),
        pinned=bool(r.get("pinned") or False),
        orderIndex=(int(r["order_index"]) if r.get("order_index") is not None else None),
        tags=parse_tags_json(r.get("tags_json") or "[]"),
        priority=int(r.get("priority") or 0),
        notes=r.get("notes"),
        trashed=bool(r.get("trashed") or False),
        trashedAt=(int(r.get("trashed_at")) if r.get("trashed_at") is not None else None),
    )

def inbox_list_id(conn, user_id: str) -> str:
    row = conn.execute(
        select(lists.c.id).where(and_(lists.c.user_id == user_id, lists.c.system_key == "inbox"))
    ).first()
    if row:
        return row[0]
    # Fallback for very old DBs where inbox id is literally 'inbox'
    row2 = conn.execute(select(lists.c.id).where(and_(lists.c.user_id == user_id, lists.c.id == "inbox"))).first()
    if row2:
        return row2[0]
    # Ensure defaults
    ensure_user_defaults(conn, user_id)
    row3 = conn.execute(
        select(lists.c.id).where(and_(lists.c.user_id == user_id, lists.c.system_key == "inbox"))
    ).first()
    if row3:
        return row3[0]
    raise HTTPException(status_code=500, detail="Inbox list missing")

def ensure_list_exists(conn, user_id: str, list_id: str):
    if not conn.execute(select(lists.c.id).where(and_(lists.c.id == list_id, lists.c.user_id == user_id))).first():
        raise HTTPException(status_code=400, detail=f"List not found")

def ensure_folder_exists(conn, user_id: str, folder_id: str):
    if not conn.execute(select(folders.c.id).where(and_(folders.c.id == folder_id, folders.c.user_id == user_id))).first():
        raise HTTPException(status_code=400, detail=f"Folder not found")

def ensure_section_exists(conn, user_id: str, section_id: str, list_id: Optional[str] = None):
    if not section_id:
        raise HTTPException(status_code=400, detail="sectionId is empty")
    row = conn.execute(select(sections).where(and_(sections.c.id == section_id, sections.c.user_id == user_id))).mappings().first()
    if not row:
        raise HTTPException(status_code=400, detail="Section not found")
    if list_id is not None and row.get("list_id") != list_id:
        raise HTTPException(status_code=400, detail="Section does not belong to list")
    return row

# --- Auth API ---

class AuthRegister(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=6, max_length=200)

class AuthLogin(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=200)

class UserOut(BaseModel):
    id: str
    email: str
    createdAt: int

class AuthOut(BaseModel):
    token: str
    user: UserOut

def to_user_out(r) -> UserOut:
    return UserOut(id=r["id"], email=r["email"], createdAt=int(r["created_at"]))

@app.post("/api/auth/register", response_model=AuthOut)
def register(payload: AuthRegister, response: Response):
    email = payload.email.strip().lower()
    pw = payload.password
    if "@" not in email or "." not in email:
        raise HTTPException(status_code=400, detail="Введите корректный email")
    uid = gen_id()
    with engine.begin() as conn:
        # email unique check
        if conn.execute(select(users.c.id).where(users.c.email == email)).first():
            raise HTTPException(status_code=400, detail="Пользователь с таким email уже существует")

        first = is_first_user(conn)
        conn.execute(insert(users).values(id=uid, email=email, password_hash=hash_password(pw), created_at=now_ts()))

        # If this is the first user, attach legacy data (rows with user_id NULL) to them.
        if first:
            try:
                conn.execute(update(lists).where(lists.c.user_id.is_(None)).values(user_id=uid))
                conn.execute(update(folders).where(folders.c.user_id.is_(None)).values(user_id=uid))
                conn.execute(update(tasks).where(tasks.c.user_id.is_(None)).values(user_id=uid))
            except Exception:
                pass

            # Backfill system_key for old fixed ids
            try:
                mapping = {"inbox": "inbox", "welcome": "welcome", "work": "work", "personal": "personal"}
                for lid, sk in mapping.items():
                    conn.execute(
                        update(lists)
                        .where(and_(lists.c.user_id == uid, lists.c.id == lid, lists.c.system_key.is_(None)))
                        .values(system_key=sk)
                    )
            except Exception:
                pass

        ensure_user_defaults(conn, uid)
        u = conn.execute(select(users).where(users.c.id == uid)).mappings().first()
    token = create_token(uid)
    _set_auth_cookie(response, token)
    return AuthOut(token=token, user=to_user_out(u))

@app.post("/api/auth/login", response_model=AuthOut)
def login(payload: AuthLogin, response: Response):
    email = payload.email.strip().lower()
    pw = payload.password
    with engine.begin() as conn:
        u = conn.execute(select(users).where(users.c.email == email)).mappings().first()
        if not u:
            raise HTTPException(status_code=400, detail="Неверный email или пароль")
        if not verify_password(pw, u["password_hash"]):
            raise HTTPException(status_code=400, detail="Неверный email или пароль")
        ensure_user_defaults(conn, u["id"])
    token = create_token(u["id"])
    _set_auth_cookie(response, token)
    return AuthOut(token=token, user=to_user_out(u))

@app.post("/api/auth/logout")
def auth_logout(response: Response):
    _clear_auth_cookie(response)
    return {"ok": True}

@app.get("/api/auth/me", response_model=UserOut)
def me(user=Depends(require_user)):
    return to_user_out(user)

@app.get("/api/health")
def health(): return {"ok": True, "today": today_str()}

@app.get("/api/folders", response_model=List[FolderOut])
def get_folders(user=Depends(require_user)):
    stmt = select(folders).where(folders.c.user_id == user["id"]).order_by(folders.c.sort_order.asc(), folders.c.created_at.asc())
    with engine.connect() as conn:
        rows = conn.execute(stmt).mappings().all()
    return [to_folder_out(r) for r in rows]

@app.post("/api/folders", response_model=FolderOut)
def create_folder(payload: FolderCreate, user=Depends(require_user)):
    title = payload.title.strip()
    if not title: raise HTTPException(status_code=400, detail="Title is empty")
    fid = gen_id(); emoji = payload.emoji.strip() or "📁"
    with engine.begin() as conn:
        conn.execute(insert(folders).values(id=fid,user_id=user["id"],title=title,emoji=emoji,sort_order=next_sort_order(folders, conn, user["id"]),created_at=now_ts()))
        row = conn.execute(select(folders).where(folders.c.id==fid)).mappings().first()
    return to_folder_out(row)

@app.patch("/api/folders/{folder_id}", response_model=FolderOut)
def update_folder(folder_id: str, payload: FolderUpdate, user=Depends(require_user)):
    values = {}
    if payload.title is not None:
        t = payload.title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="Title is empty")
        values["title"] = t
    if payload.emoji is not None:
        e = payload.emoji.strip()
        if not e:
            raise HTTPException(status_code=400, detail="Emoji is empty")
        values["emoji"] = e
    if not values:
        raise HTTPException(status_code=400, detail="Nothing to update")
    stmt = update(folders).where(and_(folders.c.id==folder_id, folders.c.user_id==user["id"])).values(**values).returning(folders)
    with engine.begin() as conn:
        row = conn.execute(stmt).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Folder not found")
    return to_folder_out(row)

@app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: str, user=Depends(require_user)):
    """Delete folder; lists stay, but get detached from the folder."""
    with engine.begin() as conn:
        conn.execute(update(lists).where(and_(lists.c.folder_id==folder_id, lists.c.user_id==user["id"])).values(folder_id=None))
        res = conn.execute(delete(folders).where(and_(folders.c.id==folder_id, folders.c.user_id==user["id"])))
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Folder not found")
    return {"deleted": True}

@app.post("/api/folders/reorder")
def reorder_folders(payload: ReorderSimple, user=Depends(require_user)):
    ordered = [x for x in payload.orderedIds if isinstance(x, str) and x.strip()]
    if not ordered:
        raise HTTPException(status_code=400, detail="orderedIds required")
    base = 10
    with engine.begin() as conn:
        for i, fid in enumerate(ordered):
            conn.execute(update(folders).where(and_(folders.c.id==fid, folders.c.user_id==user["id"])).values(sort_order=base + i * 10))
    return {"ok": True}

@app.get("/api/lists", response_model=List[ListOut])
def get_lists(user=Depends(require_user)):
    stmt = select(lists).where(lists.c.user_id == user["id"]).order_by(lists.c.sort_order.asc(), lists.c.created_at.asc())
    with engine.connect() as conn:
        rows = conn.execute(stmt).mappings().all()
    return [to_list_out(r) for r in rows]

@app.post("/api/lists", response_model=ListOut)
def create_list(payload: ListCreate, user=Depends(require_user)):
    title = payload.title.strip()
    if not title: raise HTTPException(status_code=400, detail="Title is empty")
    lid = gen_id(); emoji = payload.emoji.strip() or "📌"
    folder_id = payload.folderId.strip() if payload.folderId else None
    with engine.begin() as conn:
        if folder_id: ensure_folder_exists(conn, user["id"], folder_id)
        conn.execute(insert(lists).values(id=lid,user_id=user["id"],system_key=None,title=title,emoji=emoji,sort_order=next_sort_order(lists, conn, user["id"]),created_at=now_ts(),folder_id=folder_id))
        row = conn.execute(select(lists).where(lists.c.id==lid)).mappings().first()
    return to_list_out(row)

@app.patch("/api/lists/{list_id}", response_model=ListOut)
def update_list(list_id: str, payload: ListUpdate, user=Depends(require_user)):
    values = {}
    if payload.title is not None:
        t = payload.title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="Title is empty")
        values["title"] = t
    if payload.emoji is not None:
        e = payload.emoji.strip()
        if not e:
            raise HTTPException(status_code=400, detail="Emoji is empty")
        values["emoji"] = e
    if payload.folderId is not None:
        fid = payload.folderId.strip() if payload.folderId else None
        if fid:
            with engine.connect() as conn:
                ensure_folder_exists(conn, user["id"], fid)
        values["folder_id"] = fid
    if not values:
        raise HTTPException(status_code=400, detail="Nothing to update")
    stmt = update(lists).where(and_(lists.c.id==list_id, lists.c.user_id==user["id"])).values(**values).returning(lists)
    with engine.begin() as conn:
        row = conn.execute(stmt).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="List not found")
    return to_list_out(row)

@app.delete("/api/lists/{list_id}")
def delete_list(list_id: str, user=Depends(require_user)):
    """Delete list; tasks are moved to inbox to avoid data loss."""
    with engine.begin() as conn:
        # Prevent deleting inbox for this user
        sk = conn.execute(select(lists.c.system_key).where(and_(lists.c.id == list_id, lists.c.user_id == user["id"]))).scalar_one_or_none()
        if sk == "inbox" or list_id == inbox_list_id(conn, user["id"]):
            raise HTTPException(status_code=400, detail="Cannot delete inbox")

        inbox_id = inbox_list_id(conn, user["id"])
        conn.execute(update(tasks).where(and_(tasks.c.list_id==list_id, tasks.c.user_id==user["id"])).values(list_id=inbox_id, updated_at=now_ts()))
        res = conn.execute(delete(lists).where(and_(lists.c.id==list_id, lists.c.user_id==user["id"])))
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="List not found")
    return {"deleted": True}

@app.post("/api/lists/reorder")
def reorder_lists(payload: ReorderSimple, user=Depends(require_user)):
    ordered = [x for x in payload.orderedIds if isinstance(x, str) and x.strip()]
    if not ordered:
        raise HTTPException(status_code=400, detail="orderedIds required")
    base = 10
    with engine.begin() as conn:
        for i, lid in enumerate(ordered):
            conn.execute(update(lists).where(and_(lists.c.id==lid, lists.c.user_id==user["id"])).values(sort_order=base + i * 10))
    return {"ok": True}

@app.get("/api/sections", response_model=List[SectionOut])
def list_sections(list_id: str, user=Depends(require_user)):
    lid = list_id.strip()
    if not lid:
        raise HTTPException(status_code=400, detail="list_id required")
    with engine.connect() as conn:
        ensure_list_exists(conn, user["id"], lid)
        rows = conn.execute(
            select(sections).where(and_(sections.c.user_id==user["id"], sections.c.list_id==lid)).order_by(sections.c.sort_order.asc())
        ).mappings().all()
    return [to_section_out(r) for r in rows]

@app.post("/api/sections", response_model=SectionOut)
def create_section(payload: SectionCreate, user=Depends(require_user)):
    lid = payload.listId.strip()
    title = payload.title.strip()
    if not lid or not title:
        raise HTTPException(status_code=400, detail="Invalid payload")
    sid = gen_id()
    with engine.begin() as conn:
        ensure_list_exists(conn, user["id"], lid)
        so = next_sort_order(sections, conn=conn, user_id=user["id"])
        row = conn.execute(insert(sections).values(id=sid, user_id=user["id"], list_id=lid, title=title, sort_order=so, created_at=now_ts()).returning(sections)).mappings().first()
    return to_section_out(row)

@app.patch("/api/sections/{section_id}", response_model=SectionOut)
def update_section(section_id: str, payload: SectionUpdate, user=Depends(require_user)):
    values = {}
    if payload.title is not None:
        t = payload.title.strip()
        if not t:
            raise HTTPException(status_code=400, detail="Title is empty")
        values["title"] = t
    if not values:
        raise HTTPException(status_code=400, detail="Nothing to update")
    stmt = update(sections).where(and_(sections.c.id==section_id, sections.c.user_id==user["id"])).values(**values).returning(sections)
    with engine.begin() as conn:
        row = conn.execute(stmt).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Section not found")
    return to_section_out(row)

@app.delete("/api/sections/{section_id}")
def delete_section(section_id: str, user=Depends(require_user)):
    with engine.begin() as conn:
        # detach tasks
        conn.execute(update(tasks).where(and_(tasks.c.section_id==section_id, tasks.c.user_id==user["id"])).values(section_id=None, updated_at=now_ts()))
        res = conn.execute(delete(sections).where(and_(sections.c.id==section_id, sections.c.user_id==user["id"])))
        if res.rowcount == 0:
            raise HTTPException(status_code=404, detail="Section not found")
    return {"deleted": True}

@app.post("/api/sections/reorder")
def reorder_sections(payload: ReorderSimple, user=Depends(require_user)):
    ordered = [x for x in payload.orderedIds if isinstance(x, str) and x.strip()]
    if not ordered:
        raise HTTPException(status_code=400, detail="orderedIds required")
    base = 10
    with engine.begin() as conn:
        for i, sid in enumerate(ordered):
            conn.execute(update(sections).where(and_(sections.c.id==sid, sections.c.user_id==user["id"])).values(sort_order=base + i*10))
    return {"ok": True}

@app.get("/api/tasks", response_model=List[TaskOut])
def list_tasks(filter: Filter="all", sort: Sort="due", list_id: Optional[str]=None, due: Optional[str]=None,
              due_from: Optional[str]=None, due_to: Optional[str]=None,
              completed_from: Optional[str]=None, completed_to: Optional[str]=None,
              q: Optional[str]=None,
              tag: Optional[str]=None, priority: Optional[int]=None, user=Depends(require_user)):
    conds=[]
    # Always filter by user
    conds.append(tasks.c.user_id == user["id"])
    if filter=="active":
        conds.append(tasks.c.completed.is_(False))
        conds.append(tasks.c.trashed.is_(False))
    elif filter=="completed":
        conds.append(tasks.c.completed.is_(True))
        conds.append(tasks.c.trashed.is_(False))
    elif filter=="trash":
        conds.append(tasks.c.trashed.is_(True))
    else:
        # all (but not trashed)
        conds.append(tasks.c.trashed.is_(False))
    if list_id: conds.append(tasks.c.list_id==list_id)
    if due is not None:
        dd = validate_date_str(due)
        conds.append(tasks.c.due_date==dd)
    if completed_from is not None or completed_to is not None:
        cf = validate_date_str(completed_from) if completed_from else None
        ct = validate_date_str(completed_to) if completed_to else None
        conds.append(tasks.c.completed_at.is_not(None))
        if cf:
            start = int(datetime.strptime(cf, '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp())
            conds.append(tasks.c.completed_at >= start)
        if ct:
            end = int((datetime.strptime(ct, '%Y-%m-%d').replace(tzinfo=timezone.utc) + timedelta(days=1)).timestamp())
            conds.append(tasks.c.completed_at < end)

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

    pin_first = case((tasks.c.pinned.is_(True), 0), else_=1)

    if sort=="created":
        stmt = stmt.order_by(pin_first.asc(), tasks.c.created_at.desc())
    elif sort=="completed":
        nulls_last = case((tasks.c.completed_at.is_(None),1), else_=0)
        stmt = stmt.order_by(pin_first.asc(), nulls_last.asc(), tasks.c.completed_at.desc(), tasks.c.created_at.desc())
    elif sort=="trashed":
        nulls_last = case((tasks.c.trashed_at.is_(None),1), else_=0)
        stmt = stmt.order_by(pin_first.asc(), nulls_last.asc(), tasks.c.trashed_at.desc(), tasks.c.created_at.desc())
    elif sort=="manual":
        nulls_last = case((tasks.c.order_index.is_(None),1), else_=0)
        stmt = stmt.order_by(pin_first.asc(), nulls_last.asc(), tasks.c.order_index.asc(), tasks.c.created_at.desc())
    else:
        nulls_date = case((tasks.c.due_date.is_(None),1), else_=0)
        nulls_time = case((tasks.c.due_time.is_(None),1), else_=0)
        stmt = stmt.order_by(pin_first.asc(), nulls_date.asc(), tasks.c.due_date.asc(), nulls_time.asc(), tasks.c.due_time.asc(), tasks.c.created_at.desc())

    with engine.connect() as conn:
        rows = conn.execute(stmt).mappings().all()
    return [to_task_out(r) for r in rows]

@app.post("/api/tasks", response_model=TaskOut)
def create_task(payload: TaskCreate, user=Depends(require_user)):
    title = payload.title.strip()
    if not title: raise HTTPException(status_code=400, detail="Title is empty")
    with engine.begin() as conn:
        if payload.listId:
            list_id = payload.listId.strip()
            if not list_id:
                raise HTTPException(status_code=400, detail="listId is empty")
            ensure_list_exists(conn, user["id"], list_id)
        else:
            list_id = inbox_list_id(conn, user["id"])

        section_id = None
        if payload.sectionId:
            section_id = payload.sectionId.strip()
            if section_id:
                ensure_section_exists(conn, user["id"], section_id, list_id)
            else:
                section_id = None

        due = validate_date_str(payload.dueDate)
        due_time = validate_time_str(payload.dueTime)
        reminder_minutes = validate_reminder_minutes(payload.reminderMinutes)
        repeat_rule = validate_repeat_rule(payload.repeatRule)
        if due is None:
            due_time = None
            reminder_minutes = None
        tid = gen_id(); ts = now_ts()
        order_index = ts*1000
        stmt = insert(tasks).values(
            id=tid,user_id=user["id"],title=title,completed=False,created_at=ts,updated_at=ts,completed_at=None,
            list_id=list_id,section_id=section_id,due_date=due,due_time=due_time,
            reminder_minutes=reminder_minutes, repeat_rule=repeat_rule, pinned=bool(payload.pinned),
            order_index=order_index,
            priority=int(payload.priority or 0),
            trashed=False, trashed_at=None,
            notes=(payload.notes.strip() if payload.notes else None),
            tags_json=dumps_tags(payload.tags)
        ).returning(tasks)
        row = conn.execute(stmt).mappings().first()
    return to_task_out(row)

@app.patch("/api/tasks/{task_id}", response_model=TaskOut)
def update_task(task_id: str, payload: TaskUpdate, user=Depends(require_user)):
    with engine.connect() as conn:
        cur = conn.execute(select(tasks).where(and_(tasks.c.id==task_id, tasks.c.user_id==user["id"]))).mappings().first()
    if not cur: raise HTTPException(status_code=404, detail="Task not found")
    fields_set = set(getattr(payload, "model_fields_set", None) or getattr(payload, "__fields_set__", set()) or set())
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
        with engine.connect() as conn:
            ensure_list_exists(conn, user["id"], lid)
        values["list_id"]=lid

        # If moving to another list without specifying section, drop section assignment
        if payload.sectionId is None:
            values["section_id"] = None

    if payload.sectionId is not None:
        sid = payload.sectionId.strip()
        if not sid:
            values["section_id"] = None
        else:
            target_list = values.get("list_id") or cur["list_id"]
            with engine.connect() as conn:
                ensure_section_exists(conn, user["id"], sid, target_list)
            values["section_id"] = sid
    if "dueDate" in fields_set:
        values["due_date"] = validate_date_str(payload.dueDate)
        # if date cleared, time/reminder are cleared too (TickTick-like scheduling reset)
        if values["due_date"] is None:
            values["due_time"] = None
            values["reminder_minutes"] = None
    if "dueTime" in fields_set:
        values["due_time"] = validate_time_str(payload.dueTime)
    if "reminderMinutes" in fields_set:
        values["reminder_minutes"] = validate_reminder_minutes(payload.reminderMinutes)
    if "repeatRule" in fields_set:
        values["repeat_rule"] = validate_repeat_rule(payload.repeatRule)
    if payload.pinned is not None:
        values["pinned"] = bool(payload.pinned)
    if payload.tags is not None: values["tags_json"]=dumps_tags(payload.tags)
    if payload.priority is not None: values["priority"]=int(payload.priority)
    if "notes" in fields_set: values["notes"]=payload.notes.strip() if payload.notes else None
    if payload.trashed is not None:
        tr = bool(payload.trashed)
        values["trashed"] = tr
        values["trashed_at"] = now_ts() if tr else None

    # normalize schedule consistency: time/reminder require a date
    effective_due = values.get("due_date", cur.get("due_date"))
    if effective_due is None:
        if "due_time" in values and values["due_time"] is not None:
            values["due_time"] = None
        if "reminder_minutes" in values and values["reminder_minutes"] is not None:
            values["reminder_minutes"] = None

    if not values: raise HTTPException(status_code=400, detail="Nothing to update")
    values["updated_at"]=now_ts()
    stmt = update(tasks).where(and_(tasks.c.id==task_id, tasks.c.user_id==user["id"])).values(**values).returning(tasks)
    with engine.begin() as conn:
        row = conn.execute(stmt).mappings().first()
    return to_task_out(row)

@app.post("/api/tasks/reorder")
def reorder_tasks(payload: ReorderPayload, user=Depends(require_user)):
    list_id = payload.listId.strip()
    if not list_id:
        raise HTTPException(status_code=400, detail="listId required")
    section_id = payload.sectionId.strip() if payload.sectionId else None
    with engine.connect() as conn:
        ensure_list_exists(conn, user["id"], list_id)
        if section_id:
            ensure_section_exists(conn, user["id"], section_id, list_id)
    ordered=[x for x in payload.orderedIds if isinstance(x,str) and x.strip()]
    if not ordered:
        raise HTTPException(status_code=400, detail="orderedIds required")
    base = now_ts()*1000
    step=10
    with engine.begin() as conn:
        for i, tid in enumerate(ordered):
            cond = [tasks.c.id==tid, tasks.c.list_id==list_id, tasks.c.user_id==user["id"]]
            if section_id:
                cond.append(tasks.c.section_id==section_id)
            else:
                cond.append(tasks.c.section_id.is_(None))
            conn.execute(update(tasks).where(and_(*cond)).values(order_index=base+i*step))
    return {"ok": True}

@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: str, hard: bool = False, user=Depends(require_user)):
    """Delete task.

    - Default: move to Trash (soft delete).
    - If already in Trash OR hard=true: permanently delete.
    """
    with engine.begin() as conn:
        row = conn.execute(select(tasks).where(and_(tasks.c.id==task_id, tasks.c.user_id==user["id"]))).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Task not found")
        if hard or bool(row.get("trashed")):
            res = conn.execute(delete(tasks).where(and_(tasks.c.id==task_id, tasks.c.user_id==user["id"])))
            if res.rowcount==0:
                raise HTTPException(status_code=404, detail="Task not found")
            return {"deleted": True}
        conn.execute(update(tasks).where(and_(tasks.c.id==task_id, tasks.c.user_id==user["id"])).values(trashed=True, trashed_at=now_ts(), updated_at=now_ts()))
    return {"trashed": True}


class TagOut(BaseModel):
    tag: str
    count: int

@app.post('/api/trash/empty')
def empty_trash(user=Depends(require_user)):
    with engine.begin() as conn:
        conn.execute(delete(tasks).where(and_(tasks.c.user_id==user['id'], tasks.c.trashed.is_(True))))
    return {"ok": True}

@app.get('/api/tags', response_model=List[TagOut])
def list_tags(include_completed: bool = False, user=Depends(require_user)):
    # Return tag counts for the sidebar.
    with engine.connect() as conn:
        conds = [tasks.c.user_id==user['id'], tasks.c.trashed.is_(False)]
        if not include_completed:
            conds.append(tasks.c.completed.is_(False))
        rows = conn.execute(select(tasks.c.tags_json).where(and_(*conds))).all()
    counts = {}
    for (s,) in rows:
        for t in parse_tags_json(s or '[]'):
            counts[t] = counts.get(t, 0) + 1
    out = [TagOut(tag=k, count=v) for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0].lower()))]
    return out

@app.get('/api/counts')
def get_counts(user=Depends(require_user)):
    # Aggregated counters for smart lists and sidebar.
    today = today_str()
    next_to = (date.today() + timedelta(days=6)).isoformat()
    with engine.connect() as conn:
        inbox_id = inbox_list_id(conn, user['id'])
        active_conds = and_(tasks.c.user_id==user['id'], tasks.c.completed.is_(False), tasks.c.trashed.is_(False))

        active_total = conn.execute(select(text('COUNT(*)')).select_from(tasks).where(active_conds)).scalar_one()
        completed_total = conn.execute(select(text('COUNT(*)')).select_from(tasks).where(and_(tasks.c.user_id==user['id'], tasks.c.completed.is_(True), tasks.c.trashed.is_(False)))).scalar_one()
        trash_total = conn.execute(select(text('COUNT(*)')).select_from(tasks).where(and_(tasks.c.user_id==user['id'], tasks.c.trashed.is_(True)))).scalar_one()

        today_count = conn.execute(select(text('COUNT(*)')).select_from(tasks).where(and_(active_conds, tasks.c.due_date==today))).scalar_one()
        next7_count = conn.execute(select(text('COUNT(*)')).select_from(tasks).where(and_(active_conds, tasks.c.due_date.is_not(None), tasks.c.due_date>=today, tasks.c.due_date<=next_to))).scalar_one()
        inbox_count = conn.execute(select(text('COUNT(*)')).select_from(tasks).where(and_(active_conds, tasks.c.list_id==inbox_id))).scalar_one()

        rows = conn.execute(
            select(tasks.c.list_id, text('COUNT(*) as c')).where(active_conds).group_by(tasks.c.list_id)
        ).all()
        by_list = {lid: int(c) for lid, c in rows}

    return {
        'activeTotal': int(active_total),
        'completedTotal': int(completed_total),
        'trashTotal': int(trash_total),
        'today': int(today_count),
        'next7': int(next7_count),
        'inbox': int(inbox_count),
        'byList': by_list,
    }

@app.get('/api/stats')
def get_stats(days: int = 14, user=Depends(require_user)):
    # Statistics for the dashboard (UTC-based).
    days = max(7, min(365, int(days)))
    end_d = datetime.now(tz=timezone.utc).date()
    start_d = end_d - timedelta(days=days-1)

    def dstr(d: date) -> str:
        return d.isoformat()

    start_ts = int(datetime.combine(start_d, datetime.min.time(), tzinfo=timezone.utc).timestamp())
    end_ts = int(datetime.combine(end_d + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc).timestamp())

    with engine.connect() as conn:
        tasks_total = int(conn.execute(select(text('COUNT(*)')).select_from(tasks).where(and_(tasks.c.user_id==user['id'], tasks.c.trashed.is_(False)))).scalar_one())
        completed_total = int(conn.execute(select(text('COUNT(*)')).select_from(tasks).where(and_(tasks.c.user_id==user['id'], tasks.c.completed.is_(True), tasks.c.trashed.is_(False)))).scalar_one())
        lists_total = int(conn.execute(select(text('COUNT(*)')).select_from(lists).where(lists.c.user_id==user['id'])).scalar_one())
        trash_total = int(conn.execute(select(text('COUNT(*)')).select_from(tasks).where(and_(tasks.c.user_id==user['id'], tasks.c.trashed.is_(True)))).scalar_one())

        first_task_ts = conn.execute(select(tasks.c.created_at).where(tasks.c.user_id==user['id']).order_by(tasks.c.created_at.asc()).limit(1)).scalar()
        first_ts = int(first_task_ts) if first_task_ts is not None else int(user.get('created_at') or now_ts())

        today = datetime.now(tz=timezone.utc).date()
        t0 = int(datetime.combine(today, datetime.min.time(), tzinfo=timezone.utc).timestamp())
        t1 = int(datetime.combine(today + timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc).timestamp())
        completed_today = int(conn.execute(select(text('COUNT(*)')).select_from(tasks).where(and_(tasks.c.user_id==user['id'], tasks.c.completed.is_(True), tasks.c.trashed.is_(False), tasks.c.completed_at.is_not(None), tasks.c.completed_at>=t0, tasks.c.completed_at<t1))).scalar_one())

        done_rows = conn.execute(
            select(tasks.c.completed_at).where(and_(tasks.c.user_id==user['id'], tasks.c.completed.is_(True), tasks.c.trashed.is_(False), tasks.c.completed_at.is_not(None), tasks.c.completed_at>=start_ts, tasks.c.completed_at<end_ts))
        ).all()
        done_by_day = {}
        for (ts,) in done_rows:
            try:
                day = datetime.fromtimestamp(int(ts), tz=timezone.utc).date().isoformat()
                done_by_day[day] = done_by_day.get(day, 0) + 1
            except Exception:
                pass

        due_rows = conn.execute(
            select(tasks.c.due_date, tasks.c.completed).where(and_(tasks.c.user_id==user['id'], tasks.c.trashed.is_(False), tasks.c.due_date.is_not(None), tasks.c.due_date>=dstr(start_d), tasks.c.due_date<=dstr(end_d)))
        ).all()
        due_total_by_day = {}
        due_done_by_day = {}
        for dd, comp in due_rows:
            if not dd:
                continue
            due_total_by_day[dd] = due_total_by_day.get(dd, 0) + 1
            if comp:
                due_done_by_day[dd] = due_done_by_day.get(dd, 0) + 1

    dates = []
    completed_counts = []
    completion_rates = []
    for i in range(days):
        d = start_d + timedelta(days=i)
        ds = d.isoformat()
        dates.append(ds)
        completed_counts.append(int(done_by_day.get(ds, 0)))
        tot = int(due_total_by_day.get(ds, 0))
        done = int(due_done_by_day.get(ds, 0))
        completion_rates.append(None if tot == 0 else round(done * 100.0 / tot, 1))

    days_active = max(1, int((now_ts() - first_ts) // 86400) + 1)
    points = completed_total * 5 + tasks_total

    return {
        'totals': {
            'tasksTotal': tasks_total,
            'completedTotal': completed_total,
            'listsTotal': lists_total,
            'trashTotal': trash_total,
            'daysActive': days_active,
            'completedToday': completed_today,
            'points': points,
        },
        'series': {
            'dates': dates,
            'completed': completed_counts,
            'completionRate': completion_rates,
        }
    }

FRONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
if os.path.isdir(FRONT_DIR):
    app.mount("/", StaticFiles(directory=FRONT_DIR, html=True), name="frontend")