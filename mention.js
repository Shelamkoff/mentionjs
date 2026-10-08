/*!
 * MentionJS v1.0.0
 * Lightweight @-mention autocomplete for textarea and contenteditable
 * MIT License
 */
(function (global, factory) {
    if (typeof exports === 'object' && typeof module !== 'undefined') {
        module.exports = factory();
    } else if (typeof define === 'function' && define.amd) {
        define(factory);
    } else {
        const root = typeof globalThis !== 'undefined' ? globalThis : global || self;
        root.MentionJS = factory();
    }
})(this, function () {
    'use strict';

    const DEFAULTS = {
        trigger: '@',
        searchFunction: null,
        provideSearchContext: false,
        emitInputOnProgrammaticChange: false,
        debounceDelay: 300,
        noResultsText: 'No results found',
        dropdownClass: '',
        onMentionSelect: null,
        renderItem: null,
        renderNoResults: null,
        renderLoading: null,
    };

    let instanceCounter = 0;
    const activeInstances = new WeakMap();
    const SEARCH_CANCELLED = Symbol('MentionJS search cancelled');
    const SEARCH_FAILED = Symbol('MentionJS search failed');
    const graphemeSegmenter = typeof Intl?.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;

    function graphemeSegments(str) {
        if (graphemeSegmenter) {
            return Array.from(graphemeSegmenter.segment(str), ({ segment, index }) => ({
                segment,
                start: index,
                end: index + segment.length,
            }));
        }

        // Preserve common extended graphemes on runtimes without Intl.Segmenter.
        const segments = [];
        let index = 0;
        let start = 0;
        let cluster = '';
        let regionalCount = 0;
        for (const unit of Array.from(str)) {
            const regional = /\p{Regional_Indicator}/u.test(unit);
            const extend = /\p{Mark}/u.test(unit) ||
                /\p{Emoji_Modifier}/u.test(unit);
            const joins = cluster && (
                extend || unit === '\u200D' || cluster.endsWith('\u200D') ||
                (unit === '\n' && cluster.endsWith('\r')) ||
                (regional && regionalCount === 1)
            );
            if (!joins && cluster) {
                segments.push({ segment: cluster, start, end: index });
                start = index;
                cluster = '';
                regionalCount = 0;
            }
            cluster += unit;
            if (regional) regionalCount++;
            else if (!extend && unit !== '\u200D') regionalCount = 0;
            index += unit.length;
        }
        if (cluster) segments.push({ segment: cluster, start, end: index });
        return segments;
    }

    function countGraphemes(str) {
        return graphemeSegments(str).length;
    }

    function removeGraphemeBefore(str, offset) {
        if (offset <= 0) return { text: str, offset };

        const segments = graphemeSegments(str);
        let target = null;
        for (const segment of segments) {
            if (segment.start < offset && segment.end >= offset) {
                target = segment;
                break;
            }
            if (segment.end <= offset) target = segment;
        }

        if (!target) return { text: str, offset };

        return {
            text: str.substring(0, target.start) + str.substring(target.end),
            offset: target.start,
        };
    }

    function removeGraphemeAt(str, offset) {
        if (offset >= str.length) return { text: str, offset };

        const target = graphemeSegments(str).find(
            (segment) => segment.start <= offset && segment.end > offset
        );
        if (!target) return { text: str, offset };

        return {
            text: str.substring(0, target.start) + str.substring(target.end),
            offset: target.start,
        };
    }

    function contentEditableState(element) {
        let current = element;

        while (current instanceof HTMLElement) {
            const raw = current.getAttribute('contenteditable');

            if (raw !== null) {
                const value = raw.trim().toLowerCase();

                if (value === '' || value === 'true' || value === 'plaintext-only') {
                    return true;
                }
                if (value === 'false') return false;
            }

            current = current.parentElement;
        }

        return false;
    }

    function createElement(tag, className) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        return el;
    }

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (s) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]
        ));
    }

    function setCaretAt(node, offset) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.setStart(node, offset);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function setCaretAfterNode(node) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function setCaretBeforeNode(node) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.setStartBefore(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    class DropdownUI {
        constructor(options, id) {
            this._options = options;
            this._id = id;
            this._el = null;
        }

        get el() {
            return this._el;
        }

        mount(type) {
            if (this._el) this.destroy();

            this._el = createElement(
                'div',
                ['mention-dropdown', this._options.dropdownClass].filter(Boolean).join(' ')
            );
            this._el.dataset.mentionType = type;
            this._el.id = this._id;
            this._el.setAttribute('role', 'listbox');
            document.body.appendChild(this._el);
            return this._el;
        }

        render(items, selectedIndex) {
            if (!this._el) return;
            this._el.innerHTML = '';

            if (items.length === 0) {
                this._el.appendChild(this._buildNoResults());
                return;
            }

            items.forEach((item, index) => {
                this._el.appendChild(this._buildItem(item, index, selectedIndex));
            });
        }

        appendItems(newItems, startIndex, selectedIndex) {
            if (!this._el) return;
            newItems.forEach((item, i) => {
                this._el.appendChild(this._buildItem(item, startIndex + i, selectedIndex));
            });
        }

        _buildItem(data, index, selectedIndex) {
            if (this._options.renderItem) {
                const custom = this._options.renderItem(data, index, index === selectedIndex);
                if (custom instanceof HTMLElement) {
                    if (!custom.classList.contains('mention-item')) custom.classList.add('mention-item');
                    if (index === selectedIndex) custom.classList.add('mention-active');
                    custom.dataset.index = index;
                    custom.id = this.getOptionId(index);
                    custom.setAttribute('role', 'option');
                    custom.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
                    return custom;
                }
            }

            const el = createElement('div', 'mention-item' + (index === selectedIndex ? ' mention-active' : ''));
            el.dataset.index = index;
            el.id = this.getOptionId(index);
            el.setAttribute('role', 'option');
            el.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');

            if (data.avatar) {
                const img = document.createElement('img');
                img.src = data.avatar;
                img.alt = '';
                img.className = 'mention-avatar';
                el.appendChild(img);
            } else {
                const placeholder = createElement('div', 'mention-avatar-placeholder');
                const firstGrapheme = graphemeSegments(data.name || '?')[0]?.segment || '?';
                placeholder.textContent = firstGrapheme.toUpperCase();
                el.appendChild(placeholder);
            }

            const info = createElement('div', 'mention-info');
            const name = createElement('div', 'mention-name');
            name.textContent = data.name || '';
            info.appendChild(name);

            if (data.details) {
                const details = createElement('div', 'mention-details');
                details.textContent = data.details;
                info.appendChild(details);
            }

            el.appendChild(info);
            return el;
        }

        _buildNoResults() {
            if (this._options.renderNoResults) {
                const custom = this._options.renderNoResults(this._options.noResultsText);
                if (custom instanceof HTMLElement) {
                    if (!custom.hasAttribute('role')) custom.setAttribute('role', 'status');
                    custom.setAttribute('aria-live', 'polite');
                    return custom;
                }
            }

            const el = createElement('div', 'mention-item mention-no-results');
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            el.innerHTML = `
                <div class="mention-avatar-placeholder">?</div>
                <div class="mention-info">
                    <div class="mention-name">${escapeHtml(this._options.noResultsText)}</div>
                </div>
            `;
            return el;
        }

        getOptionId(index) {
            return this._id + '-option-' + index;
        }

        updateSelection(selectedIndex) {
            if (!this._el) return;
            this._el.querySelectorAll('.mention-item[data-index]').forEach((item) => {
                const isSelected = parseInt(item.dataset.index) === selectedIndex;
                item.classList.toggle('mention-active', isSelected);
                item.setAttribute('aria-selected', isSelected ? 'true' : 'false');
            });
        }

        scrollToActive() {
            if (!this._el) return;
            const active = this._el.querySelector('.mention-active');
            if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }

        showLoading() {
            if (!this._el || this._el.querySelector('.mention-loading')) return;

            if (this._options.renderLoading) {
                const custom = this._options.renderLoading();
                if (custom instanceof HTMLElement) {
                    if (!custom.classList.contains('mention-loading')) custom.classList.add('mention-loading');
                    if (!custom.hasAttribute('role')) custom.setAttribute('role', 'status');
                    custom.setAttribute('aria-live', 'polite');
                    this._el.appendChild(custom);
                    return;
                }
            }

            const loader = createElement('div', 'mention-loading');
            loader.setAttribute('role', 'status');
            loader.setAttribute('aria-live', 'polite');
            loader.innerHTML = `
                <div class="mention-item">
                    <div class="mention-avatar-placeholder">⏳</div>
                    <div class="mention-info"><div class="mention-name">Loading...</div></div>
                </div>
            `;
            this._el.appendChild(loader);
        }

        hideLoading() {
            if (!this._el) return;
            const loader = this._el.querySelector('.mention-loading');
            if (loader) loader.remove();
        }

        position({ top, left, cursorY, lineHeight = 20 }) {
            const element = this._el;
            if (!element) return;
            requestAnimationFrame(() => {
                // The dropdown may have been destroyed and remounted while
                // waiting for the frame. Never position a different element.
                if (this._el !== element) return;
                this._positionRaw({ top, left, cursorY, lineHeight });
            });
        }

        // Synchronous variant — use inside requestAnimationFrame to avoid double-rAF delay.
        positionRaw({ top, left, cursorY, lineHeight = 20 }) {
            if (!this._el) return;
            this._positionRaw({ top, left, cursorY, lineHeight });
        }

        _positionRaw({ top, left, cursorY, lineHeight }) {
            if (!this._el) return;

            this._el.style.top = top + 'px';
            this._el.style.left = left + 'px';

            const rect = this._el.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            let newLeft = left;
            let newTop = top;
            let horizontalOffset = 0;

            if (rect.right > vw - 10) {
                horizontalOffset -= rect.right - (vw - 10);
            }
            if (rect.left + horizontalOffset < 10) {
                horizontalOffset += 10 - (rect.left + horizontalOffset);
            }
            newLeft += horizontalOffset;

            if (rect.bottom > vh - 10 && cursorY > vh / 2) {
                newTop = top - this._el.offsetHeight - lineHeight;
            }

            this._el.style.top = newTop + 'px';
            this._el.style.left = newLeft + 'px';
            this._el.classList.add('active');
        }

        hide() {
            if (this._el) this._el.classList.remove('active');
        }

        destroy() {
            if (this._el) {
                this._el.remove();
                this._el = null;
            }
        }
    }


    class SearchSession {
        constructor(options) {
            this._options = options;
            this._requestId = 0;
            this._currentQuery = '';
            this._items = [];
            this._nextPageUrl = null;
            this._isLoadingMore = false;
            this._loadingMoreGeneration = 0;
            this._debounceTimer = null;
            this._debounceReject = null;
            this._activeController = null;
            this._activeReject = null;
        }

        get items() {
            return this._items;
        }

        get currentQuery() {
            return this._currentQuery;
        }

        get nextPageUrl() {
            return this._nextPageUrl;
        }

        get isLoadingMore() {
            return this._isLoadingMore;
        }

        beginLoadingMore() {
            if (this._isLoadingMore) return null;
            this._isLoadingMore = true;
            return ++this._loadingMoreGeneration;
        }

        finishLoadingMore(generation) {
            if (generation !== this._loadingMoreGeneration) return false;
            this._isLoadingMore = false;
            return true;
        }

        _invalidateLoadingMore() {
            this._loadingMoreGeneration++;
            this._isLoadingMore = false;
        }

        async search(query, nextPageUrl = null) {
            if (!nextPageUrl) {
                this._currentQuery = query;
                this._cancelDebounce();
                this._cancelActiveRequest();
                this._items = [];
                this._nextPageUrl = null;
                this._invalidateLoadingMore();
            }

            const requestId = ++this._requestId;

            const execute = async () => {
                if (!this._options.searchFunction) return { items: [], nextPageUrl: null };

                this._cancelActiveRequest();

                const controller = typeof AbortController === 'function'
                    ? new AbortController()
                    : null;
                let requestReject = null;
                this._activeController = controller;

                try {
                    return await new Promise((resolve, reject) => {
                        requestReject = reject;
                        this._activeReject = reject;

                        const searchFunction = this._options.searchFunction;
                        const args = [query, nextPageUrl];

                        if (this._options.provideSearchContext || searchFunction.length >= 3) {
                            args.push({ signal: controller?.signal });
                        }

                        Promise.resolve(
                            searchFunction(...args)
                        ).then(resolve, reject);
                    });
                } finally {
                    if (this._activeController === controller) {
                        this._activeController = null;
                    }
                    if (this._activeReject === requestReject) {
                        this._activeReject = null;
                    }
                }
            };

            let raw;
            try {
                if (!nextPageUrl && query.trim() !== '') {
                    raw = await new Promise((resolve, reject) => {
                        this._debounceReject = reject;
                        this._debounceTimer = setTimeout(() => {
                            this._debounceReject = null;
                            this._debounceTimer = null;
                            execute().then(resolve).catch(reject);
                        }, this._options.debounceDelay);
                    });
                } else {
                    raw = await execute();
                }
            } catch (err) {
                if (
                    err === SEARCH_CANCELLED ||
                    requestId !== this._requestId ||
                    err?.name === 'AbortError'
                ) {
                    return null;
                }
                console.warn('MentionJS: search failed', err);
                return SEARCH_FAILED;
            }

            if (requestId !== this._requestId) return null;

            const isArrayResult = Array.isArray(raw);
            const isObjectResult =
                raw !== null &&
                typeof raw === 'object' &&
                !isArrayResult &&
                Object.prototype.hasOwnProperty.call(raw, 'items');

            if (!isArrayResult && !isObjectResult) {
                console.warn('MentionJS: searchFunction returned an invalid result', raw);
                return SEARCH_FAILED;
            }

            const items = isArrayResult ? raw : raw.items;
            const next = isArrayResult ? null : (raw.nextPageUrl ?? null);
            const validItems =
                Array.isArray(items) &&
                items.every((item) => (
                    item !== null &&
                    typeof item === 'object' &&
                    (typeof item.id === 'string' ||
                     (typeof item.id === 'number' && Number.isFinite(item.id))) &&
                    typeof item.name === 'string' &&
                    (item.avatar === undefined || typeof item.avatar === 'string') &&
                    (item.details === undefined || typeof item.details === 'string')
                ));

            if (!validItems || (next !== null && typeof next !== 'string')) {
                console.warn('MentionJS: searchFunction returned an invalid result', raw);
                return SEARCH_FAILED;
            }

            this._nextPageUrl = next;
            this._items = nextPageUrl ? [...this._items, ...items] : items;

            return items;
        }

        cancel() {
            this._requestId++;
            this._cancelDebounce();
            this._cancelActiveRequest();
            this._items = [];
            this._nextPageUrl = null;
            this._invalidateLoadingMore();
        }

        _cancelDebounce() {
            if (this._debounceReject) {
                this._debounceReject(SEARCH_CANCELLED);
                this._debounceReject = null;
            }
            if (this._debounceTimer) {
                clearTimeout(this._debounceTimer);
                this._debounceTimer = null;
            }
        }

        _cancelActiveRequest() {
            if (this._activeController && !this._activeController.signal.aborted) {
                this._activeController.abort();
            }
            if (this._activeReject) {
                this._activeReject(SEARCH_CANCELLED);
            }
            this._activeController = null;
            this._activeReject = null;
        }
    }

    class TextareaMentionStore {
        constructor(initialValue = '', trigger = '@') {
            this._value = initialValue;
            this._trigger = trigger;
            this._edit = null;
            this._mentions = [];
        }

        captureEdit(element, event) {
            const inputType = event.inputType || '';
            const supported = new Set([
                'insertText',
                'insertCompositionText',
                'insertFromPaste',
                'insertFromDrop',
                'insertReplacementText',
                'deleteContentBackward',
                'deleteContentForward',
                'deleteByCut',
            ]);

            if (!supported.has(inputType)) {
                this._edit = null;
                return;
            }

            let start = element.selectionStart ?? 0;
            let end = element.selectionEnd ?? start;

            if (start === end) {
                if (inputType === 'deleteContentBackward' && start > 0) {
                    start--;
                } else if (inputType === 'deleteContentForward' && end < element.value.length) {
                    end++;
                }
            }

            this._edit = {
                start,
                end,
                value: element.value,
            };
        }

        reconcile(text) {
            const previousText = this._value ?? '';
            const edit = this._edit;

            if (previousText !== text) {
                const delta = text.length - previousText.length;
                const suffix = previousText.substring(edit?.end ?? previousText.length);
                const trustedEdit = edit &&
                    edit.value === previousText &&
                    text.startsWith(previousText.substring(0, edit.start)) &&
                    text.endsWith(suffix);

                const project = ({ start, end }) => this._mentions.flatMap((mention) => {
                    if (mention.end <= start) {
                        return [{ mention, start: mention.start, end: mention.end }];
                    }
                    if (mention.start >= end) {
                        return [{
                            mention,
                            start: mention.start + delta,
                            end: mention.end + delta,
                        }];
                    }
                    return [];
                });

                const primary = project(this._resolveEdit(
                    previousText, text, trustedEdit ? edit : null
                ));

                if (trustedEdit) {
                    this._mentions = primary.map(({ mention, start, end }) => ({
                        ...mention, start, end,
                    }));
                } else {
                    // Without a trustworthy beforeinput range, identical text can
                    // match different original mentions. Keep metadata only if
                    // both possible edit alignments preserve the same source.
                    const alternate = project(this._resolveEditFromEnd(previousText, text));
                    this._mentions = primary
                        .filter((item) => alternate.some((candidate) =>
                            candidate.mention === item.mention &&
                            candidate.start === item.start &&
                            candidate.end === item.end
                        ))
                        .map(({ mention, start, end }) => ({ ...mention, start, end }));
                }
            }

            this._mentions = this._mentions.filter((mention) => (
                mention.start >= 0 &&
                mention.end >= mention.start &&
                mention.end <= text.length &&
                text.substring(mention.start, mention.end) ===
                    this._trigger + mention.name
            ));

            this.acknowledge(text);
        }

        sync(value) {
            // Reading metadata before the browser's native input event must not
            // consume the pending beforeinput range while the value is unchanged.
            if (value !== this._value) this.reconcile(value);
        }

        replaceRange(start, end, replacementLength, mention) {
            const delta = replacementLength - (end - start);

            this._mentions = this._mentions.filter(
                (item) => item.end <= start || item.start >= end
            );

            this._mentions.forEach((item) => {
                if (item.start >= end) {
                    item.start += delta;
                    item.end += delta;
                }
            });

            this._mentions.push(mention);
            this._mentions.sort((a, b) => a.start - b.start);
        }

        acknowledge(value) {
            this._value = value;
            this._edit = null;
        }

        getMentions() {
            return this._mentions.map(({ id, name, start, end }) => ({ id, name, start, end }));
        }

        clear() {
            this._mentions = [];
            this.acknowledge('');
        }

        _resolveEditFromEnd(previousText, text) {
            const previousLength = previousText.length;
            const currentLength = text.length;
            let suffix = 0;
            while (
                suffix < previousLength &&
                suffix < currentLength &&
                previousText[previousLength - 1 - suffix] === text[currentLength - 1 - suffix]
            ) {
                suffix++;
            }

            let prefix = 0;
            while (
                prefix < previousLength - suffix &&
                prefix < currentLength - suffix &&
                previousText[prefix] === text[prefix]
            ) {
                prefix++;
            }

            return { start: prefix, end: previousLength - suffix };
        }

        _resolveEdit(previousText, text, edit) {
            if (edit && edit.value === previousText) {
                return { start: edit.start, end: edit.end };
            }

            const previousLength = previousText.length;
            const currentLength = text.length;
            let prefix = 0;

            while (
                prefix < previousLength &&
                prefix < currentLength &&
                previousText[prefix] === text[prefix]
            ) {
                prefix++;
            }

            let suffix = 0;
            while (
                suffix < previousLength - prefix &&
                suffix < currentLength - prefix &&
                previousText[previousLength - 1 - suffix] === text[currentLength - 1 - suffix]
            ) {
                suffix++;
            }

            return {
                start: prefix,
                end: previousLength - suffix,
            };
        }
    }

    class MentionJS {
        constructor(element, options = {}) {
            if (!(element instanceof HTMLElement)) {
                throw new Error('MentionJS: first argument must be an HTMLElement');
            }

            const tagName = element.tagName.toLowerCase();
            const contentEditable = element.getAttribute('contenteditable');
            const contentEditableValue = contentEditable?.trim().toLowerCase();
            const isTextarea = tagName === 'textarea';
            const isContentEditable =
                contentEditableValue === '' ||
                contentEditableValue === 'true' ||
                contentEditableValue === 'plaintext-only';
            const isEditingHost =
                isContentEditable &&
                !contentEditableState(element.parentElement);

            if (!isTextarea && !isEditingHost) {
                throw new Error('MentionJS: element must be a textarea or contenteditable editing host');
            }

            if (activeInstances.has(element)) {
                throw new Error('MentionJS: this editing host already has an active instance');
            }

            this._opts = Object.assign({}, DEFAULTS, options);

            if (
                typeof this._opts.trigger !== 'string' ||
                countGraphemes(this._opts.trigger) !== 1 ||
                /\s/u.test(this._opts.trigger)
            ) {
                throw new Error('MentionJS: trigger must be exactly one non-whitespace grapheme');
            }

            if (
                typeof this._opts.debounceDelay !== 'number' ||
                !Number.isFinite(this._opts.debounceDelay) ||
                this._opts.debounceDelay < 0
            ) {
                throw new Error('MentionJS: debounceDelay must be a non-negative finite number');
            }

            for (const optionName of [
                'searchFunction',
                'onMentionSelect',
                'renderItem',
                'renderNoResults',
                'renderLoading',
            ]) {
                const value = this._opts[optionName];
                if (value !== null && value !== undefined && typeof value !== 'function') {
                    throw new Error(`MentionJS: ${optionName} must be a function or null`);
                }
            }

            if (typeof this._opts.noResultsText !== 'string') {
                throw new Error('MentionJS: noResultsText must be a string');
            }
            if (typeof this._opts.dropdownClass !== 'string') {
                throw new Error('MentionJS: dropdownClass must be a string');
            }
            for (const optionName of ['provideSearchContext', 'emitInputOnProgrammaticChange']) {
                if (typeof this._opts[optionName] !== 'boolean') {
                    throw new Error(`MentionJS: ${optionName} must be a boolean`);
                }
            }

            this._el = element;
            this._isTextarea = isTextarea;
            this._instanceId = ++instanceCounter;
            this._dropdownId = 'mentionjs-dropdown-' + this._instanceId;

            this._ui = new DropdownUI(this._opts, this._dropdownId);
            this._searchSession = new SearchSession(this._opts);
            this._textareaMentions = this._isTextarea
                ? new TextareaMentionStore(element.value, this._opts.trigger)
                : null;

            this._selectedIndex = 0;
            this._mentionStart = null;
            this._mentionEnd = null;
            this._mentionSpan = null;
            this._mentionCounter = 0;
            this._suppressNextInput = false;
            this._suppressSyntheticContentEditableInput = false;
            this._nativeTriggerPending = false;
            this._dismissedTextareaStart = null;
            this._destroyed = false;

            this._h = {};
            this._a11yOriginal = {};

            this._configureAccessibility();
            this._bindElementEvents();
            this._bindDocumentClick();
            activeInstances.set(this._el, this);
        }

        _assertAlive() {
            if (this._destroyed) {
                throw new Error('MentionJS: instance has been destroyed');
            }
        }

        _isHostFocused() {
            const root = this._el.getRootNode?.();
            if (root && 'activeElement' in root) {
                return root.activeElement === this._el;
            }
            return document.activeElement === this._el;
        }

        _configureAccessibility() {
            const attributes = [
                'role',
                'aria-autocomplete',
                'aria-haspopup',
                'aria-controls',
                'aria-expanded',
                'aria-activedescendant',
            ];

            attributes.forEach((name) => {
                this._a11yOriginal[name] = this._el.getAttribute(name);
            });

            if (!this._el.hasAttribute('role')) this._el.setAttribute('role', 'combobox');
            this._el.setAttribute('aria-autocomplete', 'list');
            this._el.setAttribute('aria-haspopup', 'listbox');
            this._el.setAttribute('aria-controls', this._dropdownId);
            this._el.setAttribute('aria-expanded', 'false');
        }

        _restoreAccessibility() {
            Object.entries(this._a11yOriginal).forEach(([name, value]) => {
                if (value === null) this._el.removeAttribute(name);
                else this._el.setAttribute(name, value);
            });
        }

        _setExpanded(expanded) {
            this._el.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            if (!expanded) this._el.removeAttribute('aria-activedescendant');
        }

        _syncActiveDescendant() {
            if (!this._ui.el || !this._searchSession.items[this._selectedIndex]) {
                this._el.removeAttribute('aria-activedescendant');
                return;
            }

            this._el.setAttribute(
                'aria-activedescendant',
                this._ui.getOptionId(this._selectedIndex)
            );
        }

        _bindElementEvents() {
            this._h.blur = () => this._closeDropdown();

            if (this._isTextarea) {
                this._h.beforeinput = (e) => this._onTextareaBeforeInput(e);
                this._h.input = () => this._onTextareaInput();
                this._h.keydown = (e) => this._onTextareaKeydown(e);
                this._el.addEventListener('beforeinput', this._h.beforeinput);
                this._el.addEventListener('input', this._h.input);
                this._el.addEventListener('keydown', this._h.keydown);
            } else {
                this._h.beforeinput = (e) => this._onBeforeInput(e);
                this._h.input = () => this._onContentEditableInput();
                this._h.keydown = (e) => this._onContentEditableKeydown(e);
                this._h.compositionstart = () => this._onContentEditableCompositionStart();
                this._el.addEventListener('beforeinput', this._h.beforeinput);
                this._el.addEventListener('input', this._h.input);
                this._el.addEventListener('keydown', this._h.keydown);
                this._el.addEventListener('compositionstart', this._h.compositionstart);
            }

            this._el.addEventListener('blur', this._h.blur);
        }

        _unbindElementEvents() {
            if (this._isTextarea) {
                this._el.removeEventListener('beforeinput', this._h.beforeinput);
                this._el.removeEventListener('input', this._h.input);
                this._el.removeEventListener('keydown', this._h.keydown);
            } else {
                this._el.removeEventListener('beforeinput', this._h.beforeinput);
                this._el.removeEventListener('input', this._h.input);
                this._el.removeEventListener('keydown', this._h.keydown);
                this._el.removeEventListener('compositionstart', this._h.compositionstart);
            }

            this._el.removeEventListener('blur', this._h.blur);
        }

        _bindDocumentClick() {
            this._h.docClick = (e) => {
                const hasActiveSearch =
                    !!this._ui.el ||
                    this._mentionStart !== null ||
                    !!this._mentionSpan;
                if (!hasActiveSearch) return;

                const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
                const insideEditor =
                    path.includes(this._el) ||
                    this._el.contains(e.target) ||
                    e.target === this._el;
                const insideDropdown =
                    !!this._ui.el &&
                    (path.includes(this._ui.el) || this._ui.el.contains(e.target));

                if (!insideEditor && !insideDropdown) this._closeDropdown();
            };
            document.addEventListener('click', this._h.docClick);
        }

        _unbindDocumentClick() {
            if (this._h.docClick) document.removeEventListener('click', this._h.docClick);
        }

        _bindDropdownEvents() {
            if (!this._ui.el) return;

            this._h.ddClick = (e) => {
                const item = e.target.closest('.mention-item[data-index]');
                if (!item) return;
                const data = this._searchSession.items[parseInt(item.dataset.index)];
                if (data) this._commitMention(data);
            };
            this._h.ddScroll = () => this._onDropdownScroll();
            this._h.ddMousedown = (e) => e.preventDefault();
            this._h.ddMousemove = (e) => {
                const item = e.target.closest('.mention-item[data-index]');
                if (!item) return;

                const index = parseInt(item.dataset.index);
                if (!Number.isInteger(index) || index === this._selectedIndex) return;

                this._selectedIndex = index;
                this._ui.updateSelection(index);
                this._syncActiveDescendant();
            };

            this._ui.el.addEventListener('click', this._h.ddClick);
            this._ui.el.addEventListener('scroll', this._h.ddScroll);
            this._ui.el.addEventListener('mousedown', this._h.ddMousedown);
            this._ui.el.addEventListener('mousemove', this._h.ddMousemove);
        }

        _unbindDropdownEvents() {
            if (!this._ui.el) return;
            const EVENT_MAP = {
                ddClick: 'click',
                ddScroll: 'scroll',
                ddMousedown: 'mousedown',
                ddMousemove: 'mousemove',
            };
            Object.entries(EVENT_MAP).forEach(([key, eventName]) => {
                if (this._h[key]) this._ui.el.removeEventListener(eventName, this._h[key]);
            });
        }

        _bindScrollResize() {
            this._h.reposition = () => this._repositionDropdown();
            document.addEventListener('scroll', this._h.reposition, { passive: true, capture: true });
            window.addEventListener('resize', this._h.reposition, { passive: true });
        }

        _unbindScrollResize() {
            if (this._h.reposition) {
                document.removeEventListener('scroll', this._h.reposition, true);
                window.removeEventListener('resize', this._h.reposition);
            }
        }

        _bindSelectionChange() {
            if (this._h.selectionChange) return;
            this._h.selectionChange = () => this._onSelectionChange();
            document.addEventListener('selectionchange', this._h.selectionChange);
        }

        _unbindSelectionChange() {
            if (this._h.selectionChange) {
                document.removeEventListener('selectionchange', this._h.selectionChange);
                this._h.selectionChange = null;
            }
        }

        _onSelectionChange() {
            const hasActiveContext =
                !!this._ui.el ||
                this._mentionStart !== null ||
                !!this._mentionSpan;
            if (!hasActiveContext) return;

            if (this._isTextarea) {
                if (this._el.selectionStart !== this._el.selectionEnd) {
                    this._closeDropdown();
                    return;
                }

                const token = this._findTokenAtCursor(this._el.value, this._el.selectionStart);
                if (!token) {
                    this._closeDropdown();
                    return;
                }

                if (
                    token.start !== this._mentionStart ||
                    token.end !== this._mentionEnd ||
                    token.query !== this._searchSession.currentQuery
                ) {
                    this._mentionStart = token.start;
                    this._mentionEnd = token.end;
                    this._search(token.query).then((items) => {
                        if (items === null) return;
                        if (items === SEARCH_FAILED) {
                            this._closeDropdown();
                            return;
                        }
                        if (this._isHostFocused()) this._openDropdown(items);
                    });
                }
                return;
            }

            const span = this._getMentionSpan(window.getSelection());
            if (!span || span !== this._mentionSpan) {
                this._closeDropdown();
            }
        }

        _onTextareaBeforeInput(e) {
            this._textareaMentions.captureEdit(this._el, e);
        }

        async _onTextareaInput() {
            if (this._suppressNextInput) {
                this._suppressNextInput = false;
                return;
            }

            this._textareaMentions.reconcile(this._el.value);

            const pos = this._el.selectionStart;
            const hasSelection = this._el.selectionStart !== this._el.selectionEnd;
            const token = hasSelection ? null : this._findTokenAtCursor(this._el.value, pos);

            // Escape dismisses this token until its trigger is removed.
            if (this._dismissedTextareaStart !== null) {
                const start = this._dismissedTextareaStart;
                if (this._el.value.slice(start, start + this._opts.trigger.length) !== this._opts.trigger) {
                    this._dismissedTextareaStart = null;
                } else if (token?.start === start) {
                    this._closeDropdown();
                    return;
                }
            }

            if (token) {
                this._mentionStart = token.start;
                this._mentionEnd = token.end;
                const items = await this._search(token.query);
                if (items === null) return;
                if (items === SEARCH_FAILED) {
                    this._closeDropdown();
                    return;
                }
                this._openDropdown(items);
            } else {
                this._closeDropdown();
            }
        }

        _onTextareaKeydown(e) {
            if (e.key === 'Escape' && (this._ui.el || this._mentionStart !== null)) {
                e.preventDefault();
                this._dismissedTextareaStart = this._mentionStart;
                this._closeDropdown();
                return;
            }

            if (!this._ui.el) return;

            if (this._searchSession.items.length === 0) {
                if (e.key === 'Tab') {
                    // No candidate to accept: keep normal form focus traversal.
                    this._closeDropdown();
                } else if (e.key === 'Enter' || e.key === 'Escape') {
                    e.preventDefault();
                    this._closeDropdown();
                }
                return;
            }

            this._handleNavigationKey(e, (data) => this._commitTextareaMention(data));
        }

        _onContentEditableCompositionStart() {
            const sel = window.getSelection();
            const span = this._getMentionSpan(sel);
            if (!span || !sel?.isCollapsed) return;

            const node = sel.anchorNode;
            const offset = sel.anchorOffset;
            const text = span.textContent || '';
            const cursor =
                node?.nodeType === Node.TEXT_NODE && node.parentElement === span
                    ? offset
                    : (node === span ? offset : null);

            if (cursor === 0) {
                // Move the selection while the token is still connected.
                // Closing a pending token replaces its span with a text node.
                setCaretBeforeNode(span);
                this._closeDropdown();
                return;
            }

            const isCommitted =
                span.hasAttribute('data-mention-id') &&
                span.hasAttribute('data-mention-name');

            if (isCommitted && cursor === text.length) {
                const next = span.nextSibling;
                if (next?.nodeType === Node.TEXT_NODE) {
                    setCaretAt(next, 0);
                } else {
                    const textNode = document.createTextNode('');
                    span.after(textNode);
                    setCaretAt(textNode, 0);
                }
                this._closeDropdown();
            }
        }

        async _onBeforeInput(e) {
            this._nativeTriggerPending = false;
            const sel = window.getSelection();
            const span = this._getMentionSpan(sel);

            if (span) {
                await this._handleInputInsideSpan(e, span, sel);
                return;
            }

            if (e.inputType === 'insertText' && e.data === this._opts.trigger) {
                if (!this._canInsertMentionHere(sel)) return;
                if (!e.cancelable) {
                    // Let the browser insert normally; adopt its trigger on input.
                    this._nativeTriggerPending = true;
                    return;
                }
                e.preventDefault();
                const newSpan = this._insertMentionSpan(sel);
                this._mentionSpan = newSpan;
                this._dispatchContentEditableInput('insertText', this._opts.trigger);
                const items = await this._search('');
                if (items === null) return;
                if (items === SEARCH_FAILED) {
                    this._closeDropdown();
                    return;
                }
                this._openDropdownForSpan(items, newSpan);
            } else {
                this._closeDropdown();
            }
        }

        async _onContentEditableInput() {
            if (this._suppressSyntheticContentEditableInput) return;

            const pendingNativeTrigger = this._nativeTriggerPending;
            this._nativeTriggerPending = false;
            const sel = window.getSelection();
            const span = this._getMentionSpan(sel);

            if (!span) {
                if (pendingNativeTrigger) {
                    const adopted = this._adoptNativeTriggerAtCaret(sel);
                    if (adopted) {
                        const items = await this._search('');
                        if (items === null) return;
                        if (items === SEARCH_FAILED) {
                            this._closeDropdown();
                            return;
                        }
                        this._openDropdownForSpan(items, adopted);
                        return;
                    }
                }
                if (this._ui.el || this._mentionSpan) this._closeDropdown();
                return;
            }

            const text = span.textContent || '';

            // An unrelated input event must not erase a committed mention.
            if (
                span.hasAttribute('data-mention-id') &&
                span.hasAttribute('data-mention-name') &&
                !span.classList.contains('active') &&
                text === this._opts.trigger + span.dataset.mentionName
            ) {
                if (this._mentionSpan && this._mentionSpan !== span) {
                    // Selection may have reached another committed mention
                    // before the queued selectionchange event is delivered.
                    // Do not leave results attached to the previous token.
                    this._closeDropdown();
                }
                return;
            }

            if (!text.startsWith(this._opts.trigger)) {
                this._invalidateMentionMetadata(span);
                this._unwrapMentionSpan(span, sel);
                this._closeDropdown();
                return;
            }

            const query = text.substring(this._opts.trigger.length);
            if (/\s/u.test(query)) {
                // The token ended at whitespace. Keep the typed text, but stop
                // treating it as an unfinished mention or a search context.
                this._invalidateMentionMetadata(span);
                this._unwrapMentionSpan(span, sel);
                this._closeDropdown();
                return;
            }

            this._invalidateMentionMetadata(span);
            span.classList.add('active');
            this._mentionSpan = span;

            const items = await this._search(query);
            if (items === null) return;
            if (items === SEARCH_FAILED) {
                this._closeDropdown();
                return;
            }
            this._openDropdownForSpan(items, span);
        }

        async _handleInputInsideSpan(e, span, sel) {
            if (!this._inDOM(span)) { this._closeDropdown(); return; }

            const anchorNode = sel.anchorNode;
            const anchorOffset = sel.anchorOffset;
            const isActive = span.classList.contains('active');

            const spanText = span.textContent;
            const cursorInText = (anchorNode?.nodeType === Node.TEXT_NODE && anchorNode.parentElement === span)
                ? anchorOffset
                : (anchorNode === span ? anchorOffset : null);

            const isAtStart = cursorInText === 0;
            const isAtEnd = cursorInText === spanText.length;
            const browserManagedSelectionEdit =
                !sel.isCollapsed &&
                (
                    e.inputType.startsWith('delete') ||
                    [
                        'insertText',
                        'insertCompositionText',
                        'insertFromPaste',
                        'insertFromDrop',
                        'insertReplacementText',
                    ].includes(e.inputType)
                );

            if (browserManagedSelectionEdit) {
                this._invalidateMentionMetadata(span);
                if (!isActive) span.classList.add('active');
                this._mentionSpan = span;
                return;
            }

            if (isAtStart) {
                // Cancelling an uncommitted search unwraps the span. Preserve the
                // actual replacement node before performing an adjacent edit.
                const target = this._mentionSpan === span &&
                    !span.hasAttribute('data-mention-id')
                    ? this._unwrapMentionSpan(span, sel)
                    : span;
                this._closeDropdown();

                const manuallyInsertedText =
                    ['insertText', 'insertReplacementText'].includes(e.inputType) &&
                    typeof e.data === 'string' &&
                    e.data.length > 0;

                if (manuallyInsertedText) {
                    if (!e.cancelable) return;
                    e.preventDefault();
                    const tn = document.createTextNode(e.data);
                    target.parentNode.insertBefore(tn, target);
                    setCaretAt(tn, e.data.length);
                    this._dispatchContentEditableInput(e.inputType, e.data);
                    return;
                }

                if (e.inputType === 'deleteContentBackward') {
                    if (!e.cancelable) return;
                    e.preventDefault();
                    if (this._backspaceBeforeSpan(target, sel)) {
                        this._dispatchContentEditableInput(e.inputType);
                    }
                    return;
                }

                if (e.inputType === 'deleteContentForward') {
                    if (!e.cancelable) return;
                    e.preventDefault();
                    if (this._deleteForwardInSpan(target, spanText)) {
                        this._dispatchContentEditableInput(e.inputType);
                    }
                    return;
                }

                // Paste/drop and other browser-managed edits must not be swallowed.
                // Native input will reconcile the resulting DOM.
                return;
            }

            if (isAtEnd && !isActive) {
                if (
                    ['insertText', 'insertReplacementText'].includes(e.inputType) &&
                    typeof e.data === 'string' &&
                    e.data.length > 0
                ) {
                    if (!e.cancelable) return;
                    e.preventDefault();
                    const next = span.nextSibling;
                    if (next?.nodeType === Node.TEXT_NODE) {
                        next.textContent = e.data + next.textContent;
                        setCaretAt(next, e.data.length);
                    } else {
                        const char = e.data === ' ' ? '\u00A0' : e.data;
                        const tn = document.createTextNode(char);
                        span.after(tn);
                        setCaretAt(tn, char.length);
                    }
                    this._dispatchContentEditableInput(e.inputType, e.data);
                    return;
                }
                if (e.inputType === 'deleteContentForward') {
                    if (!e.cancelable) return;
                    e.preventDefault();
                    if (this._deleteForwardAfterNode(span)) {
                        this._dispatchContentEditableInput(e.inputType);
                    }
                    return;
                }
            }

            if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
                if (!e.cancelable) return;
                e.preventDefault();
                if (isActive && this._searchSession.items.length > 0) return;

                span.classList.remove('active');
                // The active span may be replaced by plain text on close.
                setCaretAfterNode(span);
                this._closeDropdown();
                if (this._insertBr(window.getSelection())) {
                    this._dispatchContentEditableInput(e.inputType);
                }
                return;
            }

            if (e.inputType === 'deleteContentBackward') {
                if (!e.cancelable) return;
                const offset = cursorInText ?? spanText.length;

                if (spanText === this._opts.trigger) {
                    e.preventDefault();
                    const prev = span.previousSibling;
                    const next = span.nextSibling;
                    span.remove();
                    if (this._mentionSpan === span) this._mentionSpan = null;
                    this._closeDropdown();

                    const range = document.createRange();
                    if (prev?.nodeType === Node.TEXT_NODE) range.setStart(prev, prev.textContent.length);
                    else if (next) range.setStartBefore(next);
                    else range.setStart(this._el, 0);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);

                    this._dispatchContentEditableInput(e.inputType);
                    return;
                }

                // Backspace over the trigger char → unwrap to plain text.
                if (offset === this._opts.trigger.length && spanText.startsWith(this._opts.trigger)) {
                    e.preventDefault();
                    const tn = document.createTextNode(
                        spanText.substring(this._opts.trigger.length)
                    );
                    span.parentNode.insertBefore(tn, span);
                    span.remove();
                    this._closeDropdown();
                    setCaretAt(tn, 0);
                    this._dispatchContentEditableInput(e.inputType);
                    return;
                }

                e.preventDefault();
                this._invalidateMentionMetadata(span);

                const removal = removeGraphemeBefore(spanText, offset);
                const newText = removal.text;
                const newOffset = removal.offset;
                const tn = span.firstChild;

                if (tn?.nodeType === Node.TEXT_NODE) {
                    tn.textContent = newText;
                } else {
                    span.textContent = newText;
                }
                setCaretAt(span.firstChild, newOffset);
                this._dispatchContentEditableInput(e.inputType);

                if (!isActive) span.classList.add('active');
                this._mentionSpan = span;

                const items = await this._search(newText.substring(this._opts.trigger.length));
                if (items === null) return;
                if (items === SEARCH_FAILED) {
                    this._closeDropdown();
                    return;
                }
                this._openDropdownForSpan(items, span);
                return;
            }

            if (e.inputType === 'deleteContentForward') {
                if (!e.cancelable) return;
                const offset = cursorInText ?? spanText.length;

                // At end of span → delete next sibling content.
                if (offset >= spanText.length) {
                    e.preventDefault();
                    if (this._deleteForwardAfterNode(span)) {
                        this._dispatchContentEditableInput(e.inputType);
                    }
                    return;
                }

                e.preventDefault();
                this._invalidateMentionMetadata(span);

                const removal = removeGraphemeAt(spanText, offset);
                const newText = removal.text;
                const newOffset = removal.offset;

                if (newText.length === 0) {
                    const prev = span.previousSibling;
                    const next = span.nextSibling;
                    span.remove();
                    this._closeDropdown();

                    const range = document.createRange();
                    if (next) range.setStartBefore(next);
                    else if (prev?.nodeType === Node.TEXT_NODE) range.setStart(prev, prev.textContent.length);
                    else range.setStart(this._el, 0);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);

                    this._dispatchContentEditableInput(e.inputType);
                    return;
                }

                // Deleted the trigger character → unwrap to plain text.
                if (
                    offset < this._opts.trigger.length &&
                    !newText.startsWith(this._opts.trigger)
                ) {
                    const tn = document.createTextNode(newText);
                    span.parentNode.insertBefore(tn, span);
                    span.remove();
                    this._closeDropdown();
                    setCaretAt(tn, 0);
                    this._dispatchContentEditableInput(e.inputType);
                    return;
                }

                const tn = span.firstChild;
                if (tn?.nodeType === Node.TEXT_NODE) {
                    tn.textContent = newText;
                } else {
                    span.textContent = newText;
                }
                setCaretAt(span.firstChild, newOffset);
                this._dispatchContentEditableInput(e.inputType);

                if (!isActive) span.classList.add('active');
                this._mentionSpan = span;

                const items = await this._search(newText.substring(this._opts.trigger.length));
                if (items === null) return;
                if (items === SEARCH_FAILED) {
                    this._closeDropdown();
                    return;
                }
                this._openDropdownForSpan(items, span);
                return;
            }

            if (e.inputType === 'insertText' && e.data) {
                const insertAt = cursorInText ?? spanText.length;
                const newText = spanText.substring(0, insertAt) + e.data + spanText.substring(insertAt);

                this._invalidateMentionMetadata(span);
                if (!isActive) span.classList.add('active');
                this._mentionSpan = span;

                // Browser mutation is not prevented here. The following native input
                // event reconciles the real DOM and supersedes this predicted query.
                const items = await this._search(newText.substring(this._opts.trigger.length));
                if (items === null) return;
                if (items === SEARCH_FAILED) {
                    this._closeDropdown();
                    return;
                }
                this._openDropdownForSpan(items, span);
            }
        }

        async _onContentEditableKeydown(e) {
            const sel = window.getSelection();
            const span = this._getMentionSpan(sel);

            if (e.key === 'Escape' && (this._ui.el || this._mentionSpan)) {
                e.preventDefault();
                this._closeDropdown();
                return;
            }

            if (e.key === 'Enter') {
                if (span?.classList.contains('active') || this._ui.el) {
                    e.preventDefault();
                    if (this._searchSession.items.length > 0) {
                        this._commitMention(this._searchSession.items[this._selectedIndex]);
                    } else {
                        if (span) span.classList.remove('active');
                        this._closeDropdown();
                    }
                    return;
                }

                if (span) {
                    e.preventDefault();
                    setCaretAfterNode(span);
                    if (this._insertBr(window.getSelection())) {
                        this._dispatchContentEditableInput('insertParagraph');
                    }
                    return;
                }
            }

            if (!this._ui.el) return;

            this._handleNavigationKey(e, (data) => this._commitMention(data));
        }

        _handleNavigationKey(e, onSelect) {
            const max = this._searchSession.items.length - 1;

            if (max < 0) {
                if (e.key === 'Escape') { e.preventDefault(); this._closeDropdown(); }
                return;
            }

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    this._selectedIndex = Math.min(this._selectedIndex + 1, max);
                    this._ui.updateSelection(this._selectedIndex);
                    this._syncActiveDescendant();
                    this._ui.scrollToActive();
                    this._maybeLoadMore();
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    this._selectedIndex = Math.max(this._selectedIndex - 1, 0);
                    this._ui.updateSelection(this._selectedIndex);
                    this._syncActiveDescendant();
                    this._ui.scrollToActive();
                    break;
                case 'Enter':
                case 'Tab':
                    e.preventDefault();
                    if (this._searchSession.items[this._selectedIndex]) {
                        onSelect(this._searchSession.items[this._selectedIndex]);
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    this._closeDropdown();
                    break;
            }
        }

        _commitMention(data) {
            if (this._isTextarea) {
                this._commitTextareaMention(data);
            } else {
                this._commitSpanMention(data);
            }
        }

        _commitTextareaMention(data) {
            if (this._mentionStart === null) return;

            const mentionText = this._opts.trigger + data.name;
            const before = this._el.value.substring(0, this._mentionStart);
            const after = this._el.value.substring(this._mentionEnd);
            const hasSeparator = /^[\s\u00A0]/.test(after);
            const separator = hasSeparator ? '' : ' ';

            this._el.value = before + mentionText + separator + after;
            this._textareaMentions.replaceRange(
                this._mentionStart,
                this._mentionEnd,
                mentionText.length + separator.length,
                {
                    id: data.id,
                    name: data.name,
                    start: this._mentionStart,
                    end: this._mentionStart + mentionText.length,
                }
            );
            this._textareaMentions.acknowledge(this._el.value);

            const newPos = this._mentionStart + mentionText.length + (hasSeparator ? 1 : separator.length);
            this._el.setSelectionRange(newPos, newPos);
            this._el.focus();
            this._closeDropdown();

            this._suppressNextInput = true;
            try {
                this._el.dispatchEvent(new Event('input', { bubbles: true }));
            } finally {
                // Earlier listeners can stop propagation before our input handler
                // sees this synthetic event; never suppress a later native edit.
                this._suppressNextInput = false;
            }
            this._textareaMentions.reconcile(this._el.value);
            this._fireSelect(data);
        }

        _commitSpanMention(data) {
            const span = this._mentionSpan;
            if (!span || !this._inDOM(span)) return;

            span.textContent = this._opts.trigger + data.name;
            span.classList.remove('active');
            span.dataset.mentionjsToken = 'true';
            span.dataset.mentionId = String(data.id);
            span.dataset.mentionName = data.name;
            span.removeAttribute('id');

            const next = span.nextSibling;
            const hasSpace = next?.nodeType === Node.TEXT_NODE && /^[\s\u00A0]/.test(next.textContent);

            if (hasSpace) {
                setCaretAt(next, 1);
            } else {
                const space = document.createTextNode('\u00A0');
                span.after(space);
                setCaretAt(space, 1);
            }

            this._closeDropdown();
            this._dispatchContentEditableInput(
                'insertReplacementText',
                this._opts.trigger + data.name
            );
            this._fireSelect(data);
        }

        _notifyProgrammaticChange(inputType, data = null) {
            if (!this._opts.emitInputOnProgrammaticChange) return;

            if (this._isTextarea) {
                this._suppressNextInput = true;
                try {
                    this._el.dispatchEvent(new Event('input', { bubbles: true }));
                } finally {
                    this._suppressNextInput = false;
                    this._textareaMentions.reconcile(this._el.value);
                }
            } else {
                this._dispatchContentEditableInput(inputType, data);
            }
        }

        _dispatchContentEditableInput(inputType = '', data = null) {
            this._suppressSyntheticContentEditableInput = true;

            try {
                let event;
                try {
                    event = new InputEvent('input', {
                        bubbles: true,
                        inputType,
                        data,
                    });
                } catch (_) {
                    event = new Event('input', { bubbles: true });
                }
                this._el.dispatchEvent(event);
                this._reconcileCommittedContentEditableMentions();
            } finally {
                this._suppressSyntheticContentEditableInput = false;
            }
        }

        _reconcileCommittedContentEditableMentions() {
            const selection = window.getSelection();
            const committed = Array.from(
                this._el.querySelectorAll(
                    'span.mention[data-mention-id][data-mention-name]'
                )
            );

            committed.forEach((span) => {
                const expected = this._opts.trigger + span.dataset.mentionName;
                if (span.textContent === expected) return;

                delete span.dataset.mentionId;
                delete span.dataset.mentionName;
                delete span.dataset.mentionjsToken;
                span.classList.remove('mention', 'active');

                if (span.isConnected) this._unwrapMentionSpan(span, selection);
            });
        }

        _fireSelect(data) {
            try {
                if (typeof this._opts.onMentionSelect === 'function') {
                    this._opts.onMentionSelect({ id: data.id, name: data.name });
                }
            } finally {
                if (this._isTextarea) {
                    this._textareaMentions.reconcile(this._el.value);
                } else {
                    this._reconcileCommittedContentEditableMentions();
                }
            }
        }

        // ─────────────────────────────────────────────
        // ContentEditable utilities
        // ─────────────────────────────────────────────

        _isMentionSpan(span) {
            if (!(span instanceof HTMLElement) || !span.matches('span.mention')) return false;
            return span.dataset.mentionjsToken === 'true' ||
                (span.hasAttribute('data-mention-id') && span.hasAttribute('data-mention-name'));
        }

        _getMentionSpan(sel) {
            if (!sel || sel.rangeCount === 0) return null;

            const range = sel.getRangeAt(0);
            const findSpan = (node) => {
                const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
                const span = element?.closest?.('span.mention') ?? null;
                return span && this._el.contains(span) && this._isMentionSpan(span) ? span : null;
            };

            const startSpan = findSpan(range.startContainer);
            const endSpan = findSpan(range.endContainer);

            return startSpan && startSpan === endSpan ? startSpan : null;
        }

        _invalidateMentionMetadata(span) {
            span.dataset.mentionjsToken = 'true';
            delete span.dataset.mentionId;
            delete span.dataset.mentionName;
        }

        _unwrapMentionSpan(span, sel = window.getSelection()) {
            const text = span.textContent || '';
            const selectionInside =
                !!sel &&
                sel.rangeCount > 0 &&
                !!sel.anchorNode &&
                span.contains(sel.anchorNode);
            const offset =
                selectionInside && sel.anchorNode.nodeType === Node.TEXT_NODE
                    ? sel.anchorOffset
                    : text.length;

            const textNode = document.createTextNode(text);
            span.replaceWith(textNode);

            if (selectionInside) {
                setCaretAt(textNode, Math.min(offset, text.length));
            }

            if (this._mentionSpan === span) this._mentionSpan = null;
            return textNode;
        }

        _findEdgeTextNode(node, fromEnd) {
            if (!node) return null;
            if (node.nodeType === Node.TEXT_NODE) return node;
            if (node.nodeType !== Node.ELEMENT_NODE) return null;

            const children = node.childNodes;
            if (fromEnd) {
                for (let i = children.length - 1; i >= 0; i--) {
                    const found = this._findEdgeTextNode(children[i], true);
                    if (found) return found;
                }
            } else {
                for (let i = 0; i < children.length; i++) {
                    const found = this._findEdgeTextNode(children[i], false);
                    if (found) return found;
                }
            }

            return null;
        }

        _deleteEdgeCharacter(node, fromEnd) {
            const textNode = this._findEdgeTextNode(node, fromEnd);
            if (textNode && textNode.textContent.length > 0) {
                const text = textNode.textContent;
                const removal = fromEnd
                    ? removeGraphemeBefore(text, text.length)
                    : removeGraphemeAt(text, 0);

                textNode.textContent = removal.text;
                if (textNode.textContent.length === 0) textNode.remove();
                return removal.text !== text;
            }

            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
                node.remove();
                return true;
            }

            return false;
        }

        _isBlockBoundaryElement(node) {
            if (!(node instanceof Element)) return false;
            if (node.tagName === 'BR') return true;

            const blockTags = new Set([
                'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
                'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2',
                'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL',
                'P', 'PRE', 'SECTION', 'TABLE', 'UL',
            ]);
            if (blockTags.has(node.tagName)) return true;

            const display = window.getComputedStyle(node).display;
            return display === 'block' ||
                display === 'list-item' ||
                display === 'table' ||
                display === 'flex' ||
                display === 'grid' ||
                display === 'flow-root' ||
                display.startsWith('table-');
        }

        _charBeforeCaret(sel) {
            if (!sel || sel.rangeCount === 0) return null;

            const range = sel.getRangeAt(0);
            const container = range.startContainer;
            const offset = range.startOffset;

            if (container.nodeType === Node.TEXT_NODE && offset > 0) {
                return container.textContent[offset - 1];
            }

            if (container.nodeType === Node.ELEMENT_NODE && offset > 0) {
                const prev = container.childNodes[offset - 1];
                if (this._isBlockBoundaryElement(prev)) return '\n';

                const textNode = this._findEdgeTextNode(prev, true);
                if (textNode?.textContent?.length) return textNode.textContent.slice(-1);
            }

            let current = container;
            while (current && current !== this._el) {
                const prev = current.previousSibling;
                if (prev) {
                    if (this._isBlockBoundaryElement(prev)) return '\n';

                    const textNode = this._findEdgeTextNode(prev, true);
                    if (textNode?.textContent?.length) return textNode.textContent.slice(-1);
                }

                const parent = current.parentNode;
                if (!parent) break;
                if (parent !== this._el && this._isBlockBoundaryElement(parent)) return '\n';
                current = parent;
            }

            return null;
        }

        _canInsertMentionHere(sel) {
            const charBefore = this._charBeforeCaret(sel);
            return charBefore === null || /[\s\u00A0]/.test(charBefore);
        }

        _adoptNativeTriggerAtCaret(sel) {
            if (!sel?.isCollapsed || !this._isHostFocused()) return null;
            const node = sel.anchorNode;
            const offset = sel.anchorOffset;
            const trigger = this._opts.trigger;
            if (node?.nodeType !== Node.TEXT_NODE || offset < trigger.length ||
                node.textContent.slice(offset - trigger.length, offset) !== trigger) {
                return null;
            }

            const boundary = document.createRange();
            boundary.setStart(node, offset - trigger.length);
            boundary.collapse(true);
            const before = this._charBeforeCaret({
                rangeCount: 1,
                getRangeAt: () => boundary,
            });
            if (before !== null && !/[\s\u00A0]/u.test(before)) return null;

            const range = document.createRange();
            range.setStart(node, offset - trigger.length);
            range.setEnd(node, offset);
            range.deleteContents();

            const span = createElement('span', 'mention active');
            span.dataset.mentionjsToken = 'true';
            span.id = 'mjs-' + this._instanceId + '-' + (++this._mentionCounter);
            span.textContent = trigger;
            range.insertNode(span);
            setCaretAt(span.firstChild, trigger.length);
            this._mentionSpan = span;
            return span;
        }

        _insertMentionSpan(sel) {
            const range = sel.getRangeAt(0);
            range.deleteContents();

            const span = createElement('span', 'mention active');
            span.dataset.mentionjsToken = 'true';
            span.id = 'mjs-' + this._instanceId + '-' + (++this._mentionCounter);
            span.appendChild(document.createTextNode(this._opts.trigger));
            range.insertNode(span);

            setCaretAt(span.firstChild, this._opts.trigger.length);
            return span;
        }

        _backspaceBeforeSpan(span, sel) {
            const prev = span.previousSibling;

            if (prev?.nodeType === Node.TEXT_NODE && prev.textContent.length > 0) {
                const text = prev.textContent;
                const removal = removeGraphemeBefore(text, text.length);
                prev.textContent = removal.text;
                if (prev.textContent.length === 0) prev.remove();
                setCaretBeforeNode(span);
                return removal.text !== text;
            }

            if (this._isMentionSpan(prev)) {
                prev.classList.add('active');
                setCaretAt(prev.firstChild, prev.textContent.length);
                this._mentionSpan = prev;
                const query = prev.textContent.substring(this._opts.trigger.length);
                this._search(query).then((items) => {
                    if (items === null) return;
                    if (items === SEARCH_FAILED) {
                        this._closeDropdown();
                        return;
                    }
                    this._openDropdownForSpan(items, prev);
                });
                return false;
            }

            if (prev) {
                const changed = this._deleteEdgeCharacter(prev, true);
                setCaretBeforeNode(span);
                return changed;
            }

            return false;
        }

        // Forward delete at left edge of span — deletes the trigger character.
        _deleteForwardInSpan(span, spanText) {
            if (spanText === this._opts.trigger) {
                const next = span.nextSibling;
                span.remove();
                if (next) setCaretBeforeNode(next);
                else setCaretAt(this._el, this._el.childNodes.length);
            } else {
                const remaining = spanText.substring(this._opts.trigger.length);
                const tn = document.createTextNode(remaining);
                span.parentNode.insertBefore(tn, span);
                span.remove();
                setCaretAt(tn, 0);
            }

            return true;
        }

        // Delete the first character of the next sibling after a node.
        _deleteForwardAfterNode(node) {
            const next = node.nextSibling;
            if (!next) return false;

            if (this._isMentionSpan(next)) {
                next.remove();
                return true;
            }

            return this._deleteEdgeCharacter(next, false);
        }

        _insertBr(sel) {
            if (!sel.rangeCount) return false;

            const range = sel.getRangeAt(0);
            range.deleteContents();
            const br = document.createElement('br');
            range.insertNode(br);
            range.setStartAfter(br);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            return true;
        }

        _findTokenAtCursor(text, position) {
            const before = text.substring(0, position);
            const triggerIdx = before.lastIndexOf(this._opts.trigger);

            if (triggerIdx === -1) return null;
            if (triggerIdx > 0 && !/\s/.test(text[triggerIdx - 1])) return null;

            const triggerEnd = triggerIdx + this._opts.trigger.length;
            const query = before.substring(triggerEnd);
            if (/\s/.test(query)) return null;
            if (triggerEnd + query.length !== position) return null;

            return { start: triggerIdx, end: position, query };
        }

        _openDropdownForSpan(items, span) {
            if (!this._inDOM(span) || this._mentionSpan !== span) {
                this._closeDropdown();
                return;
            }
            this._openDropdown(items);
        }

        _openDropdown(items) {
            if (!this._el.isConnected) {
                this._closeDropdown();
                return;
            }

            const isNew = !this._ui.el;
            if (isNew) {
                this._ui.mount(this._isTextarea ? 'textarea' : 'contenteditable');
                this._bindDropdownEvents();
                this._bindScrollResize();
                this._bindSelectionChange();
            }

            this._ui.hide();
            this._selectedIndex = 0;
            this._ui.render(items, 0);
            this._setExpanded(true);
            this._syncActiveDescendant();
            this._repositionDropdown();
        }

        _closeDropdown() {
            this._nativeTriggerPending = false;
            this._searchSession.cancel();
            this._setExpanded(false);

            this._unbindDropdownEvents();
            this._unbindScrollResize();
            this._unbindSelectionChange();
            this._ui.destroy();

            if (this._mentionSpan) {
                const span = this._mentionSpan;
                const isCommitted =
                    span.hasAttribute('data-mention-id') &&
                    span.hasAttribute('data-mention-name');

                span.classList.remove('active');
                span.removeAttribute('id');

                if (!isCommitted) {
                    this._unwrapMentionSpan(span, window.getSelection());
                }
            }

            this._mentionStart = null;
            this._mentionEnd = null;
            this._mentionSpan = null;
            this._selectedIndex = 0;
        }

        _repositionDropdown() {
            if (!this._ui.el) return;
            if (this._isTextarea) {
                this._positionNearCursorInTextarea();
            } else {
                this._positionNearMentionSpan();
            }
        }

        _positionNearCursorInTextarea() {
            const dropdown = this._ui.el;
            const tokenStart = this._mentionStart;
            requestAnimationFrame(() => {
                if (!dropdown || this._ui.el !== dropdown || this._mentionStart !== tokenStart) return;

                const el = this._el;
                const cursorPos = tokenStart !== null ? tokenStart : el.selectionStart;
                const textBeforeCursor = el.value.substring(0, cursorPos);
                const cs = window.getComputedStyle(el);

                const mirror = document.createElement('div');
                const copyProps = [
                    'font', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle',
                    'lineHeight', 'letterSpacing', 'wordSpacing', 'textTransform',
                    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
                    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
                    'boxSizing', 'direction', 'textAlign', 'tabSize', 'overflowWrap', 'wordBreak',
                ];
                copyProps.forEach((p) => { mirror.style[p] = cs[p]; });
                mirror.style.position = 'absolute';
                mirror.style.visibility = 'hidden';
                mirror.style.top = '0';
                mirror.style.left = '0';
                // Exclude the real textarea's vertical scrollbar from line wrapping.
                const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
                const borderRight = parseFloat(cs.borderRightWidth) || 0;
                const paddingLeft = parseFloat(cs.paddingLeft) || 0;
                const paddingRight = parseFloat(cs.paddingRight) || 0;
                const mirrorWidth = cs.boxSizing === 'border-box'
                    ? el.clientWidth + borderLeft + borderRight
                    : el.clientWidth - paddingLeft - paddingRight;
                mirror.style.width = Math.max(0, mirrorWidth) + 'px';
                mirror.style.whiteSpace = 'pre-wrap';
                mirror.style.wordWrap = 'break-word';
                mirror.style.overflow = 'hidden';
                mirror.textContent = textBeforeCursor;

                const marker = document.createElement('span');
                marker.textContent = '\u200b';
                mirror.appendChild(marker);
                document.body.appendChild(mirror);

                const elRect = el.getBoundingClientRect();
                const markerRect = marker.getBoundingClientRect();
                const mirrorRect = mirror.getBoundingClientRect();
                document.body.removeChild(mirror);

                const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
                const relX = markerRect.left - mirrorRect.left - el.scrollLeft;
                const relY = markerRect.top - mirrorRect.top - el.scrollTop;

                this._ui.positionRaw({
                    top: elRect.top + relY + lineHeight + window.scrollY,
                    left: elRect.left + relX + window.scrollX,
                    cursorY: elRect.top + relY + lineHeight,
                    lineHeight,
                });
            });
        }

        _positionNearMentionSpan() {
            const span = this._mentionSpan;
            if (!span || !this._inDOM(span)) {
                this._closeDropdown();
                return;
            }
            const rect = span.getBoundingClientRect();
            this._ui.position({
                top: rect.bottom + window.scrollY,
                left: rect.left + window.scrollX,
                cursorY: rect.bottom,
                lineHeight: rect.height || 20,
            });
        }

        async _search(query, nextPageUrl = null) {
            if (!nextPageUrl) {
                this._bindSelectionChange();
                if (this._ui.el) {
                    this._ui.hide();
                    this._setExpanded(false);
                }
            }
            return await this._searchSession.search(query, nextPageUrl);
        }

        _onDropdownScroll() {
            if (!this._ui.el || this._searchSession.isLoadingMore || !this._searchSession.nextPageUrl) return;
            const { scrollTop, scrollHeight, clientHeight } = this._ui.el;
            if (scrollTop + clientHeight >= scrollHeight - 10) this._loadMoreResults();
        }

        _maybeLoadMore() {
            if (this._selectedIndex >= this._searchSession.items.length - 2 &&
                this._searchSession.nextPageUrl &&
                !this._searchSession.isLoadingMore) {
                this._loadMoreResults();
            }
        }

        async _loadMoreResults() {
            if (!this._searchSession.nextPageUrl) return;

            const loadingGeneration = this._searchSession.beginLoadingMore();
            if (loadingGeneration === null) return;

            this._ui.showLoading();
            try {
                const prevLen = this._searchSession.items.length;
                const newItems = await this._search(
                    this._searchSession.currentQuery,
                    this._searchSession.nextPageUrl
                );
                if (newItems === null || newItems === SEARCH_FAILED) return;
                this._ui.appendItems(newItems, prevLen, this._selectedIndex);
            } catch (err) {
                console.warn('MentionJS: load more failed', err);
            } finally {
                if (this._searchSession.finishLoadingMore(loadingGeneration)) {
                    this._ui.hideLoading();
                }
            }
        }

        _inDOM(el) {
            return !!el && el.isConnected;
        }

        /**
         * Returns all committed mentions.
         * Textarea: [{id, name, start, end}]
         * ContentEditable: [{id, name}]
         */
        getMentions() {
            this._assertAlive();

            if (this._isTextarea) {
                // Programmatic value changes do not emit input events.
                this._textareaMentions.sync(this._el.value);
                return this._textareaMentions.getMentions();
            }
            return Array.from(
                this._el.querySelectorAll(
                    'span.mention:not(.active)[data-mention-id][data-mention-name]'
                )
            )
                .filter((el) => (
                    el.textContent === this._opts.trigger + el.dataset.mentionName
                ))
                .map((el) => ({
                    id: el.dataset.mentionId,
                    name: el.dataset.mentionName,
                }));
        }

        /**
         * Programmatically insert a mention at the current cursor / end of field.
         * @param {{ id: any, name: string }} mentionData
         */
        push(mentionData) {
            this._assertAlive();

            if (
                !mentionData ||
                typeof mentionData !== 'object' ||
                (typeof mentionData.id !== 'string' &&
                 (typeof mentionData.id !== 'number' || !Number.isFinite(mentionData.id))) ||
                typeof mentionData.name !== 'string'
            ) {
                throw new Error('MentionJS: push() requires { id: string|number, name: string }');
            }

            if (this._ui.el || this._mentionStart !== null || this._mentionSpan) {
                this._closeDropdown();
            }
            this._dismissedTextareaStart = null;

            if (this._isTextarea) {
                this._textareaMentions.sync(this._el.value);
                const text = this._el.value;
                const mentionText = this._opts.trigger + mentionData.name;
                const hasCaret = this._isHostFocused();
                const start = hasCaret ? (this._el.selectionStart ?? text.length) : text.length;
                const end = hasCaret ? (this._el.selectionEnd ?? start) : start;
                const after = text.substring(end);
                const hasSeparator = /^[\s\u00A0]/.test(after);
                const separator = hasSeparator ? '' : ' ';
                const insertion = mentionText + separator;

                this._el.value = text.substring(0, start) + insertion + after;
                this._textareaMentions.replaceRange(
                    start,
                    end,
                    insertion.length,
                    {
                        id: mentionData.id,
                        name: mentionData.name,
                        start,
                        end: start + mentionText.length,
                    }
                );

                const pos = start + insertion.length + (hasSeparator ? 1 : 0);
                this._textareaMentions.acknowledge(this._el.value);
                this._el.setSelectionRange(pos, pos);
                this._el.focus();
            } else {
                const sel = window.getSelection();
                let range = null;

                if (sel?.rangeCount) {
                    const candidate = sel.getRangeAt(0);
                    const container = candidate.commonAncestorContainer;
                    if (container === this._el || this._el.contains(container)) {
                        range = candidate.cloneRange();

                        // Committed mentions are atomic. Never split their DOM
                        // or nest a new mention inside their existing span.
                        const ownerOf = (node) => {
                            const element = node.nodeType === Node.ELEMENT_NODE
                                ? node : node.parentElement;
                            const owner = element?.closest?.('span.mention');
                            return owner && this._el.contains(owner) &&
                                owner.hasAttribute('data-mention-id') &&
                                owner.hasAttribute('data-mention-name')
                                ? owner : null;
                        };
                        const startOwner = ownerOf(range.startContainer);
                        const endOwner = ownerOf(range.endContainer);

                        if (range.collapsed && startOwner) {
                            const atBeginning =
                                (range.startContainer === startOwner.firstChild &&
                                 range.startOffset === 0) ||
                                (range.startContainer === startOwner && range.startOffset === 0);
                            if (atBeginning) {
                                range.setStartBefore(startOwner);
                            } else {
                                const after = startOwner.nextSibling;
                                if (after?.nodeType === Node.TEXT_NODE &&
                                    /^[\s\u00A0]/u.test(after.textContent)) {
                                    range.setStart(after, 1);
                                } else {
                                    range.setStartAfter(startOwner);
                                }
                            }
                            range.collapse(true);
                        } else if (!range.collapsed) {
                            if (startOwner) range.setStartBefore(startOwner);
                            if (endOwner) range.setEndAfter(endOwner);
                        }
                    }
                }

                const span = createElement('span', 'mention');
                span.dataset.mentionjsToken = 'true';
                span.dataset.mentionId = String(mentionData.id);
                span.dataset.mentionName = mentionData.name;
                span.textContent = this._opts.trigger + mentionData.name;
                if (range) {
                    range.deleteContents();
                    range.insertNode(span);
                } else {
                    this._el.appendChild(span);
                }

                const next = span.nextSibling;
                const hasSeparator = next?.nodeType === Node.TEXT_NODE &&
                    /^[\s\u00A0]/u.test(next.textContent);
                const separator = hasSeparator ? next : document.createTextNode('\u00A0');
                if (!hasSeparator) span.after(separator);

                this._el.focus();
                setCaretAt(separator, 1);
            }

            this._notifyProgrammaticChange(
                'insertReplacementText',
                this._opts.trigger + mentionData.name
            );
        }

        /**
         * Clear all content and committed mentions.
         */
        clear() {
            this._assertAlive();

            if (this._isTextarea) {
                this._dismissedTextareaStart = null;
                this._el.value = '';
                this._textareaMentions.clear();
            } else {
                this._el.innerHTML = '';
            }
            this._closeDropdown();
            this._notifyProgrammaticChange('deleteContent');
        }

        /**
         * Tear down all event listeners and remove the dropdown.
         */
        destroy() {
            if (this._destroyed) return;

            this._closeDropdown();
            this._dismissedTextareaStart = null;
            this._unbindElementEvents();
            this._unbindDocumentClick();
            this._restoreAccessibility();

            if (activeInstances.get(this._el) === this) {
                activeInstances.delete(this._el);
            }

            this._destroyed = true;
        }

        static create(element, options) {
            return new MentionJS(element, options);
        }
    }

    return MentionJS;
});
