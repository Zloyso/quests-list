# Quests List

To-do lists for Obsidian with nested and password-protected lists, start and due dates, attachments, a calendar page, and sync with Google, Yandex and CalDAV calendars. Works on desktop and mobile. [English description below](#english).

Простые списки задач для Obsidian с календарём и синхронизацией с Яндекс, Google и другими календарями. Работает на компьютере, телефоне и планшете.

## Возможности

- **Три колонки**: списки слева, задачи выбранного списка в центре, карточка задачи справа. На телефоне колонки открываются по одной, с кнопкой «Назад».
- **Умные списки**: «Сегодня» (начатые и просроченные), «Ближайшие 7 дней», «Все задачи». Там же — переход в календарь.
- **Цвет и иконка у списка**: иконки из того же набора, что в самом Obsidian (меню списка → «Иконка…»).
- **Вложенные списки**: меню списка → «Новый подсписок». Открытый список показывает свои задачи и задачи вложенных списков, сгруппированные по подзаголовкам. Список можно перетащить внутрь другого (на середину строки), рядом с другим (на верхний или нижний край) или на заголовок «Списки», чтобы вынести на верхний уровень. То же — через меню «Переместить в…».
- **Даты по желанию**: новая задача создаётся без дат. Можно указать дату начала, срок или обе — с временем или на весь день. Задача только со сроком попадает в «Сегодня» и в календарь в день срока; задача без дат живёт только в своём списке. Задачи, добавленные в «Сегодня» или «Ближайшие 7 дней», получают сегодняшнюю или завтрашнюю дату, чтобы не пропасть из виду. Просроченные задачи подсвечиваются.
- **Описание в Markdown** с работающими `[[ссылками]]` на заметки.
- **Ссылки на заметки** хранилища и **вложения**: файл можно выбрать в хранилище или загрузить с устройства. При переименовании файла ссылки обновляются.
- **Перетаскивание**: меняйте порядок списков и задач, переносите задачу в другой список, бросив её на список слева. Работает мышью и пальцем (за значок ⋮⋮).
- **Сортировка** задач: вручную, по дате начала, по сроку, по названию, сначала новые. Списки — вручную или по названию. Если перетащить задачу в отсортированном списке, порядок на экране сохранится и список перейдёт на ручную сортировку.
- **Календарь** на отдельной странице: месяц, задачи и события подключённых календарей, повестка выбранного дня. Задачу можно перенести на другой день перетаскиванием. Переключатели над календарём включают и выключают отдельные списки и календари; правая кнопка на переключателе (или «Настройки вида» → «Показать только один список…») оставляет только один.
- **Синхронизация с календарями**: Яндекс Календарь, Google Календарь, iCloud, Nextcloud и любые CalDAV-серверы, а также подписки по ссылке `.ics`.
- Интерфейс на русском и английском, внешний вид в стиле [Passovik](https://github.com/Zloyso/passovik).

## Как пользоваться

1. Откройте Quests List значком ✓ на боковой панели или командой «Открыть списки задач». Календарь — значком календаря или командой «Открыть календарь задач».
2. Впишите задачу в строку «Добавить задачу» и нажмите Enter. Первая задача создаст список «Входящие».
3. Нажмите на задачу, чтобы открыть карточку: название, список, даты, описание, ссылки и вложения сохраняются сразу.

Правая кнопка мыши на задаче или списке открывает меню: переименовать, цвет, переместить, дублировать, удалить. На телефоне то же меню — под кнопкой «…» у списка и в карточке задачи.

## Закрытые списки

Меню списка → «Сделать закрытым». В первый раз плагин попросит придумать пароль: один пароль открывает все закрытые списки.

- Задачи и вложенные списки закрытого списка хранятся в `quests.json` **зашифрованными** (AES-256-GCM, ключ из пароля через PBKDF2-SHA256, 600 000 итераций). В открытом виде остаются только название, цвет и иконка самого списка.
- Пока списки закрыты, их задач нет ни в «Сегодня», ни в поиске, ни в календаре. Нажмите на закрытый список или выполните команду «Открыть закрытые списки» и введите пароль.
- Списки снова закрываются после бездействия (по умолчанию через 10 минут, настраивается), кнопкой с замком в заголовке «Списки» или командой «Закрыть закрытые списки».
- Задачи закрытых списков **никогда не отправляются** во внешние календари.
- Вложения и связанные заметки не шифруются — это обычные файлы хранилища.
- **Восстановить забытый пароль невозможно.** Пароль можно сменить в настройках плагина → «Закрытые списки»; если его сменили на одном устройстве, на других плагин попросит новый.

## Где хранятся данные

Всё хранится в папке `Quests` внутри хранилища Obsidian:

- `quests.json` — списки и задачи;
- `attachments/` — файлы, загруженные с устройства.

Папку можно перенести куда угодно в хранилище:

- в настройках плагина → «Папка с задачами»: выберите папку из подсказок (получится `<папка>/Quests`) или впишите путь и нажмите «Переместить» — папка переедет вместе с файлами, ссылки на вложения обновятся;
- или просто перетащите папку в проводнике Obsidian — плагин заметит это и продолжит работать с новым местом.

Если папку перенесли на другом устройстве, а настройки плагина между устройствами не синхронизируются, при запуске плагин сам найдёт файл задач на новом месте.

Папка намеренно не скрытая: скрытые папки многие синхронизаторы пропускают. Если файл изменился на другом устройстве, Quests List объединит изменения по каждой задаче отдельно.

Настройки календарей (включая пароли приложений и токен Google) хранятся в `.obsidian/plugins/quests-list/data.json`. Если вы синхронизируете папку `.obsidian`, они попадут и на другие устройства — это удобно, но учитывайте это.

## Синхронизация с календарями

Откройте настройки плагина → «Календари» → «Подключить календарь».

| Способ | Чтение событий | Задачи в календарь |
|---|---|---|
| Яндекс Календарь (CalDAV) | да | да |
| Google Календарь (API) | да | да |
| Другой CalDAV (iCloud, Nextcloud, Fastmail…) | да | да |
| Подписка по ссылке `.ics` | да | нет |

Если включено «Отправлять задачи в этот календарь», задачи появляются в нём как события (выполненные — с пометкой ✓). Если перенести или переименовать такое событие в календаре, задача изменится тоже. Если задачу правили и здесь, и в календаре, побеждает версия из Obsidian. Удалённые задачи удаляются и из календаря.

Календари обновляются раз в 15 минут (настраивается) и по кнопке ⟳; изменения задач отправляются через несколько секунд после правки.

### Яндекс Календарь

1. Откройте [Яндекс ID → Пароли приложений](https://id.yandex.ru/security/app-passwords) и создайте пароль с типом «Календарь CalDAV».
2. В Quests List выберите «Яндекс Календарь», укажите адрес почты и этот пароль.
3. Нажмите «Найти календари», выберите календарь и сохраните.

### Google Календарь

Google не разрешает сторонним плагинам общий ключ доступа, поэтому нужен свой (бесплатный) OAuth-клиент. Это делается один раз:

1. Откройте [Google Cloud Console](https://console.cloud.google.com/), создайте проект.
2. «APIs & Services» → «Library» → включите **Google Calendar API**.
3. «OAuth consent screen» (Google Auth Platform): тип **External**, заполните название и почту. В «Audience» добавьте себя в тестовые пользователи **или** нажмите «Publish app».
   В режиме «Testing» Google отзывает доступ через 7 дней — тогда придётся входить заново. Опубликованное приложение для личного использования проверять не нужно; при входе Google покажет предупреждение «приложение не проверено» — нажмите «Дополнительно» → «Перейти».
4. «Credentials» → «Create credentials» → «OAuth client ID» → тип **Desktop app**. Скопируйте Client ID и Client secret.
5. В Quests List выберите «Google Календарь», вставьте Client ID и Client secret, нажмите «Войти через Google» и разрешите доступ в браузере.
6. Выберите календарь и сохраните.

Вход возможен только в Obsidian на компьютере. После этого синхронизация работает и на телефоне, если настройки плагина синхронизируются между устройствами.

Если нужно только **видеть** события Google без отправки задач, проще подключить подписку: настройки календаря Google → «Закрытый адрес в формате iCal».

### iCloud и другие CalDAV

Выберите «Другой CalDAV». Для iCloud адрес сервера — `https://caldav.icloud.com`, пароль — [пароль приложения Apple ID](https://support.apple.com/ru-ru/102654).

## Сеть и приватность

Плагин обращается к сети **только если вы подключили календари**, и только к их серверам:

- подписки `.ics` — по указанной вами ссылке;
- CalDAV (Яндекс, iCloud и другие) — к указанному серверу, с вашим логином и паролем приложения;
- Google — к `oauth2.googleapis.com` и `www.googleapis.com` (вход и Calendar API). Для входа на компьютере плагин на время открывает локальный адрес `127.0.0.1` для ответа Google.

Логины, пароли приложений и токен Google хранятся в настройках плагина (`.obsidian/plugins/quests-list/data.json`) и никуда больше не передаются. Задачи закрытых списков во внешние календари не отправляются. Без подключённых календарей плагин в сеть не выходит. Телеметрии и рекламы нет.

Для синхронизации нужен аккаунт в соответствующем календаре (Google, Яндекс, iCloud и т. п.), а для Google — ещё и собственный OAuth-клиент (см. выше). Всё остальное работает без аккаунтов и без интернета.

## Лицензия

[MIT](LICENSE). В сборку входит библиотека [ical.js](https://github.com/kewisch/ical.js) (Mozilla Public License 2.0) для чтения календарей в формате iCalendar.

## Установка

### Через BRAT

1. Установите плагин [BRAT](https://obsidian.md/plugins?id=obsidian42-brat).
2. В его настройках выберите «Add beta plugin» и укажите `https://github.com/Zloyso/quests-list`.
3. Включите Quests List в настройках Obsidian.

### Вручную

Скачайте `main.js`, `manifest.json` и `styles.css` из [последнего релиза](https://github.com/Zloyso/quests-list/releases/latest), положите их в `<хранилище>/.obsidian/plugins/quests-list/` и включите плагин.

## Разработка

```bash
npm install
npm run dev     # сборка с отслеживанием изменений
npm test        # тесты
npm run lint
npm run build   # проверка типов и сборка
```

---

## English

Quests List is a simple to-do plugin for Obsidian on desktop and mobile. Three panes show lists, the tasks of the selected list and the task card. Tasks have an optional start date and due date (with or without time; new tasks have none), a Markdown description with working `[[links]]`, linked notes and attachments. Lists can be nested and have their own color and icon. Lists and tasks can be reordered by drag and drop (mouse or touch) or sorted. A separate calendar page shows tasks and events from connected calendars, with per-list filters; drag a task to another day to reschedule it.

**Private lists**: protect lists with a password. Their tasks and nested lists are stored encrypted (AES-256-GCM, key derived with PBKDF2-SHA256, 600,000 iterations), close automatically after inactivity and are never sent to outside calendars. A forgotten password cannot be recovered.

**Calendar sync**: Yandex Calendar and other CalDAV servers (iCloud, Nextcloud, Fastmail), Google Calendar (with your own OAuth "Desktop app" client, see the steps above), and read-only `.ics` subscriptions. Tasks can be sent to CalDAV and Google calendars as events; moving or renaming such an event in the calendar updates the task.

**Network use**: the plugin connects only to the calendars you add (your `.ics` links, your CalDAV server, or Google's OAuth and Calendar API; Google sign-in briefly listens on `127.0.0.1` on desktop). Credentials stay in the plugin's settings. Without connected calendars it makes no network requests. No telemetry, no ads.

**Accounts**: calendar sync needs an account with that calendar service (Google, Yandex, iCloud…), and Google also needs your own OAuth client. Everything else works without any account and offline.

**License**: MIT. Bundles [ical.js](https://github.com/kewisch/ical.js) (Mozilla Public License 2.0) to read iCalendar data.

**Data** lives in the `Quests` folder of your vault (`quests.json` and `attachments/`; the folder can be moved in the settings or in the file explorer) and is merged per task when synced between devices.

Install with [BRAT](https://obsidian.md/plugins?id=obsidian42-brat) (`https://github.com/Zloyso/quests-list`) or download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Zloyso/quests-list/releases/latest) into `<vault>/.obsidian/plugins/quests-list/`.
