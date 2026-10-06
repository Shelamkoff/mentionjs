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
