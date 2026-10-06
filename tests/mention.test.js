// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import MentionModule from '../mention.js';

const MentionJS = MentionModule?.default ?? MentionModule;

if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = (callback) => {
        callback();
        return 0;
    };
}

if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
}

function setCaret(node, offset) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

function beforeInput(element, inputType, data = null) {
    const event = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType,
        data,
    });
    element.dispatchEvent(event);
    return event;
}

function input(element) {
    element.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('MentionJS behavior invariants', () => {
    it('accepts only textarea or contenteditable editing hosts', () => {
        const inputElement = document.createElement('input');
        expect(() => new MentionJS(inputElement)).toThrow(/textarea or contenteditable/);
    });

    it('starts textarea search on the trigger and stops it when the trigger disappears', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([{ id: 1, name: 'Alice' }]);
        const mention = new MentionJS(textarea, { searchFunction, debounceDelay: 0 });

        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('', null);
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        textarea.value = '';
        textarea.setSelectionRange(0, 0);
        input(textarea);

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('cancels an unresolved search when the editing host loses focus', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let resolveSearch;
        const searchFunction = vi.fn(() => new Promise((resolve) => {
            resolveSearch = resolve;
        }));
        const mention = new MentionJS(textarea, { searchFunction });

        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        expect(searchFunction).toHaveBeenCalledTimes(1);
        textarea.dispatchEvent(new Event('blur'));
        resolveSearch([{ id: 1, name: 'Alice' }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('inserts push() at the active textarea caret and keeps mention offsets correct', () => {
        const textarea = document.createElement('textarea');
        textarea.value = 'hello world';
        document.body.appendChild(textarea);

        const mention = new MentionJS(textarea);
        textarea.focus();
        textarea.setSelectionRange(6, 6);

        mention.push({ id: 7, name: 'Alice' });

        expect(textarea.value).toBe('hello @Alice world');
        expect(mention.getMentions()).toEqual([
            { id: 7, name: 'Alice', start: 6, end: 12 },
        ]);
        expect(textarea.selectionStart).toBe(13);
        mention.destroy();
    });

    it('does not move textarea mention identity onto a different equal-looking token', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea);

        mention.push({ id: 42, name: 'Alice' });
        textarea.value += '@Alice';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        input(textarea);

        textarea.setSelectionRange(0, 7);
        beforeInput(textarea, 'deleteContentBackward');
        textarea.value = textarea.value.substring(7);
        textarea.setSelectionRange(0, 0);
        input(textarea);

        expect(textarea.value).toBe('@Alice');
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('does not expose an unfinished contenteditable token as a committed mention', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, { searchFunction });

        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(editor.querySelector('span.mention.active')).not.toBeNull();
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));

        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('backspace at a mention boundary deletes one adjacent character, not the whole rich-text node', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<strong>abc</strong><span class="mention" data-mention-id="1" data-mention-name="Alice">@Alice</span>';
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);
        const span = editor.querySelector('span.mention');

        setCaret(span.firstChild, 0);
        beforeInput(editor, 'deleteContentBackward');

        expect(editor.querySelector('strong')).not.toBeNull();
        expect(editor.querySelector('strong').textContent).toBe('ab');
        mention.destroy();
    });

    it('stops treating a contenteditable token as a mention when its trigger is removed by browser-driven input', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);

        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');
        span.textContent = 'Alice';
        setCaret(span.firstChild, span.textContent.length);
        input(editor);

        expect(mention.getMentions()).toEqual([]);
        expect(editor.textContent.startsWith('Alice')).toBe(true);
        mention.destroy();
    });
});


describe('MentionJS interaction consistency', () => {
    it('keeps ARIA combobox state synchronized with dropdown selection', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            searchFunction: async () => [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ],
        });

        textarea.value = '@';
        textarea.focus();
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(textarea.getAttribute('aria-expanded')).toBe('true');
        });

        const dropdown = document.querySelector('.mention-dropdown');
        const options = dropdown.querySelectorAll('.mention-item[data-index]');

        expect(textarea.getAttribute('role')).toBe('combobox');
        expect(dropdown.getAttribute('role')).toBe('listbox');
        expect(options[0].getAttribute('role')).toBe('option');
        expect(options[0].getAttribute('aria-selected')).toBe('true');
        expect(textarea.getAttribute('aria-activedescendant')).toBe(options[0].id);

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        expect(options[0].getAttribute('aria-selected')).toBe('false');
        expect(options[1].getAttribute('aria-selected')).toBe('true');
        expect(textarea.getAttribute('aria-activedescendant')).toBe(options[1].id);

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));

        expect(textarea.getAttribute('aria-expanded')).toBe('false');
        expect(textarea.hasAttribute('aria-activedescendant')).toBe(false);
        mention.destroy();
    });

    it('uses the hovered dropdown item for the next keyboard commit', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            searchFunction: async () => [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ],
        });

        textarea.value = '@';
        textarea.focus();
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelectorAll('.mention-item[data-index]').length).toBe(2);
        });

        const second = document.querySelector('.mention-item[data-index="1"]');
        second.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(textarea.value).toBe('@Bob ');
        expect(mention.getMentions()).toEqual([
            { id: 2, name: 'Bob', start: 0, end: 4 },
        ]);
        mention.destroy();
    });

    it('dispatches input after committing a contenteditable mention', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });
        const externalInput = vi.fn();
        editor.addEventListener('input', externalInput);

        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(externalInput).toHaveBeenCalledTimes(1);
        expect(mention.getMentions()).toEqual([{ id: '1', name: 'Alice' }]);
        mention.destroy();
    });

    it('ignores unrelated elements that only reuse the mention CSS class', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<span class="mention">ordinary styled text</span>';
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);

        const foreign = editor.querySelector('.mention');
        setCaret(foreign.firstChild, 1);
        beforeInput(editor, 'deleteContentBackward');

        expect(foreign.textContent).toBe('ordinary styled text');
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });
});


describe('MentionJS caret lifecycle', () => {
    it('closes textarea search when the caret leaves the active trigger token', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        textarea.value = '@a';
        textarea.focus();
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        textarea.setSelectionRange(0, 0);
        document.dispatchEvent(new Event('selectionchange'));

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('updates textarea search when the caret moves within the active token', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([{ id: 1, name: 'Alice' }]);
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.value = '@abc';
        textarea.focus();
        textarea.setSelectionRange(4, 4);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('abc', null);
        });

        textarea.setSelectionRange(2, 2);
        document.dispatchEvent(new Event('selectionchange'));

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('a', null);
        });

        mention.destroy();
    });

    it('closes contenteditable search when selection leaves the active mention span', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        const outsideText = document.createTextNode('outside');
        editor.appendChild(outsideText);
        setCaret(outsideText, outsideText.textContent.length);
        document.dispatchEvent(new Event('selectionchange'));

        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });
});


describe('MentionJS preserved feature behavior', () => {
    it('debounces non-empty searches and cancels the superseded query before execution', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(textarea, {
            debounceDelay: 20,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@a';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        textarea.value = '@ab';
        textarea.setSelectionRange(3, 3);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('ab', null);
        });

        expect(searchFunction).not.toHaveBeenCalledWith('a', null);
        mention.destroy();
    });

    it('ignores a stale async response after a newer query has completed', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let resolveInitial;
        const initial = new Promise((resolve) => {
            resolveInitial = resolve;
        });
        const searchFunction = vi.fn((query) => {
            if (query === '') return initial;
            return Promise.resolve([{ id: 2, name: 'Fast' }]);
        });
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        textarea.value = '@f';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-name')?.textContent).toBe('Fast');
        });

        resolveInitial([{ id: 1, name: 'Stale' }]);
        await Promise.resolve();
        await Promise.resolve();

        expect(document.querySelector('.mention-name')?.textContent).toBe('Fast');
        mention.destroy();
    });

    it('loads the next result page when keyboard selection approaches the end', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn(async (query, nextPageUrl) => {
            if (nextPageUrl) {
                return {
                    items: [{ id: 3, name: 'Charlie' }],
                    nextPageUrl: null,
                };
            }
            return {
                items: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ],
                nextPageUrl: '/next',
            };
        });
        const mention = new MentionJS(textarea, { searchFunction });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelectorAll('.mention-item[data-index]').length).toBe(2);
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('', '/next');
            expect(document.querySelectorAll('.mention-item[data-index]').length).toBe(3);
        });

        mention.destroy();
    });

    it('keeps custom single-character triggers behavior identical to the default trigger', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(textarea, {
            trigger: '#',
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '#topic';
        textarea.setSelectionRange(6, 6);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('topic', null);
        });

        mention.destroy();
    });

    it('does not start textarea search when the trigger is embedded in a word', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = 'mail@alice';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        input(textarea);

        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(searchFunction).not.toHaveBeenCalled();
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        mention.destroy();
    });

    it('inserts push() at the active contenteditable caret instead of appending to the end', () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.textContent = 'hello world';
        document.body.appendChild(editor);
        const mention = new MentionJS(editor);

        editor.focus();
        setCaret(editor.firstChild, 6);
        mention.push({ id: 2, name: 'Bob' });

        expect(editor.textContent).toBe('hello @Bob\u00A0world');
        expect(mention.getMentions()).toEqual([{ id: '2', name: 'Bob' }]);

        const selection = window.getSelection();
        expect(selection.anchorNode.nodeType).toBe(Node.TEXT_NODE);
        expect(selection.anchorNode.textContent).toBe('\u00A0');
        expect(selection.anchorOffset).toBe(1);
        mention.destroy();
    });

    it('places the caret after the trailing space when a textarea mention is committed', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        expect(textarea.value).toBe('@Alice ');
        expect(textarea.selectionStart).toBe(7);
        expect(textarea.selectionEnd).toBe(7);
        mention.destroy();
    });

    it('places the caret after the trailing non-breaking space when a contenteditable mention is committed', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        }));

        const selection = window.getSelection();
        expect(mention.getMentions()).toEqual([{ id: '1', name: 'Alice' }]);
        expect(selection.anchorNode.nodeType).toBe(Node.TEXT_NODE);
        expect(selection.anchorNode.textContent).toBe('\u00A0');
        expect(selection.anchorOffset).toBe(1);
        mention.destroy();
    });

    it('clear resets content, committed mentions, dropdown, and accessibility state', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const mention = new MentionJS(textarea, {
            searchFunction: async () => [{ id: 1, name: 'Alice' }],
        });

        mention.push({ id: 2, name: 'Bob' });
        textarea.focus();
        textarea.value += '@';
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelector('.mention-dropdown')).not.toBeNull();
        });

        mention.clear();

        expect(textarea.value).toBe('');
        expect(mention.getMentions()).toEqual([]);
        expect(document.querySelector('.mention-dropdown')).toBeNull();
        expect(textarea.getAttribute('aria-expanded')).toBe('false');
        mention.destroy();
    });

    it('destroy removes behavior listeners and restores host accessibility attributes', async () => {
        const textarea = document.createElement('textarea');
        textarea.setAttribute('role', 'textbox');
        document.body.appendChild(textarea);
        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(textarea, { searchFunction });

        expect(textarea.getAttribute('role')).toBe('textbox');
        expect(textarea.getAttribute('aria-autocomplete')).toBe('list');

        mention.destroy();

        expect(textarea.getAttribute('role')).toBe('textbox');
        expect(textarea.hasAttribute('aria-autocomplete')).toBe(false);
        expect(textarea.hasAttribute('aria-controls')).toBe(false);
        expect(textarea.hasAttribute('aria-expanded')).toBe(false);

        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);
        await Promise.resolve();

        expect(searchFunction).not.toHaveBeenCalled();
        expect(document.querySelector('.mention-dropdown')).toBeNull();
    });
});


describe('MentionJS option and rich-text boundaries', () => {
    it('rejects invalid trigger values instead of partially supporting them', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        expect(() => new MentionJS(textarea, { trigger: '' })).toThrow(/trigger/);
        expect(() => new MentionJS(textarea, { trigger: '@@' })).toThrow(/trigger/);
        expect(() => new MentionJS(textarea, { trigger: ' ' })).toThrow(/trigger/);
        expect(() => new MentionJS(textarea, { trigger: '#' })).not.toThrow();
    });

    it('rejects invalid debounce delays', () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        expect(() => new MentionJS(textarea, { debounceDelay: -1 })).toThrow(/debounceDelay/);
        expect(() => new MentionJS(textarea, { debounceDelay: Number.NaN })).toThrow(/debounceDelay/);
    });

    it('does not start contenteditable search directly after formatted non-whitespace text', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<strong>abc</strong>';
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, { searchFunction });
        setCaret(editor, editor.childNodes.length);

        const event = beforeInput(editor, 'insertText', '@');
        await Promise.resolve();

        expect(event.defaultPrevented).toBe(false);
        expect(searchFunction).not.toHaveBeenCalled();
        expect(editor.querySelector('span.mention')).toBeNull();
        mention.destroy();
    });

    it('allows contenteditable search after whitespace inside a formatted node', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<strong>abc </strong>';
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, { searchFunction });
        setCaret(editor, editor.childNodes.length);

        const event = beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(event.defaultPrevented).toBe(true);
            expect(searchFunction).toHaveBeenCalledWith('', null);
        });

        mention.destroy();
    });

    it('does not confuse a user search error named cancelled with internal cancellation', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const searchFunction = vi.fn().mockRejectedValue(new Error('cancelled'));
        const mention = new MentionJS(textarea, { searchFunction });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(warning).toHaveBeenCalledWith(
                'MentionJS: search failed',
                expect.any(Error)
            );
        });

        mention.destroy();
    });
});


describe('MentionJS second-pass regressions', () => {
    it('releases an unfinished contenteditable token when search is cancelled', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);
        const mention = new MentionJS(editor, {
            searchFunction: async () => [],
        });

        editor.focus();
        setCaret(editor, 0);
        beforeInput(editor, 'insertText', '@');

        await vi.waitFor(() => {
            expect(editor.querySelector('span.mention.active')).not.toBeNull();
        });

        editor.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));

        expect(editor.textContent).toBe('@');
        expect(editor.querySelector('span.mention')).toBeNull();
        expect(editor.querySelector('[data-mentionjs-token]')).toBeNull();
        expect(mention.getMentions()).toEqual([]);
        mention.destroy();
    });

    it('uses the actual contenteditable DOM after replacing a selection inside a mention', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction,
        });

        mention.push({ id: 1, name: 'Alice' });
        const span = editor.querySelector('span.mention');
        const text = span.firstChild;

        const selection = window.getSelection();
        const range = document.createRange();
        range.setStart(text, 1);
        range.setEnd(text, 4);
        selection.removeAllRanges();
        selection.addRange(range);

        beforeInput(editor, 'insertText', 'B');

        text.textContent = '@Bce';
        setCaret(text, 2);
        input(editor);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('Bce', null);
        });

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(searchFunction).not.toHaveBeenCalledWith('BAlice', null);
        expect(mention.getMentions()).toEqual([]);

        mention.destroy();
    });

    it('allows pagination for a new query even while an older page request is unresolved', async () => {
        const textarea = document.createElement('textarea');
        document.body.appendChild(textarea);

        let resolveOldPage;
        const oldPage = new Promise((resolve) => {
            resolveOldPage = resolve;
        });

        const searchFunction = vi.fn((query, nextPageUrl) => {
            if (nextPageUrl === '/old') return oldPage;
            if (nextPageUrl === '/new') {
                return Promise.resolve({
                    items: [{ id: 5, name: 'New Three' }],
                    nextPageUrl: null,
                });
            }
            if (query === 'n') {
                return Promise.resolve({
                    items: [
                        { id: 3, name: 'New One' },
                        { id: 4, name: 'New Two' },
                    ],
                    nextPageUrl: '/new',
                });
            }
            return Promise.resolve({
                items: [
                    { id: 1, name: 'Old One' },
                    { id: 2, name: 'Old Two' },
                ],
                nextPageUrl: '/old',
            });
        });

        const mention = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction,
        });

        textarea.focus();
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        input(textarea);

        await vi.waitFor(() => {
            expect(document.querySelectorAll('.mention-item[data-index]').length).toBe(2);
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('', '/old');
        });

        textarea.value = '@n';
        textarea.setSelectionRange(2, 2);
        input(textarea);

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('n', null);
            expect(document.querySelector('.mention-name')?.textContent).toBe('New One');
        });

        textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
        }));

        await vi.waitFor(() => {
            expect(searchFunction).toHaveBeenCalledWith('n', '/new');
        });

        resolveOldPage({
            items: [{ id: 6, name: 'Old Three' }],
            nextPageUrl: null,
        });

        mention.destroy();
    });

    it('does not start a mention at the start of a formatted node when text before it is non-whitespace', async () => {
        const editor = document.createElement('div');
        editor.setAttribute('contenteditable', 'true');
        editor.innerHTML = '<em>x</em><strong>abc</strong>';
        document.body.appendChild(editor);

        const searchFunction = vi.fn().mockResolvedValue([]);
        const mention = new MentionJS(editor, { searchFunction });

        const strongText = editor.querySelector('strong').firstChild;
        setCaret(strongText, 0);

        const event = beforeInput(editor, 'insertText', '@');
        await Promise.resolve();

        expect(event.defaultPrevented).toBe(false);
        expect(searchFunction).not.toHaveBeenCalled();
        expect(editor.querySelector('span.mention')).toBeNull();

        mention.destroy();
    });
});
