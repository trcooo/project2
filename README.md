# TickTick-like ToDo (v4-fixed)

Если "кнопки не реагируют", почти всегда причина — JS ошибка или Service Worker кэш:
- Chrome DevTools → Console (посмотреть ошибки)
- DevTools → Application → Service Workers → Unregister
- Application → Clear storage → Clear site data
- затем Hard Reload (Ctrl+Shift+R)

Фичи: темы, свайпы с подтверждением, drag&drop manual-sort, папки/списки, теги/приоритет (база).


## Миграции
Если ты деплоил старую версию на Railway, Postgres мог остаться со старой схемой. В этой версии миграции выполняются автоматически при старте (добавятся недостающие колонки `tasks.list_id`, `tasks.due_date` и т.д.).
