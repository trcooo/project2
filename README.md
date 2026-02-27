# TickTick-like ToDo — One-service Railway deploy + PostgreSQL

## Что изменилось
- **Один сервис**: FastAPI отдает и API, и фронтенд (static).
- **Railway deploy без ручных настроек**: в репо есть `railway.toml` + `Procfile`, старт-команда уже прописана.
- **PostgreSQL**: если в окружении есть `DATABASE_URL` — используем Postgres (Railway). Если нет — локально падаем на SQLite.

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

## Railway (быстро)
1) Залей репозиторий на GitHub
2) Railway → **New Project** → **Deploy from GitHub** → выбери репо → Deploy ✅  
   (Railway сам подхватит `railway.toml` и запустит проект)

## Подключить PostgreSQL на Railway
Railway → **Add** → **PostgreSQL** → после этого в сервис автоматически появится `DATABASE_URL`.  
Перезапуск не обязателен — но если попросит, сделай Redeploy.

## API
- GET    /api/tasks?filter=all|active|completed
- POST   /api/tasks     { "title": "..." }
- PATCH  /api/tasks/{id} { "title"?: "...", "completed"?: true/false }
- DELETE /api/tasks/{id}
- GET    /api/export
