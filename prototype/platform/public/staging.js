/* Protected synthetic staging. OIDC and session cookies belong to the server.
 * No bearer, password, fixture identity selector or browser token storage. */
(() => {
  let session = null;
  let sessionGeneration = 0;
  let viewGeneration = 0;
  let loggingOut = false;
  const operations = new WeakMap();
  const content = document.querySelector('#content');
  const message = document.querySelector('#message');
  const sessionLabel = document.querySelector('#session');
  const logout = document.querySelector('#logout');
  const home = document.querySelector('#home');
  const money = value => `${(value / 100).toFixed(2)} ر.س`;
  const text = (tag, value, className = '') => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node; };
  const states = { pending_payment: 'بانتظار محاكاة الدفع', accepted: 'مقبول', preparing: 'قيد التحضير', ready: 'جاهز', completed: 'مكتمل' };

  class RequestError extends Error {
    constructor(status, code = '') {
      super(status === 401 ? 'انتهت الجلسة. سجّل الدخول من جديد.' : status === 403 ? 'حسابك غير مخول لهذا الإجراء.' : status === 409 ? 'تغيرت البيانات. حدّث الصفحة المعروضة قبل إعادة الإجراء.' : status === 404 ? 'البيانات المطلوبة غير متاحة لحسابك.' : code === 'invalid_response' ? 'تعذر التحقق من استجابة الخادم.' : 'تعذر الاتصال. لم نؤكد نجاح العملية؛ حدّث البيانات قبل إعادة المحاولة.');
      this.status = status;
    }
  }

  function currentScope() {
    const view = viewGeneration;
    const generation = sessionGeneration;
    return () => view === viewGeneration && generation === sessionGeneration && !loggingOut;
  }
  function beginView() {
    viewGeneration++;
    message.textContent = '';
    content.replaceChildren(text('p', 'جارٍ تحميل البيانات…'));
    return currentScope();
  }
  function clearSession(reason = '') {
    sessionGeneration++;
    viewGeneration++;
    session = null;
    loggingOut = false;
    sessionLabel.textContent = 'لم تسجّل الدخول';
    logout.hidden = true;
    home.hidden = true;
    showSignIn();
    message.textContent = reason;
  }
  function loginUrl() {
    const path = location.pathname;
    const allowed = path === '/' || /^\/checkout\/[a-f0-9-]{36}$/.test(path) || path === '/oauth/authorize';
    const returnTo = allowed ? path + (path === '/oauth/authorize' ? location.search : '') : '/';
    return `/auth/login?${new URLSearchParams({ returnTo })}`;
  }
  function showSignIn() {
    const card = text('article', '', 'card stage-signin');
    card.append(text('span', '↗', 'stage-lock'), text('h2', 'أهلًا بك في بيئة الاختبار'), text('p', 'سجّل الدخول بحسابك المصرح له. تحدد صلاحياته المطاعم والطلبات التي يمكنك الوصول إليها.'));
    const link = text('a', 'تسجيل الدخول', 'link stage-link');
    link.id = 'sign-in'; link.href = loginUrl();
    card.append(link, text('p', 'التحقق من الهوية يتم في صفحة تسجيل الدخول الآمنة. لا تُدخل بيانات عملاء حقيقية هنا.', 'stage-subtitle'));
    content.replaceChildren(card);
  }
  async function api(path, { body, csrf, allowSignedOut = false } = {}) {
    const generation = sessionGeneration;
    const mutation = body !== undefined;
    const csrfToken = csrf ?? session?.csrfToken;
    if (mutation && (!csrfToken || (loggingOut && !csrf))) throw new RequestError(401);
    let response;
    try {
      response = await fetch(path, {
        method: mutation ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: mutation ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken } : { Accept: 'application/json' },
        body: mutation ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000)
      });
    } catch { throw new RequestError(0); }
    if (response.status === 401 && !allowSignedOut && generation === sessionGeneration) clearSession('انتهت الجلسة. سجّل الدخول من جديد.');
    if (!response.ok) throw new RequestError(response.status);
    if (response.status === 204) return {};
    try { return await response.json(); } catch { throw new RequestError(0, 'invalid_response'); }
  }
  async function run(button, callback, isCurrent = currentScope()) {
    if (!isCurrent()) return;
    const operation = Symbol('operation');
    if (button) { operations.set(button, operation); button.disabled = true; }
    message.textContent = '';
    let keepDisabled = false;
    try { keepDisabled = (await callback())?.keepDisabled === true; }
    catch (error) { if (isCurrent()) message.textContent = error instanceof RequestError ? error.message : 'تعذر إكمال العملية. حدّث البيانات قبل إعادة المحاولة.'; }
    finally { if (button && operations.get(button) === operation && !keepDisabled) button.disabled = false; }
  }
  function button(label, callback, isCurrent, className = '') {
    const node = text('button', label, className);
    node.type = 'button'; node.onclick = () => run(node, callback, isCurrent); return node;
  }
  function internalCheckout(url) {
    const parsed = new URL(url, location.origin);
    if (parsed.origin !== location.origin || parsed.username || parsed.password || !/^\/checkout\/[a-f0-9-]{36}$/.test(parsed.pathname) || parsed.search || parsed.hash) throw new RequestError(0, 'invalid_response');
    return parsed.href;
  }

  async function loadSession() {
    const isCurrent = beginView();
    await run(null, async () => {
      let result;
      try { result = await api('/api/session', { allowSignedOut: true }); }
      catch (error) {
        if (!isCurrent()) return;
        clearSession(error.status === 401 ? '' : error.message);
        return;
      }
      if (!isCurrent()) return;
      if (result.authMode !== 'oidc' || !result.principal || !['customer', 'merchant'].includes(result.principal.role) || typeof result.csrfToken !== 'string' || !result.csrfToken) {
        clearSession('هذه الصفحة تتطلب جلسة موثقة. تعذر قبول إعداد تسجيل الدخول.'); return;
      }
      session = { principal: result.principal, csrfToken: result.csrfToken };
      sessionLabel.textContent = result.principal.role === 'merchant' ? 'حساب إدارة مطعم • جلسة موثقة' : 'حساب عميل • جلسة موثقة';
      logout.hidden = false; home.hidden = false;
      await render();
    }, isCurrent);
  }

  logout.onclick = async () => {
    if (!session || loggingOut) return;
    const csrf = session.csrfToken;
    const generation = ++sessionGeneration;
    viewGeneration++;
    loggingOut = true;
    logout.disabled = true;
    content.replaceChildren(text('p', 'جارٍ إنهاء الجلسة…'));
    message.textContent = '';
    try {
      await api('/auth/logout', { body: {}, csrf });
      if (generation === sessionGeneration) clearSession('تم تسجيل الخروج.');
    } catch (error) {
      if (generation === sessionGeneration) {
        loggingOut = false;
        content.replaceChildren(text('article', 'لم نتمكن من تأكيد إنهاء الجلسة لدى الخادم. أعد محاولة تسجيل الخروج.', 'card'));
        message.textContent = error.message;
      }
    } finally { logout.disabled = false; }
  };
  home.onclick = () => { if (session && !loggingOut) { history.replaceState(null, '', '/'); void render(); } };

  function directory() {
    const isCurrent = beginView();
    return run(null, async () => {
      const { restaurants } = await api('/api/restaurants');
      if (!isCurrent()) return;
      const grid = text('div', '', 'grid');
      for (const restaurant of restaurants) {
        const card = text('article', '', 'card');
        card.dataset.tenant = restaurant.id;
        card.append(text('span', 'مطعم اصطناعي', 'stage-tag'), text('h3', restaurant.name), text('p', restaurant.cuisine), button('استعراض المنيو', () => menuView(restaurant.id), isCurrent));
        grid.append(card);
      }
      content.replaceChildren(text('h2', 'اختر مطعمك'), text('p', 'جرّب سلة وطلبًا منفصلين لكل مطعم.', 'stage-subtitle'), grid);
    }, isCurrent);
  }

  function menuView(tenantId) {
    const isCurrent = beginView();
    return run(null, async () => {
      const menu = await api(`/api/restaurants/${encodeURIComponent(tenantId)}/menu`);
      if (!isCurrent()) return;
      let cartGeneration = 0;
      let quoteRequest = 0;
      let activeQuote = null;
      const inputs = [];
      const title = text('div', '', 'topline');
      title.append(text('h2', menu.name), button('المطاعم', directory, isCurrent, 'secondary'));
      const list = text('div', '', 'card');
      const total = text('div', ''); total.id = 'total';
      for (const item of menu.items) {
        const row = text('div', '', 'item');
        const description = text('div', ''); description.append(text('h3', item.name), text('span', `${money(item.priceMinor)} · متاح ${item.stock}`));
        const label = text('label', 'الكمية ');
        const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '20'; input.value = '0'; input.dataset.item = item.id;
        input.oninput = () => { cartGeneration++; activeQuote = null; total.replaceChildren(); };
        label.append(input); row.append(description, label); list.append(row); inputs.push({ itemId: item.id, input });
      }
      const quoteButton = button('حساب السلة', async () => {
        const cartVersion = cartGeneration;
        const request = ++quoteRequest;
        activeQuote = null; total.replaceChildren();
        const items = Object.freeze(inputs.map(({ itemId, input }) => Object.freeze({ itemId, quantity: Number(input.value) })).filter(item => item.quantity > 0));
        const quoteIsCurrent = () => isCurrent() && cartVersion === cartGeneration && request === quoteRequest;
        let quote;
        try { quote = await api(`/api/restaurants/${encodeURIComponent(tenantId)}/quote`, { body: { items } }); }
        catch (error) { if (quoteIsCurrent()) throw error; return; }
        if (!quoteIsCurrent()) return;
        const snapshot = Object.freeze({ tenantId, items, expectedTotalMinor: quote.totalMinor, idempotencyKey: crypto.randomUUID() });
        activeQuote = snapshot;
        const card = text('article', '', 'total');
        card.append(text('strong', `الإجمالي ${money(snapshot.expectedTotalMinor)}`), text('p', 'هذه معاينة فقط؛ لم يُنشأ طلب أو حجز بعد.', 'stage-checkout-copy'));
        const checkoutIsCurrent = () => quoteIsCurrent() && activeQuote === snapshot;
        const checkout = button('متابعة إلى التأكيد', async () => {
          const result = await api(`/api/restaurants/${encodeURIComponent(snapshot.tenantId)}/checkouts`, { body: { items: snapshot.items, expectedTotalMinor: snapshot.expectedTotalMinor, idempotencyKey: snapshot.idempotencyKey } });
          if (!checkoutIsCurrent()) return;
          location.assign(internalCheckout(result.checkoutUrl));
          return { keepDisabled: true };
        }, checkoutIsCurrent);
        checkout.id = 'checkout'; card.append(checkout); total.replaceChildren(card);
      }, isCurrent);
      quoteButton.id = 'quote';
      const actions = text('div', '', 'actions'); actions.append(quoteButton);
      content.replaceChildren(title, list, actions, total);
    }, isCurrent);
  }

  function checkoutView(id) {
    const isCurrent = beginView();
    return run(null, async () => {
      const checkout = await api(`/api/checkouts/${id}`);
      if (!isCurrent()) return;
      const card = text('article', '', 'card');
      card.append(text('span', 'طلب اصطناعي', 'stage-tag'), text('h2', 'راجع السلة وأكّد الطلب'), text('p', `المطعم: ${checkout.tenantId}`), text('strong', money(checkout.totalMinor), 'price'), text('p', checkout.paymentMode === 'local-simulator' ? 'الدفع محاكاة محلية فقط، ولا تُسحب أموال.' : 'بوابة دفع اختبارية فقط؛ لا تستخدم بيانات مالية حقيقية.'));
      const payment = text('div', '', 'stage-payment-info'); payment.id = 'payment';
      const confirm = button('تأكيد إنشاء الطلب الاصطناعي', async () => {
        const result = await api(`/api/checkouts/${id}/confirm`, { body: {} });
        if (!isCurrent()) return;
        const info = text('p', `الطلب ${result.order.id} — ${states[result.order.status] ?? result.order.status}`);
        payment.replaceChildren(info);
        if (result.paymentUrl) {
          const target = new URL(result.paymentUrl);
          if (target.protocol !== 'https:' || target.username || target.password) throw new RequestError(0, 'invalid_response');
          const link = text('a', 'فتح صفحة الدفع الاختبارية', 'link stage-link'); link.href = target.href; link.rel = 'noreferrer noopener'; payment.append(link);
        } else {
          let settled = false;
          const paymentUrl = new URL(result.simulationUrl, location.origin);
          if (paymentUrl.origin !== location.origin || !/^\/api\/restaurants\/[^/]+\/orders\/[a-zA-Z0-9_-]{1,128}\/simulate-payment$/.test(paymentUrl.pathname)) throw new RequestError(0, 'invalid_response');
          const pay = button('محاكاة نجاح الدفع — لا تُسحب أموال', async () => {
            const updated = await api(paymentUrl.pathname, { body: {} });
            if (!isCurrent()) return;
            settled = true;
            info.textContent = `${states[updated.status] ?? updated.status} — ${money(updated.totalMinor)} — الإصدار ${updated.version}`;
            return { keepDisabled: true };
          }, () => isCurrent() && !settled);
          payment.append(pay);
        }
        return { keepDisabled: true };
      }, isCurrent);
      confirm.id = 'confirm'; card.append(confirm, payment); content.replaceChildren(card);
    }, isCurrent);
  }

  function merchantView() {
    const isCurrent = beginView();
    return run(null, async () => {
      const { restaurants } = await api('/api/merchant/restaurants');
      if (!isCurrent()) return;
      const groups = await Promise.all(restaurants.map(async restaurant => {
        const orders = await api(`/api/merchant/restaurants/${encodeURIComponent(restaurant.id)}/orders`);
        return { restaurant, orders: orders.orders };
      }));
      if (!isCurrent()) return;
      const heading = text('div', '', 'topline'); heading.append(text('h2', 'مساحة إدارة المطعم'), button('تحديث', merchantView, isCurrent, 'secondary'));
      content.replaceChildren(heading, text('p', 'إدارة اختبار محدودة؛ لا تستبدل لوحة المطعم أو تطبيق الإدارة الكامل.', 'stage-subtitle'));
      for (const { restaurant, orders } of groups) {
        const group = text('section', '', 'stage-section'); group.dataset.tenant = restaurant.id;
        group.append(text('h2', restaurant.name), text('h3', 'الطلبات الاصطناعية'));
        const grid = text('div', '', 'grid stage-order-grid');
        for (const order of orders) {
          const card = text('article', '', 'card');
          card.append(text('span', states[order.status] ?? order.status, 'stage-tag'), text('code', order.id, 'stage-order-id'), text('strong', money(order.totalMinor), 'price'), text('p', `الإصدار ${order.version}`));
          const next = order.paymentStatus === 'paid' ? { accepted: 'preparing', preparing: 'ready', ready: 'completed' }[order.status] : null;
          if (next) card.append(button(`نقل إلى: ${states[next]}`, async () => {
            await api(`/api/merchant/restaurants/${encodeURIComponent(restaurant.id)}/orders/${encodeURIComponent(order.id)}/status`, { body: { status: next, expectedVersion: order.version } });
            if (isCurrent()) await merchantView();
          }, isCurrent));
          grid.append(card);
        }
        if (!orders.length) grid.append(text('p', 'لا توجد طلبات لهذا المطعم حاليًا.', 'stage-empty'));
        group.append(grid); content.append(group);
      }
      if (!groups.length) content.append(text('article', 'لا توجد مطاعم مخوّلة لهذا الحساب.', 'card stage-empty'));
    }, isCurrent);
  }

  function render() {
    if (!session) { showSignIn(); return; }
    const checkout = /^\/checkout\/([a-f0-9-]{36})$/.exec(location.pathname);
    if (checkout) return checkoutView(checkout[1]);
    const returned = /^\/payment-return\/(demo-[ab])\/([a-zA-Z0-9_-]{1,128})$/.exec(location.pathname);
    if (returned) {
      const isCurrent = beginView();
      const card = text('article', '', 'card');
      const result = text('p', 'العودة من البوابة لا تثبت الدفع. تحقق من حالة الطلب لدى الخادم.');
      card.append(text('h2', 'متابعة نتيجة الدفع'), result, button('تحقق من الخادم', async () => {
        const order = await api(`/api/restaurants/${returned[1]}/orders/${returned[2]}/payment-status`, { body: {} });
        if (isCurrent()) result.textContent = `${states[order.status] ?? order.status} — ${money(order.totalMinor)}`;
      }, isCurrent));
      content.replaceChildren(card); return;
    }
    return session.principal.role === 'merchant' ? merchantView() : directory();
  }
  void loadSession();
})();
