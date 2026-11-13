/*
 * Shell of the site: the sidebar, the top bar and the mobile drawer, plus the list of everything in it.
 * It runs right after <body> opens, so it adds them before the first paint and leaves the page's own markup alone.
 * <body data-shell="app"> gets the navigation; "bare" (customer pages, sign-in) only the name on top.
 *
 * NAV is the single source of truth: the sidebar, the drawer and the Inicio page all read it.
 */
(function () {
  'use strict';

  const ICONS = {
    "home": "<rect width=\"7\" height=\"9\" x=\"3\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"5\" x=\"14\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"9\" x=\"14\" y=\"12\" rx=\"1\"/><rect width=\"7\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\"/>",
    "clean": "<path d=\"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z\"/><path d=\"M20 2v4\"/><path d=\"M22 4h-4\"/><circle cx=\"4\" cy=\"20\" r=\"2\"/>",
    "box": "<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\"/><path d=\"M12 22V12\"/><polyline points=\"3.29 7 12 12 20.71 7\"/><path d=\"m7.5 4.27 9 5.15\"/>",
    "supplies": "<rect width=\"8\" height=\"4\" x=\"8\" y=\"2\" rx=\"1\" ry=\"1\"/><path d=\"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2\"/><path d=\"M12 11h4\"/><path d=\"M12 16h4\"/><path d=\"M8 11h.01\"/><path d=\"M8 16h.01\"/>",
    "activity": "<path d=\"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2\"/>",
    "alert": "<circle cx=\"12\" cy=\"12\" r=\"10\"/><line x1=\"12\" x2=\"12\" y1=\"8\" y2=\"12\"/><line x1=\"12\" x2=\"12.01\" y1=\"16\" y2=\"16\"/>",
    "sliders": "<path d=\"M10 5H3\"/><path d=\"M12 19H3\"/><path d=\"M14 3v4\"/><path d=\"M16 17v4\"/><path d=\"M21 12h-9\"/><path d=\"M21 19h-5\"/><path d=\"M21 5h-7\"/><path d=\"M8 10v4\"/><path d=\"M8 12H3\"/>",
    "coins": "<path d=\"M13.744 17.736a6 6 0 1 1-7.48-7.48\"/><path d=\"M15 6h1v4\"/><path d=\"m6.134 14.768.866-.5 2 3.464\"/><circle cx=\"16\" cy=\"8\" r=\"6\"/>",
    "pull": "<path d=\"M11 15h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 17\"/><path d=\"m7 21 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9\"/><path d=\"m2 16 6 6\"/><circle cx=\"16\" cy=\"9\" r=\"2.9\"/><circle cx=\"6\" cy=\"5\" r=\"3\"/>",
    "receipt": "<path d=\"M12 17V7\"/><path d=\"M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8\"/><path d=\"M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z\"/>",
    "bank": "<path d=\"M10 18v-7\"/><path d=\"M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z\"/><path d=\"M14 18v-7\"/><path d=\"M18 18v-7\"/><path d=\"M3 22h18\"/><path d=\"M6 18v-7\"/>",
    "warning": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/><path d=\"M12 9v4\"/><path d=\"M12 17h.01\"/>",
    "ticket": "<path d=\"M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z\"/><path d=\"M13 5v2\"/><path d=\"M13 17v2\"/><path d=\"M13 11v2\"/>",
    "hub": "<rect width=\"7\" height=\"7\" x=\"3\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"7\" x=\"14\" y=\"3\" rx=\"1\"/><rect width=\"7\" height=\"7\" x=\"14\" y=\"14\" rx=\"1\"/><rect width=\"7\" height=\"7\" x=\"3\" y=\"14\" rx=\"1\"/>",
    "chart": "<path d=\"M3 3v16a2 2 0 0 0 2 2h16\"/><path d=\"M18 17V9\"/><path d=\"M13 17V5\"/><path d=\"M8 17v-3\"/>",
    "pencil": "<path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\"/><path d=\"m15 5 4 4\"/>",
    "table": "<path d=\"M3 9h18\"/><path d=\"M9 3v18\"/><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/>",
    "calendar": "<path d=\"M8 2v3\"/><path d=\"M16 2v3\"/><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M3 9h18\"/>",
    "notes": "<path d=\"M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4\"/><path d=\"M2 6h4\"/><path d=\"M2 10h4\"/><path d=\"M2 14h4\"/><path d=\"M2 18h4\"/><path d=\"M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z\"/>",
    "book": "<path d=\"M12 5v16\"/><path d=\"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z\"/>",
    "sheet": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\"/><line x1=\"3\" x2=\"21\" y1=\"9\" y2=\"9\"/><line x1=\"3\" x2=\"21\" y1=\"15\" y2=\"15\"/><line x1=\"9\" x2=\"9\" y1=\"9\" y2=\"21\"/><line x1=\"15\" x2=\"15\" y1=\"9\" y2=\"21\"/>",
    "upload": "<path d=\"M12 3v12\"/><path d=\"m17 8-5-5-5 5\"/><path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/>",
    "file": "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\"/><path d=\"M14 2v5a1 1 0 0 0 1 1h5\"/><path d=\"M8 18v-1\"/><path d=\"M12 18v-6\"/><path d=\"M16 18v-3\"/>",
    "calculator": "<rect width=\"16\" height=\"20\" x=\"4\" y=\"2\" rx=\"2\"/><line x1=\"8\" x2=\"16\" y1=\"6\" y2=\"6\"/><line x1=\"16\" x2=\"16\" y1=\"14\" y2=\"18\"/><path d=\"M16 10h.01\"/><path d=\"M12 10h.01\"/><path d=\"M8 10h.01\"/><path d=\"M12 14h.01\"/><path d=\"M8 14h.01\"/><path d=\"M12 18h.01\"/><path d=\"M8 18h.01\"/>",
    "sun": "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2\"/><path d=\"M12 20v2\"/><path d=\"m4.93 4.93 1.41 1.41\"/><path d=\"m17.66 17.66 1.41 1.41\"/><path d=\"M2 12h2\"/><path d=\"M20 12h2\"/><path d=\"m6.34 17.66-1.41 1.41\"/><path d=\"m19.07 4.93-1.41 1.41\"/>",
    "moon": "<path d=\"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401\"/>",
    "menu": "<path d=\"M4 5h16\"/><path d=\"M4 12h16\"/><path d=\"M4 19h16\"/>",
    "close": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/><path d=\"M9 3v18\"/><path d=\"m16 15-3-3 3-3\"/>",
    "open": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/><path d=\"M9 3v18\"/><path d=\"m14 9 3 3-3 3\"/>",
    "logout": "<path d=\"m16 17 5-5-5-5\"/><path d=\"M21 12H9\"/><path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4\"/>",
    "chevron": "<path d=\"m9 18 6-6-6-6\"/>",
    "external": "<path d=\"M15 3h6v6\"/><path d=\"M10 14 21 3\"/><path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\"/>"
  };

  const ADMINS = ['lalo', 'oscar', 'adrian'];
  const SESSION_KEY = 'mcf_admin_authenticated'; // the session the sign-in page writes
  const USER_KEY = 'mcf_user';

  /*
   * page: internal form, opened with ?user= as the forms expect. href: any other address.
   * admin: only shown after the admin password. out: opens elsewhere.
   */
  const NAV = [
    { items: [{ href: '/admin', label: 'Inicio', icon: 'home', home: true }] },
    {
      label: 'Registrar Visita',
      items: [
        { page: 'final-visit', label: 'Registrar Limpieza', desc: 'Checklist de tareas de limpieza', icon: 'clean' },
        { page: 'inventario', label: 'Registro Inventario', desc: 'Conteo de productos y suministros', icon: 'box' },
        { page: 'reportar-insumos', label: 'Reportar Falta de Insumos', desc: 'Pedir insumos que no son jabón, suavizante u oxígeno', icon: 'supplies' },
      ],
    },
    {
      label: 'Kioscos',
      items: [
        { href: '/estado', label: 'Estado de los kioscos', desc: 'Si todo va bien o qué está fallando', icon: 'activity' },
        { href: '/errores', label: 'Catálogo de errores', desc: 'Qué significa cada código y qué hacer', icon: 'alert' },
        { href: '/kiosko', label: 'Ajustes del kiosco', desc: 'Precios, horario, descuentos e intervalos', icon: 'sliders', admin: true },
      ],
    },
    {
      label: 'Movimientos de Caja',
      admin: true,
      items: [
        { page: 'fondo-caja', label: 'Ingreso Monedas a Fondo', desc: 'Añadir monedas al fondo de caja', icon: 'coins' },
        { page: 'retiro', label: 'Retiro en Tránsito', desc: 'Retirar efectivo de caja', icon: 'pull' },
        { page: 'gastos', label: 'Pago de un Gasto', desc: 'Registrar gasto con efectivo', icon: 'receipt' },
        { page: 'deposito', label: 'Depósito a Cuenta', desc: 'Registrar depósito bancario', icon: 'bank' },
      ],
    },
    {
      label: 'Otros',
      admin: true,
      items: [
        { page: 'incidencias', label: 'Incidencias', desc: 'Reportar quejas o llamadas', icon: 'warning' },
        { page: 'ticket', label: 'Ticket / Factura', desc: 'Generar ticket o factura en PDF', icon: 'ticket' },
      ],
    },
    {
      label: 'Corporate',
      admin: true,
      items: [
        { href: '/reporte#hub', label: 'Hub', desc: 'Ventas y saldos por usuario', icon: 'hub' },
        { page: 'reporte', label: 'Reportes', desc: 'Resumen mensual, comparativas, P&L y pivot libre', icon: 'chart' },
        { href: '/reporte#gastos', label: 'Gastos (Editar)', desc: 'Revisar, editar, adjuntar factura y exportar el mes', icon: 'pencil' },
        { href: '/reporte#calculator', label: 'Calculador', desc: 'Análisis de inversiones', icon: 'calculator' },
        { href: 'https://docs.google.com/spreadsheets/d/1brwERISPLIXih8nbPbHDpUHU0yBWdt8S6wvNYqs5mN4/edit?gid=1590924242#gid=1590924242', label: 'P&L', desc: 'Estado de resultados', icon: 'table', out: true },
        { href: 'https://docs.google.com/spreadsheets/d/1kzmdDbJQTXy_ABgvWTse0bMtYU0jONo5HkTftVBQEAo/edit?gid=0#gid=0', label: 'Calendario', desc: 'Semanas de Socios', icon: 'calendar', out: true },
        { href: 'https://docs.google.com/document/d/1PAI_M78kdA_xLr-GO_tbvjsHyanVja6xrIJUXYYDny8/edit?tab=t.0#heading=h.9iuzv5bwe9df', label: 'Minutas Reuniones', desc: 'Notas de reuniones', icon: 'notes', out: true },
        { href: 'https://docs.google.com/document/d/18asaW-mJIkdK2SCKIOfnhGaqMm4cHB1ox2IywM3yeK8/edit?tab=t.0#heading=h.iz6cjqtsm42a', label: 'Manual de Operaciones', desc: 'Guía de procedimientos', icon: 'book', out: true },
        { href: 'https://docs.google.com/spreadsheets/d/1wju-dUlIOAA8qFbMX2roH0YcinsbqrXWgjSSNNyN0qs/edit?gid=0#gid=0', label: 'Gastos (Spreadsheet)', desc: 'Registro de gastos', icon: 'sheet', out: true },
        { href: 'https://docs.google.com/forms/d/e/1FAIpQLSew7_dIfJCoqgKmbAxfHpHbuqlZ7w3Idk-Rxa0cyss8jKQiwA/viewform', label: 'Subir Facturas Gastos', desc: 'Formulario de facturas', icon: 'upload', out: true },
        { href: 'https://www.notion.so/eduardoflores/1dc13ec8894180579789ec6239fb1098?v=23813ec8894180ccabb9000cc6bf0eaf', label: 'Reportes de Ventas', desc: 'Reportes mensuales de ventas', icon: 'file', out: true },
      ],
    },
  ];

  // Browser storage can be missing or blocked, and the site must still work.
  const store = {
    get(area, key) { try { return window[area].getItem(key); } catch { return null; } },
    set(area, key, value) { try { window[area].setItem(key, value); } catch { /* stays for this page only */ } },
    remove(area, key) { try { window[area].removeItem(key); } catch { /* nothing to remove */ } },
  };

  function icon(name, cls) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls}"` : ''} aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function adminSession() {
    try {
      const data = JSON.parse(store.get('sessionStorage', SESSION_KEY) || 'null');
      return data && data.authenticated && ADMINS.includes(data.user) ? data.user : null;
    } catch { return null; }
  }

  function currentUser() {
    const fromUrl = new URLSearchParams(location.search).get('user');
    if (fromUrl) store.set('sessionStorage', USER_KEY, fromUrl);
    return fromUrl || adminSession() || store.get('sessionStorage', USER_KEY);
  }

  const isAdmin = () => adminSession() !== null;

  function hrefOf(item) {
    if (!item.page) return item.href;
    const user = currentUser();
    return `/${item.page}.html${user ? `?user=${encodeURIComponent(user)}` : ''}`;
  }

  function visibleGroups() {
    const admin = isAdmin();
    return NAV.filter(g => admin || !g.admin)
      .map(g => ({ ...g, items: g.items.filter(i => admin || !i.admin) }))
      .filter(g => g.items.length > 0);
  }

  function isActive(item) {
    const here = location.pathname.replace(/\.html$/, '').replace(/\/$/, '');
    const target = item.page ? `/${item.page}` : (item.href || '').split('#')[0];
    return here === target;
  }

  function linkAttrs(item) {
    return item.out ? ' target="_blank" rel="noopener"' : '';
  }

  // ───────── theme ─────────

  const THEME_KEY = 'mcf_theme';

  function applyTheme(theme) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.querySelectorAll('[data-mcf-theme]').forEach(b => {
      b.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
      b.setAttribute('aria-label', theme === 'dark' ? 'Tema claro' : 'Tema oscuro');
    });
  }

  function currentTheme() {
    return store.get('localStorage', THEME_KEY) === 'dark' ? 'dark' : 'light';
  }

  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    store.set('localStorage', THEME_KEY, next);
    applyTheme(next);
  }

  applyTheme(currentTheme());

  // ───────── shell ─────────

  function navHtml() {
    return visibleGroups().map(group => `
      <div class="mcf-nav-group">
        ${group.label ? `<span class="mcf-nav-label">${esc(group.label)}</span>` : ''}
        ${group.items.map(item => `
          <a class="mcf-nav-item${isActive(item) ? ' active' : ''}" href="${esc(hrefOf(item))}"${linkAttrs(item)}>
            ${icon(item.icon)}<span>${esc(item.label)}</span>${item.out ? icon('external', 'mcf-out') : ''}
          </a>`).join('')}
      </div>`).join('');
  }

  function closeDrawer() {
    document.body.classList.remove('mcf-drawer-open');
  }

  function logout() {
    store.remove('sessionStorage', SESSION_KEY);
    store.remove('sessionStorage', USER_KEY);
    fetch('/api/auth/pin', { method: 'DELETE', keepalive: true }).catch(() => {});
    location.href = '/admin';
  }

  function removeShell() {
    document.querySelectorAll('[data-mcf-shell]').forEach(el => el.remove());
    document.body.classList.remove('has-shell', 'mcf-drawer-open');
  }

  function buildApp() {
    const body = document.body;
    const user = currentUser();
    body.classList.add('has-shell');
    body.classList.toggle('sidebar-collapsed', store.get('localStorage', 'mcf_sidebar') === 'collapsed');

    const aside = document.createElement('aside');
    aside.className = 'mcf-sidebar';
    aside.setAttribute('data-mcf-shell', '');
    aside.innerHTML = `
      <div class="mcf-brand-row">
        <a href="/admin" class="mcf-brand"><strong>MCF</strong><span>Soluciones</span></a>
        <div style="display:flex;gap:4px">
          <button type="button" class="icon-btn" data-mcf-theme></button>
          <button type="button" class="icon-btn" data-mcf-collapse aria-label="Ocultar menú">${icon('close')}</button>
        </div>
      </div>
      <nav class="mcf-nav">${navHtml()}</nav>
      ${user ? `<div class="mcf-sidebar-foot"><strong>${esc(user)}</strong>${isAdmin() ? 'Administrador' : 'Personal'}</div>` : ''}`;

    const top = document.createElement('header');
    top.className = 'mcf-topbar';
    top.setAttribute('data-mcf-shell', '');
    top.innerHTML = `
      <button type="button" class="icon-btn mcf-menu-btn" data-mcf-menu aria-label="Abrir menú">${icon('menu')}</button>
      <button type="button" class="icon-btn mcf-open-btn" data-mcf-collapse aria-label="Mostrar menú">${icon('open')}</button>
      <a class="mcf-topbar-brand" href="/admin">MCF</a>
      <button type="button" class="icon-btn mcf-menu-btn" data-mcf-theme></button>
      ${user
        ? `<button type="button" class="mcf-logout" data-mcf-logout>${icon('logout')}<span>Salir</span></button>`
        : '<a class="mcf-logout" href="/admin"><span>Entrar</span></a>'}`;

    const scrim = document.createElement('div');
    scrim.className = 'mcf-scrim';
    scrim.setAttribute('data-mcf-shell', '');

    body.prepend(scrim);
    body.prepend(top);
    body.prepend(aside);

    body.querySelectorAll('[data-mcf-theme]').forEach(b => b.addEventListener('click', toggleTheme));
    body.querySelectorAll('[data-mcf-logout]').forEach(b => b.addEventListener('click', logout));
    body.querySelectorAll('[data-mcf-menu]').forEach(b => b.addEventListener('click', () => body.classList.add('mcf-drawer-open')));
    body.querySelectorAll('[data-mcf-collapse]').forEach(b => b.addEventListener('click', () => {
      if (body.classList.contains('mcf-drawer-open')) { closeDrawer(); return; }
      const collapsed = !body.classList.contains('sidebar-collapsed');
      body.classList.toggle('sidebar-collapsed', collapsed);
      store.set('localStorage', 'mcf_sidebar', collapsed ? 'collapsed' : 'open');
      closeDrawer();
    }));
    scrim.addEventListener('click', closeDrawer);
    aside.querySelectorAll('a').forEach(a => a.addEventListener('click', closeDrawer));
    applyTheme(currentTheme());
  }

  function buildBare() {
    const brand = document.createElement('div');
    brand.className = 'mcf-bare-brand';
    brand.setAttribute('data-mcf-shell', '');
    brand.innerHTML = '<strong>MCF</strong><span>Soluciones</span>';
    document.body.prepend(brand);
  }

  function refresh() {
    removeShell();
    const mode = document.body.dataset.shell;
    if (mode === 'app') buildApp();
    else if (mode === 'bare') buildBare();
  }

  // ───────── Inicio ─────────

  const STATES = {
    ok: ['Todo bien', 'good'],
    problem: ['Hay algo que revisar', 'warn'],
    down: ['Sin señal', 'bad'],
    off: ['Telemetría desactivada', ''],
    unknown: ['Aún sin datos', ''],
  };

  function ago(iso) {
    if (!iso) return 'sin señal todavía';
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return 'última señal ahora mismo';
    if (minutes < 60) return `última señal hace ${minutes} min`;
    if (minutes < 1440) return `última señal hace ${Math.round(minutes / 60)} h`;
    return `última señal hace ${Math.round(minutes / 1440)} días`;
  }

  async function renderKioskTiles(el) {
    try {
      const res = await fetch('/api/kiosk/status', { cache: 'no-store' });
      if (!res.ok) return;
      const { kiosks } = await res.json();
      el.innerHTML = kiosks.map(k => {
        const [text, tone] = STATES[k.state] || [k.state, ''];
        return `<a class="tile" href="/estado">
          <div class="tile-title">${esc(k.name)}</div>
          <div class="tile-value ${tone}">${esc(text)}</div>
          <div class="tile-sub">${esc(ago(k.last_seen))}</div>
        </a>`;
      }).join('');
    } catch { /* the page is still useful without the kiosk status */ }
  }

  function renderHome(el) {
    const user = currentUser();
    el.innerHTML = `
      <div class="header">
        <h1>Hola${user ? `, <span style="text-transform:capitalize">${esc(user)}</span>` : ''}</h1>
        <p>¿Qué quieres hacer?</p>
      </div>
      <div class="tiles" data-mcf-tiles></div>
      <div class="home-grid">
        ${visibleGroups().filter(g => g.label).map(group => `
          <section class="panel">
            <div class="panel-header"><h2 class="panel-title">${esc(group.label)}</h2></div>
            ${group.items.map(item => `
              <a class="link-row" href="${esc(hrefOf(item))}"${linkAttrs(item)}>
                ${icon(item.icon)}
                <span class="link-row-text">
                  <span class="link-row-title">${esc(item.label)}</span><br>
                  <span class="link-row-desc">${esc(item.desc || '')}</span>
                </span>
                ${icon(item.out ? 'external' : 'chevron', 'link-row-end')}
              </a>`).join('')}
          </section>`).join('')}
      </div>`;
    renderKioskTiles(el.querySelector('[data-mcf-tiles]'));
  }

  function setUser(user) {
    store.set('sessionStorage', USER_KEY, user);
  }

  window.MCF = { refresh, renderHome, currentUser, setUser, isAdmin };
  refresh();
})();
