import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DRIVER_URL = 'http://127.0.0.1:9515';
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const BROWSER = process.env.BROWSER || 'chrome';
const BUNDLE = process.env.BUNDLE || 'source';

if (!['chrome', 'firefox'].includes(BROWSER)) {
    throw new Error(`Unsupported browser: ${BROWSER}`);
}
if (!['source', 'dist'].includes(BUNDLE)) {
    throw new Error(`Unsupported browser fixture: ${BUNDLE}`);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function sleep(ms) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function request(path, method = 'GET', body = undefined) {
    const response = await fetch(DRIVER_URL + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });

    const payload = await response.json();
    if (!response.ok || payload.value?.error) {
        throw new Error(
            `WebDriver ${method} ${path} failed: ${JSON.stringify(payload)}`
        );
    }
    return payload.value;
}

async function waitForDriver(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const status = await request('/status');
            if (status.ready) return;
        } catch (_) {}
        await sleep(100);
    }
    throw new Error('ChromeDriver did not become ready');
}

async function waitFor(exec, predicate, message, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await exec();
        if (predicate(last)) return last;
        await sleep(50);
    }
    throw new Error(`${message}; last value: ${JSON.stringify(last)}`);
}

const driver = BROWSER === 'firefox'
    ? spawn('geckodriver', ['--port', '9515'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    : spawn('chromedriver', ['--port=9515'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

let driverOutput = '';
driver.stdout.on('data', (chunk) => { driverOutput += chunk.toString(); });
driver.stderr.on('data', (chunk) => { driverOutput += chunk.toString(); });

let sessionId = null;

try {
    await waitForDriver();

    const alwaysMatch = BROWSER === 'firefox'
        ? {
            browserName: 'firefox',
            'moz:firefoxOptions': {
                args: ['-headless'],
            },
        }
        : {
            browserName: 'chrome',
            'goog:chromeOptions': {
                args: [
                    '--headless=new',
                    '--no-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage',
                    '--allow-file-access-from-files',
                ],
            },
        };

    const session = await request('/session', 'POST', {
        capabilities: { alwaysMatch },
    });
    sessionId = session.sessionId;

    const base = `/session/${sessionId}`;
    const execute = async (script, args = []) => request(
        base + '/execute/sync',
        'POST',
        { script, args }
    );
    const activeElement = async () => {
        const element = await request(base + '/element/active');
        return element[ELEMENT_KEY];
    };
    const sendKeys = async (text) => {
        const elementId = await activeElement();
        await request(
            `${base}/element/${encodeURIComponent(elementId)}/value`,
            'POST',
            { text, value: Array.from(text) }
        );
    };

    const fixtureUrl = pathToFileURL(
        resolve(process.cwd(), BUNDLE === 'dist'
            ? 'tests/browser-smoke-dist.html'
            : 'tests/browser-smoke.html')
    ).href;
    await request(base + '/url', 'POST', { url: fixtureUrl });

    await waitFor(
        () => execute('return typeof window.MentionJS'),
        (value) => value === 'function',
        'MentionJS did not load in Chrome'
    );

    // 1. Real textarea key events: trigger -> query -> Enter commit -> caret.
    await execute(`
        window.__instance?.destroy();
        window.__calls = [];
        const textarea = document.getElementById('textarea');
        textarea.value = '';
        textarea.focus();
        window.__instance = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction: async (query) => {
                window.__calls.push(query);
                return [{ id: 1, name: 'Alice' }];
            },
        });
    `);
    await sendKeys('@a');

    await waitFor(
        () => execute(`
            return {
                calls: window.__calls,
                dropdown: !!document.querySelector('.mention-dropdown.active'),
            };
        `),
        (value) => value.dropdown && value.calls.includes('a'),
        'Textarea search did not open for native key input'
    );

    await sendKeys('\uE007'); // Enter
    const textareaCommit = await execute(`
        const textarea = document.getElementById('textarea');
        return {
            value: textarea.value,
            start: textarea.selectionStart,
            end: textarea.selectionEnd,
            mentions: window.__instance.getMentions(),
        };
    `);
    assert(textareaCommit.value === '@Alice ', 'Textarea commit text mismatch');
    assert(textareaCommit.start === 7 && textareaCommit.end === 7,
        'Textarea caret was not placed after committed mention');
    assert(textareaCommit.mentions.length === 1 && textareaCommit.mentions[0].id === 1,
        'Textarea committed mention metadata mismatch');

    // 2. Real contenteditable key events: trigger -> query -> Enter commit.
    await execute(`
        window.__instance.destroy();
        window.__calls = [];
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__instance = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction: async (query) => {
                window.__calls.push(query);
                return [{ id: 2, name: 'Bob' }];
            },
        });
    `);
    await sendKeys('@b');

    await waitFor(
        () => execute(`
            return {
                calls: window.__calls,
                dropdown: !!document.querySelector('.mention-dropdown.active'),
            };
        `),
        (value) => value.dropdown && value.calls.includes('b'),
        'Contenteditable search did not open for native key input'
    );

    await sendKeys('\uE007');
    const editableCommit = await execute(`
        const editor = document.getElementById('editor');
        const span = editor.querySelector('span.mention');
        const selection = window.getSelection();
        return {
            text: editor.textContent,
            id: span?.dataset.mentionId ?? null,
            name: span?.dataset.mentionName ?? null,
            active: span?.classList.contains('active') ?? null,
            caretText: selection.anchorNode?.textContent ?? null,
            caretOffset: selection.anchorOffset,
        };
    `);
    assert(editableCommit.id === '2' && editableCommit.name === 'Bob',
        'Contenteditable committed mention metadata mismatch');
    assert(editableCommit.active === false,
        'Contenteditable committed mention stayed active');
    assert(editableCommit.caretText === '\u00A0' && editableCommit.caretOffset === 1,
        'Contenteditable caret was not placed after trailing separator');

    // 3. Escape must cancel a pending search before its response arrives.
    await execute(`
        window.__instance.destroy();
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__pendingResolve = null;
        window.__instance = new MentionJS(editor, {
            searchFunction: () => new Promise((resolve) => {
                window.__pendingResolve = resolve;
            }),
        });
    `);
    await sendKeys('@');

    await waitFor(
        () => execute('return typeof window.__pendingResolve'),
        (value) => value === 'function',
        'Pending contenteditable search was not started'
    );

    await sendKeys('\uE00C'); // Escape
    await execute(`
        window.__pendingResolve([{ id: 3, name: 'Carol' }]);
    `);
    await sleep(100);

    const pendingEscape = await execute(`
        const editor = document.getElementById('editor');
        return {
            text: editor.textContent,
            mention: !!editor.querySelector('span.mention'),
            dropdown: !!document.querySelector('.mention-dropdown'),
        };
    `);
    assert(pendingEscape.text === '@', 'Escape changed pending trigger text');
    assert(!pendingEscape.mention, 'Escape left a pending mention token');
    assert(!pendingEscape.dropdown, 'Late pending response reopened dropdown after Escape');

    // 4. Native Backspace must remove a trigger-only token completely.
    await execute(`
        window.__instance.destroy();
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__instance = new MentionJS(editor, {
            searchFunction: async () => [],
        });
    `);
    await sendKeys('@');
    await waitFor(
        () => execute("return !!document.querySelector('#editor span.mention')"),
        Boolean,
        'Trigger-only mention token was not created'
    );
    await sendKeys('\uE003'); // Backspace
    const backspace = await execute(`
        const editor = document.getElementById('editor');
        return {
            text: editor.textContent,
            span: !!editor.querySelector('span'),
        };
    `);
    assert(backspace.text === '' && !backspace.span,
        'Backspace did not remove trigger-only token cleanly');

    // 5. Native undo/redo must never leave mention metadata detached from text.
    await execute(`
        window.__instance?.destroy();
        const textarea = document.getElementById('textarea');
        textarea.value = '';
        textarea.focus();
        window.__instance = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction: async () => [{ id: 10, name: 'Alice' }],
        });
    `);
    await sendKeys('@a');
    await waitFor(
        () => execute("return !!document.querySelector('.mention-dropdown.active')"),
        Boolean,
        'Textarea dropdown did not open before undo/redo check'
    );
    await sendKeys('\uE007');

    const assertTextareaMentionConsistency = async (label) => {
        const state = await execute(`
            const textarea = document.getElementById('textarea');
            return {
                value: textarea.value,
                mentions: window.__instance.getMentions(),
            };
        `);

        for (const mention of state.mentions) {
            assert(
                state.value.slice(mention.start, mention.end) === '@' + mention.name,
                label + ': textarea mention metadata is stale'
            );
        }
    };

    await sendKeys('\uE009z\uE000'); // Control+Z
    await sleep(100);
    await assertTextareaMentionConsistency('undo');

    await sendKeys('\uE009\uE008z\uE000'); // Control+Shift+Z
    await sleep(100);
    await assertTextareaMentionConsistency('redo');

    await execute(`
        window.__instance.destroy();
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__instance = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction: async () => [{ id: 11, name: 'Bob' }],
        });
    `);
    await sendKeys('@b');
    await waitFor(
        () => execute("return !!document.querySelector('.mention-dropdown.active')"),
        Boolean,
        'Contenteditable dropdown did not open before undo/redo check'
    );
    await sendKeys('\uE007');

    const assertEditableMentionConsistency = async (label) => {
        const state = await execute(`
            const editor = document.getElementById('editor');
            return Array.from(
                editor.querySelectorAll('span[data-mention-id][data-mention-name]')
            ).map((span) => ({
                text: span.textContent,
                name: span.dataset.mentionName,
                active: span.classList.contains('active'),
            }));
        `);

        for (const mention of state) {
            assert(
                mention.text === '@' + mention.name && !mention.active,
                label + ': contenteditable mention metadata is stale'
            );
        }
    };

    await sendKeys('\uE009z\uE000'); // Control+Z
    await sleep(100);
    await assertEditableMentionConsistency('undo');

    await sendKeys('\uE009\uE008z\uE000'); // Control+Shift+Z
    await sleep(100);
    await assertEditableMentionConsistency('redo');

    // 6. A caret inside a token must replace its entire suffix, while
    // preserving the comma that follows the name.
    await execute(`
        window.__instance.destroy();
        window.__queries = [];
        const textarea = document.getElementById('textarea');
        textarea.value = '@alice, world';
        textarea.focus();
        textarea.setSelectionRange(3, 3);
        window.__instance = new MentionJS(textarea, {
            debounceDelay: 0,
            searchFunction: async (query) => {
                window.__queries.push(query);
                return [{ id: 22, name: 'Bob' }];
            },
        });
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await waitFor(
        () => execute(`
            return {
                query: window.__queries.at(-1),
                dropdown: !!document.querySelector('.mention-dropdown.active'),
            };
        `),
        (value) => value.dropdown && value.query === 'al',
        'Mid-token query failed in the native browser'
    );
    await sendKeys('\uE007');
    const middleCommit = await execute(`
        const textarea = document.getElementById('textarea');
        return {
            value: textarea.value,
            caret: textarea.selectionStart,
            mentions: window.__instance.getMentions(),
        };
    `);
    assert(middleCommit.value === '@Bob, world',
        'A mid-token commit lost punctuation or kept the old token suffix');
    assert(middleCommit.caret === 4, 'Caret after a mid-token mention is wrong');
    assert(middleCommit.mentions.length === 1 &&
        middleCommit.mentions[0].id === 22,
        'Mid-token commit did not retain the selected identity');

    // 7. External .value changes without input must invalidate stale
    // autocomplete results before a keyboard commit.
    await execute(`
        const textarea = document.getElementById('textarea');
        textarea.value = '@';
        textarea.setSelectionRange(1, 1);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await waitFor(
        () => execute("return !!document.querySelector('.mention-dropdown.active')"),
        Boolean,
        'Dropdown did not open before stale-input regression'
    );
    await execute(`
        const textarea = document.getElementById('textarea');
        textarea.value = 'plain text';
        textarea.setSelectionRange(10, 10);
    `);
    await sendKeys('\uE007');
    const staleCommit = await execute(`
        const textarea = document.getElementById('textarea');
        return {
            value: textarea.value,
            mentions: window.__instance.getMentions(),
            dropdown: !!document.querySelector('.mention-dropdown'),
        };
    `);
    // If selectionchange closes the dropdown before Enter, a textarea may
    // accept Enter as an ordinary newline. What must never happen is
    // committing the stale mention or reopening its suggestion list.
    assert(/^plain text(?:\r?\n)?$/u.test(staleCommit.value) &&
        staleCommit.mentions.length === 0 && !staleCommit.dropdown,
        'Stale result after silent host edit: ' + JSON.stringify(staleCommit));

    // 8. Real browser selection must survive cancellation of an active
    // contenteditable mention, including backwards anchor/focus direction.
    await execute(`
        window.__instance.destroy();
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__instance = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction: async () => [],
        });
    `);
    await sendKeys('@al');
    await waitFor(
        () => execute(`
            const span = document.querySelector('#editor span.mention.active');
            return !!span && span.textContent === '@al' &&
                !!document.querySelector('.mention-dropdown.active');
        `),
        Boolean,
        'Active rich-text mention did not initialize for selection test'
    );
    const backwardSelection = await execute(`
        const editor = document.getElementById('editor');
        const span = editor.querySelector('span.mention.active');
        const tail = document.createTextNode(' tail');
        editor.appendChild(tail);
        const selection = window.getSelection();
        selection.setBaseAndExtent(tail, 3, span.firstChild, 1);
        document.dispatchEvent(new Event('selectionchange'));
        return {
            hasSpan: !!editor.querySelector('span.mention'),
            text: editor.textContent,
            selected: selection.toString(),
            anchorIsTail: selection.anchorNode === tail,
            anchorOffset: selection.anchorOffset,
            focusIsText: selection.focusNode === editor.firstChild,
            focusOffset: selection.focusOffset,
        };
    `);
    assert(!backwardSelection.hasSpan &&
        backwardSelection.text === '@al tail' &&
        backwardSelection.selected === 'al ta' &&
        backwardSelection.anchorIsTail &&
        backwardSelection.anchorOffset === 3 &&
        backwardSelection.focusIsText &&
        backwardSelection.focusOffset === 1,
        'Backward selection was not preserved after cancelling a mention: ' +
        JSON.stringify(backwardSelection));


    // 9. Exercise the interactive demo, not just the isolated library fixture.
    const demoUrl = pathToFileURL(resolve(process.cwd(), 'demo.html')).href;
    await request(base + '/url', 'POST', { url: demoUrl });
    await waitFor(
        () => execute("return document.documentElement.dataset.demoReady === 'true' && typeof window.MentionJS === 'function';"),
        Boolean, 'Interactive demo did not initialize'
    );
    const readyDemo = await execute(
        "return { title: document.title, editor: !!document.getElementById('editor'), textarea: !!document.getElementById('textarea'), previews: document.querySelectorAll('.mention-preview').length };"
    );
    assert(readyDemo.title.includes('MentionJS') &&
        readyDemo.editor && readyDemo.textarea && readyDemo.previews === 2,
        'Demo is missing an interactive editor or metadata preview');

    await execute("document.getElementById('textarea').focus();");
    await sendKeys('@');
    await waitFor(
        () => execute("return document.querySelectorAll('.mention-dropdown.active .mention-item[data-index]').length;"),
        (value) => value === 5, 'Demo did not show the first result page'
    );
    await execute(
        "const list = document.querySelector('.mention-dropdown'); list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll'));"
    );
    await waitFor(
        () => execute("return document.querySelectorAll('.mention-dropdown.active .mention-item[data-index]').length;"),
        (value) => value === 10, 'Demo did not load the second result page'
    );

    await sendKeys('\uE007');
    const demoCommit = await execute(
        "return { value: document.getElementById('textarea').value, mentions: JSON.parse(document.getElementById('mentions-textarea').textContent), feedback: document.getElementById('status-textarea').textContent };"
    );
    assert(demoCommit.value.startsWith('@Anna Ivanova') &&
        demoCommit.mentions.length === 1 && demoCommit.mentions[0].id === 1 &&
        demoCommit.feedback.includes('Selected'),
        'Demo did not show committed textarea mention metadata');

    const demoApi = await execute(
        "pushMention('textarea'); const pushed = JSON.parse(document.getElementById('mentions-textarea').textContent); " +
        "clearField('textarea'); const cleared = JSON.parse(document.getElementById('mentions-textarea').textContent); " +
        "pushMention('editor'); const editorPushed = JSON.parse(document.getElementById('mentions-editor').textContent); " +
        "clearField('editor'); const editorCleared = JSON.parse(document.getElementById('mentions-editor').textContent); " +
        "return { pushed: pushed.length, cleared: cleared.length, editorPushed, editorCleared: editorCleared.length, textarea: document.getElementById('textarea').value, editorText: document.getElementById('editor').textContent };"
    );
    assert(demoApi.pushed === 2 && demoApi.cleared === 0 &&
        demoApi.editorPushed.length === 1 && demoApi.editorPushed[0].id === '7' &&
        demoApi.editorCleared === 0 && demoApi.textarea === '' && demoApi.editorText === '',
        'Demo public API controls did not keep metadata in sync');


    // 10. Long native contenteditable typing must not silently unwrap the active
    // mention before the user chooses a suggestion, even with no match.
    await request(base + '/url', 'POST', { url: fixtureUrl });
    await execute(`
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__typingTrace = [];
        const snapshot = (type, event) => {
            const span = editor.querySelector('span.mention');
            const sel = window.getSelection();
            window.__typingTrace.push({
                type,
                inputType: event?.inputType || null,
                data: event?.data || null,
                text: editor.textContent,
                span: span?.textContent || null,
                active: !!span?.classList.contains('active'),
                node: sel.anchorNode?.nodeName || null,
                parent: sel.anchorNode?.parentElement?.tagName || null,
                offset: sel.anchorOffset,
            });
        };
        editor.addEventListener('beforeinput', (event) => snapshot('beforeinput', event), true);
        editor.addEventListener('input', (event) => snapshot('input', event));
        document.addEventListener('selectionchange', () => snapshot('selectionchange'));
        window.__instance = new MentionJS(editor, {
            debounceDelay: 30,
            searchFunction: async (query) => {
                await new Promise(resolve => setTimeout(resolve, 85));
                return query.toLowerCase().startsWith('anna')
                    ? [{ id: 100, name: 'Anna Ivanova' }]
                    : [];
            },
        });
    `);
    await sendKeys('@Anna Ivanod');
    await sleep(450);
    const typingState = await execute(`
        const editor = document.getElementById('editor');
        return {
            text: editor.textContent,
            span: editor.querySelector('span.mention')?.outerHTML || null,
            active: !!editor.querySelector('span.mention.active'),
            expanded: editor.getAttribute('aria-expanded'),
            dropdown: !!document.querySelector('.mention-dropdown.active'),
            trace: window.__typingTrace.slice(-35),
        };
    `);
    assert(typingState.text === '@Anna Ivanod' &&
        typingState.active && typingState.dropdown,
        'Long native contenteditable query lost its active token: ' +
        JSON.stringify(typingState));

    // Editing a committed mention must retain the editable token while
    // the trigger still exists, without silently converting it to plain text.
    await execute(`
        window.__instance.destroy();
        const editor = document.getElementById('editor');
        editor.innerHTML = '';
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(true);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        window.__instance = new MentionJS(editor, {
            debounceDelay: 0,
            searchFunction: async () => [{ id: 1, name: 'Anna Ivanova' }],
        });
    `);
    await sendKeys('@a');
    await waitFor(
        () => execute("return !!document.querySelector('.mention-dropdown.active')"),
        Boolean, 'No suggestions before edit-committed case'
    );
    await sendKeys('\uE007');
    await execute(`
        const span = document.querySelector('#editor span[data-mention-id]');
        const range = document.createRange();
        range.setStart(span.firstChild, span.textContent.length - 1);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.getElementById('editor').focus();
    `);
    await sendKeys('\uE003');
    await sleep(120);
    const reedit = await execute(`
        const el = document.getElementById('editor');
        const span = el.querySelector('span.mention');
        return {
            text: el.textContent,
            active: !!span?.classList.contains('active'),
            span: span?.outerHTML || null,
            dropdown: !!document.querySelector('.mention-dropdown.active'),
            mentions: window.__instance.getMentions(),
        };
    `);
    assert(reedit.active && reedit.dropdown &&
        reedit.mentions.length === 0,
        'Editing a committed mention did not retain an active span: ' + JSON.stringify(reedit));

    await execute('window.__browserSmokePassed = true; return true;');
    console.log(`MentionJS ${BROWSER} ${BUNDLE} smoke tests passed`);
} catch (error) {
    console.error(error);
    console.error(driverOutput);
    process.exitCode = 1;
} finally {
    if (sessionId) {
        try {
            await request(`/session/${sessionId}`, 'DELETE');
        } catch (_) {}
    }
    driver.kill('SIGTERM');
}
