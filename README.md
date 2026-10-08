# MentionJS

[Русская версия](README.ru.md)

Lightweight @-mention autocomplete for `<textarea>` and `contenteditable`.
No dependencies. ~10 KB gzipped. TypeScript definitions included.

**[Interactive demo](https://shelamkoff.github.io/mentionjs/)** ([direct link](https://shelamkoff.github.io/mentionjs/demo.html))

## Features

- Works with both `<textarea>` and `contenteditable` elements
- Async search function with debounce and stale-request guard
- Scroll-based and keyboard-based pagination via `nextPageUrl`
- Keyboard navigation: Arrow keys, Enter, Tab, Escape
- Programmatic API: `push()`, `getMentions()`, `clear()`, `destroy()`
- Avatar support (image URL or auto-generated letter placeholder)
- Viewport-aware dropdown positioning (flips above cursor when near bottom)
- Animated dropdown appearance (CSS transition)
- ARIA combobox/listbox semantics synchronized with keyboard and pointer selection
- UMD module format (browser global, CommonJS, AMD)

## Quick Start

```html
<link rel="stylesheet" href="mention.css">
<script src="mention.js"></script>

<div id="editor" contenteditable="true"></div>

<script>
const mention = new MentionJS(document.getElementById('editor'), {
    trigger: '@',
    debounceDelay: 300,
    noResultsText: 'Not found',
    provideSearchContext: true,
    allowSpacesInQuery: true, // Optional: search full names like "Anna Ivanova"
    searchFunction: async (query, nextPageUrl, context = {}) => {
        const url = nextPageUrl || `/api/users?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, { signal: context.signal });
        if (!res.ok) throw new Error(`Search failed (${res.status})`);
        return res.json(); // { items: [{ id, name, avatar?, details? }], nextPageUrl }
    },
    onMentionSelect(data) {
        console.log('Selected:', data.id, data.name);
    },
});
</script>
```

The example enables `provideSearchContext` because its callback declares a default third parameter. The request's `AbortSignal` is forwarded to `fetch`. The library passes `nextPageUrl` back to your callback for pagination, but does not fetch that URL itself.

## Installation

```bash
npm install @shelamkoff/mentionjs
```

```js
// CommonJS
const MentionJS = require('@shelamkoff/mentionjs');
```

```js
// ES Module (with bundler)
import MentionJS from '@shelamkoff/mentionjs';
```

**CDN:**

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@shelamkoff/mentionjs/dist/mention.min.css">
<script src="https://cdn.jsdelivr.net/npm/@shelamkoff/mentionjs/dist/mention.min.js"></script>
```

**Manual:**

```html
<link rel="stylesheet" href="mention.css">
<script src="mention.js"></script>
```

## Constructor

```js
const m = new MentionJS(element, options);
```

`element` must be a `<textarea>` or an element with `contenteditable="true"`.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `trigger` | `string` | `'@'` | Exactly one non-whitespace Unicode grapheme that opens the dropdown |
| `searchFunction` | `SearchFunction` | `null` | Async search function (see below) |
| `provideSearchContext` | `boolean` | `false` | Always pass the optional third search callback argument for callbacks with default/rest parameters |
| `emitInputOnProgrammaticChange` | `boolean` | `false` | Dispatch `input` after `push()` and `clear()` (opt-in for backwards compatibility) |
| `allowSpacesInQuery` | `boolean` | `false` | Keep an active search across spaces in names, e.g. `@Anna Ivanova`; line breaks and tabs still end the query |
| `debounceDelay` | `number` | `300` | Debounce delay in ms for non-empty queries |
| `noResultsText` | `string` | `'No results found'` | Text shown when search returns no items |
| `dropdownClass` | `string` | `''` | Additional CSS class for the dropdown container |
| `onMentionSelect` | `(data: { id, name }) => void` | `null` | Callback when a mention is committed |
| `renderItem` | `(data, index, isActive) => HTMLElement` | `null` | Custom render function for dropdown items |
| `renderNoResults` | `(noResultsText) => HTMLElement` | `null` | Custom render function for the "no results" row |
| `renderLoading` | `() => HTMLElement` | `null` | Custom render function for the loading indicator |

### searchFunction

```ts
type SearchFunction = (
    query: string,
    nextPageUrl?: string | null,
    context?: { signal?: AbortSignal }
) => Promise<SearchResult | MentionItem[]>;
```

Must return a Promise resolving to:

```js
{
    items: [
        { id: 1, name: 'Alice', avatar: '/img/alice.jpg', details: 'Developer' },
        { id: 2, name: 'Bob', details: 'Designer' },
    ],
    nextPageUrl: '/api/users?q=a&page=2'  // null when no more pages
}
```

- `items[].id` — unique identifier (string or number)
- `items[].name` — display name (required)
- `items[].avatar` — image URL (optional; letter placeholder is generated when absent)
- `items[].details` — secondary text line (optional)
- `nextPageUrl` — URL for the next page; `null` means no more pages

You may also return a plain array of items (without pagination).

Empty-string queries (`query === ''`) are executed immediately (no debounce) to show the initial list when the trigger character is typed.

By default, a whitespace character ends the search and releases an unfinished mention span. Set `allowSpacesInQuery: true` to search multi-word names without losing the active mention when typing a space. In `contenteditable`, native non-breaking spaces (NBSP) are normalized to regular spaces before calling `searchFunction`. With this option enabled, a space **does not** finish the search: select a result with Enter, Tab, or click; use Escape or move the caret out to cancel. Newlines and tabs still terminate the query.

`context.signal` is aborted for an **in-flight request** when it is superseded, the dropdown closes, or the instance is destroyed. A request that has already completed is not retroactively aborted. Existing search functions accepting only `query` or `(query, nextPageUrl)` remain compatible. Set `provideSearchContext: true` to receive the third argument in a callback with default or rest parameters (which report a smaller JavaScript `function.length`).

### Render Functions

All render functions are optional. When provided, they must return an `HTMLElement`. If they return a falsy value, the default rendering is used as a fallback.

**renderItem(data, index, isActive)**

Custom rendering for each dropdown item. The returned element automatically gets `mention-item` class and `data-index` attribute.

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

Custom rendering for the empty-results state.

```js
renderNoResults(text) {
    const el = document.createElement('div');
    el.className = 'mention-item mention-no-results';
    el.textContent = text;
    return el;
}
```

**renderLoading()**

Custom rendering for the pagination loading indicator. The returned element automatically gets `mention-loading` class.

```js
renderLoading() {
    const el = document.createElement('div');
    el.className = 'mention-loading';
    el.innerHTML = '<div class="mention-item"><div class="spinner"></div></div>';
    return el;
}
```

## Methods

### `getMentions()`

Returns an array of all committed mentions.

**Textarea** returns UTF-16 code-unit offsets (as in `textarea.selectionStart` and `selectionEnd`, not Unicode grapheme counts):

```js
[{ id: 1, name: 'Alice', start: 0, end: 6 }]
```

**ContentEditable** returns id and name only:

```js
[{ id: '1', name: 'Alice' }]
```

### `push({ id, name })`

Programmatically inserts a mention at the current cursor position, or at the end of the field if no cursor is active.

```js
m.push({ id: 1, name: 'Alice' });
```

### `clear()`

Clears all content and committed mentions.

By default, `push()` and `clear()` preserve the legacy behavior of not dispatching `input`. Set `emitInputOnProgrammaticChange: true` to notify form/framework listeners of both operations. A normal dropdown selection always emits `input`.

### `destroy()`

Removes all event listeners and the dropdown element. Call before removing the host element from the DOM.

### `MentionJS.create(element, options?)`

Static factory method. Equivalent to `new MentionJS(element, options)`.

## CSS Classes

Import `mention.css` for default styles. All classes are customizable:

| Class | Description |
|-------|-------------|
| `.mention-dropdown` | Dropdown container (positioned absolute, appended to `<body>`) |
| `.mention-dropdown.active` | Visible state (opacity 1, pointer-events auto) |
| `.mention-item` | Individual item row |
| `.mention-item.mention-active` | Highlighted item (keyboard or hover) |
| `.mention-item.mention-no-results` | "No results" row |
| `.mention-avatar` | Avatar `<img>` element |
| `.mention-avatar-placeholder` | Letter-circle fallback avatar |
| `.mention-info` | Text container (name + details) |
| `.mention-name` | Primary name text |
| `.mention-details` | Secondary details text |
| `.mention-loading` | Loading indicator row (pagination) |
| `.mention` | Committed mention `<span>` inside contenteditable |
| `.mention.active` | Active (being edited) mention span |

## How It Works

**Textarea**: Mentions are tracked as `{ id, name, start, end }` objects with UTF-16, half-open `[start, end)` ranges. Native edits are tracked via `beforeinput` and reconciled after `input`. Assigning `textarea.value` programmatically does not emit `input`; `getMentions()` and `push()` conservatively reconcile changes and may drop an ID when identical visible text makes mention identity ambiguous. The mention text is displayed inline as `@Name`.

**ContentEditable**: Each mention is a `<span class="mention">` with internal ownership metadata plus `data-mention-id` and `data-mention-name`. Active (in-progress) mentions have the `.active` class. Browser-driven input is reconciled after `input`, while operations that need atomic mention behavior are handled through `beforeinput`.

## Files

| File | Description |
|------|-------------|
| `mention.js` | Library source |
| `mention.css` | Default stylesheet |
| `mention.d.ts` | TypeScript type definitions |
| `dist/mention.min.js` | Generated minified JS (`npm run build` / `prepack`) |
| `dist/mention.min.css` | Generated minified CSS (`npm run build` / `prepack`) |
| `demo.html` | Interactive demo page |
| `index.html` | GitHub Pages root entrypoint (redirects to the demo) |
| `.nojekyll` | Disables Jekyll processing for the static site |
| `.github/workflows/ci.yml` | Tests and build checks |
| `.github/workflows/pages.yml` | GitHub Pages deployment after successful CI |
| `dist/mention.d.ts` | Generated copy of the TypeScript declarations |

The `dist/` directory is generated and is not stored in Git. It is included in published npm packages because `prepack` runs the build automatically.

## Browser Support

Requires modern `beforeinput`, Selection/Range, and AbortController support. Native CI smoke tests run source and the minified npm build in current Chrome and Firefox. Safari/WebKit is not part of the automated browser matrix. IE11 is not supported.

For complete Unicode grapheme segmentation, use an environment with `Intl.Segmenter`. When it is absent, MentionJS uses a best-effort built-in fallback for common combining marks and emoji sequences; it does not implement all Unicode grapheme-break rules (including some Indic conjuncts and Hangul Jamo).

## License

MIT

## Trust Boundary

`contenteditable` can import pre-existing mention spans carrying `data-mention-id` and `data-mention-name`. Such markup is treated as application-provided metadata, not as an authenticated identity. Sanitize untrusted HTML before inserting it into an editing host and validate mention IDs server-side before performing privileged actions. Custom render functions are also responsible for safe handling of untrusted content.

## Demo deployment

`demo.html` uses the local `mention.js` and `mention.css` files. It demonstrates abortable search, pagination, keyboard selection, the public `push()` / `clear()` / `getMentions()` methods, and committed IDs / offsets. `index.html` provides a GitHub Pages root entrypoint.

The **Deploy demo to Pages** workflow publishes the demo and minified JS/CSS **after a successful CI run triggered by a push to `main`**. The [GitHub Pages site](https://shelamkoff.github.io/mentionjs/) has been deployed successfully. Pages uses **Settings → Pages → Build and deployment → Source: GitHub Actions**; no `gh-pages` branch is required.
