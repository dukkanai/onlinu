// Version the URI when the component contract changes: hosts cache UI resources.
export const CORE_MENU_UI_RESOURCE_URI = 'ui://onlinu/core-menu-v1.html';

// This function is serialized into a self-contained MCP Apps resource. Keep all
// browser dependencies inside it; no direct HTTP requests or credentials belong
// in this view. Business prices come exclusively from quote_cart.
export function startCoreMenuUI() {
  const byId = id => document.getElementById(id);
  const menuSlot = byId('menu');
  const quoteSlot = byId('quote');
  const status = byId('status');
  const reset = byId('reset');
  const refresh = byId('refresh');
  const retry = byId('retry');
  const money = value => `${(value / 100).toFixed(2)} ر.س`;
  const element = (tag, value, className) => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (className) node.className = className;
    return node;
  };
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const validMoney = value => Number.isSafeInteger(value) && value >= 0 && value <= 40_000_000_000;
  const validText = value => typeof value === 'string' && value.length <= 4096;
  let menu = null;
  let inputTenant = null;
  let viewVersion = 0;
  let cartVersion = 0;
  let quoteRequest = 0;
  let debounce;
  let closed = false;
  let ready = false;
  let transport = 'connecting';
  let initialResultReceived = false;
  let openingCancelled = false;
  let refreshing = false;
  let nextId = 0;
  const pending = new Map();
  const selections = new Map();
  let sizeObserver;

  const problemMessages = {
    authentication_required: 'أعد ربط Onlinu في ChatGPT ثم أعد المحاولة.',
    authorization_required: 'الربط الحالي لا يسمح بهذه المعاينة. راجع صلاحيات Onlinu.',
    out_of_stock: 'الكمية المطلوبة غير متاحة. قلّلها أو حدّث المنيو.',
    item_unavailable: 'أحد الأصناف لم يعد متاحًا. حدّث المنيو.',
    invalid_option: 'إحدى الإضافات لم تعد متاحة. حدّث المنيو.',
    store_closed: 'المطعم لا يستقبل الطلبات الآن. يمكنك تحديث المنيو لاحقًا.',
    mode_unavailable: 'معاينة الاستلام غير متاحة لهذا المطعم الآن.',
    rate_limited: 'طلبات كثيرة خلال وقت قصير. انتظر قليلًا ثم أعد المحاولة.',
    bridge_unavailable: 'تعذّر الاتصال بواجهة ChatGPT. يمكنك استخدام أدوات Onlinu في المحادثة.',
    timeout: 'تأخر الرد. أعد المحاولة للحصول على سعر حديث.',
  };
  const messageFor = error => problemMessages[error?.code] ?? 'تعذّر تحديث السعر. أعد المحاولة أو حدّث المنيو.';
  const failure = code => Object.assign(new Error(code), { code });
  const canChoose = () => ready && !closed && !refreshing && menu?.settings.pickupEnabled && menu.settings.acceptingOrders;
  const cart = () => [...selections].filter(([, value]) => value.quantity > 0)
    .map(([itemId, value]) => ({ itemId, quantity: value.quantity, optionIds: [...value.optionIds].sort() }));

  function post(message) {
    // MCP Apps uses an opaque-origin sandbox. Verify source on receipt; a fixed
    // target origin cannot be assumed here. Never include secrets in messages.
    window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  }
  function request(method, params, timeout = 15000) {
    if (closed) return Promise.reject(failure('bridge_unavailable'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(failure('timeout')); }, timeout);
      pending.set(id, { resolve, reject, timer });
      post({ id, method, params });
    });
  }
  async function call(name, args) {
    // A component bug must not turn the price preview into checkout or a write.
    if (!ready || closed || !['get_restaurant_menu', 'quote_cart'].includes(name)) throw failure('bridge_unavailable');
    let result;
    if (transport === 'mcp') result = await request('tools/call', { name, arguments: args });
    else {
      let timer;
      try {
        result = await Promise.race([
          window.openai.callTool(name, args),
          new Promise((_, reject) => { timer = setTimeout(() => reject(failure('timeout')), 15000); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    if (result?.isError) {
      const code = result.content?.find(row => row.type === 'text')?.text;
      throw failure(Object.hasOwn(problemMessages, code) ? code : 'tool_error');
    }
    // Legacy hosts may hand the structured payload back directly.
    return result?.structuredContent ?? (transport === 'legacy' ? result : undefined);
  }

  function syncControls() {
    reset.disabled = !menu || refreshing || closed || !cart().length;
    refresh.disabled = !ready || !(menu || inputTenant) || refreshing || closed;
    const selectedCount = cart().length;
    for (const [id, value] of selections) {
      value.minus.disabled = !canChoose() || value.quantity === 0;
      value.plus.disabled = !canChoose() || !value.available || value.quantity >= 99 || (value.quantity === 0 && selectedCount >= 50);
      value.count.textContent = String(value.quantity);
      for (const [optionId, checkbox] of value.checkboxes) {
        checkbox.disabled = !canChoose() || !value.available || !value.quantity || !checkbox.optionAvailable || (!checkbox.checked && value.optionIds.size >= 30);
        checkbox.checked = value.optionIds.has(optionId);
      }
    }
  }
  function invalidateQuote(text = 'السلة فارغة. اختر صنفًا للبدء.') {
    ++cartVersion;
    clearTimeout(debounce);
    retry.hidden = true;
    quoteSlot.replaceChildren(element('p', text, 'muted'));
    quoteSlot.removeAttribute('data-total-minor');
    quoteSlot.setAttribute('aria-busy', 'false');
  }
  function changed() {
    const items = cart();
    invalidateQuote(items.length ? 'جارٍ تحديث السعر من المطعم…' : undefined);
    status.textContent = '';
    syncControls();
    if (items.length) debounce = setTimeout(() => void quoteCart(), 200);
  }
  function validMenu(data) {
    return data && validId(data.tenantId) && data.settings?.currency === 'SAR'
      && validText(data.settings.name) && validText(data.settings.description)
      && ['demo', 'pickupEnabled', 'acceptingOrders'].every(key => typeof data.settings[key] === 'boolean')
      && Array.isArray(data.categories) && data.categories.length <= 1000
      && data.categories.every(row => validId(row.id) && validText(row.name))
      && Array.isArray(data.items) && data.items.length <= 5000
      && new Set(data.items.map(row => row.id)).size === data.items.length
      && data.items.every(row => validId(row.id) && validId(row.categoryId) && validText(row.name) && validText(row.description)
        && validMoney(row.priceMinor) && typeof row.available === 'boolean'
        && (row.options == null || (Array.isArray(row.options) && row.options.length <= 100
          && new Set(row.options.map(option => option.id)).size === row.options.length
          && row.options.every(option => validId(option.id) && validText(option.name) && validMoney(option.priceMinor) && typeof option.available === 'boolean'))));
  }
  function acceptMenu(data) {
    if (!validMenu(data) || (inputTenant && data.tenantId !== inputTenant)) throw failure('invalid_response');
    ++viewVersion;
    menu = data;
    initialResultReceived = true;
    selections.clear();
    invalidateQuote();
    menuSlot.replaceChildren();
    byId('title').textContent = menu.settings.name;
    byId('description').textContent = menu.settings.description;
    byId('demo').hidden = !menu.settings.demo;
    byId('availability').textContent = !menu.settings.pickupEnabled ? problemMessages.mode_unavailable
      : !menu.settings.acceptingOrders ? problemMessages.store_closed : '';
    const categories = new Map(menu.categories.map(row => [row.id, row.name]));
    const ordered = [...menu.items].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    const categoryIds = [...new Set([...menu.categories].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)).map(row => row.id).concat(ordered.map(row => row.categoryId)))];
    for (const categoryId of categoryIds) {
      const items = ordered.filter(row => row.categoryId === categoryId);
      if (!items.length) continue;
      const section = element('section');
      section.append(element('h2', categories.get(categoryId) ?? 'أصناف أخرى', 'category'));
      for (const item of items) {
        const card = element('article', undefined, 'item');
        card.dataset.itemId = item.id;
        const heading = element('div', undefined, 'row');
        heading.append(element('h3', item.name), element('span', money(item.priceMinor), 'price'));
        card.append(heading);
        if (item.description) card.append(element('p', item.description, 'muted'));
        if (!item.available) card.append(element('p', 'غير متاح حاليًا', 'muted'));
        const controls = element('div', undefined, 'quantity');
        const minus = element('button', '−'); minus.type = 'button'; minus.setAttribute('aria-label', `تقليل ${item.name}`);
        const count = element('output', '0'); count.setAttribute('aria-label', `كمية ${item.name}`);
        const plus = element('button', '+'); plus.type = 'button'; plus.setAttribute('aria-label', `زيادة ${item.name}`);
        const value = { quantity: 0, optionIds: new Set(), checkboxes: new Map(), minus, plus, count, available: item.available };
        selections.set(item.id, value);
        minus.onclick = () => { if (minus.disabled) return; value.quantity--; changed(); };
        plus.onclick = () => { if (plus.disabled) return; value.quantity++; changed(); };
        controls.append(minus, count, plus);
        card.append(controls);
        if (item.options?.length) {
          const options = element('fieldset');
          options.append(element('legend', 'الإضافات لكل حبة'));
          for (const option of item.options) {
            const label = element('label', undefined, 'option');
            const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
            checkbox.dataset.optionId = option.id; checkbox.optionAvailable = option.available;
            checkbox.onchange = () => {
              if (!canChoose() || checkbox.disabled) { checkbox.checked = value.optionIds.has(option.id); return; }
              if (checkbox.checked) value.optionIds.add(option.id); else value.optionIds.delete(option.id);
              changed();
            };
            value.checkboxes.set(option.id, checkbox);
            label.append(checkbox, element('span', `${option.name} · ${money(option.priceMinor)}${option.available ? '' : ' · غير متاح'}`));
            options.append(label);
          }
          card.append(options);
        }
        section.append(card);
      }
      menuSlot.append(section);
    }
    if (!menu.items.length) menuSlot.append(element('p', 'لا توجد أصناف منشورة حاليًا.', 'muted'));
    syncControls();
  }

  function validQuote(data, snapshot) {
    if (!data || data.tenantId !== snapshot.tenantId || data.currency !== 'SAR' || typeof data.demo !== 'boolean'
      || !['totalMinor', 'subtotalMinor', 'deliveryFeeMinor'].every(key => validMoney(data[key]))
      || !Array.isArray(data.paymentMethods) || !data.tax || typeof data.tax.enabled !== 'boolean'
      || !['netMinor', 'taxMinor', 'grossMinor'].every(key => validMoney(data.tax[key]))
      || !Array.isArray(data.items) || data.items.length !== snapshot.items.length) return false;
    const seen = new Set();
    return data.items.every(line => {
      const selected = snapshot.items.find(row => row.itemId === line.itemId);
      if (!selected || seen.has(line.itemId) || line.quantity !== selected.quantity || !validText(line.name)
        || !validMoney(line.unitPriceMinor) || !validMoney(line.totalMinor) || (line.options != null && !Array.isArray(line.options))) return false;
      seen.add(line.itemId);
      const options = line.options ?? [];
      return options.every(option => validId(option.id) && validText(option.name) && validMoney(option.priceMinor))
        && JSON.stringify(options.map(option => option.id).sort()) === JSON.stringify(selected.optionIds);
    });
  }
  function renderQuote(data) {
    quoteSlot.replaceChildren();
    quoteSlot.dataset.totalMinor = String(data.totalMinor);
    const list = element('ul', undefined, 'quote-lines');
    for (const line of data.items) {
      const item = element('li');
      item.append(element('span', `${line.quantity} × ${line.name}`), element('span', money(line.totalMinor)));
      list.append(item);
      if (line.options?.length) list.append(element('li', line.options.map(option => option.name).join('، '), 'muted extras'));
    }
    quoteSlot.append(list);
    for (const [label, amount] of [['قيمة الأصناف', data.subtotalMinor], ['رسوم الخدمة / التوصيل', data.deliveryFeeMinor]]) {
      const row = element('div', undefined, 'row'); row.append(element('span', label), element('span', money(amount))); quoteSlot.append(row);
    }
    if (data.tax.enabled) {
      const row = element('div', undefined, 'row muted');
      row.append(element('span', 'الضريبة المشمولة'), element('span', money(data.tax.taxMinor))); quoteSlot.append(row);
    }
    const total = element('div', undefined, 'row total');
    total.append(element('strong', 'الإجمالي من المطعم'), element('strong', money(data.totalMinor)));
    quoteSlot.append(total, element('p', data.demo ? 'سعر تجريبي من الخادم.' : 'السعر الحالي من الخادم.', 'muted'));
    if (!data.paymentMethods.length) quoteSlot.append(element('p', 'السعر متاح للمعاينة؛ لا توجد وسيلة دفع متاحة حاليًا.', 'notice'));
  }
  async function quoteCart() {
    clearTimeout(debounce);
    if (!canChoose()) return;
    const snapshot = { tenantId: menu.tenantId, mode: 'pickup', items: cart() };
    if (!snapshot.items.length) return;
    const view = viewVersion, revision = cartVersion, sequence = ++quoteRequest;
    const current = () => !closed && view === viewVersion && revision === cartVersion && sequence === quoteRequest;
    retry.hidden = true;
    status.textContent = '';
    quoteSlot.setAttribute('aria-busy', 'true');
    try {
      const result = await call('quote_cart', snapshot);
      if (!current()) return;
      if (!validQuote(result, snapshot)) throw failure('invalid_response');
      renderQuote(result);
    } catch (error) {
      if (!current()) return;
      quoteSlot.replaceChildren(element('p', 'لا يوجد سعر حديث لهذه السلة.', 'muted'));
      quoteSlot.removeAttribute('data-total-minor');
      status.textContent = messageFor(error);
      retry.hidden = false;
    } finally { if (current()) quoteSlot.setAttribute('aria-busy', 'false'); }
  }
  reset.onclick = () => {
    if (reset.disabled) return;
    for (const value of selections.values()) { value.quantity = 0; value.optionIds.clear(); }
    changed();
  };
  retry.onclick = () => { if (!retry.hidden) { invalidateQuote('جارٍ تحديث السعر من المطعم…'); void quoteCart(); } };
  refresh.onclick = async () => {
    if (refresh.disabled) return;
    const tenantId = menu?.tenantId ?? inputTenant;
    const version = ++viewVersion;
    refreshing = true;
    invalidateQuote('جارٍ تحديث المنيو…');
    status.textContent = '';
    syncControls();
    try {
      const result = await call('get_restaurant_menu', { tenantId });
      if (closed || version !== viewVersion) return;
      if (result?.tenantId !== tenantId) throw failure('invalid_response');
      acceptMenu(result);
      status.textContent = 'تم تحديث المنيو وتفريغ السلة.';
    } catch (error) {
      if (!closed && version === viewVersion) {
        status.textContent = messageFor(error);
        quoteSlot.replaceChildren(element('p', 'لم يكتمل تحديث المنيو. أعد المحاولة.', 'muted'));
      }
    } finally { if (!closed) { refreshing = false; syncControls(); } }
  };

  function initialResult(result) {
    // An uncorrelated quote notification cannot safely identify the current cart.
    // Only the opening menu result is consumed here. Local tool replies use IDs.
    if (closed || initialResultReceived || openingCancelled || refreshing) return;
    try {
      if (result?.isError) {
        const code = result.content?.find(row => row.type === 'text')?.text;
        throw failure(Object.hasOwn(problemMessages, code) ? code : 'tool_error');
      }
      acceptMenu(result?.structuredContent);
      status.textContent = '';
    } catch (error) {
      menuSlot.replaceChildren(element('p', 'لم يكتمل تحميل المنيو. حدّث المنيو أو اطلب عرضه مجددًا في المحادثة.', 'muted'));
      status.textContent = messageFor(error);
      syncControls();
    }
  }
  function theme(context) {
    if (['light', 'dark'].includes(context?.theme)) document.documentElement.dataset.theme = context.theme;
  }
  function dispose() {
    closed = true; ++viewVersion; clearTimeout(debounce); sizeObserver?.disconnect();
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(failure('bridge_unavailable')); }
    pending.clear(); syncControls();
    window.removeEventListener('message', onMessage);
    window.removeEventListener('openai:set_globals', onGlobals);
  }
  function onMessage(event) {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0' || closed) return;
    const msg = event.data;
    if (msg.id !== undefined && !msg.method && pending.has(msg.id)) {
      const response = pending.get(msg.id); pending.delete(msg.id); clearTimeout(response.timer);
      if (msg.error) response.reject(failure('bridge_unavailable')); else response.resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/resource-teardown' && msg.id !== undefined) { post({ id: msg.id, result: {} }); dispose(); return; }
    if (msg.method === 'ping' && msg.id !== undefined) { post({ id: msg.id, result: {} }); return; }
    if (transport === 'legacy') return;
    if (msg.method === 'ui/notifications/tool-input' && !initialResultReceived && !openingCancelled) {
      const tenantId = msg.params?.arguments?.tenantId;
      if (validId(tenantId)) { inputTenant = tenantId; syncControls(); }
    }
    if (msg.method === 'ui/notifications/tool-result') initialResult(msg.params);
    if (msg.method === 'ui/notifications/host-context-changed') theme(msg.params);
    if (msg.method === 'ui/notifications/tool-cancelled' && !initialResultReceived) {
      openingCancelled = true;
      menuSlot.replaceChildren(element('p', 'أُلغيت قراءة المنيو.', 'muted'));
      status.textContent = 'حدّث المنيو أو اطلب عرضه مجددًا في المحادثة.';
    }
  }
  function onGlobals(event) {
    if (transport !== 'legacy') return;
    initialResult({ structuredContent: event.detail?.globals?.toolOutput });
  }
  window.addEventListener('message', onMessage);
  window.addEventListener('openai:set_globals', onGlobals);
  window.addEventListener('pagehide', dispose, { once: true });

  async function connect() {
    try {
      if (window.parent === window) throw failure('bridge_unavailable');
      const result = await request('ui/initialize', {
        appInfo: { name: 'Onlinu menu preview', version: '1.0.0' },
        appCapabilities: { availableDisplayModes: ['inline'] }, protocolVersion: '2026-01-26',
      }, 3000);
      if (!result?.hostCapabilities?.serverTools || result.protocolVersion !== '2026-01-26') throw failure('bridge_unavailable');
      if (closed) return;
      transport = 'mcp'; ready = true; theme(result.hostContext);
      post({ method: 'ui/notifications/initialized', params: {} });
      if (typeof ResizeObserver === 'function') {
        sizeObserver = new ResizeObserver(() => {
          if (!closed) post({ method: 'ui/notifications/size-changed', params: { height: document.documentElement.scrollHeight } });
        });
        sizeObserver.observe(document.body);
      }
    } catch {
      if (closed) return;
      if (typeof window.openai?.callTool === 'function') {
        transport = 'legacy'; ready = true;
        const tenantId = window.openai.toolInput?.tenantId;
        if (validId(tenantId)) inputTenant = tenantId;
        initialResult({ structuredContent: window.openai.toolOutput });
      } else { status.textContent = problemMessages.bridge_unavailable; }
    }
    syncControls();
  }
  void connect();
}

export const CORE_MENU_UI_HTML = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Onlinu · معاينة المنيو والسلة</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--text:#172a23;--muted:#5b6b63;--line:#dce5df;--soft:#f4f7f4;--accent:#165b43;--button-text:#fff;--warning:#76500c}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#151b18;--text:#f0f5f1;--muted:#b3c1b8;--line:#39463e;--soft:#212c25;--accent:#90d7b5;--button-text:#11281d;--warning:#f3cc83}}
:root[data-theme=dark]{--bg:#151b18;--text:#f0f5f1;--muted:#b3c1b8;--line:#39463e;--soft:#212c25;--accent:#90d7b5;--button-text:#11281d;--warning:#f3cc83}
*{box-sizing:border-box}body{margin:0;padding:20px;background:var(--bg);color:var(--text);font:15px/1.65 system-ui,sans-serif}h1{font-size:23px;line-height:1.35;margin:5px 0}h2{font-size:18px;margin:0 0 12px}h3{font-size:16px;line-height:1.5;margin:0}p{margin:6px 0}.brand{font-size:12px;font-weight:700;letter-spacing:.1em;color:var(--accent)}.muted{color:var(--muted);font-size:13px}.badge{display:inline-block;background:var(--soft);border:1px solid var(--line);border-radius:20px;padding:2px 10px;margin-top:6px;font-size:12px}.layout{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(230px,.8fr);gap:20px;margin-top:20px}.category{padding-top:4px}.item{border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:12px;overflow-wrap:anywhere}.row{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.price{font-size:13px;white-space:nowrap;color:var(--muted)}.quantity{display:flex;align-items:center;gap:12px;justify-content:flex-end;margin-top:10px}.quantity output{min-width:24px;text-align:center;font-variant-numeric:tabular-nums}.quantity button{width:36px;height:36px;padding:0;font-size:20px}button{border:1px solid var(--line);border-radius:9px;background:var(--soft);color:var(--text);padding:7px 12px;font:inherit;cursor:pointer}button:hover:not(:disabled){border-color:var(--accent)}button:disabled{opacity:.4;cursor:default}button:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:3px}fieldset{border:0;border-top:1px solid var(--line);padding:8px 0 0;margin:10px 0 0}legend{font-size:12px;color:var(--muted);padding:0 5px}.option{display:flex;gap:8px;align-items:center;font-size:13px;padding:4px 0}.option input{width:17px;height:17px;accent-color:var(--accent)}.cart{background:var(--soft);border-radius:16px;padding:16px;align-self:start;position:sticky;top:12px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.quote-lines{list-style:none;padding:0;margin:8px 0 15px}.quote-lines li{display:flex;justify-content:space-between;gap:12px;padding:4px 0}.quote-lines .extras{padding-top:0}.total{margin-top:12px;padding-top:12px;border-top:1px solid var(--line);font-size:18px}.notice,#status,#availability{color:var(--warning);font-size:13px}.notice{margin-top:10px}#status:empty,#availability:empty{display:none}[hidden]{display:none!important}#retry{background:var(--accent);color:var(--button-text);margin-top:10px}footer{margin-top:18px;border-top:1px solid var(--line);padding-top:12px}.loading{padding:24px 0}@media(max-width:600px){body{padding:14px}.layout{grid-template-columns:minmax(0,1fr);gap:12px}.cart{position:static}.row{gap:8px}}
</style></head><body>
<header><span class="brand">ONLINU</span><h1 id="title">منيو المطعم</h1><p id="description" class="muted">معاينة أسعار الاستلام من المطعم</p><span id="demo" class="badge" hidden>وضع تجريبي</span><p id="availability"></p></header>
<p id="status" role="status" aria-live="polite"></p>
<div class="layout"><main id="menu"><p class="muted loading">جارٍ استلام المنيو من ChatGPT…</p></main>
<aside class="cart" aria-label="معاينة السلة"><h2>سلتك · استلام من المطعم</h2><div id="quote" aria-live="polite" aria-busy="false"><p class="muted">السلة فارغة. اختر صنفًا للبدء.</p></div><button id="retry" type="button" hidden>إعادة حساب السعر</button><div class="actions"><button id="reset" type="button" disabled>تفريغ السلة</button><button id="refresh" type="button" disabled>تحديث المنيو</button></div></aside></div>
<footer class="muted">معاينة فقط. الأسعار من المطعم وقد تتغير؛ لا يُنشأ طلب ولا يُحجز مخزون ولا يتم دفع. تحديث المنيو يفرّغ السلة.</footer>
<script>(${startCoreMenuUI.toString()})();</script></body></html>`;
