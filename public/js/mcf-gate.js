/**
 * Asks for the owner's PIN before a page uses the data behind it, and again if it lapses while the page is open.
 * Goes in <head>, before the page's own scripts: <script src="/js/mcf-gate.js" data-level="session|reports">.
 * "reports" is the second ask for Hub and Reportes. The server decides what is allowed; this only holds the
 * page's requests until it says yes, so the page itself needs no changes.
 *
 * The accountant signs in at /cuentas and is never asked for a PIN. window.mcfGate.who says who the server sees,
 * for a page that shows them something different.
 */
(function () {
  const level = document.currentScript.dataset.level;
  const AUTH = '/api/auth/pin';
  const ACCOUNTANT_FLAG = 'mcf_accountant_session';
  const pageFetch = window.fetch.bind(window);
  let prompt = null;

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function remember(user) {
    try {
      sessionStorage.removeItem(ACCOUNTANT_FLAG);
      sessionStorage.setItem('mcf_admin_authenticated', JSON.stringify({ authenticated: true, user, timestamp: Date.now() }));
    } catch { /* the sign-in itself is in the cookies */ }
    if (window.MCF) window.MCF.refresh();
  }

  function rememberAccountant() {
    try {
      sessionStorage.removeItem('mcf_admin_authenticated');
      sessionStorage.setItem(ACCOUNTANT_FLAG, 'gastos_only');
    } catch { /* the sign-in itself is in the cookie */ }
  }

  function wasAccountant() {
    try { return sessionStorage.getItem(ACCOUNTANT_FLAG) !== null; } catch { return false; }
  }

  // Her session lapsed. The flag goes first, so /cuentas doesn't send her straight back. Nothing after this runs.
  function backToCuentas() {
    try { sessionStorage.removeItem(ACCOUNTANT_FLAG); } catch { /* nothing to clear */ }
    location.replace('/cuentas');
    return new Promise(() => {});
  }

  async function whoAmI() {
    try {
      return await (await pageFetch(AUTH, { cache: 'no-store' })).json();
    } catch {
      return { user: null, reports: false };
    }
  }

  function askPin() {
    if (prompt) return prompt;
    prompt = new Promise(resolve => {
      const show = () => {
        const text = level === 'reports'
          ? { title: 'Hub y Reportes', hint: 'Introduzca su PIN otra vez para ver estos datos.' }
          : { title: 'Movimientos de caja', hint: 'Introduzca su PIN. El movimiento quedará a su nombre.' };
        const box = document.createElement('div');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:#f4f6f8;color:#1f2933;font-family:Geist,system-ui,-apple-system,"Segoe UI",sans-serif';
        box.innerHTML = `<form autocomplete="off" style="width:100%;max-width:340px;padding:24px;background:#fff;border:1px solid #d9dfe6;border-radius:12px;box-sizing:border-box">
            <h1 style="margin:0 0 6px;font-size:18px;font-weight:600">${esc(text.title)}</h1>
            <p style="margin:0 0 16px;font-size:14px;color:#52606d">${esc(text.hint)}</p>
            <input type="password" inputmode="numeric" maxlength="6" autocomplete="off" aria-label="PIN" placeholder="PIN"
              style="width:100%;box-sizing:border-box;padding:12px;font-size:20px;letter-spacing:.3em;text-align:center;background:#fff;color:#1f2933;border:1px solid #cbd2d9;border-radius:8px">
            <p data-message role="alert" style="min-height:20px;margin:8px 0;font-size:13px;color:#b42318"></p>
            <button type="submit" style="width:100%;padding:12px;font-size:15px;font-weight:600;color:#fff;background:#2d6695;border:0;border-radius:8px;cursor:pointer">Continuar</button>
            <a href="/admin" style="display:block;margin-top:12px;font-size:13px;text-align:center;color:#2d6695">Volver</a>
          </form>`;
        const form = box.querySelector('form');
        const input = box.querySelector('input');
        const message = box.querySelector('[data-message]');
        let checking = false;

        async function submit() {
          if (checking || !input.value) return;
          checking = true;
          message.textContent = '';
          try {
            const res = await pageFetch(AUTH, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pin: input.value, reports: level === 'reports' }),
            });
            const data = await res.json();
            if (!res.ok) { message.textContent = data.error || 'No se pudo comprobar el PIN'; return; }
            box.remove();
            prompt = null;
            remember(data.user);
            resolve(data.user);
          } catch {
            message.textContent = 'No se pudo comprobar el PIN';
          } finally {
            checking = false;
            input.value = '';
          }
        }

        form.addEventListener('submit', e => { e.preventDefault(); submit(); });
        input.addEventListener('input', () => { if (input.value.length === 6) submit(); });
        document.body.appendChild(box);
        input.focus();
      };
      if (document.body) show();
      else document.addEventListener('DOMContentLoaded', show, { once: true });
    });
    return prompt;
  }

  // The forms show the person from the address, so it has to be whoever the PIN says.
  function showAs(user) {
    if (level !== 'session') return;
    const params = new URLSearchParams(location.search);
    if (params.get('user') === user) return;
    params.set('user', user);
    location.replace(`${location.pathname}?${params}`);
  }

  let accountant = false;
  let announce;
  const who = new Promise(resolve => { announce = resolve; });
  window.mcfGate = { who };

  let ready = (async () => {
    let me = await whoAmI();
    if (level === 'reports' && !me.reports) {
      if (me.accountant) {
        accountant = true;
        rememberAccountant();
        announce(me);
        return;
      }
      if (!me.user && wasAccountant()) await backToCuentas();
    }
    const open = level === 'reports' ? me.reports : !!me.user;
    if (!open) {
      const user = await askPin();
      me = { ...await whoAmI(), user };
    }
    remember(me.user);
    showAs(me.user);
    announce(me);
  })();

  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url || String(input), location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.pathname === AUTH) return pageFetch(input, init);
    await ready;
    const res = await pageFetch(input, init);
    if (res.status !== 401) return res;
    const body = await res.clone().json().catch(() => ({}));
    if (!body.needs_pin) return res;
    if (accountant) {
      // Either her session lapsed, or this is a route she doesn't have, which is the page's error to show.
      if (!(await whoAmI()).accountant) await backToCuentas();
      return res;
    }
    // It lapsed while the page was open: ask, then carry on with the same request, so nothing typed is lost.
    ready = askPin();
    await ready;
    return pageFetch(input, init);
  };
})();
