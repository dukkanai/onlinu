/* All identities and orders here are fictitious. Tokens remain in memory. */
let token = null;
let principal = null;
let identityGeneration = 0;
let viewGeneration = 0;
const buttonOperations = new WeakMap();
const content = document.querySelector('#content');
const message = document.querySelector('#message');
const identityInput = document.querySelector('#identity');
const loginButton = document.querySelector('#login');
const sessionLabel = document.querySelector('#session');
const money = value => `${(value / 100).toFixed(2)} ر.س`;
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const states = { pending_payment: 'بانتظار الدفع', accepted: 'طلب مدفوع جديد', preparing: 'قيد التجهيز', ready: 'جاهز', completed: 'مكتمل' };

async function api(path, data) {
  const accessToken = token;
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(8000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'request_failed');
  return result;
}

async function act(button, action, isCurrent = () => true) {
  if (!isCurrent()) return;
  message.textContent = '';
  const operation = Symbol('button operation');
  if (button) { buttonOperations.set(button, operation); button.disabled = true; }
  let keepDisabled = false;
  try { keepDisabled = (await action())?.keepDisabled === true; }
  catch (error) {
    if (isCurrent()) message.textContent = `لم تكتمل العملية: ${error.message}. لا نفترض نجاح الطلب عند فقد الاتصال.`;
  } finally {
    if (button && buttonOperations.get(button) === operation && !keepDisabled) button.disabled = false;
  }
}

function beginView() {
  const view = ++viewGeneration;
  const identity = identityGeneration;
  message.textContent = '';
  content.textContent = 'جارٍ تحميل البيانات الاصطناعية…';
  return () => view === viewGeneration && identity === identityGeneration;
}

function clearIdentity() {
  identityGeneration++;
  token = null;
  principal = null;
  sessionLabel.textContent = 'غير مسجل';
  return identityGeneration;
}

identityInput.onchange = () => {
  clearIdentity();
  // A pending response for a previous selection must not restore its token.
  buttonOperations.delete(loginButton);
  loginButton.disabled = false;
  void render();
};

loginButton.onclick = () => {
  const identity = identityInput.value;
  const generation = clearIdentity();
  beginView();
  const isCurrent = () => generation === identityGeneration && identityInput.value === identity;
  return act(loginButton, async () => {
    const result = await api('/dev/session', { identity });
    if (!isCurrent()) return;
    token = result.accessToken;
    principal = result.principal;
    sessionLabel.textContent = `جلسة وهمية: ${principal.id}`;
    await render();
  }, isCurrent);
};

function directory() {
  const isCurrent = beginView();
  return act(null, async () => {
    const { restaurants } = await api('/api/restaurants');
    if (!isCurrent()) return;
    content.innerHTML = '<h2>اختر مطعمًا</h2><div class="grid"></div>';
    const grid = content.querySelector('.grid');
    for (const restaurant of restaurants) {
      const article = document.createElement('article');
      article.className = 'card';
      article.innerHTML = `<small>${escapeHtml(restaurant.cuisine)} · ${escapeHtml(restaurant.id)}</small><h3>${escapeHtml(restaurant.name)}</h3><p>نسخة مستقلة بمنيو وطلبات وبيانات معزولة.</p><button>عرض المنيو</button>`;
      article.querySelector('button').onclick = () => { if (isCurrent()) void menuView(restaurant.id); };
      grid.append(article);
    }
  }, isCurrent);
}

function menuView(tenantId) {
  const isCurrent = beginView();
  return act(null, async () => {
    const menu = await api(`/api/restaurants/${tenantId}/menu`);
    if (!isCurrent()) return;
    let cartGeneration = 0;
    let quoteRequest = 0;
    let activeQuote = null;
    content.innerHTML = `<div class="topline"><h2>${escapeHtml(menu.name)}</h2><button class="secondary" id="back">المطاعم</button></div><div class="card" id="menu"></div><div class="actions"><button id="quote">حساب السلة من الخادم</button></div><div id="total"></div>`;
    const list = content.querySelector('#menu');
    const total = content.querySelector('#total');
    const quoteButton = content.querySelector('#quote');
    const inputs = [];
    for (const item of menu.items) {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `<div><h3>${escapeHtml(item.name)}</h3><span>${money(item.priceMinor)} · متاح ${item.stock}</span></div><label>الكمية <input data-item="${escapeHtml(item.id)}" type="number" min="0" max="20" value="0"></label>`;
      const input = row.querySelector('input');
      inputs.push({ itemId: item.id, input });
      input.oninput = () => { cartGeneration++; activeQuote = null; total.replaceChildren(); };
      list.append(row);
    }
    content.querySelector('#back').onclick = () => { if (isCurrent()) void directory(); };
    quoteButton.onclick = () => {
      if (!isCurrent()) return;
      const cartVersion = cartGeneration;
      const request = ++quoteRequest;
      activeQuote = null;
      total.replaceChildren();
      const items = Object.freeze(inputs.map(({ itemId, input }) => Object.freeze({ itemId, quantity: Number(input.value) })).filter(item => item.quantity > 0));
      const quoteIsCurrent = () => isCurrent() && cartVersion === cartGeneration && request === quoteRequest;
      return act(quoteButton, async () => {
        const quote = await api(`/api/restaurants/${tenantId}/quote`, { items });
        if (!quoteIsCurrent()) return;
        const snapshot = Object.freeze({ tenantId, items, expectedTotalMinor: quote.totalMinor, idempotencyKey: crypto.randomUUID() });
        activeQuote = snapshot;
        total.innerHTML = `<div class="total"><strong>الإجمالي ${money(snapshot.expectedTotalMinor)}</strong><p>لا يوجد طلب أو حجز بعد. هذا النموذج يثبت المسار الأساسي فقط.</p><button id="checkout">الانتقال للتأكيد</button></div>`;
        const checkout = total.querySelector('#checkout');
        const checkoutIsCurrent = () => quoteIsCurrent() && activeQuote === snapshot;
        checkout.onclick = () => act(checkout, async () => {
          if (!principal || principal.role !== 'customer') throw new Error('اختر هوية عميل تجريبية أولًا');
          const session = await api(`/api/restaurants/${snapshot.tenantId}/checkouts`, {
            items: snapshot.items, expectedTotalMinor: snapshot.expectedTotalMinor, idempotencyKey: snapshot.idempotencyKey
          });
          if (!checkoutIsCurrent()) return;
          location.assign(session.checkoutUrl);
          return { keepDisabled: true };
        }, checkoutIsCurrent);
      }, quoteIsCurrent);
    };
  }, isCurrent);
}

function checkoutView(id) {
  const isCurrent = beginView();
  if (!principal) {
    content.innerHTML = '<div class="card"><h2>تأكيد الطلب التجريبي</h2><p>اختر هوية العميل الوهمية التي أنشأت السلة، ثم اضغط دخول تجريبي. الرابط وحده لا يتيح بيانات الطلب.</p></div>';
    return;
  }
  return act(null, async () => {
    const session = await api(`/api/checkouts/${id}`);
    if (!isCurrent()) return;
    content.innerHTML = `<article class="card"><small>${escapeHtml(session.tenantId)}</small><h2>مراجعة وتأكيد</h2><p>الإجمالي: <strong>${money(session.totalMinor)}</strong></p><p>وضع الدفع: <strong>${session.paymentMode === 'local-simulator' ? 'محاكاة محلية — ليست ميسر' : 'ميسر الاختباري فقط'}</strong></p><p>لا نجمع معلومات شخصية في هذا النموذج.</p><button id="confirm">تأكيد إنشاء الطلب التجريبي</button><div id="payment"></div></article>`;
    const confirm = content.querySelector('#confirm');
    const box = content.querySelector('#payment');
    confirm.onclick = () => act(confirm, async () => {
      const result = await api(`/api/checkouts/${id}/confirm`, {});
      if (!isCurrent()) return;
      box.replaceChildren();
      const info = document.createElement('p');
      info.textContent = `رقم الطلب: ${result.order.id} — ${states[result.order.status]}`;
      box.append(info);
      if (result.paymentUrl) {
        const link = document.createElement('a'); link.textContent = 'فتح صفحة ميسر الاختبارية'; link.href = result.paymentUrl; link.rel = 'noreferrer'; box.append(link);
      } else {
        const pay = document.createElement('button');
        pay.textContent = 'محاكاة نجاح الدفع محليًا — لا تُسحب أموال';
        let settled = false;
        pay.onclick = () => act(pay, async () => {
          const order = await api(result.simulationUrl, {});
          if (!isCurrent()) return;
          settled = true;
          info.textContent = `${states[order.status]} — ${money(order.totalMinor)} — الإصدار ${order.version}`;
          return { keepDisabled: true };
        }, () => isCurrent() && !settled);
        box.append(pay);
      }
      return { keepDisabled: true };
    }, isCurrent);
  }, isCurrent);
}

function merchantView() {
  const isCurrent = beginView();
  return act(null, async () => {
    const { restaurants } = await api('/api/merchant/restaurants');
    if (!isCurrent()) return;
    const groups = await Promise.all(restaurants.map(async restaurant => ({ restaurant, ...(await api(`/api/merchant/restaurants/${restaurant.id}/orders`)) })));
    if (!isCurrent()) return;
    content.innerHTML = '<div class="topline"><h2>مراقبة الطلبات التجريبية</h2><button id="refresh">تحديث</button></div><p>هذه شاشة فحص ويب مساعدة؛ تطبيق Flutter منفصل.</p><div class="grid"></div>';
    const grid = content.querySelector('.grid');
    content.querySelector('#refresh').onclick = () => { if (isCurrent()) void merchantView(); };
    for (const { restaurant, orders } of groups) {
      for (const order of orders) {
        const card = document.createElement('article'); card.className = 'card';
        card.innerHTML = `<small>${escapeHtml(restaurant.name)}</small><h3>${states[order.status]}</h3><code>${escapeHtml(order.id)}</code><p>${money(order.totalMinor)} · الإصدار ${order.version}</p>`;
        const next = { accepted: 'preparing', preparing: 'ready', ready: 'completed' }[order.status];
        if (next) {
          const button = document.createElement('button'); button.textContent = `نقل إلى: ${states[next]}`;
          button.onclick = () => act(button, async () => {
            await api(`/api/merchant/restaurants/${restaurant.id}/orders/${order.id}/status`, { status: next, expectedVersion: order.version });
            if (isCurrent()) await merchantView();
          }, isCurrent);
          card.append(button);
        }
        grid.append(card);
      }
    }
    if (!groups.some(group => group.orders.length)) grid.textContent = 'لا توجد طلبات لهذا المطعم حتى الآن.';
  }, isCurrent);
}

function render() {
  const checkout = /^\/checkout\/([a-f0-9-]{36})$/.exec(location.pathname);
  if (checkout) return checkoutView(checkout[1]);
  const returned = /^\/payment-return\/(demo-[ab])\/([a-zA-Z0-9_-]{1,128})$/.exec(location.pathname);
  if (returned) {
    const isCurrent = beginView();
    content.innerHTML = '<div class="card"><h2>التحقق من الدفع</h2><p>العودة من البوابة ليست إثبات سداد. سجل دخول العميل التجريبي ثم تحقق.</p><button id="verify">تحقق من الخادم</button><pre id="result"></pre></div>';
    const verify = content.querySelector('#verify');
    const result = content.querySelector('#result');
    verify.onclick = () => act(verify, async () => {
      const order = await api(`/api/restaurants/${returned[1]}/orders/${returned[2]}/payment-status`, {});
      if (isCurrent()) result.textContent = JSON.stringify(order, null, 2);
    }, isCurrent);
    return;
  }
  return principal?.role === 'merchant' ? merchantView() : directory();
}

void render();
