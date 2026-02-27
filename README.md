# TickTick-like ToDo (UI v3) — Railway one-click + PostgreSQL

## Исправления / улучшения
- Исправлен `Internal Server Error` на SQLite (убран `NULLS LAST`).
- Добавлена сортировка на бэке: `sort=due|created`.
- Свайпы по задаче (моб): вправо = выполнить, влево = удалить.
- Быстрый ввод как в TickTick: нижняя строка ввода + иконки.
- Переключатель сортировки (кнопка "несгруппирован…").
- Адаптив под устройство: mobile/tablet/desktop (на десктопе боковое меню закреплено).

## Быстрый деплой на Railway
1) GitHub: залей репо
2) Railway → New Project → Deploy from GitHub → выбери репо → Deploy
3) Railway → Add → PostgreSQL (появится `DATABASE_URL`) → готово

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
