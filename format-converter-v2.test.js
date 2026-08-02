const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const HTML_FILE = 'format-converter-v2.html';

function loadHtml() {
  return fs.readFileSync(HTML_FILE, 'utf8');
}

function getInlineScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(`No inline script found in ${HTML_FILE}`);
  }
  return match[1];
}

function createClassList() {
  return {
    values: new Set(),
    add(name) {
      this.values.add(name);
    },
    remove(name) {
      this.values.delete(name);
    },
    contains(name) {
      return this.values.has(name);
    },
  };
}

function createElement(id, calls) {
  return {
    id,
    value: '',
    innerHTML: '',
    innerText: '',
    textContent: '',
    className: '',
    style: {},
    classList: createClassList(),
    focus() {
      calls.focused.push(id);
    },
    blur() {
      calls.blurred.push(id);
    },
    select() {
      calls.selected.push(id);
    },
    setSelectionRange(start, end) {
      calls.ranges.push({ id, start, end });
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
}

function createHarness(options = {}) {
  const calls = {
    blurred: [],
    clipboardWrites: [],
    execCommand: [],
    focused: [],
    ranges: [],
    selected: [],
    share: 0,
    vibrate: [],
  };
  const elements = {};
  const document = {
    getElementById(id) {
      if (!elements[id]) {
        elements[id] = createElement(id, calls);
      }
      return elements[id];
    },
    execCommand(command) {
      calls.execCommand.push(command);
      return options.execCommandResult !== undefined ? options.execCommandResult : true;
    },
  };
  const navigator = {
    vibrate(pattern) {
      calls.vibrate.push(pattern);
    },
    share() {
      calls.share += 1;
      return Promise.resolve();
    },
    ...(options.navigator || {}),
  };
  const context = {
    document,
    navigator,
    window: {
      isSecureContext: Boolean(options.isSecureContext),
      getSelection() {
        return { removeAllRanges() {} };
      },
    },
    setTimeout(fn) {
      fn();
      return 1;
    },
    clearTimeout() {},
  };

  vm.createContext(context);
  vm.runInContext(getInlineScript(loadHtml()), context);
  return { calls, context, elements };
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

(async () => {
  await test('page is fully local and does not load font or icon CDNs', () => {
    const html = loadHtml();

    assert(!html.includes('fonts.googleapis.com'));
    assert(!html.includes('fonts.gstatic.com'));
    assert(!html.includes('cdnjs.cloudflare.com'));
  });

  await test('mobile viewport allows pinch zoom', () => {
    const html = loadHtml();
    const viewport = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/i)?.[1] || '';

    assert(!viewport.includes('user-scalable=no'));
    assert(!viewport.includes('maximum-scale=1.0'));
  });

  await test('forward conversion supports spaces and keeps only first four fields', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'user@gmail.com pass123 recovery@gmail.com SECRET extra-field';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'user@gmail.com---pass123---recovery@gmail.com---SECRET',
    );
  });

  await test('forward conversion extracts spaced 2FA and drops trailing log data', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'crepetul.ipe@gmail.com|1TD8ybM8981|c6ls jsva ve36 c4jg 1rff 3tar lshj fgsl 2026-06-30 15:12:57 已经订阅 账号凭证获取成功 {"client_id":"example-client-id.apps.example.test","client_secret":"example-client-secret","token":"example-token","scope":"mail","expires":123}';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'crepetul.ipe@gmail.com---1TD8ybM8981---c6ls jsva ve36 c4jg 1rff 3tar lshj fgsl',
    );
  });

  await test('double-dash conversion extracts grouped 2FA and drops log data', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'shopper@example.com--Pa55word@--7cpz n5te hwvm vklb hrkg 5qw6 eow2 7nnx 账号凭证获取成功 {"client_id":"example-client-id.apps.example.test","client_secret":"example-client-secret","token":"example-token"}';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'shopper@example.com---Pa55word@---7cpz n5te hwvm vklb hrkg 5qw6 eow2 7nnx',
    );
  });

  await test('double-dash conversion skips metadata when 2FA is missing', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'shopper@example.com--Pa55word@--2024 Hong Kong 2026-07-18 09:00:05 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('2FA change receipt keeps original credentials and uses the changed 2FA', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-07-27 06:21:01 2fa修改成功 repeated@example.com--RepeatedPass--new1 new2 new3 new4 new5 new6 new7 new8 账号凭证获取成功 {"client_id":"example-client-id.apps.example.test","client_secret":"example-client-secret","token":"example-token"}';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---new1 new2 new3 new4 new5 new6 new7 new8',
    );
  });

  await test('2FA change receipt is skipped when the changed 2FA is missing', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-07-27 06:21:01 2fa修改成功 original@example.com--OldPass123--2024 Germany 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('pipe conversion keeps compact 2FA instead of year and country metadata', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'buyer@example.com|Pa55word|helper@example.com|ABCD2345EFGH6789JKLM2345NPQR6789|2024|Hong Kong 2026-07-16 09:00:05 订阅成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'buyer@example.com---Pa55word---helper@example.com---ABCD2345EFGH6789JKLM2345NPQR6789',
    );
  });

  await test('pipe conversion skips rows when 2FA is missing before metadata', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'buyer@example.com|Pa55word|helper@example.com|2024|Hong Kong 2026-07-16 09:00:05 订阅成功';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('forward conversion keeps recovery email when present', () => {
    const harness = createHarness();

    harness.elements.inputText.value = '账号: buyer@gmail.com 密码: Pa55word 辅助邮箱: helper@gmail.com 2FA: abcd efgh ijkl mnop 已经订阅';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'buyer@gmail.com---Pa55word---helper@gmail.com---abcd efgh ijkl mnop',
    );
  });

  await test('forward conversion skips recovery email when it is missing', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'buyer@gmail.com|Pa55word|abcd efgh ijkl mnop 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'buyer@gmail.com---Pa55word---abcd efgh ijkl mnop',
    );
  });

  await test('already converted no-recovery rows stay dashed and drop log tail', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'buyer@gmail.com---Pa55word---abcd efgh ijkl mnop 2026-07-09 12:30:00 已经订阅 账号凭证日志 JSON token {"token":"example-token"}';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'buyer@gmail.com---Pa55word---abcd efgh ijkl mnop',
    );
  });

  await test('already converted recovery rows stay dashed and drop token tail', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'buyer@gmail.com---Pa55word---helper@gmail.com---abcd efgh ijkl mnop Johnson token {"client_id":"example-client-id.apps.example.test"}';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'buyer@gmail.com---Pa55word---helper@gmail.com---abcd efgh ijkl mnop',
    );
  });

  await test('input stats count non-empty rows, not trailing blank lines', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'first line\n\nsecond line\n';
    harness.context.handleInput();

    assert(harness.elements.inputStats.innerHTML.includes('<strong>2</strong>'));
  });

  await test('clearAll clears stale output, warning, and stats', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'user@gmail.com|pass|recovery@gmail.com|ABCDEFGHIJKLMNOP';
    harness.context.handleInput();
    harness.elements.copyWarningBanner.classList.add('show');

    harness.context.clearAll();

    assert.strictEqual(harness.elements.inputText.value, '');
    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
    assert(!harness.elements.copyWarningBanner.classList.contains('show'));
    assert(harness.elements.outputStats.innerHTML.includes('<strong>0</strong>'));
    assert(harness.elements.skipStats.innerHTML.includes('<strong>0</strong>'));
  });

  await test('copy fallback selects output and does not use Web Share on mobile', () => {
    const harness = createHarness();

    harness.elements.outputText.value = 'user@gmail.com---pass---recovery@gmail.com---SECRET';
    harness.context.executeCopy();

    assert.strictEqual(harness.calls.share, 0);
    assert.deepStrictEqual(harness.calls.execCommand, ['copy']);
    assert.deepStrictEqual(harness.calls.ranges.at(-1), {
      id: 'outputText',
      start: 0,
      end: harness.elements.outputText.value.length,
    });
  });
})();
