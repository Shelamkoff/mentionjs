# MentionJS

@-mention автокомплит для `<textarea>` и `contenteditable`.
Без зависимостей. ~10 КБ gzipped. TypeScript типы в комплекте.

**[Демо](https://shelamkoff.github.io/mentionjs/demo.html)**

## Возможности

- Работает с `<textarea>` и `contenteditable` элементами
- Асинхронная функция поиска с debounce и защитой от устаревших запросов
- Пагинация по скроллу и клавиатуре через `nextPageUrl`
- Навигация клавиатурой: стрелки, Enter, Tab, Escape
- Программный API: `push()`, `getMentions()`, `clear()`, `destroy()`
- Аватары (URL изображения или автоматическая буква-заглушка)
- Позиционирование дропдауна с учётом viewport (переворачивается вверх у нижнего края)
- Анимация появления дропдауна (CSS-переход)
- ARIA-семантика combobox/listbox, синхронизированная с клавиатурой и указателем
- UMD-модуль (глобальная переменная, CommonJS, AMD)

## Быстрый старт

```html
<link rel="stylesheet" href="mention.css">
<script src="mention.js"></script>

<div id="editor" contenteditable="true"></div>

<script>
const mention = new MentionJS(document.getElementById('editor'), {
    trigger: '@',
    debounceDelay: 300,
    noResultsText: 'Никого не найдено',
    searchFunction: async (query, nextPageUrl) => {
        const url = nextPageUrl || `/api/users?q=${encodeURIComponent(query)}`;
        const res = await fetch(url);
        return await res.json();
        // Ожидается: { items: [{ id, name, avatar?, details? }], nextPageUrl: string | null }
    },
    onMentionSelect(data) {
        console.log('Выбран:', data.id, data.name);
    },
});
</script>
```

## Установка

```bash
npm install @shelamkoff/mentionjs
```

```js
// CommonJS
const MentionJS = require('@shelamkoff/mentionjs');
```

```js
// ES Module (с бандлером)
import MentionJS from '@shelamkoff/mentionjs';
```

**CDN:**

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@shelamkoff/mentionjs/dist/mention.min.css">
<script src="https://cdn.jsdelivr.net/npm/@shelamkoff/mentionjs/dist/mention.min.js"></script>
```

**Вручную:**

```html
<link rel="stylesheet" href="mention.css">
<script src="mention.js"></script>
```

## Конструктор

```js
const m = new MentionJS(element, options);
```

`element` должен быть `<textarea>` или элемент с `contenteditable="true"`.

## Опции

| Опция | Тип | По умолчанию | Описание |
|-------|-----|-------------|----------|
| `trigger` | `string` | `'@'` | Ровно одна непробельная Unicode-графема, открывающая дропдаун |
| `searchFunction` | `SearchFunction` | `null` | Асинхронная функция поиска (см. ниже) |
| `provideSearchContext` | `boolean` | `false` | Передавать третий аргумент поиска для функций с параметрами по умолчанию или rest |
| `emitInputOnProgrammaticChange` | `boolean` | `false` | Отправлять событие `input` после `push()` и `clear()` (по умолчанию сохранено старое поведение) |
| `debounceDelay` | `number` | `300` | Задержка debounce в мс для непустых запросов |
| `noResultsText` | `string` | `'No results found'` | Текст при пустом результате поиска |
| `dropdownClass` | `string` | `''` | Дополнительный CSS-класс для контейнера дропдауна |
| `onMentionSelect` | `(data: { id, name }) => void` | `null` | Колбэк при фиксации упоминания |
| `renderItem` | `(data, index, isActive) => HTMLElement` | `null` | Кастомный рендер элемента дропдауна |
| `renderNoResults` | `(noResultsText) => HTMLElement` | `null` | Кастомный рендер строки «нет результатов» |
| `renderLoading` | `() => HTMLElement` | `null` | Кастомный рендер индикатора загрузки |

### searchFunction

```ts
type SearchFunction = (
    query: string,
    nextPageUrl?: string | null,
    context?: { signal?: AbortSignal }
) => Promise<SearchResult | MentionItem[]>;
```

Должна вернуть Promise, который резолвится в:

```js
{
    items: [
        { id: 1, name: 'Анна Иванова', avatar: '/img/anna.jpg', details: 'Frontend Developer' },
        { id: 2, name: 'Алексей Петров', details: 'Backend Developer' },
    ],
    nextPageUrl: '/api/users?q=а&page=2'  // null — больше нет страниц
}
```

- `items[].id` — уникальный идентификатор (string или number)
- `items[].name` — отображаемое имя (обязательно)
- `items[].avatar` — URL изображения (необязательно; при отсутствии генерируется буква-заглушка)
- `items[].details` — вторая строка текста (необязательно)
- `nextPageUrl` — URL следующей страницы; `null` — страниц больше нет

Можно также вернуть простой массив items (без пагинации).

Пустые запросы (`query === ''`) выполняются без debounce, чтобы сразу показать список при вводе триггер-символа.

`context.signal` отменяется при новом запросе, закрытии дропдауна или уничтожении экземпляра. Старые функции, принимающие только `query` или `(query, nextPageUrl)`, остаются совместимыми. Для функций поиска с параметрами по умолчанию или rest установите `provideSearchContext: true`: третий аргумент будет передан даже при меньшем значении JavaScript `function.length`.

### Render-функции

Все render-функции необязательны. Должны возвращать `HTMLElement`. Если возвращают falsy-значение, используется рендер по умолчанию.

**renderItem(data, index, isActive)**

Кастомный рендер элемента дропдауна. Возвращённый элемент автоматически получает класс `mention-item` и атрибут `data-index`.

```js
renderItem(data, index, isActive) {
    const el = document.createElement('div');
    el.className = 'mention-item' + (isActive ? ' mention-active' : '');

    if (data.avatar) {
        const img = document.createElement('img');
        img.src = data.avatar;
        img.alt = '';
        img.className = 'mention-avatar';
        el.appendChild(img);
    }

    const info = document.createElement('div');
    info.className = 'mention-info';

    const name = document.createElement('div');
    name.className = 'mention-name';
    name.textContent = data.name;
    info.appendChild(name);

    if (data.role) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = data.role;
        info.appendChild(badge);
    }

    el.appendChild(info);
    return el;
}
```

**renderNoResults(noResultsText)**

Кастомный рендер состояния «нет результатов».

```js
renderNoResults(text) {
    const el = document.createElement('div');
    el.className = 'mention-item mention-no-results';
    el.textContent = text;
    return el;
}
```

**renderLoading()**

Кастомный рендер индикатора загрузки при пагинации. Возвращённый элемент автоматически получает класс `mention-loading`.

```js
renderLoading() {
    const el = document.createElement('div');
    el.className = 'mention-loading';
    el.innerHTML = '<div class="mention-item"><div class="spinner"></div></div>';
    return el;
}
```

## Методы

### `getMentions()`

Возвращает массив всех зафиксированных упоминаний.

**Textarea** — объекты со смещениями символов:

```js
[{ id: 1, name: 'Анна Иванова', start: 0, end: 13 }]
```

**ContentEditable** — только id и name:

```js
[{ id: '1', name: 'Анна Иванова' }]
```

### `push({ id, name })`

Программно вставляет упоминание в позицию курсора или в конец поля, если курсор не активен.

```js
m.push({ id: 1, name: 'Анна Иванова' });
```

### `clear()`

Очищает содержимое и все зафиксированные упоминания.

По умолчанию `push()` и `clear()` не генерируют событие `input` для совместимости. Используйте `emitInputOnProgrammaticChange: true` для уведомления управляемых форм. Выбор упоминания из списка всегда генерирует `input`.

### `destroy()`

Удаляет все обработчики событий и элемент дропдауна. Вызывайте перед удалением элемента из DOM.

### `MentionJS.create(element, options?)`

Статическая фабрика. Эквивалент `new MentionJS(element, options)`.

## CSS-классы

Подключите `mention.css` для стилей по умолчанию. Все классы можно переопределить:

| Класс | Описание |
|-------|----------|
| `.mention-dropdown` | Контейнер дропдауна (position: absolute, добавляется в `<body>`) |
| `.mention-dropdown.active` | Видимое состояние (opacity 1, pointer-events auto) |
| `.mention-item` | Строка элемента списка |
| `.mention-item.mention-active` | Выделенный элемент (клавиатура или hover) |
| `.mention-item.mention-no-results` | Строка «Нет результатов» |
| `.mention-avatar` | Элемент `<img>` аватара |
| `.mention-avatar-placeholder` | Буква-заглушка аватара (круг) |
| `.mention-info` | Контейнер текста (имя + детали) |
| `.mention-name` | Основной текст (имя) |
| `.mention-details` | Дополнительный текст |
| `.mention-loading` | Индикатор загрузки (пагинация) |
| `.mention` | Зафиксированный `<span>` упоминания внутри contenteditable |
| `.mention.active` | Активный (редактируемый) span упоминания |

## Как это работает

**Textarea**: Упоминания хранятся как объекты `{ id, name, start, end }`. Диапазон изменения фиксируется через `beforeinput` и сверяется после `input`, поэтому identity упоминания остаётся привязанной к исходному диапазону. Текст упоминания отображается inline как `@Имя`.

**ContentEditable**: Каждое упоминание — это `<span class="mention">` с внутренним маркером владения и атрибутами `data-mention-id` / `data-mention-name`. Активные упоминания имеют класс `.active`. Изменения браузера сверяются после `input`, а операции, требующие атомарного поведения mention, обрабатываются через `beforeinput`.

## Файлы

| Файл | Описание |
|------|----------|
| `mention.js` | Исходный код библиотеки |
| `mention.css` | Стили по умолчанию |
| `mention.d.ts` | TypeScript типы |
| `dist/mention.min.js` | Генерируемый минифицированный JS (`npm run build` / `prepack`) |
| `dist/mention.min.css` | Генерируемый минифицированный CSS (`npm run build` / `prepack`) |
| `demo.html` | Интерактивная демо-страница |

Каталог `dist/` генерируется и не хранится в Git. В опубликованный npm-пакет он включается автоматически: `prepack` запускает сборку перед упаковкой.

## Поддержка браузеров

Требуется современная поддержка `beforeinput`, Selection/Range и AbortController. Native smoke-тесты CI выполняются в актуальных Chrome и Firefox. Safari/WebKit не входит в автоматическую браузерную матрицу. IE11 не поддерживается.

## Лицензия

MIT

## Граница доверия

`contenteditable` может содержать заранее загруженные span с атрибутами `data-mention-id` и `data-mention-name`. Эта разметка считается метаданными приложения, а не подтверждением личности пользователя. Санитизируйте недоверенный HTML перед вставкой в редактор и проверяйте идентификаторы упоминаний на сервере перед выполнением привилегированных действий. Пользовательские функции рендера должны безопасно обрабатывать недоверенные данные.
