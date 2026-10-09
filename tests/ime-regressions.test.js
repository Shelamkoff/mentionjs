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

const instances = [];
afterEach(() => {
    for (const instance of instances.splice(0)) instance.destroy();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

function selectionAt(node, offset) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
}

async function setup(mode) {
    const host = document.createElement(mode === 'textarea' ? 'textarea' : 'div');
    if (mode === 'contenteditable') host.contentEditable = 'true';
    if (mode === 'contenteditable') host.setAttribute('contenteditable', 'true');
    document.body.appendChild(host);
    host.focus();
    const instance = new MentionJS(host, {
        debounceDelay: 0,
        searchFunction: async () => [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ],
    });
    instances.push(instance);

    if (mode === 'textarea') {
        host.value = '@';
        host.setSelectionRange(1, 1);
        host.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        selectionAt(host, 0);
        host.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertText', data: '@', cancelable: true, bubbles: true,
        }));
    }

    await vi.waitFor(() => {
        expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
        expect(document.querySelectorAll('.mention-item[data-index]')).toHaveLength(2);
    });
    return { host, instance };
}

function keydown(host, key, isComposing = false) {
    const event = new KeyboardEvent('keydown', {
        key, bubbles: true, cancelable: true, isComposing,
    });
    host.dispatchEvent(event);
    return event;
}

for (const mode of ['textarea', 'contenteditable']) {
    describe(`IME safety in ${mode}`, () => {
        it('does not commit or navigate with composing keyboard events', async () => {
            const { host, instance } = await setup(mode);
            for (const key of ['ArrowDown', 'Tab', 'Escape', 'Enter']) {
                const event = keydown(host, key, true);
                expect(event.defaultPrevented).toBe(false);
                expect(instance.getMentions()).toEqual([]);
                expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
                expect(document.querySelector('.mention-item.mention-active')?.dataset.index)
                    .toBe('0');
            }
        });

        it('resets abandoned composition after blur so later keyboard selection works', async () => {
            const { host, instance } = await setup(mode);
            host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            expect(instance._isComposing).toBe(true);

            // Some browsers or focus transitions omit compositionend.
            host.dispatchEvent(new Event('blur'));
            expect(instance._isComposing).toBe(false);

            host.focus();
            if (mode === 'textarea') {
                host.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                host.textContent = '';
                selectionAt(host, 0);
                host.dispatchEvent(new InputEvent('beforeinput', {
                    inputType: 'insertText', data: '@',
                    cancelable: true, bubbles: true,
                }));
            }
            await vi.waitFor(() => {
                expect(document.querySelector('.mention-dropdown.active')).not.toBeNull();
            });

            const enter = keydown(host, 'Enter');
            expect(enter.defaultPrevented).toBe(true);
            expect(instance.getMentions()).toHaveLength(1);
            expect(instance.getMentions()[0].name).toBe('Alice');
        });

        it('tracks compositionstart through compositionend even if keydown lacks isComposing', async () => {
            const { host, instance } = await setup(mode);
            host.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            const composingEnter = keydown(host, 'Enter');
            expect(composingEnter.defaultPrevented).toBe(false);
            expect(instance.getMentions()).toEqual([]);
            host.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
            const normalEnter = keydown(host, 'Enter');
            expect(normalEnter.defaultPrevented).toBe(true);
            expect(instance.getMentions()).toHaveLength(1);
            expect(instance.getMentions()[0].name).toBe('Alice');
        });
    });
}
