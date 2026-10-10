// Test host only. It exercises the MCP Apps iframe protocol, but is not evidence
// that ChatGPT rendered a resource. callTool can route to a real local MCP server.
export async function openCoreMenuHarness({ browser, html, initialResult, initialTenant = initialResult.structuredContent?.tenantId, cancelOpening = false, callTool, legacy = false, hasTouch = false, viewport = { width: 980, height: 1000 } }) {
  const context = await browser.newContext({ viewport, hasTouch, locale: 'ar-SA' });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [], requests = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  await page.exposeFunction('__callTool', async (name, args) => {
    calls.push({ name, args });
    return callTool(name, args);
  });
  if (legacy) {
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(({ initialResult, initialTenant }) => {
      window.openai = {
        toolInput: { tenantId: initialTenant },
        toolOutput: initialResult.structuredContent,
        callTool: window.__callTool,
      };
    }, { initialResult, initialTenant });
    await page.setContent(html);
  } else {
    await page.setContent('<!doctype html><html><body style="margin:0"><iframe title="Onlinu test" sandbox="allow-scripts" style="width:100%;height:950px;border:0"></iframe></body></html>');
    await page.evaluate(({ html, initialResult, initialTenant, cancelOpening }) => {
      const iframe = document.querySelector('iframe');
      const send = message => iframe.contentWindow.postMessage({ jsonrpc: '2.0', ...message }, '*');
      window.harness = { initialized: false, events: [], toolReplies: [], send };
      window.addEventListener('message', async event => {
        if (event.source !== iframe.contentWindow || event.data?.jsonrpc !== '2.0') return;
        const msg = event.data;
        window.harness.events.push(msg);
        if (msg.method === 'ui/initialize') {
          send({ id: msg.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'isolated-test-host', version: '1' }, hostCapabilities: { serverTools: {} }, hostContext: { theme: 'light' } } });
        } else if (msg.method === 'ui/notifications/initialized') {
          window.harness.initialized = true;
          send({ method: 'ui/notifications/tool-input', params: { arguments: { tenantId: initialTenant } } });
          if (cancelOpening) send({ method: 'ui/notifications/tool-cancelled', params: { reason: 'test cancellation' } });
          send({ method: 'ui/notifications/tool-result', params: initialResult });
        } else if (msg.method === 'tools/call') {
          try { send({ id: msg.id, result: await window.__callTool(msg.params.name, msg.params.arguments) }); }
          catch { send({ id: msg.id, error: { code: -32603, message: 'fixture failure' } }); }
          window.harness.toolReplies.push(msg.id);
        }
      });
      iframe.srcdoc = html;
    }, { html, initialResult, initialTenant, cancelOpening });
    await page.waitForFunction(() => window.harness.initialized);
  }
  const frame = legacy ? page.mainFrame() : page.frames().find(frame => frame.parentFrame());
  if (!cancelOpening && initialResult.structuredContent?.settings?.name) await frame.locator('#title').filter({ hasText: initialResult.structuredContent.settings.name }).waitFor();
  else await frame.locator('#status').filter({ hasText: /\S/ }).waitFor();
  return { context, page, frame, errors, requests, calls, close: () => context.close() };
}
