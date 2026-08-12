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
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
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
        if (id === 'formatModeToggle') {
          elements[id].setAttribute('aria-pressed', 'false');
        }
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
  // Existing parser tests exercise the extended output contract. Production
  // starts in legacy mode; opt into that mode explicitly when testing it.
  if (options.skipModeSetup) {
    // Assert the production default without invoking the public setter.
  } else if (options.mode) {
    context.setConversionMode(options.mode);
  } else {
    context.setConversionMode('extended');
  }
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

  await test('page blocks outbound connections and suppresses referrer data', () => {
    const html = loadHtml();
    const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1] || '';
    const referrer = html.match(/<meta\s+name="referrer"\s+content="([^"]+)"/i)?.[1] || '';

    assert(csp.includes("connect-src 'none'"));
    assert(csp.includes("object-src 'none'"));
    assert.strictEqual(referrer.toLowerCase(), 'no-referrer');
  });

  await test('credential textareas disable browser text assistance', () => {
    const html = loadHtml();
    const inputTag = html.match(/<textarea\s+id="inputText"[^>]*>/i)?.[0] || '';
    const outputTag = html.match(/<textarea\s+id="outputText"[^>]*>/i)?.[0] || '';

    assert(/autocomplete="off"/i.test(inputTag));
    assert(/autocapitalize="off"/i.test(inputTag));
    assert(/autocorrect="off"/i.test(inputTag));
    assert(/spellcheck="false"/i.test(inputTag));
    assert(/spellcheck="false"/i.test(outputTag));
  });

  await test('service worker keeps documents fresh and caches only same-origin GET requests', () => {
    const serviceWorker = fs.readFileSync('sw.js', 'utf8');

    assert(serviceWorker.includes("const CACHE_NAME = 'g-auth-v15'"));
    assert(serviceWorker.includes("request.method !== 'GET'"));
    assert(serviceWorker.includes('requestUrl.origin !== self.location.origin'));
    assert(serviceWorker.includes("request.mode === 'navigate'"));
    assert(serviceWorker.includes("request.destination === 'document'"));
    assert(serviceWorker.indexOf('fetch(request)') < serviceWorker.indexOf('caches.match(request)'));
  });

  await test('page registers the service worker without HTTP cache reuse', () => {
    const html = loadHtml();

    assert(html.includes("navigator.serviceWorker.register('./sw.js'"));
    assert(html.includes("updateViaCache: 'none'"));
  });

  await test('homepage and converter stay in sync', () => {
    assert.strictEqual(
      fs.readFileSync('index.html', 'utf8'),
      fs.readFileSync('format-converter-v2.html', 'utf8'),
    );
  });

  await test('format mode toggle is present and defaults to legacy', () => {
    const html = loadHtml();
    const toggle = html.match(/<button\s+[^>]*id="formatModeToggle"[^>]*>/i)?.[0] || '';

    assert(toggle);
    assert(/aria-pressed="false"/i.test(toggle));
    assert(html.includes('默认旧版只输出四字段'));

    const harness = createHarness({ skipModeSetup: true });
    assert.strictEqual(harness.context.getConversionMode(), 'legacy');
    assert.strictEqual(harness.elements.formatModeToggle.getAttribute('aria-pressed'), 'false');
  });

  await test('switching to extended mode recomputes the current input immediately', () => {
    const harness = createHarness({ mode: 'legacy' });
    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|fa01 fa02 fa03 fa04|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 {"refresh_token":"1//mode-refresh-value"} 反重力验证成功 5550102468|https://sms.example.test/api?token=fake-mode-api';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04',
    );

    harness.context.setConversionMode('extended');
    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//mode-refresh-value---5550102468---https://sms.example.test/api?token=fake-mode-api',
    );
    assert.strictEqual(harness.elements.formatModeToggle.getAttribute('aria-pressed'), 'true');

    harness.context.toggleConversionMode();
    assert.strictEqual(harness.context.getConversionMode(), 'legacy');
    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04',
    );
  });

  await test('switching modes with empty input is safe', () => {
    const harness = createHarness({ mode: 'legacy' });

    harness.context.handleInput();
    harness.context.toggleConversionMode();

    assert.strictEqual(harness.context.getConversionMode(), 'extended');
    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('mobile mode control centers the toggle without a badge spacer', () => {
    const html = loadHtml();
    const mobileRules = html.match(/@media\s*\(max-width:\s*420px\)[\s\S]*?\n\s*}\s*\n\s*<\/style>/i)?.[0] || '';

    assert(mobileRules.includes('.mode-badge:not(.show)'));
    assert(/\.mode-badge:not\(\.show\)\s*\{[^}]*display\s*:\s*none/i.test(mobileRules));
    assert(/\.mode-controls\s*\{[^}]*justify-content\s*:\s*center/i.test(mobileRules));
    assert(/\.format-mode-toggle\s*\{[^}]*margin-inline\s*:\s*auto/i.test(mobileRules));
    assert(/\.format-mode-toggle\s*\{[^}]*max-width\s*:\s*100%/i.test(mobileRules));
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

  await test('pipe conversion preserves password punctuation exactly', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'user@gmail.com|Pa55word.)|recovery@gmail.com|ABCDEFGHIJKLMNOP234567';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'user@gmail.com---Pa55word.)---recovery@gmail.com---ABCDEFGHIJKLMNOP234567',
    );
  });

  await test('pipe conversion accepts an email-shaped password in the password position', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'user@gmail.com|password@example.net|recovery@gmail.com|ABCDEFGHIJKLMNOP234567';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'user@gmail.com---password@example.net---recovery@gmail.com---ABCDEFGHIJKLMNOP234567',
    );
  });

  await test('semicolon conversion is not confused by a comma in trailing logs', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'user@gmail.com;Pass123;recovery@gmail.com;fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08, trailing log';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'user@gmail.com---Pass123---recovery@gmail.com---fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08',
    );
  });

  await test('all hard delimiters use the first structural separator', () => {
    const delimiters = ['|', '\t', ',', ';', '，', '；'];
    const laterNoise = [';', '|', '；', ',', '\t', '，'];

    delimiters.forEach((delimiter, index) => {
      const harness = createHarness();
      harness.elements.inputText.value = [
        'user@gmail.com',
        'Pass123',
        'recovery@gmail.com',
        `fa01 fa02 fa03 fa04 账号凭证获取成功${laterNoise[index]}tail`,
      ].join(delimiter);
      harness.context.handleInput();

      assert.strictEqual(
        harness.elements.outputText.value,
        'user@gmail.com---Pass123---recovery@gmail.com---fa01 fa02 fa03 fa04',
        `delimiter ${JSON.stringify(delimiter)}`,
      );
    });
  });

  await test('pipe conversion keeps double dashes inside account and password fields', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'user--tag@gmail.com|Pass--word|recovery@gmail.com|ABCDEFGHIJKLMNOP234567';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'user--tag@gmail.com---Pass--word---recovery@gmail.com---ABCDEFGHIJKLMNOP234567',
    );
  });

  await test('rows containing the output delimiter inside a field are skipped safely', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'user@gmail.com|Pass---word|recovery@gmail.com|ABCDEFGHIJKLMNOP234567';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('pipe conversion supports a non-email account with a recovery email', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'plainuser|Pass123|recovery@gmail.com|ABCDEFGHIJKLMNOP234567';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'plainuser---Pass123---recovery@gmail.com---ABCDEFGHIJKLMNOP234567',
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

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-07-27 06:21:01 2fa修改成功 original@example.com--OldPass123--new1 new2 new3 new4 new5 new6 new7 new8 账号凭证获取成功 {"client_id":"example-client-id.apps.example.test","client_secret":"example-client-secret","token":"example-token"}';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---new1 new2 new3 new4 new5 new6 new7 new8',
    );
  });

  await test('2FA receipt with refresh JSON appends refresh token, phone, and SMS API URL', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2026-07-26 16:11:16 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08 账号凭证获取成功 {"client_id":"fake-client.apps.example.test","token":"ya29.fake-access-token","refresh_token":"1//fake-refresh-token-value"} 反重力验证成功 5550102468|https://sms.example.test?token=fake-sms-token';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08---1//fake-refresh-token-value---5550102468---https://sms.example.test?token=fake-sms-token',
    );
  });

  await test('tab-separated receipt matches the source export shape', () => {
    const harness = createHarness();
    const json = JSON.stringify({
      client_id: 'fake-client.apps.example.test',
      client_secret: 'fake-client-secret',
      token: 'ya29.fake-access-token',
      refresh_token: '1//tab-shaped-refresh-value',
      project_id: 'fake-project-id',
      expiry: '2026-07-26T09:12:03.000Z',
    });

    harness.elements.inputText.value = [
      'original@example.com',
      'OldPass123',
      'helper@example.net',
      'old1 old2 old3 old4',
      '2024',
      'Latvia',
      '订阅成功',
      '2026-07-26 16:11:16',
      '2fa修改成功',
      'original@example.com--OldPass123--fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08',
      '',
      '账号凭证获取成功',
      json,
      '反重力验证成功',
      '5550102468|https://sms.example.test?token=fake-sms-token',
    ].join('\t');
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08---1//tab-shaped-refresh-value---5550102468---https://sms.example.test?token=fake-sms-token',
    );
  });

  await test('refresh JSON can span visual line breaks and still appends all fields', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2026-07-26 16:11:16 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 {"client_id":"fake-client.apps.example.test",\n"token":"ya29.fake-access-token",\n"refresh_token":"1//multiline-refresh-value"} 反重力验证成功 5550102468|https://sms.example.test?token=fake-sms-token';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//multiline-refresh-value---5550102468---https://sms.example.test?token=fake-sms-token',
    );
  });

  await test('JSON object can span multiple physical lines after the receipt', () => {
    const harness = createHarness();

    harness.elements.inputText.value = [
      'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2026-07-26 16:11:16 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 {"client_id":"fake-client.apps.example.test",',
      '"refresh_token":"1//physical-line-refresh"}',
      '反重力验证成功 5550102468|https://sms.example.test?token=fake-sms-token',
    ].join('\n');
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//physical-line-refresh---5550102468---https://sms.example.test?token=fake-sms-token',
    );
  });

  await test('verification marker, phone, and API URL can each be on a new line', () => {
    const harness = createHarness();
    const json = JSON.stringify({ refresh_token: '1//split-verification-value' });
    harness.elements.inputText.value = [
      'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 ' + json,
      '反重力验证成功',
      '5550102468',
      'https://sms.example.test/api?token=fake-split-api',
    ].join('\n');
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//split-verification-value---5550102468---https://sms.example.test/api?token=fake-split-api',
    );
  });

  await test('JSON with refresh_token but no phone or API appends a fifth field', () => {
    const harness = createHarness();
    const json = JSON.stringify({
      client_id: 'fake-client.apps.example.test',
      client_secret: 'fake-client-secret',
      token: 'ya29.fake-access-token',
      refresh_token: '1//refresh-only-value',
      scopes: ['https://www.googleapis.com/auth/userinfo.email'],
      token_uri: 'https://oauth.example.test/token',
      project_id: 'fake-project-id',
      expiry: '2026-08-11T05:54:47.000000+00:00',
    });

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|fa01 fa02 fa03 fa04|2024|Uruguay\t订阅成功\t2026-08-11 12:53:56\t\t\t账号凭证获取成功\t' + json + '\t反重力验证成功，';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//refresh-only-value',
    );
  });

  await test('JSON appends refresh_token even when no verification marker follows', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|fa01 fa02 fa03 fa04|2024|Uruguay\t订阅成功\t2026-08-11 12:53:56\t账号凭证获取成功\t{"refresh_token":"1//json-only-value"}';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//json-only-value',
    );
  });

  await test('JSON appends an available phone when the API URL is absent', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 {"refresh_token":"1//refresh-phone-value"} 反重力验证成功 5550102468';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//refresh-phone-value---5550102468',
    );
  });

  await test('2FA receipt without JSON keeps the original four-field format', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2026-07-26 16:11:16 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 反重力验证成功 5550102468|https://sms.example.test?token=fake-sms-token';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04',
    );
  });

  await test('JSON without refresh_token keeps the original four-field format', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2026-07-26 16:11:16 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 {"token":"ya29.fake-access-token"} 反重力验证成功 5550102468|https://sms.example.test?token=fake-sms-token';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04',
    );
  });

  await test('a non-Google refresh token keeps the original four-field format', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 {"refresh_token":"opaque-refresh-value"} 反重力验证成功 5550102468|https://sms.example.test?token=fake-sms-token';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04',
    );
  });

  await test('refresh_token extraction does not confuse access token or URL token', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2026-07-26 16:11:16 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 {"token":"ya29.fake-access-token","refresh_token":"1//only-the-refresh-value"} 反重力验证成功 5550102468|https://sms.example.test?token=not-the-refresh-value';
    harness.context.handleInput();

    assert(harness.elements.outputText.value.includes('---1//only-the-refresh-value---'));
    assert(!harness.elements.outputText.value.includes('ya29.fake-access-token'));
    assert(harness.elements.outputText.value.includes('---https://sms.example.test?token=not-the-refresh-value'));
  });

  await test('complete seven-field output is idempotent', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//opaque-refresh-value---+8613800138000---https://sms.example.test?token=fake-sms-token';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//opaque-refresh-value---+8613800138000---https://sms.example.test?token=fake-sms-token',
    );
  });

  await test('refresh-only five-field output is idempotent', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//refresh-only-value';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//refresh-only-value',
    );
  });

  await test('refresh and phone six-field output is idempotent', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//refresh-phone-value---5550102468';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//refresh-phone-value---5550102468',
    );
  });

  await test('refresh and API six-field output is idempotent', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//refresh-api-value---https://sms.example.test/api?token=fake-api-only';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//refresh-api-value---https://sms.example.test/api?token=fake-api-only',
    );
  });

  await test('refresh-only output without a recovery email is idempotent', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com---OldPass123---fa01 fa02 fa03 fa04---1//refresh-no-recovery';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---fa01 fa02 fa03 fa04---1//refresh-no-recovery',
    );
  });

  await test('international phone formatting is normalized in the extended output', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 {"refresh_token":"1//opaque-refresh-value"} 反重力验证成功 +86 138 0013 8000|https://sms.example.test/api?token=fake-sms-token';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//opaque-refresh-value---+8613800138000---https://sms.example.test/api?token=fake-sms-token',
    );
  });

  await test('malformed JSON falls back to the original four-field output', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 {"refresh_token":"unterminated 反重力验证成功 5550102468|https://sms.example.test/api?token=fake-sms-token';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04',
    );
  });

  await test('refresh_token text without a JSON object keeps the original four-field output', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 refresh_token:"1//not-json" 反重力验证成功 5550102468|https://sms.example.test/api?token=fake-sms-token';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04',
    );
  });

  await test('JSON before the credential-success marker is not treated as supplemental data', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 {"refresh_token":"1//before-success-marker"} 账号凭证获取成功 反重力验证成功 5550102468|https://sms.example.test/api?token=fake-sms-token';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04',
    );
  });

  await test('a quoted refresh_token without a JSON object keeps the four-field output', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 refresh_token: "1//not-a-json-object" 反重力验证成功 5550102468|https://sms.example.test/api?token=fake-sms-token';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04',
    );
  });

  await test('only the top-level JSON refresh_token is exported', () => {
    const harness = createHarness();
    const json = JSON.stringify({
      nested: { refresh_token: '1//nested-refresh-value' },
      refresh_token: '1//top-level-refresh-value',
    });
    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 ' + json + ' 反重力验证成功 5550102468|https://sms.example.test/api?token=fake-sms-token';
    harness.context.handleInput();

    assert(harness.elements.outputText.value.includes('---1//top-level-refresh-value---'));
    assert(!harness.elements.outputText.value.includes('1//nested-refresh-value'));
  });

  await test('phone extraction tolerates a Chinese prompt between the phone and API URL', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 {"refresh_token":"1//phone-prompt-value"} 反重力验证成功：+86 138 0013 8000 骐证码已发送，请稍候 https://sms.example.test/api?token=fake-phone-prompt';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//phone-prompt-value---+8613800138000---https://sms.example.test/api?token=fake-phone-prompt',
    );
  });

  await test('verification extraction ignores URLs before the marker and keeps the first API URL after it', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 {"refresh_token":"1//multi-url-value","help":"https://metadata.example.test/help"} 日志链接 https://before.example.test/log 反重力验证成功 5550102468|https://sms.example.test/first?token=fake-first https://sms.example.test/second?token=fake-second';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//multi-url-value---5550102468---https://sms.example.test/first?token=fake-first',
    );
  });

  await test('JSON appends an available API URL when the phone is absent', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Latvia 订阅成功 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功 {"refresh_token":"1//missing-phone-value"} 反重力验证成功 验证码已发送 https://sms.example.test/api?token=fake-missing-phone';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//missing-phone-value---https://sms.example.test/api?token=fake-missing-phone',
    );
  });

  await test('verification phone and API before the credential JSON are still appended', () => {
    const harness = createHarness();
    const json = JSON.stringify({
      client_id: 'fake-client.apps.example.test',
      client_secret: 'fake-client-secret',
      token: 'ya29.fake-access-token',
      refresh_token: '1//verification-before-json',
      project_id: 'fake-project-id',
      expiry: '2026-06-28T04:48:23.000000+00:00',
    });

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|fa01 fa02 fa03 fa04|2024|Uruguay\t订阅成功\t2026-06-28 11:47:14\t反重力验证成功\t5550102468|https://sms.example.test?token=fake-api\t账号凭证获取成功\t' + json + '，';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//verification-before-json---5550102468---https://sms.example.test?token=fake-api',
    );
  });

  await test('verification before JSON works without a recovery email', () => {
    const harness = createHarness();
    const json = JSON.stringify({
      client_id: 'fake-client.apps.example.test',
      token: 'ya29.fake-access-token',
      refresh_token: '1//before-json-no-recovery',
      token_uri: 'https://oauth.example.test/token',
    });

    harness.elements.inputText.value = 'original@example.com|OldPass123|fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08\t订阅成功\t2026-06-28 11:47:14\t反重力验证成功\t5550102468|https://sms.example.test?token=fake-api\t账号凭证获取成功\t' + json + '，';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08---1//before-json-no-recovery---5550102468---https://sms.example.test?token=fake-api',
    );
  });

  await test('JSON token_uri is not used when verification before JSON has no API URL', () => {
    const harness = createHarness();
    const json = JSON.stringify({
      refresh_token: '1//before-json-without-api',
      token_uri: 'https://oauth.example.test/token',
    });

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|fa01 fa02 fa03 fa04|2024|Uruguay 反重力验证成功 5550102468 账号凭证获取成功 ' + json;
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//before-json-without-api---5550102468',
    );
  });

  await test('a URL before the verification marker is not used when JSON follows', () => {
    const harness = createHarness();
    const json = JSON.stringify({ refresh_token: '1//bounded-before-json' });

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|fa01 fa02 fa03 fa04|2024|Uruguay 日志 https://before.example.test/log 反重力验证成功 5550102468|https://sms.example.test?token=fake-api 账号凭证获取成功 ' + json;
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//bounded-before-json---5550102468---https://sms.example.test?token=fake-api',
    );
  });

  await test('verification text after JSON is preferred over an older marker before it', () => {
    const harness = createHarness();
    const json = JSON.stringify({ refresh_token: '1//prefer-after-json' });

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|fa01 fa02 fa03 fa04|2024|Uruguay 反重力验证成功 5550101111|https://old.example.test/api 账号凭证获取成功 ' + json + ' 反重力验证成功 5550102222|https://sms.example.test/new';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04---1//prefer-after-json---5550102222---https://sms.example.test/new',
    );
  });

  await test('2FA change receipt prefers the leading grouped 2FA over an SMS API token', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-08-04 02:51:00 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08 反重力验证成功 5550102468|https://sms.example.test?token=ExampleSmsApiToken12345 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08',
    );
  });

  await test('2FA change receipt ignores an SMS API URL when the changed 2FA is missing', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-08-04 02:51:00 2fa修改成功 original@example.com--OldPass123--https://sms.example.test?token=ExampleSmsApiToken12345';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('2FA change receipt does not treat an SMS API secret parameter as otpauth', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-08-04 02:51:00 2fa修改成功 original@example.com--OldPass123--https://sms.example.test?secret=ExampleSmsApiSecret12345';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('2FA change receipt still accepts a real otpauth URI', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-08-04 02:51:00 2fa修改成功 original@example.com--OldPass123--otpauth://totp/example?secret=ABCDEFGHIJKLMNOP234567';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---ABCDEFGHIJKLMNOP234567',
    );
  });

  await test('2FA change receipt supports a physical newline after the success marker', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-08-04 02:51:00 2fa修改成功\noriginal@example.com--OldPass123--fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08',
    );
  });

  await test('2FA change receipt supports a physical newline inside an eight-group 2FA', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-08-04 02:51:00 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04\nfa05 fa06 fa07 fa08 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08',
    );
  });

  await test('2FA change receipt recognizes equivalent success wording', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Germany 订阅成功 2026-08-04 02:51:00 2FA 更改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04',
    );
  });

  await test('2FA change receipt recognizes full-width success wording', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Germany 订阅成功 2026-08-04 02:51:00 ２ＦＡ 更换完毕 original@example.com--OldPass123--fa01 fa02 fa03 fa04 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04',
    );
  });

  await test('2FA change receipt supports a timestamp and success marker on the next line', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功\n02:51:00 2fa修改成功\noriginal@example.com--OldPass123--fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08',
    );
  });

  await test('two complete 2FA change receipts remain separate records', () => {
    const harness = createHarness();

    harness.elements.inputText.value = [
      'first@example.com|FirstPass|first-helper@example.net|old1 old2 old3 old4|2024|Germany 订阅成功 02:51:00 2fa修改成功 first@example.com--FirstPass--fa01 fa02 fa03 fa04 账号凭证获取成功',
      'second@example.com|SecondPass|second-helper@example.net|old1 old2 old3 old4|2024|Germany 订阅成功 02:52:00 2fa修改成功 second@example.com--SecondPass--fb01 fb02 fb03 fb04 账号凭证获取成功',
    ].join('\n');
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      [
        'first@example.com---FirstPass---first-helper@example.net---fa01 fa02 fa03 fa04',
        'second@example.com---SecondPass---second-helper@example.net---fb01 fb02 fb03 fb04',
      ].join('\n'),
    );
  });

  await test('grouped 2FA does not absorb trailing four-character metadata', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-08-04 02:51:00 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08 Hong Kong 2026 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08',
    );
  });

  await test('four-group 2FA does not absorb trailing four-character metadata', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4|2024|Germany 订阅成功 2026-08-04 02:51:00 2fa修改成功 original@example.com--OldPass123--fa01 fa02 fa03 fa04 Hong Kong 2026 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---fa01 fa02 fa03 fa04',
    );
  });

  await test('2FA change receipt is skipped when the changed 2FA is missing', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-07-27 06:21:01 2fa修改成功 original@example.com--OldPass123--2024 Germany 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('2FA change receipt does not mistake a leading JSON token for the changed 2FA', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-07-27 06:21:01 2fa修改成功 original@example.com--OldPass123--{"token":"abcdefghijklmnopqrstuvwxyz234567"}';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('2FA change receipt does not mistake a leading token label for the changed 2FA', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-07-27 06:21:01 2fa修改成功 original@example.com--OldPass123--token: abcdefghijklmnopqrstuvwxyz234567';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('2FA change receipt keeps a valid grouped 2FA that starts with json', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-07-27 06:21:01 2fa修改成功 original@example.com--OldPass123--json abcd efgh ijkl mnop 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---json abcd efgh ijkl mnop',
    );
  });

  await test('2FA change receipt is skipped when the repeated account does not match', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-07-27 06:21:01 2fa修改成功 another@example.com--OldPass123--new1 new2 new3 new4 new5 new6 new7 new8 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('2FA change receipt is skipped when the repeated password does not match', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|helper@example.net|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-07-27 06:21:01 2fa修改成功 original@example.com--AnotherPass--new1 new2 new3 new4 new5 new6 new7 new8 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('2FA change receipt supports triple-dash fields and marker spacing', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com---OldPass123---helper@example.net---old1 old2 old3 old4 old5 old6 old7 old8 2026-07-27 06:21:01 2FA 修改成功：original@example.com---OldPass123---new1 new2 new3 new4 new5 new6 new7 new8 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---helper@example.net---new1 new2 new3 new4 new5 new6 new7 new8',
    );
  });

  await test('2FA change receipt keeps working without a recovery email', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'original@example.com|OldPass123|old1 old2 old3 old4 old5 old6 old7 old8|2024|Germany 订阅成功 2026-07-27 06:21:01 2fa修改成功 original@example.com--OldPass123--new1 new2 new3 new4 new5 new6 new7 new8 账号凭证获取成功';
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'original@example.com---OldPass123---new1 new2 new3 new4 new5 new6 new7 new8',
    );
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

  await test('already converted rows do not shift recovery into a missing password', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'buyer@gmail.com------helper@gmail.com---abcd efgh ijkl mnop';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('pipe rows with an explicit missing password stay skipped', () => {
    const harness = createHarness();

    harness.elements.inputText.value = 'buyer@gmail.com||helper@gmail.com|ABCDEFGHIJKLMNOP234567';
    harness.context.handleInput();

    assert.strictEqual(harness.elements.outputText.value, '');
    assert.strictEqual(harness.elements.outputPanel.style.display, 'none');
  });

  await test('credential matrix keeps fields isolated across receipt variants', () => {
    const passwords = ['Pass!42', 'Pass.)', 'mailpass@example.net', 'Pass,;:#'];
    const tails = [
      '反重力验证成功 5550102468|https://sms.example.test?token=ExampleSmsApiToken12345',
      '账号凭证获取成功 {"client_id":"example-client","token":"example-token"}',
      'Hong Kong 2026 账号凭证获取成功',
    ];

    for (let index = 0; index < 24; index++) {
      const harness = createHarness();
      const account = `matrix${index}@example.com`;
      const password = passwords[index % passwords.length];
      const recovery = `helper${index}@example.net`;
      const separator = index % 2 ? '--' : '---';
      const marker = index % 2 ? '2fa修改成功' : '2FA 修改成功';
      const groupCount = index % 3 ? 8 : 4;
      const prefix = String.fromCharCode(97 + (index % 20));
      const groups = Array.from(
        { length: groupCount },
        (_, groupIndex) => `${prefix}${String(groupIndex).padStart(3, '0')}`,
      );
      const changedTwoFactor = groups.join(' ');
      const markerSeparator = index % 4 === 0 ? '\n' : ' ';

      harness.elements.inputText.value = `${account}|${password}|${recovery}|old1 old2 old3 old4|2024|Germany 订阅成功 2026-08-04 02:51:00 ${marker}${markerSeparator}${account}${separator}${password}${separator}${changedTwoFactor} ${tails[index % tails.length]}`;
      harness.context.handleInput();

      assert.strictEqual(
        harness.elements.outputText.value,
        `${account}---${password}---${recovery}---${changedTwoFactor}`,
        `matrix case ${index}`,
      );
    }
  });

  await test('500-case generated receipt stress matrix preserves every field', () => {
    const harness = createHarness();
    const delimiters = ['|', '\t', ',', ';', '，', '；'];
    const markers = ['2fa修改成功', '2FA 修改成功', '2FA 更改成功', '2fa更换完成', '２ＦＡ 更换完毕'];
    const tails = [
      '反重力验证成功 5550102468|https://sms.example.test?token=ExampleSmsApiToken12345',
      '账号凭证获取成功 {"client_id":"example-client","token":"example-token"}',
      'Hong Kong 2026 账号凭证获取成功',
      '2026-08-04 02:51:00 账号凭证获取成功',
    ];

    for (let index = 0; index < 500; index++) {
      const delimiter = delimiters[index % delimiters.length];
      const receiptDelimiter = index % 2 ? '--' : '---';
      const marker = markers[index % markers.length];
      const account = index % 9 === 0
        ? `plainuser${index}`
        : (index % 7 === 0 ? `user--${index}@example.com` : `user${index}@example.com`);
      const password = index % 11 === 0
        ? `mailpass${index}@example.net`
        : (receiptDelimiter === '---' ? `Pass--${index}.)` : `Pass${index}.)`);
      const recovery = `helper${index}@example.net`;
      const groupCount = index % 3 ? 8 : 4;
      const prefix = String.fromCharCode(97 + (index % 20));
      const groups = Array.from(
        { length: groupCount },
        (_, groupIndex) => `${prefix}${String((index + groupIndex) % 1000).padStart(3, '0')}`,
      );
      const oldTwoFactor = 'old1 old2 old3 old4';
      const original = [account, password, recovery, oldTwoFactor, '2024', 'Germany 订阅成功']
        .join(delimiter);
      const receiptHead = `${account}${receiptDelimiter}${password}${receiptDelimiter}`;
      const tail = tails[index % tails.length];
      const layout = index % 4;
      let input;

      if (layout === 0) {
        input = `${original} 02:51:00 ${marker} ${receiptHead}${groups.join(' ')} ${tail}`;
      } else if (layout === 1) {
        input = `${original} 02:51:00 ${marker}\n${receiptHead}${groups.join(' ')} ${tail}`;
      } else if (layout === 2) {
        input = `${original}\n02:51:00 ${marker}\n${receiptHead}${groups.join(' ')} ${tail}`;
      } else if (groupCount === 8) {
        input = `${original} 02:51:00 ${marker} ${receiptHead}${groups.slice(0, 4).join(' ')}\n${groups.slice(4).join(' ')} ${tail}`;
      } else {
        input = `${original} 02:51:00 ${marker} ${receiptHead}${groups.join(' ')} ${tail}`;
      }

      harness.elements.inputText.value = input;
      harness.context.handleInput();

      assert.strictEqual(
        harness.elements.outputText.value,
        `${account}---${password}---${recovery}---${groups.join(' ')}`,
        `generated case ${index}`,
      );
    }
  });

  await test('supported converted output is idempotent', () => {
    const firstHarness = createHarness();
    const secondHarness = createHarness();

    firstHarness.elements.inputText.value = 'user--tag@gmail.com|Pass--word.)|recovery@gmail.com|fa01 fa02 fa03 fa04 fa05 fa06 fa07 fa08';
    firstHarness.context.handleInput();
    secondHarness.elements.inputText.value = firstHarness.elements.outputText.value;
    secondHarness.context.handleInput();

    assert.strictEqual(
      secondHarness.elements.outputText.value,
      firstHarness.elements.outputText.value,
    );
  });

  await test('1000-row batch conversion keeps every row', () => {
    const harness = createHarness();
    const rows = Array.from(
      { length: 1000 },
      (_, index) => `bulk${index}@example.com|Pass${index}.)|helper${index}@example.net|ABCDEFGHIJKLMNOP234567`,
    );

    harness.elements.inputText.value = rows.join('\n');
    const startedAt = Date.now();
    harness.context.handleInput();
    const durationMs = Date.now() - startedAt;
    const outputRows = harness.elements.outputText.value.split('\n');

    assert(durationMs < 3000, `1000-row conversion took ${durationMs}ms`);
    assert.strictEqual(outputRows.length, 1000);
    assert.strictEqual(
      outputRows[999],
      'bulk999@example.com---Pass999.)---helper999@example.net---ABCDEFGHIJKLMNOP234567',
    );
  });

  await test('very long trailing log cannot replace the leading 2FA', () => {
    const harness = createHarness();
    const longLog = ` ${'x'.repeat(100000)}?token=ExampleSmsApiToken12345`;

    harness.elements.inputText.value = `user@gmail.com--Pass123--fa01 fa02 fa03 fa04${longLog}`;
    harness.context.handleInput();

    assert.strictEqual(
      harness.elements.outputText.value,
      'user@gmail.com---Pass123---fa01 fa02 fa03 fa04',
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
