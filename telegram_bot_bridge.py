from __future__ import annotations

import json
import os
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta, date
from typing import Optional

from sqlalchemy import and_, select, update, or_, case


class TelegramBotBridge:
    """Minimal Telegram bot bridge for ClockTime.

    Features:
    - /link <code> to attach Telegram chat to a ClockTime account
    - /tasks, /today, /next7, /inbox quick views
    - /add <text> add task to inbox
    - /done <id_prefix> mark task completed
    - background reminder sender (Telegram messages)

    Bot token is read from TELEGRAM_BOT_TOKEN (preferred) or CLOCKTIME_TELEGRAM_BOT_TOKEN.
    """

    def __init__(self, *, engine, users, tasks, lists, now_ts_fn, gen_id_fn, logger=None):
        self.engine = engine
        self.users = users
        self.tasks = tasks
        self.lists = lists
        self.now_ts = now_ts_fn
        self.gen_id = gen_id_fn
        self.logger = logger or (lambda *a, **k: None)

        self.token = (os.getenv("TELEGRAM_BOT_TOKEN") or os.getenv("CLOCKTIME_TELEGRAM_BOT_TOKEN") or "").strip()
        self.enabled = bool(self.token)
        self._stop = threading.Event()
        self._started = False
        self._updates_thread: Optional[threading.Thread] = None
        self._reminder_thread: Optional[threading.Thread] = None
        self._offset = 0
        self.bot_username: Optional[str] = None
        self.last_error: Optional[str] = None

    # ---------- lifecycle ----------
    def start(self):
        if not self.enabled or self._started:
            return
        self._started = True
        self._stop.clear()
        # fetch bot info (best effort)
        try:
            me = self._tg_api("getMe", {})
            if me and me.get("ok") and isinstance(me.get("result"), dict):
                self.bot_username = (me["result"].get("username") or "").strip() or None
        except Exception as e:
            self.last_error = str(e)
            self._log(f"getMe failed: {e}")

        self._updates_thread = threading.Thread(target=self._updates_loop, name="ct-telegram-updates", daemon=True)
        self._reminder_thread = threading.Thread(target=self._reminder_loop, name="ct-telegram-reminders", daemon=True)
        self._updates_thread.start()
        self._reminder_thread.start()
        self._log("Telegram bridge started")

    def stop(self):
        self._stop.set()

    def is_configured(self) -> bool:
        return self.enabled

    # ---------- telegram HTTP ----------
    def _log(self, msg: str):
        try:
            self.logger(msg)
        except Exception:
            pass

    def _tg_api(self, method: str, data: Optional[dict] = None, timeout: int = 35) -> dict:
        if not self.token:
            raise RuntimeError("Telegram bot token is not configured")
        url = f"https://api.telegram.org/bot{self.token}/{method}"
        payload = json.dumps(data or {}).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "ignore")
        try:
            return json.loads(raw)
        except Exception:
            raise RuntimeError(f"Telegram API invalid response: {raw[:200]}")

    def _send_message(self, chat_id: str, text: str):
        try:
            self._tg_api("sendMessage", {"chat_id": str(chat_id), "text": text, "disable_web_page_preview": True}, timeout=20)
            return True
        except Exception as e:
            self.last_error = str(e)
            self._log(f"sendMessage failed: {e}")
            return False

    # ---------- command handling ----------
    def _updates_loop(self):
        while not self._stop.is_set():
            try:
                resp = self._tg_api("getUpdates", {"timeout": 25, "offset": self._offset, "allowed_updates": ["message"]}, timeout=35)
                if not resp.get("ok"):
                    time.sleep(2)
                    continue
                for upd in resp.get("result") or []:
                    try:
                        uid = int(upd.get("update_id") or 0)
                        self._offset = max(self._offset, uid + 1)
                        self._handle_update(upd)
                    except Exception as e:
                        self.last_error = str(e)
                        self._log(f"handle update failed: {e}")
            except Exception as e:
                self.last_error = str(e)
                self._log(f"getUpdates failed: {e}")
                time.sleep(3)

    def _handle_update(self, upd: dict):
        msg = upd.get("message") or {}
        text = (msg.get("text") or "").strip()
        chat = msg.get("chat") or {}
        chat_id = str(chat.get("id") or "")
        from_u = msg.get("from") or {}
        username = (from_u.get("username") or "").strip() or None
        first_name = (from_u.get("first_name") or "").strip() or ""
        if not text or not chat_id:
            return

        if text.startswith("/"):
            cmd, *rest = text.split(" ", 1)
            arg = rest[0].strip() if rest else ""
            # Handle /cmd@BotName form
            cmd = cmd.split("@", 1)[0].lower()
            if cmd == "/start":
                if arg:
                    return self._cmd_link(chat_id, username, arg)
                self._send_message(chat_id,
                    "Привет! Я бот ClockTime.\n\n"
                    "Чтобы подключить аккаунт:\n"
                    "1) Открой ClockTime → Настройки → Интеграции и импорт\n"
                    "2) Скопируй код подключения\n"
                    "3) Отправь: /link <код>\n\n"
                    "Команды: /tasks /today /next7 /inbox /add /done /unlink /help")
                return
            if cmd == "/help":
                self._send_message(chat_id,
                    "Команды ClockTime:\n"
                    "/link <код> — привязать аккаунт\n"
                    "/unlink — отвязать чат\n"
                    "/tasks — активные задачи (топ)\n"
                    "/today — задачи на сегодня\n"
                    "/next7 — задачи на 7 дней\n"
                    "/inbox — входящие\n"
                    "/add <текст> — добавить задачу\n"
                    "/done <id_prefix> — отметить выполненной\n"
                    "/id — показать chat id")
                return
            if cmd == "/id":
                self._send_message(chat_id, f"Ваш Telegram chat_id: {chat_id}")
                return
            if cmd == "/link":
                return self._cmd_link(chat_id, username, arg)
            if cmd == "/unlink":
                return self._cmd_unlink(chat_id)

            user = self._user_by_chat(chat_id)
            if not user:
                self._send_message(chat_id, "Сначала привяжите аккаунт командой /link <код> (код в настройках ClockTime).")
                return

            if cmd == "/tasks":
                return self._send_message(chat_id, self._format_tasks(user["id"], mode="tasks"))
            if cmd == "/today":
                return self._send_message(chat_id, self._format_tasks(user["id"], mode="today"))
            if cmd == "/next7":
                return self._send_message(chat_id, self._format_tasks(user["id"], mode="next7"))
            if cmd == "/inbox":
                return self._send_message(chat_id, self._format_tasks(user["id"], mode="inbox"))
            if cmd == "/add":
                title = (arg or "").strip()
                if not title:
                    self._send_message(chat_id, "Формат: /add Купить молоко")
                    return
                return self._cmd_add(user["id"], chat_id, title)
            if cmd == "/done":
                return self._cmd_done(user["id"], chat_id, arg)

            self._send_message(chat_id, "Неизвестная команда. /help")

    def _cmd_link(self, chat_id: str, username: Optional[str], code: str):
        code = (code or "").strip()
        if not code:
            self._send_message(chat_id, "Использование: /link <код>. Код смотри в Настройки → Интеграции и импорт.")
            return
        with self.engine.begin() as conn:
            u = conn.execute(
                select(self.users).where(
                    and_(self.users.c.telegram_link_code == code)
                )
            ).mappings().first()
            if not u:
                self._send_message(chat_id, "Код не найден или истёк. Сгенерируй новый в настройках ClockTime.")
                return
            # code validity: 24h
            cts = int(u.get("telegram_link_code_created_at") or 0)
            if cts and self.now_ts() - cts > 86400:
                self._send_message(chat_id, "Код подключения истёк. Сгенерируй новый в настройках ClockTime.")
                return

            conn.execute(
                update(self.users)
                .where(self.users.c.id == u["id"])
                .values(
                    telegram_chat_id=str(chat_id),
                    telegram_username=username,
                    telegram_notify_enabled=True,
                    telegram_link_code=None,
                    telegram_link_code_created_at=None,
                )
            )
        self._send_message(chat_id, "✅ Аккаунт ClockTime подключен. Доступны команды: /today /tasks /next7 /inbox")

    def _cmd_unlink(self, chat_id: str):
        with self.engine.begin() as conn:
            res = conn.execute(
                update(self.users)
                .where(self.users.c.telegram_chat_id == str(chat_id))
                .values(telegram_chat_id=None, telegram_username=None, telegram_notify_enabled=False)
            )
        if res.rowcount:
            self._send_message(chat_id, "🔌 Чат отвязан от ClockTime.")
        else:
            self._send_message(chat_id, "Этот чат не привязан.")

    def _cmd_add(self, user_id: str, chat_id: str, title: str):
        inbox_id = self._inbox_list_id(user_id)
        if not inbox_id:
            self._send_message(chat_id, "Не удалось найти список 'Входящие'.")
            return
        ts = self.now_ts()
        tid = self.gen_id()
        with self.engine.begin() as conn:
            conn.execute(
                self.tasks.insert().values(
                    id=tid,
                    user_id=user_id,
                    title=title[:200],
                    completed=False,
                    created_at=ts,
                    updated_at=ts,
                    completed_at=None,
                    list_id=inbox_id,
                    section_id=None,
                    due_date=None,
                    due_time=None,
                    reminder_minutes=None,
                    repeat_rule=None,
                    pinned=False,
                    order_index=ts * 1000,
                    priority=0,
                    notes=None,
                    tags_json='[]',
                    subtasks_json='[]',
                    trashed=False,
                    trashed_at=None,
                    tg_reminder_sent_at=None,
                )
            )
        self._send_message(chat_id, f"➕ Добавил задачу во Входящие:\n{title}\nID: {tid}")

    def _cmd_done(self, user_id: str, chat_id: str, arg: str):
        q = (arg or "").strip()
        if not q:
            self._send_message(chat_id, "Формат: /done <id_prefix>. Пример: /done 1709_")
            return
        with self.engine.begin() as conn:
            rows = conn.execute(
                select(self.tasks.c.id, self.tasks.c.title, self.tasks.c.completed)
                .where(and_(self.tasks.c.user_id == user_id, self.tasks.c.trashed.is_(False), self.tasks.c.id.like(f"{q}%")))
                .order_by(self.tasks.c.created_at.desc())
                .limit(5)
            ).all()
            if not rows:
                self._send_message(chat_id, "Задача по такому ID не найдена.")
                return
            if len(rows) > 1:
                opts = "\n".join([f"• {r.id} — {r.title[:60]}" for r in rows])
                self._send_message(chat_id, "Нашёл несколько задач, уточни префикс:\n" + opts)
                return
            r = rows[0]
            if bool(r.completed):
                self._send_message(chat_id, "Эта задача уже выполнена ✅")
                return
            ts = self.now_ts()
            conn.execute(
                update(self.tasks)
                .where(and_(self.tasks.c.id == r.id, self.tasks.c.user_id == user_id))
                .values(completed=True, completed_at=ts, updated_at=ts, tg_reminder_sent_at=None)
            )
        self._send_message(chat_id, f"✅ Выполнено: {r.title}\nID: {r.id}")

    def _user_by_chat(self, chat_id: str):
        with self.engine.connect() as conn:
            return conn.execute(
                select(self.users).where(self.users.c.telegram_chat_id == str(chat_id))
            ).mappings().first()

    def _inbox_list_id(self, user_id: str) -> Optional[str]:
        with self.engine.connect() as conn:
            row = conn.execute(
                select(self.lists.c.id).where(and_(self.lists.c.user_id == user_id, self.lists.c.system_key == "inbox"))
            ).first()
            if row:
                return row[0]
            row2 = conn.execute(
                select(self.lists.c.id).where(and_(self.lists.c.user_id == user_id, self.lists.c.title == "Входящие"))
            ).first()
            return row2[0] if row2 else None

    def _format_tasks(self, user_id: str, mode: str = "tasks") -> str:
        today = date.today()
        conds = [self.tasks.c.user_id == user_id, self.tasks.c.completed.is_(False), self.tasks.c.trashed.is_(False)]
        header = "Активные задачи"
        if mode == "today":
            conds.append(self.tasks.c.due_date == today.isoformat())
            header = "Сегодня"
        elif mode == "next7":
            conds.append(self.tasks.c.due_date.is_not(None))
            conds.append(self.tasks.c.due_date >= today.isoformat())
            conds.append(self.tasks.c.due_date <= (today + timedelta(days=6)).isoformat())
            header = "Следующие 7 дней"
        elif mode == "inbox":
            inbox_id = self._inbox_list_id(user_id)
            if inbox_id:
                conds.append(self.tasks.c.list_id == inbox_id)
            header = "Входящие"
        else:
            header = "Активные задачи"

        pin_first = case((self.tasks.c.pinned.is_(True), 0), else_=1)
        nulls_date = case((self.tasks.c.due_date.is_(None), 1), else_=0)
        nulls_time = case((self.tasks.c.due_time.is_(None), 1), else_=0)

        with self.engine.connect() as conn:
            rows = conn.execute(
                select(
                    self.tasks.c.id,
                    self.tasks.c.title,
                    self.tasks.c.due_date,
                    self.tasks.c.due_time,
                    self.tasks.c.priority,
                    self.tasks.c.pinned,
                )
                .where(and_(*conds))
                .order_by(pin_first.asc(), nulls_date.asc(), self.tasks.c.due_date.asc(), nulls_time.asc(), self.tasks.c.due_time.asc(), self.tasks.c.created_at.desc())
                .limit(20)
            ).all()

        if not rows:
            return f"📭 {header}: задач нет"

        lines = [f"📋 {header} ({len(rows)})"]
        for r in rows:
            due = ""
            if r.due_date:
                due = f" · {r.due_date}{(' ' + r.due_time) if r.due_time else ''}"
            p = ""
            try:
                pr = int(r.priority or 0)
                if pr > 0:
                    p = " " + ("!" * min(3, pr))
            except Exception:
                pass
            pin = " 📌" if bool(r.pinned) else ""
            lines.append(f"• {r.title[:90]}{p}{pin}{due}\n  id: {r.id}")
        if len(rows) >= 20:
            lines.append("…показаны первые 20")
        return "\n".join(lines)

    # ---------- reminders ----------
    def _reminder_loop(self):
        # small delay on startup to let app finish init
        time.sleep(2)
        while not self._stop.is_set():
            try:
                self._send_due_reminders_once()
            except Exception as e:
                self.last_error = str(e)
                self._log(f"reminder loop error: {e}")
            # responsive sleep
            for _ in range(20):
                if self._stop.is_set():
                    return
                time.sleep(1)

    def _send_due_reminders_once(self):
        now = self.now_ts()
        # Look a bit around current time to be tolerant to loop delays.
        with self.engine.connect() as conn:
            rows = conn.execute(
                select(
                    self.tasks.c.id,
                    self.tasks.c.user_id,
                    self.tasks.c.title,
                    self.tasks.c.due_date,
                    self.tasks.c.due_time,
                    self.tasks.c.reminder_minutes,
                    self.tasks.c.tg_reminder_sent_at,
                    self.users.c.telegram_chat_id,
                    self.users.c.telegram_notify_enabled,
                )
                .select_from(self.tasks.join(self.users, self.users.c.id == self.tasks.c.user_id))
                .where(
                    and_(
                        self.tasks.c.completed.is_(False),
                        self.tasks.c.trashed.is_(False),
                        self.tasks.c.due_date.is_not(None),
                        self.tasks.c.reminder_minutes.is_not(None),
                        self.tasks.c.tg_reminder_sent_at.is_(None),
                        self.users.c.telegram_chat_id.is_not(None),
                        or_(self.users.c.telegram_notify_enabled.is_(True), self.users.c.telegram_notify_enabled.is_(None)),
                    )
                )
                .limit(300)
            ).mappings().all()

        for r in rows:
            due_ts = self._task_due_ts(r.get("due_date"), r.get("due_time"))
            if due_ts is None:
                continue
            rm = int(r.get("reminder_minutes") or 0)
            fire_at = due_ts - rm * 60
            # Trigger within [fire_at, fire_at+90s], and only if task not too stale.
            if now < fire_at or now > fire_at + 90:
                continue

            # reserve (avoid duplicate sends if multiple loops/workers race)
            with self.engine.begin() as conn:
                upd = conn.execute(
                    update(self.tasks)
                    .where(and_(self.tasks.c.id == r["id"], self.tasks.c.tg_reminder_sent_at.is_(None)))
                    .values(tg_reminder_sent_at=now, updated_at=now)
                )
                if not upd.rowcount:
                    continue

            due_text = str(r["due_date"])
            if r.get("due_time"):
                due_text += f" {r['due_time']}"
            txt = (
                f"🔔 Напоминание ClockTime\n"
                f"{r['title']}\n"
                f"Срок: {due_text}\n"
                f"ID: {r['id']}"
            )
            self._send_message(str(r["telegram_chat_id"]), txt)

    def _task_due_ts(self, due_date: Optional[str], due_time: Optional[str]) -> Optional[int]:
        if not due_date:
            return None
        try:
            if due_time:
                dt = datetime.strptime(f"{due_date} {due_time}", "%Y-%m-%d %H:%M")
            else:
                # no task timezone in app yet -> use a conventional morning reminder time (09:00 server local/UTC naive)
                dt = datetime.strptime(f"{due_date} 09:00", "%Y-%m-%d %H:%M")
            # treat as UTC to keep behaviour deterministic across Railway restarts/regions
            dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
        except Exception:
            return None
