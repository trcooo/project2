from __future__ import annotations
import os, json
from datetime import datetime, timezone, date
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
    token = None
    if creds and creds.credentials:
        token = creds.credentials
    # Some hosting/proxy layers may strip the Authorization header.
    # Accept a custom header as a reliable fallback.
    elif request.headers.get("x-auth-token"):
        token = request.headers.get("x-auth-token")
    elif ct_token:
        token = ct_token
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        uid = payload.get("sub")
        if not uid:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    with engine.connect() as conn:
        u = conn.execute(select(users).where(users.c.id == uid)).mappings().first()
    if not u:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
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
    Column("due_date", String, nullable=True),
    Column("order_index", BigInteger, nullable=True),
    Column("priority", Integer, nullable=False, server_default="0"),
    Column("notes", Text, nullable=True),
    Column("tags_json", Text, nullable=False, server_default="[]"),
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
            # new features
            "order_index": "order_index BIGINT",
            "priority": "priority INTEGER NOT NULL DEFAULT 0",
            "notes": "notes TEXT",
            "tags_json": "tags_json TEXT NOT NULL DEFAULT '[]'",
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

app = FastAPI(title="TickTick-like ToDo (v4-fixed)")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

Filter = Literal["all", "active", "completed"]
Sort = Literal["due", "created", "manual"]

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

class ReorderSimple(BaseModel):
    orderedIds: List[str]

class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    listId: Optional[str] = Field(default=None)
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
def to_list_out(r): return ListOut(id=r["id"], title=r["title"], emoji=r["emoji"], sortOrder=int(r["sort_order"]), folderId=r.get("folder_id"), systemKey=r.get("system_key"))
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

@app.get("/api/tasks", response_model=List[TaskOut])
def list_tasks(filter: Filter="all", sort: Sort="due", list_id: Optional[str]=None, due: Optional[str]=None,
              due_from: Optional[str]=None, due_to: Optional[str]=None, q: Optional[str]=None,
              tag: Optional[str]=None, priority: Optional[int]=None, user=Depends(require_user)):
    conds=[]
    # Always filter by user
    conds.append(tasks.c.user_id == user["id"])
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

        due = validate_date_str(payload.dueDate)
        tid = gen_id(); ts = now_ts()
        order_index = ts*1000
        stmt = insert(tasks).values(
            id=tid,user_id=user["id"],title=title,completed=False,created_at=ts,updated_at=ts,completed_at=None,
            list_id=list_id,due_date=due,order_index=order_index,
            priority=int(payload.priority or 0),
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
    if payload.dueDate is not None: values["due_date"]=validate_date_str(payload.dueDate)
    if payload.tags is not None: values["tags_json"]=dumps_tags(payload.tags)
    if payload.priority is not None: values["priority"]=int(payload.priority)
    if payload.notes is not None: values["notes"]=payload.notes.strip() if payload.notes else None
    if not values: raise HTTPException(status_code=400, detail="Nothing to update")
    values["updated_at"]=now_ts()
    stmt = update(tasks).where(and_(tasks.c.id==task_id, tasks.c.user_id==user["id"])).values(**values).returning(tasks)
    with engine.begin() as conn:
        row = conn.execute(stmt).mappings().first()
    return to_task_out(row)

@app.post("/api/tasks/reorder")
def reorder_tasks(payload: ReorderPayload, user=Depends(require_user)):
    list_id = payload.listId.strip()
    if not list_id: raise HTTPException(status_code=400, detail="listId required")
    with engine.connect() as conn:
        ensure_list_exists(conn, user["id"], list_id)
    ordered=[x for x in payload.orderedIds if isinstance(x,str) and x.strip()]
    if not ordered: raise HTTPException(status_code=400, detail="orderedIds required")
    base = now_ts()*1000; step=10
    with engine.begin() as conn:
        for i, tid in enumerate(ordered):
            conn.execute(update(tasks).where(and_(tasks.c.id==tid, tasks.c.list_id==list_id, tasks.c.user_id==user["id"])).values(order_index=base+i*step))
    return {"ok": True}

@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: str, user=Depends(require_user)):
    with engine.begin() as conn:
        res = conn.execute(delete(tasks).where(and_(tasks.c.id==task_id, tasks.c.user_id==user["id"])))
        if res.rowcount==0: raise HTTPException(status_code=404, detail="Task not found")
    return {"deleted": True}

FRONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")
if os.path.isdir(FRONT_DIR):
    app.mount("/", StaticFiles(directory=FRONT_DIR, html=True), name="frontend")

