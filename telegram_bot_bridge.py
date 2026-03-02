from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta, date
from typing import Optional

from sqlalchemy import and_, select, update, or_, case


_MONTHS_RU = {"янв":1,"января":1,"фев":2,"февраля":2,"мар":3,"марта":3,"апр":4,"апреля":4,"май":5,"мая":5,"июн":6,"июня":6,"июл":7,"июля":7,"авг":8,"августа":8,"сен":9,"сент":9,"сентября":9,"окт":10,"октября":10,"ноя":11,"ноября":11,"дек":12,"декабря":12}
_WEEKDAYS = {"вс":0,"воскресенье":0,"пн":1,"понедельник":1,"вт":2,"вторник":2,"ср":3,"среда":3,"чт":4,"четверг":4,"пт":5,"пятница":5,"сб":6,"суббота":6}

def _iso_date(y:int,m:int,d:int)->Optional[str]:
    try:
        dt = date(y,m,d)
        return dt.isoformat()
    except Exception:
        return None

def _parse_time_token(tok:str)->Optional[str]:
    x=(tok or '').strip().lower()
    if not x:
        return None
    x=re.sub(r'^в(?=\d)','',x)
    x=re.sub(r'[.,](\d{2})$', r':\1', x)
    m=re.match(r'^(\d{1,2}):(\d{2})(am|pm)?$', x)
    if not m:
        m2=re.match(r'^(\d{1,2})(am|pm)$', x)
        if m2:
            h=int(m2.group(1)); mm=0; ap=m2.group(2).lower()
        else:
            if re.fullmatch(r'\d{4}', x):
                h=int(x[:2]); mm=int(x[2:]); ap=''
            else:
                return None
    else:
        h=int(m.group(1)); mm=int(m.group(2)); ap=(m.group(3) or '').lower()
    if ap:
        if h==12: h=0
        if ap=='pm': h += 12
    if 0 <= h < 24 and 0 <= mm < 60:
        return f"{h:02d}:{mm:02d}"
    return None

def _parse_reminder_token(tok:str)->Optional[int]:
    m=re.match(r'^@?(\d+)(m|min|h|d)$', (tok or '').strip(), flags=re.I)
    if not m:
        return None
    n=int(m.group(1)); u=m.group(2).lower()
    return n*1440 if u.startswith('d') else n*60 if u.startswith('h') else n

def _parse_duration_token(tok:str)->Optional[int]:
    x=(tok or '').strip().lower()
    if not x:
        return None
    x=re.sub(r'^(dur:|duration:|длительность:|~+)', '', x)
    x=x.replace(',', '.')
    m=re.match(r'^(\d+(?:\.\d+)?)ч(?:(\d{1,2})м(?:ин)?)?$', x)
    if m:
        return max(1, round(float(m.group(1))*60 + int(m.group(2) or 0)))
    m=re.match(r'^(\d+)м(?:ин)?$', x)
    if m:
        return int(m.group(1))
    m=re.match(r'^(\d+(?:\.\d+)?)час(?:а|ов)?$', x)
    if m:
        return max(1, round(float(m.group(1))*60))
    m=re.match(r'^(\d+)мин(?:ут[аы]?)?$', x)
    if m:
        return int(m.group(1))
    m=re.match(r'^(\d+)h(\d{1,2})m$', x, flags=re.I)
    if m:
        return int(m.group(1))*60 + int(m.group(2))
    return None

def _parse_duration_pair(a:str,b:str)->Optional[int]:
    try:
        n=float(str(a).replace(',', '.'))
    except Exception:
        return None
    u=(b or '').strip().lower()
    if u in {'мин','м','min','minute','minutes'}:
        return max(1, round(n))
    if u in {'ч','час','часа','часов','h','hr','hrs','hour','hours'}:
        return max(1, round(n*60))
    if u in {'д','дн','дня','дней','day','days'}:
        return max(1, round(n*1440))
    return None

def _parse_repeat(tokens:list[str], i:int)->Optional[tuple[str,int]]:
    a=(tokens[i] if i < len(tokens) else '').lower()
    b=(tokens[i+1] if i+1 < len(tokens) else '').lower()
    one={('daily',):'daily',('ежедневно',):'daily',('weekly',):'weekly',('еженедельно',):'weekly',('monthly',):'monthly',('ежемесячно',):'monthly',('yearly',):'yearly',('ежегодно',):'yearly',('weekdays',):'weekdays',('будни',):'weekdays'}
    for k,v in one.items():
        if a == k[0]: return (v,1)
    if a == 'каждый' and b in {'день','дня'}: return ('daily',2)
    if a == 'каждую' and b == 'неделю': return ('weekly',2)
    if a == 'каждый' and b == 'месяц': return ('monthly',2)
    if a == 'каждый' and b == 'год': return ('yearly',2)
    if a == 'по' and b in {'будням','будни'}: return ('weekdays',2)
    return None

def _parse_date_tokens(tokens:list[str], i:int)->Optional[tuple[str,int]]:
    t1=(tokens[i] if i < len(tokens) else '').lower()
    t2=(tokens[i+1] if i+1 < len(tokens) else '').lower()
    t3=(tokens[i+2] if i+2 < len(tokens) else '').lower()
    today=date.today()
    if t1 in {'сегодня','today'}: return (today.isoformat(),1)
    if t1 in {'завтра','tomorrow'}: return ((today+timedelta(days=1)).isoformat(),1)
    if t1 == 'послезавтра': return ((today+timedelta(days=2)).isoformat(),1)
    if t1 == 'через':
        m=re.match(r'^(\d+)(д|дн|дня|дней|w|нед|недел[яьи]?)$', t2, flags=re.I)
        if m:
            n=int(m.group(1)); u=m.group(2).lower(); delta=n*7 if (u.startswith('w') or u.startswith('нед')) else n
            return ((today+timedelta(days=delta)).isoformat(),2)
        if re.fullmatch(r'\d+', t2) and re.match(r'^(д|дн|дня|дней|day|days|неделя|недели|недель|week|weeks)$', t3):
            n=int(t2); delta=n*7 if (t3.startswith('нед') or t3.startswith('week')) else n
            return ((today+timedelta(days=delta)).isoformat(),3)
    if t1 in {'в','во'} and t2 in _WEEKDAYS:
        target=_WEEKDAYS[t2]; delta=(target - today.weekday() - 1) % 7  # Python Monday=0, JS Sunday=0 mismatch fix later below
        # easier use datetime.weekday map manually from isoweekday
        pyw=today.weekday()  # Mon=0..Sun=6
        target_py={1:0,2:1,3:2,4:3,5:4,6:5,0:6}[target]
        delta=(target_py - pyw) % 7 or 7
        return ((today+timedelta(days=delta)).isoformat(),2)
    if t1 in _WEEKDAYS:
        pyw=today.weekday()
        target_py={1:0,2:1,3:2,4:3,5:4,6:5,0:6}[_WEEKDAYS[t1]]
        delta=(target_py - pyw) % 7 or 7
        return ((today+timedelta(days=delta)).isoformat(),1)
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', t1):
        return (t1,1)
    m=re.match(r'^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$', t1)
    if m:
        dd=int(m.group(1)); mm=int(m.group(2)); yy=int(m.group(3)) if m.group(3) else today.year
        if yy < 100: yy += 2000
        v=_iso_date(yy,mm,dd)
        if v: return (v,1)
    if re.fullmatch(r'\d{1,2}', t1) and t2 in _MONTHS_RU:
        dd=int(t1); yy=today.year; used=2
        if re.fullmatch(r'\d{2,4}', t3):
            yy=int(t3); yy = yy+2000 if yy < 100 else yy; used=3
        v=_iso_date(yy,_MONTHS_RU[t2],dd)
        if v and used == 2 and v < (today - timedelta(days=1)).isoformat():
            v=_iso_date(yy+1,_MONTHS_RU[t2],dd) or v
        if v: return (v,used)
    return None

def _parse_quick_add_text(raw:str)->dict:
    tokens=[t for t in (raw or '').strip().split() if t]
    kept=[]; tags=[]
    due_date=None; due_time=None; reminder=None; repeat_rule=None; duration=None; priority=0
    i=0
    while i < len(tokens):
        t=tokens[i]; low=t.lower()
        if t.startswith('#') and len(t) > 1:
            tags.append(t[1:]); i += 1; continue
        m=re.match(r'^!([1-3])$', t)
        if m:
            priority=int(m.group(1)); i += 1; continue
        rep=_parse_repeat(tokens, i)
        if rep:
            repeat_rule, used = rep; i += used; continue
        if low in {'в','во'} and i+1 < len(tokens):
            tm=_parse_time_token(tokens[i+1])
            if tm:
                due_time=tm; i += 2; continue
        tm=_parse_time_token(t)
        if tm:
            due_time=tm; i += 1; continue
        r=_parse_reminder_token(t)
        if r is not None:
            reminder=r; i += 1; continue
        if low in {'на','dur','duration','длительность'} and i+1 < len(tokens):
            d=_parse_duration_token(tokens[i+1])
            if d is not None:
                duration=d; i += 2; continue
            d2=_parse_duration_pair(tokens[i+1], tokens[i+2] if i+2 < len(tokens) else '')
            if d2 is not None:
                duration=d2; i += 3; continue
        d=_parse_duration_token(t)
        if d is not None:
            duration=d; i += 1; continue
        dt=_parse_date_tokens(tokens, i)
        if dt:
            due_date, used = dt; i += used; continue
        kept.append(t); i += 1
    # de-dup tags
    clean_tags=[]; seen=set()
    for tg in tags:
        x=tg.strip().lstrip('#')
        if x and x not in seen:
            seen.add(x); clean_tags.append(x)
    return {
        'title': ' '.join(kept).strip(),
        'due_date': due_date,
        'due_time': due_time,
        'reminder_minutes': reminder,
        'repeat_rule': repeat_rule,
        'duration_minutes': duration,
        'priority': priority,
        'tags': clean_tags,
    }


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
                    "/add <текст> — добавить задачу (понимает: сегодня/завтра/дата/время/на 2ч)\n"
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

        parsed = _parse_quick_add_text(title)
        final_title = (parsed.get("title") or "").strip() or title.strip()
        ts = self.now_ts()
        tid = self.gen_id()

        values = {
            "id": tid,
            "user_id": user_id,
            "title": final_title[:200],
            "completed": False,
            "created_at": ts,
            "updated_at": ts,
            "completed_at": None,
            "list_id": inbox_id,
            "section_id": None,
            "due_date": parsed.get("due_date"),
            "due_time": parsed.get("due_time"),
            "reminder_minutes": parsed.get("reminder_minutes"),
            "repeat_rule": parsed.get("repeat_rule"),
            "duration_minutes": parsed.get("duration_minutes"),
            "pinned": False,
            "order_index": ts * 1000,
            "priority": int(parsed.get("priority") or 0),
            "notes": None,
            "tags_json": json.dumps(parsed.get("tags") or [], ensure_ascii=False),
            "subtasks_json": '[]',
            "trashed": False,
            "trashed_at": None,
            "tg_reminder_sent_at": None,
        }
        with self.engine.begin() as conn:
            conn.execute(self.tasks.insert().values(**values))

        extras = []
        if values.get("due_date"):
            extras.append(values["due_date"] + ((" " + values["due_time"]) if values.get("due_time") else ""))
        if values.get("duration_minutes") is not None:
            try:
                dm = int(values["duration_minutes"])
                if dm >= 60 and (dm % 60):
                    extras.append(f"⏱ {dm//60}ч {dm%60}м")
                elif dm >= 60:
                    extras.append(f"⏱ {dm//60}ч")
                else:
                    extras.append(f"⏱ {dm}м")
            except Exception:
                pass
        if values.get("reminder_minutes") is not None:
            extras.append(f"🔔 {int(values['reminder_minutes'])}м")
        if values.get("repeat_rule"):
            extras.append(f"↻ {values['repeat_rule']}")
        if parsed.get("tags"):
            extras.append(" ".join("#" + t for t in parsed["tags"]))

        meta = ("\n" + " · ".join(extras)) if extras else ""
        self._send_message(chat_id, f"➕ Добавил задачу во Входящие:\n{final_title}{meta}\nID: {tid}")

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
                    self.tasks.c.duration_minutes,
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
            dur = ""
            try:
                if r.duration_minutes is not None:
                    dm = int(r.duration_minutes)
                    dur = f" · ⏱ {dm//60}ч {dm%60}м" if (dm >= 60 and dm % 60) else (f" · ⏱ {dm//60}ч" if dm >= 60 else f" · ⏱ {dm}м")
            except Exception:
                dur = ""
            lines.append(f"• {r.title[:90]}{p}{pin}{due}{dur}\n  id: {r.id}")
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
