/* ============================================================
 * 培训 Deck 运行时（零依赖）
 * 能力：←→ 导航 / #/N 深链 / F 全屏 / O 总览 / N 备注抽屉 /
 *       S 演讲者模式（CURRENT·NEXT·SCRIPT·TIMER 四磁吸卡）/
 *       ?preview=N 单页预览（iframe 用，零重载切页）/
 *       BroadcastChannel 双窗口同步 / 舞台等比缩放
 * ============================================================ */
(() => {
  const qs = new URLSearchParams(location.search);
  const PREVIEW = qs.has('preview');
  const PRESENTER = qs.get('presenter') === '1';
  const stage = document.getElementById('deck-stage');
  const slides = Array.from(document.querySelectorAll('.slide'));
  const N = slides.length;
  let idx = 0;

  /* ---------- 舞台缩放 ---------- */
  function fit() {
    const s = Math.min(innerWidth / 1280, innerHeight / 720);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }
  addEventListener('resize', fit);

  /* ---------- chrome 注入（页眉/页脚/页码/进度条） ---------- */
  function injectChrome() {
    if (PREVIEW) return;
    slides.forEach((sl, i) => {
      if (!sl.classList.contains('cover')) {
        const hd = document.createElement('div');
        hd.className = 'deck-header';
        const brand = document.createElement('span');
        brand.className = 'brand';
        const dot = document.createElement('span');
        dot.className = 'dot';
        brand.append(dot, document.createTextNode('智能问数分析系统 · 功能培训'));
        const ver = document.createElement('span');
        ver.textContent = 'NL2SQL Pro v0.4.0';
        hd.append(brand, ver);
        sl.appendChild(hd);
      }
      const ft = document.createElement('div');
      ft.className = 'deck-footer';
      ft.append(Object.assign(document.createElement('span'), { textContent: '内部培训材料' }), Object.assign(document.createElement('span'), { textContent: '← → 翻页 · S 演讲者视图 · O 总览 · N 备注' }));
      sl.appendChild(ft);
      const no = document.createElement('div');
      no.className = 'slide-number';
      no.textContent = `${i + 1} / ${N}`;
      sl.appendChild(no);
    });
    const bar = document.createElement('div');
    bar.id = 'progress';
    document.body.appendChild(bar);
  }

  /* ---------- 翻页 ---------- */
  function goto(i, broadcast = true) {
    idx = Math.max(0, Math.min(N - 1, i));
    slides.forEach((s, k) => s.classList.toggle('is-active', k === idx));
    const bar = document.getElementById('progress');
    if (bar) bar.style.width = `${((idx + 1) / N) * 100}%`;
    history.replaceState(null, '', `#/${idx + 1}`);
    if (broadcast && chan) chan.postMessage({ type: 'goto', idx, from: who });
    updateDrawer();
    if (typeof onSlideChange === 'function') onSlideChange(idx);
  }
  const next = () => goto(idx + 1);
  const prev = () => goto(idx - 1);

  /* ---------- 跨窗口同步 ---------- */
  let chan = null;
  const who = PRESENTER ? 'presenter' : (PREVIEW ? 'preview' : 'audience');
  try {
    chan = new BroadcastChannel('sdas-training-deck');
    chan.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'goto' && d.from !== who) goto(d.idx, false);
    };
  } catch { /* BroadcastChannel 不可用时退化为单窗口 */ }

  /* iframe 预览控制：父窗口（演讲者）向 iframe postMessage 切页 */
  addEventListener('message', (e) => {
    if (e.data && e.data.type === 'preview-goto') goto(e.data.idx, false);
  });

  /* ---------- 备注抽屉（N） ---------- */
  let drawer = null;
  function ensureDrawer() {
    if (drawer) return;
    drawer = document.createElement('div');
    drawer.id = 'notes-drawer';
    document.body.appendChild(drawer);
  }
  function updateDrawer() {
    if (!drawer || !drawer.classList.contains('open')) return;
    const notes = slides[idx].querySelector('.notes');
    const hd = document.createElement('div');
    hd.className = 'hd';
    hd.textContent = `备注 · 第 ${idx + 1} 页`;
    const body = document.createElement('div');
    body.style.whiteSpace = 'pre-line';
    body.textContent = notes ? notes.textContent.trim() : '（本页无备注）';
    drawer.replaceChildren(hd, body);
  }
  function toggleDrawer() {
    ensureDrawer();
    drawer.classList.toggle('open');
    updateDrawer();
  }

  /* ---------- 总览（O） ---------- */
  function toggleOverview() {
    document.body.classList.toggle('overview');
    if (document.body.classList.contains('overview')) {
      slides.forEach((s, k) => {
        s.onclick = () => { document.body.classList.remove('overview'); s.onclick = null; goto(k); };
      });
    }
  }

  /* ---------- 键盘 ---------- */
  addEventListener('keydown', (e) => {
    if (PREVIEW) return;
    const k = e.key;
    if (k === 'ArrowRight' || k === ' ' || k === 'PageDown' || k === 'Enter') { e.preventDefault(); next(); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); prev(); }
    else if (k === 'Home') goto(0);
    else if (k === 'End') goto(N - 1);
    else if (k === 'f' || k === 'F') { document.documentElement.requestFullscreen?.().catch(() => {}); }
    else if (k === 'o' || k === 'O') toggleOverview();
    else if (k === 'n' || k === 'N') toggleDrawer();
    else if (k === 's' || k === 'S') openPresenter();
    else if (k === 'Escape') {
      document.body.classList.remove('overview');
      drawer && drawer.classList.remove('open');
    }
  });

  /* ---------- 演讲者模式（S） ---------- */
  function openPresenter() {
    if (PREVIEW || PRESENTER) return;
    const base = location.pathname.split('/').pop();
    window.open(`${base}?presenter=1`, 'sdas-presenter', 'width=1160,height=760');
  }

  let onSlideChange = null;

  function buildPresenter() {
    document.body.classList.add('presenter-mode');
    const app = document.createElement('div');
    app.className = 'presenter-app';
    document.body.appendChild(app);

    const cards = [
      { id: 'current', title: '🔵 CURRENT · 当前页' },
      { id: 'next', title: '🟣 NEXT · 下一页' },
      { id: 'script', title: '🟠 SPEAKER SCRIPT · 逐字稿' },
      { id: 'timer', title: '🟢 TIMER · 计时' },
    ];
    const defaults = {
      current: { left: 24, top: 20, width: 560, height: 330 },
      next: { left: 610, top: 20, width: 560, height: 330 },
      script: { left: 24, top: 368, width: 560, height: 360 },
      timer: { left: 610, top: 368, width: 560, height: 360 },
    };
    const els = {};
    const base = location.pathname.split('/').pop();

    for (const c of cards) {
      const el = document.createElement('div');
      el.className = 'pcard';
      const pos = load(c.id) || defaults[c.id];
      Object.assign(el.style, { left: pos.left + 'px', top: pos.top + 'px', width: pos.width + 'px', height: pos.height + 'px' });
      const hd = document.createElement('div');
      hd.className = 'hd';
      hd.textContent = c.title;
      const bd = document.createElement('div');
      bd.className = 'bd';
      const rsz = document.createElement('div');
      rsz.className = 'rsz';
      el.append(hd, bd, rsz);
      app.appendChild(el);
      els[c.id] = el;
      makeDraggable(el, c.id);
      makeResizable(el, c.id);
    }

    const ifCur = document.createElement('iframe');
    ifCur.src = `${base}?preview=1`;
    els.current.querySelector('.bd').appendChild(ifCur);
    const ifNext = document.createElement('iframe');
    ifNext.src = `${base}?preview=2`;
    els.next.querySelector('.bd').appendChild(ifNext);
    const scriptEl = document.createElement('div');
    scriptEl.className = 'script';
    els.script.querySelector('.bd').appendChild(scriptEl);

    /* TIMER */
    const tWrap = els.timer.querySelector('.bd');
    const tTime = document.createElement('div'); tTime.className = 't'; tTime.textContent = '00:00';
    const tMeta = document.createElement('div'); tMeta.className = 'meta'; tMeta.textContent = `第 1 / ${N} 页`;
    const tRow = document.createElement('div'); tRow.className = 'row';
    for (const [label, act] of [['← 上一页', 'prev'], ['R 重置', 'reset'], ['下一页 →', 'next']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.a = act;
      tRow.appendChild(b);
    }
    const tBox = document.createElement('div');
    tBox.className = 'timer';
    tBox.append(tTime, tMeta, tRow);
    tWrap.appendChild(tBox);
    let t0 = Date.now();
    setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000);
      tTime.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
    tWrap.addEventListener('click', (e) => {
      const a = e.target?.dataset?.a;
      if (a === 'reset') t0 = Date.now();
      if (a === 'next') goto(idx + 1);
      if (a === 'prev') goto(idx - 1);
    });

    addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') goto(idx + 1);
      else if (e.key === 'ArrowLeft') goto(idx - 1);
      else if (e.key === 'r' || e.key === 'R') t0 = Date.now();
      else if (e.key === 'Escape') window.close();
    });

    onSlideChange = (i) => {
      ifCur.contentWindow?.postMessage({ type: 'preview-goto', idx: i }, '*');
      ifNext.contentWindow?.postMessage({ type: 'preview-goto', idx: Math.min(i + 1, N - 1) }, '*');
      const notes = slides[i].querySelector('.notes');
      scriptEl.textContent = notes ? notes.textContent.trim() : '（本页无逐字稿）';
      scriptEl.scrollTop = 0;
      tMeta.textContent = `第 ${i + 1} / ${N} 页`;
    };

    function load(id) {
      try { const v = localStorage.getItem('sdas-pcard-' + id); return v ? JSON.parse(v) : null; } catch { return null; }
    }
    function save(id, el) {
      try { localStorage.setItem('sdas-pcard-' + id, JSON.stringify({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight })); } catch {}
    }
    function makeDraggable(el, id) {
      const hd = el.querySelector('.hd');
      hd.addEventListener('mousedown', (e) => {
        const ox = e.clientX - el.offsetLeft, oy = e.clientY - el.offsetTop;
        const mv = (ev) => { el.style.left = Math.max(0, ev.clientX - ox) + 'px'; el.style.top = Math.max(0, ev.clientY - oy) + 'px'; };
        const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); save(id, el); };
        addEventListener('mousemove', mv); addEventListener('mouseup', up);
        e.preventDefault();
      });
    }
    function makeResizable(el, id) {
      const rz = el.querySelector('.rsz');
      rz.addEventListener('mousedown', (e) => {
        const ow = el.offsetWidth, oh = el.offsetHeight, sx = e.clientX, sy = e.clientY;
        const mv = (ev) => { el.style.width = Math.max(260, ow + ev.clientX - sx) + 'px'; el.style.height = Math.max(160, oh + ev.clientY - sy) + 'px'; };
        const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); save(id, el); };
        addEventListener('mousemove', mv); addEventListener('mouseup', up);
        e.preventDefault(); e.stopPropagation();
      });
    }
  }

  /* ---------- 启动 ---------- */
  injectChrome();
  fit();

  if (PRESENTER) {
    buildPresenter();
    const h = parseInt((location.hash.match(/#\/(\d+)/) || [])[1], 10);
    goto(Number.isFinite(h) ? h - 1 : 0, false);
    onSlideChange(idx);
    return;
  }

  const h = parseInt((location.hash.match(/#\/(\d+)/) || [])[1], 10);
  if (PREVIEW) {
    const p = parseInt(qs.get('preview'), 10);
    goto(Number.isFinite(p) ? p - 1 : (Number.isFinite(h) ? h - 1 : 0), false);
    document.getElementById('progress')?.remove();
    return;
  }
  goto(Number.isFinite(h) ? h - 1 : 0, false);
})();
