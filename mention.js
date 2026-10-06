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
        debounceDelay: 300,
        noResultsText: 'No results found',
        dropdownClass: '',
        onMentionSelect: null,
        renderItem: null,
        renderNoResults: null,
        renderLoading: null,
    };

    let instanceCounter = 0;
    const SEARCH_CANCELLED = Symbol('MentionJS search cancelled');

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

    function removeCharAt(str, index) {
        return str.substring(0, index) + str.substring(index + 1);
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
                placeholder.textContent = (data.name || '?').charAt(0).toUpperCase();
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
            if (!this._el) return;
            requestAnimationFrame(() => {
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
            this._debounceTimer = null;
            this._debounceReject = null;
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

        setLoadingMore(value) {
            this._isLoadingMore = value;
        }

        async search(query, nextPageUrl = null) {
            if (!nextPageUrl) {
                this._currentQuery = query;
                this._cancelDebounce();
                this._nextPageUrl = null;
                this._isLoadingMore = false;
            }

            const requestId = ++this._requestId;

            const execute = async () => {
                if (!this._options.searchFunction) return { items: [], nextPageUrl: null };
                return await this._options.searchFunction(query, nextPageUrl);
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
                if (err === SEARCH_CANCELLED) return null;
                console.warn('MentionJS: search failed', err);
                return null;
            }

            if (requestId !== this._requestId) return null;

            const items = raw?.items ?? (Array.isArray(raw) ? raw : []);
            this._nextPageUrl = raw?.nextPageUrl ?? null;
            this._items = nextPageUrl ? [...this._items, ...items] : items;

            return items;
        }

        cancel() {
            this._requestId++;
            this._cancelDebounce();
            this._items = [];
            this._nextPageUrl = null;
            this._isLoadingMore = false;
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
    }

    class TextareaMentionStore {
        constructor(initialValue = '') {
            this._value = initialValue;
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
                const { start: editStart, end: editEnd } = this._resolveEdit(previousText, text, edit);
                const delta = text.length - previousText.length;

                this._mentions = this._mentions.filter((mention) => {
                    if (mention.end <= editStart) return true;

                    if (mention.start >= editEnd) {
                        mention.start += delta;
                        mention.end += delta;
                        return true;
                    }

                    return false;
                });
            }

            this.acknowledge(text);
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
            const isTextarea = tagName === 'textarea';
            const isContentEditable = element.isContentEditable ||
                contentEditable === '' ||
                contentEditable === 'true' ||
                contentEditable === 'plaintext-only';

            if (!isTextarea && !isContentEditable) {
                throw new Error('MentionJS: element must be a textarea or contenteditable editing host');
            }

            this._opts = Object.assign({}, DEFAULTS, options);

            if (
                typeof this._opts.trigger !== 'string' ||
                this._opts.trigger.length !== 1 ||
                /\s/.test(this._opts.trigger)
            ) {
                throw new Error('MentionJS: trigger must be exactly one non-whitespace character');
            }

            if (
                typeof this._opts.debounceDelay !== 'number' ||
                !Number.isFinite(this._opts.debounceDelay) ||
                this._opts.debounceDelay < 0
            ) {
                throw new Error('MentionJS: debounceDelay must be a non-negative finite number');
            }

            this._el = element;
            this._isTextarea = isTextarea;
            this._instanceId = ++instanceCounter;
            this._dropdownId = 'mentionjs-dropdown-' + this._instanceId;

            this._ui = new DropdownUI(this._opts, this._dropdownId);
            this._searchSession = new SearchSession(this._opts);
            this._textareaMentions = this._isTextarea
                ? new TextareaMentionStore(element.value)
                : null;

            this._selectedIndex = 0;
            this._mentionStart = null;
            this._mentionEnd = null;
            this._mentionSpan = null;
            this._mentionCounter = 0;
            this._suppressNextInput = false;

            this._h = {};
            this._a11yOriginal = {};

            this._configureAccessibility();
            this._bindElementEvents();
            this._bindDocumentClick();
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
                this._el.addEventListener('beforeinput', this._h.beforeinput);
                this._el.addEventListener('input', this._h.input);
                this._el.addEventListener('keydown', this._h.keydown);
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
            }

            this._el.removeEventListener('blur', this._h.blur);
        }

        _bindDocumentClick() {
            this._h.docClick = (e) => {
                if (!this._ui.el) return;
                const outside = !this._el.contains(e.target) &&
                    !this._ui.el.contains(e.target) &&
                    e.target !== this._el;
                if (outside) this._closeDropdown();
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
            this._h.selectionChange = () => this._onSelectionChange();
            document.addEventListener('selectionchange', this._h.selectionChange);
        }

        _unbindSelectionChange() {
            if (this._h.selectionChange) {
                document.removeEventListener('selectionchange', this._h.selectionChange);
            }
        }

        _onSelectionChange() {
            if (!this._ui.el) return;

            if (this._isTextarea) {
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
                        if (document.activeElement === this._el) this._openDropdown(items);
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
                this._textareaMentions.acknowledge(this._el.value);
                return;
            }

            this._textareaMentions.reconcile(this._el.value);

            const pos = this._el.selectionStart;
            const token = this._findTokenAtCursor(this._el.value, pos);

            if (token) {
                this._mentionStart = token.start;
                this._mentionEnd = token.end;
                const items = await this._search(token.query);
                if (items === null) return;
                this._openDropdown(items);
            } else {
                this._closeDropdown();
            }
        }

        _onTextareaKeydown(e) {
            if ((e.key === 'Backspace' || e.key === 'Delete') && this._ui.el) {
                setTimeout(() => {
                    const token = this._findTokenAtCursor(this._el.value, this._el.selectionStart);
                    if (!token) this._closeDropdown();
                }, 0);
            }

            if (!this._ui.el) return;

            if (this._searchSession.items.length === 0) {
                if (['Enter', 'Tab', 'Escape'].includes(e.key)) {
                    e.preventDefault();
                    this._closeDropdown();
                }
                return;
            }

            this._handleNavigationKey(e, (data) => this._commitTextareaMention(data));
        }

        async _onBeforeInput(e) {
            const sel = window.getSelection();
            const span = this._getMentionSpan(sel);

            if (span) {
                await this._handleInputInsideSpan(e, span, sel);
                return;
            }

            if (e.data === this._opts.trigger) {
                if (!this._canInsertMentionHere(sel)) return;
                e.preventDefault();
                const newSpan = this._insertMentionSpan(sel);
                this._mentionSpan = newSpan;
                const items = await this._search('');
                if (items === null) return;
                if (this._inDOM(newSpan)) this._openDropdown(items);
            } else {
                this._closeDropdown();
            }
        }

        async _onContentEditableInput() {
            const sel = window.getSelection();
            const span = this._getMentionSpan(sel);

            if (!span) {
                if (this._ui.el || this._mentionSpan) this._closeDropdown();
                return;
            }

            const text = span.textContent || '';

            if (!text.startsWith(this._opts.trigger)) {
                this._invalidateMentionMetadata(span);
                this._unwrapMentionSpan(span, sel);
                this._closeDropdown();
                return;
            }

            this._invalidateMentionMetadata(span);
            span.classList.add('active');
            this._mentionSpan = span;

            const items = await this._search(text.substring(this._opts.trigger.length));
            if (items === null) return;
            if (this._inDOM(span)) this._openDropdown(items);
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
            const isAtEnd   = cursorInText === spanText.length;

            if (isAtStart) {
                e.preventDefault();
                this._closeDropdown();
                if (e.inputType === 'insertText' && e.data) {
                    const tn = document.createTextNode(e.data);
                    span.parentNode.insertBefore(tn, span);
                    setCaretAt(tn, e.data.length);
                } else if (e.inputType === 'deleteContentBackward') {
                    this._backspaceBeforeSpan(span, sel);
                } else if (e.inputType === 'deleteContentForward') {
                    this._deleteForwardInSpan(span, spanText);
                }
                return;
            }

            if (isAtEnd && !isActive) {
                if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText') {
                    e.preventDefault();
                    const next = span.nextSibling;
                    if (next?.nodeType === Node.TEXT_NODE) {
                        next.textContent = e.data + next.textContent;
                        setCaretAt(next, e.data.length);
                    } else {
                        const char = e.data === ' ' ? '\u00A0' : e.data;
                        const tn = document.createTextNode(char);
                        span.after(tn);
                        setCaretAt(tn, 1);
                    }
                    return;
                }
                if (e.inputType === 'deleteContentForward') {
                    e.preventDefault();
                    this._deleteForwardAfterNode(span);
                    return;
                }
            }

            if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
                e.preventDefault();
                if (isActive && this._searchSession.items.length > 0) return;
                span.classList.remove('active');
                this._closeDropdown();
                setCaretAfterNode(span);
                this._insertBr(window.getSelection());
                return;
            }

            if (e.inputType === 'deleteContentBackward') {
                const offset = cursorInText ?? spanText.length;

                if (spanText.length === 1) {
                    e.preventDefault();
                    this._closeDropdown();
                    const prev = span.previousSibling, next = span.nextSibling;
                    span.remove();
                    const range = document.createRange();
                    if (prev?.nodeType === Node.TEXT_NODE) range.setStart(prev, prev.textContent.length);
                    else if (next) range.setStartBefore(next);
                    else range.setStart(this._el, 0);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return;
                }

                // Backspace over the trigger char → unwrap to plain text
                if (offset === 1 && spanText.startsWith(this._opts.trigger)) {
                    e.preventDefault();
                    const tn = document.createTextNode(spanText.substring(1));
                    span.parentNode.insertBefore(tn, span);
                    span.remove();
                    this._closeDropdown();
                    setCaretAt(tn, 0);
                    return;
                }

                e.preventDefault();
                this._invalidateMentionMetadata(span);

                const newText   = removeCharAt(spanText, offset - 1);
                const newOffset = offset - 1;

                const tn = span.firstChild;
                if (tn?.nodeType === Node.TEXT_NODE) {
                    tn.textContent = newText;
                } else {
                    span.textContent = newText;
                }
                setCaretAt(span.firstChild, newOffset);

                if (!isActive) span.classList.add('active');
                this._mentionSpan = span;

                const items = await this._search(newText.substring(this._opts.trigger.length));
                if (items === null) return;
                if (this._inDOM(span)) this._openDropdown(items);
                return;
            }

            if (e.inputType === 'deleteContentForward') {
                const offset = cursorInText ?? spanText.length;

                // At end of span → delete next sibling content
                if (offset >= spanText.length) {
                    e.preventDefault();
                    this._deleteForwardAfterNode(span);
                    return;
                }

                e.preventDefault();
                this._invalidateMentionMetadata(span);

                const newText = removeCharAt(spanText, offset);

                if (newText.length === 0) {
                    const prev = span.previousSibling, next = span.nextSibling;
                    span.remove();
                    this._closeDropdown();
                    const range = document.createRange();
                    if (next) range.setStartBefore(next);
                    else if (prev?.nodeType === Node.TEXT_NODE) range.setStart(prev, prev.textContent.length);
                    else range.setStart(this._el, 0);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return;
                }

                // Deleted the trigger character → unwrap to plain text
                if (offset === 0 && !newText.startsWith(this._opts.trigger)) {
                    const tn = document.createTextNode(newText);
                    span.parentNode.insertBefore(tn, span);
                    span.remove();
                    this._closeDropdown();
                    setCaretAt(tn, 0);
                    return;
                }

                const tn = span.firstChild;
                if (tn?.nodeType === Node.TEXT_NODE) {
                    tn.textContent = newText;
                } else {
                    span.textContent = newText;
                }
                setCaretAt(span.firstChild, offset);

                if (!isActive) span.classList.add('active');
                this._mentionSpan = span;

                const items = await this._search(newText.substring(this._opts.trigger.length));
                if (items === null) return;
                if (this._inDOM(span)) this._openDropdown(items);
                return;
            }

            if (e.inputType === 'insertText' && e.data) {
                const insertAt = cursorInText ?? spanText.length;
                const newText = spanText.substring(0, insertAt) + e.data + spanText.substring(insertAt);

                this._invalidateMentionMetadata(span);
                if (!isActive) span.classList.add('active');
                this._mentionSpan = span;
                const items = await this._search(newText.substring(this._opts.trigger.length));
                if (items === null) return;
                if (this._inDOM(span)) this._openDropdown(items);
            }
        }

        async _onContentEditableKeydown(e) {
            const sel = window.getSelection();
            const span = this._getMentionSpan(sel);

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
                    this._insertBr(window.getSelection());
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

            this._el.value = before + mentionText + ' ' + after;
            this._textareaMentions.replaceRange(
                this._mentionStart,
                this._mentionEnd,
                mentionText.length + 1,
                {
                    id: data.id,
                    name: data.name,
                    start: this._mentionStart,
                    end: this._mentionStart + mentionText.length,
                }
            );
            this._textareaMentions.acknowledge(this._el.value);

            const newPos = this._mentionStart + mentionText.length + 1;
            this._el.setSelectionRange(newPos, newPos);
            this._el.focus();
            this._closeDropdown();

            this._suppressNextInput = true;
            this._el.dispatchEvent(new Event('input', { bubbles: true }));
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
            this._el.dispatchEvent(new Event('input', { bubbles: true }));
            this._fireSelect(data);
        }

        _fireSelect(data) {
            if (typeof this._opts.onMentionSelect === 'function') {
                this._opts.onMentionSelect({ id: data.id, name: data.name });
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
            if (!sel) return null;
            const node = sel.anchorNode;
            if (!node) return null;

            const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
            const span = element?.closest?.('span.mention') ?? null;

            return span && this._el.contains(span) && this._isMentionSpan(span) ? span : null;
        }

        _invalidateMentionMetadata(span) {
            delete span.dataset.mentionId;
            delete span.dataset.mentionName;
        }

        _unwrapMentionSpan(span, sel = window.getSelection()) {
            const text = span.textContent || '';
            let offset = text.length;

            if (sel?.anchorNode?.nodeType === Node.TEXT_NODE && span.contains(sel.anchorNode)) {
                offset = sel.anchorOffset;
            }

            const textNode = document.createTextNode(text);
            span.replaceWith(textNode);

            if (sel) {
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
                textNode.textContent = fromEnd
                    ? textNode.textContent.slice(0, -1)
                    : textNode.textContent.substring(1);

                if (textNode.textContent.length === 0) textNode.remove();
                return true;
            }

            if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'BR') {
                node.remove();
                return true;
            }

            return false;
        }

        _canInsertMentionHere(sel) {
            if (!sel || sel.rangeCount === 0) return true;

            const caret = sel.getRangeAt(0);
            const before = document.createRange();
            before.selectNodeContents(this._el);
            before.setEnd(caret.startContainer, caret.startOffset);

            const textBeforeCaret = before.toString();
            const charBefore = textBeforeCaret.slice(-1);

            return charBefore === '' || /[\s\u00A0]/.test(charBefore);
        }

        _insertMentionSpan(sel) {
            const range = sel.getRangeAt(0);
            range.deleteContents();

            const span = createElement('span', 'mention active');
            span.dataset.mentionjsToken = 'true';
            span.id = 'mjs-' + this._instanceId + '-' + (++this._mentionCounter);
            span.appendChild(document.createTextNode(this._opts.trigger));
            range.insertNode(span);

            setCaretAt(span.firstChild, 1);
            return span;
        }

        _backspaceBeforeSpan(span, sel) {
            const prev = span.previousSibling;
            if (prev?.nodeType === Node.TEXT_NODE && prev.textContent.length > 0) {
                prev.textContent = prev.textContent.slice(0, -1);
                if (prev.textContent.length === 0) prev.remove();
                setCaretBeforeNode(span);
            } else if (this._isMentionSpan(prev)) {
                prev.classList.add('active');
                setCaretAt(prev.firstChild, prev.textContent.length);
                this._mentionSpan = prev;
                const query = prev.textContent.substring(this._opts.trigger.length);
                this._search(query).then((items) => {
                    if (items === null) return;
                    if (this._inDOM(prev)) this._openDropdown(items);
                });
            } else if (prev) {
                this._deleteEdgeCharacter(prev, true);
                setCaretBeforeNode(span);
            }
        }

        // Forward delete at left edge of span — deletes the trigger character.
        _deleteForwardInSpan(span, spanText) {
            if (spanText.length <= 1) {
                const next = span.nextSibling;
                span.remove();
                if (next) setCaretBeforeNode(next);
                else setCaretAt(this._el, this._el.childNodes.length);
            } else {
                const remaining = spanText.substring(1);
                const tn = document.createTextNode(remaining);
                span.parentNode.insertBefore(tn, span);
                span.remove();
                setCaretAt(tn, 0);
            }
        }

        // Delete the first character of the next sibling after a node.
        _deleteForwardAfterNode(node) {
            const next = node.nextSibling;
            if (!next) return;

            if (this._isMentionSpan(next)) {
                next.remove();
                return;
            }

            this._deleteEdgeCharacter(next, false);
        }

        _insertBr(sel) {
            if (!sel.rangeCount) return;
            const range = sel.getRangeAt(0);
            range.deleteContents();
            const br = document.createElement('br');
            range.insertNode(br);
            range.setStartAfter(br);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
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

        _openDropdown(items) {
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
                    span.classList.remove('mention');
                    delete span.dataset.mentionjsToken;
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
            requestAnimationFrame(() => {
                if (!this._ui.el) return;

                const el = this._el;
                const cursorPos = this._mentionStart !== null ? this._mentionStart : el.selectionStart;
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
                mirror.style.width = el.offsetWidth + 'px';
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
            if (this._searchSession.isLoadingMore || !this._searchSession.nextPageUrl) return;
            this._searchSession.setLoadingMore(true);
            this._ui.showLoading();
            try {
                const prevLen = this._searchSession.items.length;
                const newItems = await this._search(
                    this._searchSession.currentQuery,
                    this._searchSession.nextPageUrl
                );
                this._ui.hideLoading();
                if (newItems === null) return;
                this._ui.appendItems(newItems, prevLen, this._selectedIndex);
            } catch (err) {
                console.warn('MentionJS: load more failed', err);
                this._ui.hideLoading();
            } finally {
                this._searchSession.setLoadingMore(false);
            }
        }

        _inDOM(el) {
            return !!el && document.contains(el);
        }

        /**
         * Returns all committed mentions.
         * Textarea: [{id, name, start, end}]
         * ContentEditable: [{id, name}]
         */
        getMentions() {
            if (this._isTextarea) {
                return this._textareaMentions.getMentions();
            }
            return Array.from(
                this._el.querySelectorAll(
                    'span.mention:not(.active)[data-mention-id][data-mention-name]'
                )
            ).map((el) => ({
                id: el.dataset.mentionId,
                name: el.dataset.mentionName,
            }));
        }

        /**
         * Programmatically insert a mention at the current cursor / end of field.
         * @param {{ id: any, name: string }} mentionData
         */
        push(mentionData) {
            if (this._isTextarea) {
                const text = this._el.value;
                const mentionText = this._opts.trigger + mentionData.name;
                const hasCaret = document.activeElement === this._el;
                const start = hasCaret ? (this._el.selectionStart ?? text.length) : text.length;
                const end = hasCaret ? (this._el.selectionEnd ?? start) : start;
                const insertion = mentionText + ' ';

                this._el.value = text.substring(0, start) + insertion + text.substring(end);
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

                const pos = start + insertion.length;
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
                        range = candidate;
                    }
                }

                const span = createElement('span', 'mention');
                span.dataset.mentionjsToken = 'true';
                span.dataset.mentionId = String(mentionData.id);
                span.dataset.mentionName = mentionData.name;
                span.textContent = this._opts.trigger + mentionData.name;
                const space = document.createTextNode('\u00A0');

                if (range) {
                    range.deleteContents();
                    range.insertNode(span);
                    span.after(space);
                } else {
                    this._el.appendChild(span);
                    this._el.appendChild(space);
                }

                this._el.focus();
                setCaretAt(space, 1);
            }
        }

        /**
         * Clear all content and committed mentions.
         */
        clear() {
            if (this._isTextarea) {
                this._el.value = '';
                this._textareaMentions.clear();
            } else {
                this._el.innerHTML = '';
            }
            this._closeDropdown();
        }

        /**
         * Tear down all event listeners and remove the dropdown.
         */
        destroy() {
            this._closeDropdown();
            this._unbindElementEvents();
            this._unbindDocumentClick();
            this._restoreAccessibility();
        }

        static create(element, options) {
            return new MentionJS(element, options);
        }
    }

    return MentionJS;
});
