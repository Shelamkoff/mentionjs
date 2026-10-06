import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DRIVER_URL = 'http://127.0.0.1:9515';
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

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

const driver = spawn('chromedriver', ['--port=9515'], {
    stdio: ['ignore', 'pipe', 'pipe'],
});

let driverOutput = '';
driver.stdout.on('data', (chunk) => { driverOutput += chunk.toString(); });
driver.stderr.on('data', (chunk) => { driverOutput += chunk.toString(); });

let sessionId = null;

try {
    await waitForDriver();

    const session = await request('/session', 'POST', {
        capabilities: {
            alwaysMatch: {
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
            },
        },
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
        resolve(process.cwd(), 'tests/browser-smoke.html')
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

    await execute('window.__browserSmokePassed = true; return true;');
    console.log('MentionJS Chromium smoke tests passed');
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
