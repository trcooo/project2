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

    def _send_message(self, chat_id: str, text: str, *, parse_mode: str = "HTML"):
        try:
            payload = {"chat_id": str(chat_id), "text": text, "disable_web_page_preview": True}
            if parse_mode:
                payload["parse_mode"] = parse_mode
            self._tg_api("sendMessage", payload, timeout=20)
            return True
        except Exception as e:
            self.last_error = str(e)
            self._log(f"sendMessage failed: {e}")
            return False

    def _h(self, s) -> str:
        x = "" if s is None else str(s)
        return (x.replace("&", "&amp;")
                 .replace("<", "&lt;")
                 .replace(">", "&gt;"))

    def _fmt_due_human(self, due_date, due_time=None) -> str:
        if not due_date:
            return "Без даты"
        try:
            d = datetime.strptime(str(due_date), "%Y-%m-%d").date()
            today = date.today()
            delta = (d - today).days
            if delta == 0:
                label = "Сегодня"
            elif delta == 1:
                label = "Завтра"
            elif delta == -1:
                label = "Вчера"
            elif 0 < delta < 7:
                names = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
                label = f"{names[d.weekday()]} ({d.strftime('%d.%m')})"
            else:
                label = d.strftime("%d.%m.%Y")
            if due_time:
                return f"{label} в {due_time}"
            return label
        except Exception:
            return f"{due_date}{(' ' + str(due_time)) if due_time else ''}"

    def _fmt_duration(self, minutes) -> str:
        try:
            if minutes is None:
                return ""
            dm = int(minutes)
            if dm <= 0:
                return ""
            if dm >= 60 and dm % 60:
                return f"{dm//60} ч {dm%60} мин"
            if dm >= 60:
                return f"{dm//60} ч"
            return f"{dm} мин"
        except Exception:
            return ""

    def _fmt_reminder(self, minutes) -> str:
        try:
            if minutes is None:
                return ""
            rm = int(minutes)
            if rm < 60:
                return f"за {rm} мин"
            if rm % 60 == 0 and rm < 1440:
                return f"за {rm//60} ч"
            if rm < 1440:
                return f"за {rm//60} ч {rm%60} мин"
            days = rm // 1440
            return f"за {days} дн"
        except Exception:
            return ""

    def _fmt_repeat(self, rule) -> str:
        m = {
            "daily": "Ежедневно",
            "weekdays": "По будням",
            "weekly": "Еженедельно",
            "monthly": "Ежемесячно",
            "yearly": "Ежегодно",
        }
        return m.get(str(rule or ""), str(rule or ""))

    def _task_line_html(self, r) -> str:
        title = self._h((r.title or "")[:90])
        markers = []
        try:
            pr = int(getattr(r, "priority", 0) or 0)
            if pr > 0:
                markers.append("❗" * min(3, pr))
        except Exception:
            pass
        if bool(getattr(r, "pinned", False)):
            markers.append("📌")
        head = f"• <b>{title}</b>"
        if markers:
            head += " " + " ".join(markers)
        meta = []
        if getattr(r, "due_date", None):
            meta.append("📅 " + self._h(self._fmt_due_human(r.due_date, getattr(r, "due_time", None))))
        dur = self._fmt_duration(getattr(r, "duration_minutes", None))
        if dur:
            meta.append("⏱ " + self._h(dur))
        body = head
        if meta:
            body += "\n  " + " • ".join(meta)
        body += f"\n  <code>{self._h(r.id)}</code>"
        return body

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
                    "👋 <b>ClockTime Bot</b>\n\n"
                    "Подключу тебя к аккаунту и помогу быстро управлять задачами.\n\n"
                    "<b>Как подключить:</b>\n"
                    "1) Открой <b>ClockTime → Настройки → Интеграции и импорт</b>\n"
                    "2) Скопируй код подключения\n"
                    "3) Отправь сюда: <code>/link КОД</code>\n\n"
                    "<b>Быстрые команды:</b>\n"
                    "• <code>/today</code> — задачи на сегодня\n"
                    "• <code>/tasks</code> — активные задачи\n"
                    "• <code>/add</code> — быстро добавить задачу\n"
                    "• <code>/help</code> — полный список")
                return
            if cmd == "/help":
                self._send_message(chat_id,
                    "🧭 <b>Команды ClockTime</b>\n\n"
                    "<b>Привязка</b>\n"
                    "• <code>/link КОД</code> — подключить аккаунт\n"
                    "• <code>/unlink</code> — отвязать чат\n"
                    "• <code>/id</code> — показать chat id\n\n"
                    "<b>Просмотр задач</b>\n"
                    "• <code>/today</code> — на сегодня\n"
                    "• <code>/tasks</code> — активные\n"
                    "• <code>/next7</code> — на 7 дней\n"
                    "• <code>/inbox</code> — входящие\n\n"
                    "<b>Быстрые действия</b>\n"
                    "• <code>/add текст</code> — добавить задачу\n"
                    "  <i>Пример:</i> <code>/add репетитор завтра 20:30 на 2ч @30m #учеба</code>\n"
                    "• <code>/done ID_ПРЕФИКС</code> — отметить выполненной")
                return
            if cmd == "/id":
                self._send_message(chat_id, f"🆔 <b>Ваш Telegram chat_id</b>\n<code>{self._h(chat_id)}</code>")
                return
            if cmd == "/link":
                return self._cmd_link(chat_id, username, arg)
            if cmd == "/unlink":
                return self._cmd_unlink(chat_id)

            user = self._user_by_chat(chat_id)
            if not user:
                self._send_message(chat_id, "🔗 <b>Аккаунт не подключён</b>\n\nОтправь <code>/link КОД</code> (код возьми в настройках ClockTime).")
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
                    self._send_message(chat_id, "✍️ <b>Как добавить задачу</b>\n<code>/add Купить молоко завтра 19:00 @30m</code>")
                    return
                return self._cmd_add(user["id"], chat_id, title)
            if cmd == "/done":
                return self._cmd_done(user["id"], chat_id, arg)

            self._send_message(chat_id, "🤔 Неизвестная команда. Открой <code>/help</code> для списка команд.")

    def _cmd_link(self, chat_id: str, username: Optional[str], code: str):
        code = (code or "").strip()
        if not code:
            self._send_message(chat_id, "🔗 <b>Подключение аккаунта</b>\nОтправь команду в формате: <code>/link КОД</code>\nКод находится в настройках ClockTime.")
            return
        with self.engine.begin() as conn:
            u = conn.execute(
                select(self.users).where(
                    and_(self.users.c.telegram_link_code == code)
                )
            ).mappings().first()
            if not u:
                self._send_message(chat_id, "❌ <b>Код не найден</b> или уже недействителен.\nСгенерируй новый код в настройках ClockTime.")
                return
            # code validity: 24h
            cts = int(u.get("telegram_link_code_created_at") or 0)
            if cts and self.now_ts() - cts > 86400:
                self._send_message(chat_id, "⌛ <b>Код подключения истёк</b>.\nСгенерируй новый код в настройках ClockTime.")
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
        self._send_message(chat_id,\
            "✅ <b>ClockTime подключён</b>\n\n"\
            "Теперь доступны команды:\n"\
            "• <code>/today</code>\n"\
            "• <code>/tasks</code>\n"\
            "• <code>/next7</code>\n"\
            "• <code>/inbox</code>\n"\
            "• <code>/add ...</code>")

    def _cmd_unlink(self, chat_id: str):
        with self.engine.begin() as conn:
            res = conn.execute(
                update(self.users)
                .where(self.users.c.telegram_chat_id == str(chat_id))
                .values(telegram_chat_id=None, telegram_username=None, telegram_notify_enabled=False)
            )
        if res.rowcount:
            self._send_message(chat_id, "🔌 <b>Чат отвязан</b> от ClockTime. Уведомления больше не будут приходить.")
        else:
            self._send_message(chat_id, "ℹ️ Этот чат сейчас не привязан к аккаунту ClockTime.")

    def _cmd_add(self, user_id: str, chat_id: str, title: str):
        inbox_id = self._inbox_list_id(user_id)
        if not inbox_id:
            self._send_message(chat_id, "⚠️ Не удалось найти список <b>«Входящие»</b>. Проверь системные списки в приложении.")
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

        details = []
        if values.get("due_date"):
            details.append(("📅", self._fmt_due_human(values["due_date"], values.get("due_time"))))
        if values.get("duration_minutes") is not None:
            dur_txt = self._fmt_duration(values.get("duration_minutes"))
            if dur_txt:
                details.append(("⏱", dur_txt))
        if values.get("reminder_minutes") is not None:
            rem_txt = self._fmt_reminder(values.get("reminder_minutes"))
            if rem_txt:
                details.append(("🔔", rem_txt))
        if values.get("repeat_rule"):
            details.append(("🔁", self._fmt_repeat(values.get("repeat_rule"))))
        if parsed.get("tags"):
            details.append(("🏷️", " ".join("#" + t for t in parsed["tags"])))
        if values.get("priority"):
            details.append(("⚡", "Приоритет " + ("❗" * int(values["priority"])) ))

        lines = [
            "✅ <b>Задача добавлена во «Входящие»</b>",
            f"<b>{self._h(final_title)}</b>",
        ]
        for icon, txt in details:
            lines.append(f"{icon} {self._h(txt)}")
        lines.append(f"🆔 <code>{self._h(tid)}</code>")
        self._send_message(chat_id, "\n".join(lines))

    def _cmd_done(self, user_id: str, chat_id: str, arg: str):
        q = (arg or "").strip()
        if not q:
            self._send_message(chat_id, "✅ <b>Как завершить задачу</b>\nИспользуй: <code>/done ID_ПРЕФИКС</code>\nПример: <code>/done 1709_</code>")
            return
        with self.engine.begin() as conn:
            rows = conn.execute(
                select(self.tasks.c.id, self.tasks.c.title, self.tasks.c.completed)
                .where(and_(self.tasks.c.user_id == user_id, self.tasks.c.trashed.is_(False), self.tasks.c.id.like(f"{q}%")))
                .order_by(self.tasks.c.created_at.desc())
                .limit(5)
            ).all()
            if not rows:
                self._send_message(chat_id, "❌ Задача с таким ID (или префиксом) не найдена.")
                return
            if len(rows) > 1:
                opts = "\n".join([f"• {r.id} — {r.title[:60]}" for r in rows])
                self._send_message(chat_id, "🔎 <b>Нашёл несколько задач</b> — уточни ID-префикс:\n\n<pre>" + self._h(opts) + "</pre>")
                return
            r = rows[0]
            if bool(r.completed):
                self._send_message(chat_id, "✅ Эта задача уже была отмечена как выполненная.")
                return
            ts = self.now_ts()
            conn.execute(
                update(self.tasks)
                .where(and_(self.tasks.c.id == r.id, self.tasks.c.user_id == user_id))
                .values(completed=True, completed_at=ts, updated_at=ts, tg_reminder_sent_at=None)
            )
        self._send_message(chat_id, f"✅ <b>Задача выполнена</b>\n<b>{self._h(r.title)}</b>\n🆔 <code>{self._h(r.id)}</code>")

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
        header_icon = "📋"
        if mode == "today":
            conds.append(self.tasks.c.due_date == today.isoformat())
            header = "Сегодня"
            header_icon = "📅"
        elif mode == "next7":
            conds.append(self.tasks.c.due_date.is_not(None))
            conds.append(self.tasks.c.due_date >= today.isoformat())
            conds.append(self.tasks.c.due_date <= (today + timedelta(days=6)).isoformat())
            header = "Следующие 7 дней"
            header_icon = "🗓️"
        elif mode == "inbox":
            inbox_id = self._inbox_list_id(user_id)
            if inbox_id:
                conds.append(self.tasks.c.list_id == inbox_id)
            header = "Входящие"
            header_icon = "📥"
        else:
            header = "Активные задачи"
            header_icon = "📋"

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
            return f"{header_icon} <b>{self._h(header)}</b>\n\nПока пусто ✨"

        lines = [f"{header_icon} <b>{self._h(header)}</b> <i>({len(rows)})</i>", ""]
        for r in rows:
            lines.append(self._task_line_html(r))
            lines.append("")
        if len(rows) >= 20:
            lines.append("… показаны первые <b>20</b> задач")
        lines.append("")
        lines.append("💡 <i>Завершить задачу:</i> <code>/done ID_ПРЕФИКС</code>")
        return "\n".join(lines).strip()

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
                "🔔 <b>Напоминание ClockTime</b>\n"
                f"<b>{self._h(r['title'])}</b>\n"
                f"📅 {self._h(self._fmt_due_human(r.get('due_date'), r.get('due_time')))}\n"
                f"🆔 <code>{self._h(r['id'])}</code>\n\n"
                "✅ <i>Завершить:</i> <code>/done ID_ПРЕФИКС</code>"
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
