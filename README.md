# TickTick-like ToDo (UI v2) — One-click Railway + PostgreSQL

## Быстрый деплой на Railway
1) Залей репо на GitHub
2) Railway → New Project → Deploy from GitHub → выбери репо → Deploy
3) Railway → Add → PostgreSQL (появится `DATABASE_URL`) → приложение само начнёт использовать Postgres

> Важно: НЕ добавляй Dockerfile и не подключай Vite — фронт статический и отдаётся FastAPI.

## Локальный запуск
```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Открой: http://127.0.0.1:8000/

## Что есть (похоже на TickTick)
- боковое меню (списки + счётчики)
- умный список "Сегодня"
- карточки задач + чекбокс выполнено
- даты: Сегодня / Завтра / дата
- группы (Сегодня/Завтра/Позже/Без даты) + сворачивание
- "Выполнено" отдельной секцией
- календарь (вкладка) + задачи выбранного дня
- глобальный поиск (вкладка)

## API
- GET    /api/lists
- POST   /api/lists
- PATCH  /api/lists/{id}
- DELETE /api/lists/{id}

- GET    /api/tasks?filter=all|active|completed&list_id=...&due=YYYY-MM-DD&q=...
- POST   /api/tasks
- PATCH  /api/tasks/{id}
- DELETE /api/tasks/{id}
