/**
 * The in-page authoring overlay for `yarn record`.
 *
 * `overlayMain` is serialised with `.toString()` and injected into every
 * document the recorder opens, so it must be entirely self-contained: no
 * imports, no references to anything outside its own body. Node owns all
 * state; the page is a dumb emitter and renderer. Every user action calls
 * `window.__omsEvent(...)`, Node updates the shot and returns the new state,
 * and the overlay re-renders from that. That is what lets the recording
 * survive a full navigation - the overlay is rebuilt from Node's copy.
 *
 * Modes:
 *   record    clicks and typing become `steps`
 *   region    hover highlights the capture regions under the cursor, click selects
 *   annotate  pick a type, click an anchor element, choose a direction
 *   pause     the app behaves normally, nothing is recorded
 */

export function overlayMain(cfg) {
  const NS = 'http://www.w3.org/2000/svg';
  const ID = '__oms_rec';
  let mode = 'pause';
  let annType = 'arrow';
  let annFrom = 'below-left';
  let state = null;
  let pendingFill = null; // { el, selector }
  let lastPath = location.pathname;
  let hoverBox = null;
  // Direct references, not id lookups: when a dialog hosting the panel is
  // unmounted, the panel is detached with it and getElementById returns null.
  let barEl = null;
  let layerEl = null;

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') Object.assign(n.style, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids) n.append(kid);
    return n;
  };

  // ---------------------------------------------------------------- selectors
  /**
   * A selector the shoot runner can replay in four languages: prefer a
   * data-testid on the element or its nearest ancestor, then anchor inside an
   * open dialog, otherwise a structural path. `stable` tells the UI which.
   */
  function selectorFor(target) {
    const parts = [];
    let node = target;
    while (node && node !== document.body && node.nodeType === 1) {
      const tid = node.getAttribute('data-testid');
      if (tid) {
        parts.unshift(`[data-testid="${tid}"]`);
        return { selector: parts.join(' > '), stable: true };
      }
      if (node.tagName === 'DIALOG' && node.hasAttribute('open')) {
        parts.unshift('dialog[open]');
        return { selector: parts.join(' > '), stable: true };
      }
      if (node.getAttribute('role') === 'menu') {
        parts.unshift('[role="menu"]');
        return { selector: parts.join(' > '), stable: true };
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      const sibs = parent ? [...parent.children].filter((c) => c.tagName === node.tagName) : [];
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(node) + 1})` : tag);
      node = parent;
    }
    return { selector: parts.join(' > '), stable: false };
  }

  /** The element the user means - climb from text nodes/icons to the control. */
  function controlFor(target) {
    return (
      target.closest('button, a, input, select, textarea, [role="menuitem"], [role="option"], [data-testid], li, tr') ||
      target
    );
  }

  const inOverlay = (t) => !!(t && t.closest && t.closest(`#${ID}_bar, #${ID}_layer`));

  // -------------------------------------------------------------------- state
  async function send(evt) {
    state = await window.__omsEvent(evt);
    render();
    if (state?.annotate?.length && window.__omsRender) {
      window.__omsRender({ annotations: state.annotate, style: cfg.style });
    } else {
      document.getElementById('__oms_shot_overlay__')?.remove();
    }
    return state;
  }

  // ---------------------------------------------------------------- recording
  // Hotkeys - Ctrl+Alt+letter, matched on e.code because on macOS Alt+letter
  // turns e.key into a symbol ('®' for R). Handled before anything else so the
  // app never sees them, and so they work with a dialog or menu open, when a
  // click on the panel would risk dismissing it.
  const HOTKEYS = { KeyR: 'record', KeyG: 'region', KeyA: 'annotate', KeyP: 'pause', KeyS: 'save' };
  function onHotkey(e) {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.altKey || e.metaKey) return false;
    const action = HOTKEYS[e.code];
    if (!action) return false;
    e.preventDefault();
    e.stopPropagation();
    if (action === 'save') send({ type: 'save' });
    else setMode(action);
    return true;
  }

  function onCapture(e) {
    if (onHotkey(e)) return;
    if (inOverlay(e.target)) return;
    // Escape always backs out of a pick mode without touching the app.
    if (e.type === 'keydown' && e.key === 'Escape' && (mode === 'region' || mode === 'annotate')) {
      e.preventDefault();
      e.stopPropagation();
      setMode('pause');
      return;
    }
    if (mode === 'pause') return;

    if (mode === 'record') {
      if (e.type === 'click') {
        flushFill();
        const c = controlFor(e.target);
        const { selector, stable } = selectorFor(c);
        const dialogsBefore = document.querySelectorAll('dialog[open]').length;
        const menusBefore = document.querySelectorAll('[role="menu"]').length;
        send({ type: 'step', step: { click: selector }, stable, label: labelOf(c) });
        // Did the click open something? Then the replay needs to wait for it.
        setTimeout(() => {
          if (document.querySelectorAll('dialog[open]').length > dialogsBefore) {
            send({ type: 'step', step: { waitFor: 'dialog[open]' }, stable: true, auto: true });
          } else if (document.querySelectorAll('[role="menu"]').length > menusBefore) {
            send({ type: 'step', step: { waitFor: '[role="menu"]' }, stable: true, auto: true });
          }
        }, 450);
      }
      if (e.type === 'input') {
        const t = e.target;
        if (!t || t.type === 'password') return;
        const { selector } = selectorFor(t);
        pendingFill = { el: t, selector };
      }
      if (e.type === 'keydown' && e.key === 'Enter') {
        flushFill();
        send({ type: 'step', step: { press: 'Enter' }, stable: true });
      }
      return;
    }

    // Pick modes: the app must not react at all. `click` alone is not enough -
    // focus moves and rows select on pointerdown/mousedown, before click fires.
    if (e.type === 'pointerdown' || e.type === 'mousedown') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.type === 'click') {
      e.preventDefault();
      e.stopPropagation();
      const c = controlFor(e.target);
      if (mode === 'region') pickRegion(e.clientX, e.clientY, c);
      if (mode === 'annotate') pickAnchor(c);
    }
  }

  function flushFill() {
    if (!pendingFill) return;
    const { el: t, selector } = pendingFill;
    pendingFill = null;
    if (!t.value) return;
    send({ type: 'step', step: { fill: { selector, text: t.value } }, stable: selector.includes('data-testid') });
  }

  function labelOf(node) {
    return (node.getAttribute('title') || node.getAttribute('aria-label') || node.innerText || node.value || '')
      .trim()
      .split('\n')[0]
      .slice(0, 40);
  }

  // Route changes are steps too - a click on a row that opens a record is
  // what `openFirstRow` stands for.
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (mode === 'record') send({ type: 'navigate', path: location.pathname });
    }
  }, 300);

  // ------------------------------------------------------------ region picking
  /**
   * All region boxes containing the point, smallest first.
   *
   * The recorder's own panels are `popover` elements covering the viewport,
   * so without the exclusion below the `menu` region (`[popover]:popover-open`)
   * matched the recorder itself and every hover read "region: menu".
   */
  const OURS = `#${ID}_bar, #${ID}_layer, #__oms_shot_overlay__`;
  function regionsAt(x, y) {
    const hits = [];
    for (const name of cfg.regionOrder) {
      const sel = cfg.regions[name];
      if (!sel) continue;
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      for (const n of nodes) {
        if (n.closest(OURS)) continue;
        const r = n.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) {
          hits.push({ name, node: n, rect: r, area: r.width * r.height });
        }
      }
    }
    hits.sort((a, b) => a.area - b.area);
    return hits;
  }

  function onMove(e) {
    if (mode !== 'region' && mode !== 'annotate') return hideHover();
    if (inOverlay(e.target)) return hideHover();
    if (mode === 'region') {
      const hits = regionsAt(e.clientX, e.clientY);
      if (hits.length) return showHover(hits[0].rect, `region: ${hits[0].name}`, '#2f6fed');
      const c = controlFor(e.target);
      const { selector, stable } = selectorFor(c);
      return showHover(c.getBoundingClientRect(), `clip: ${selector}`, stable ? '#2f6fed' : '#c0392b');
    }
    const c = controlFor(e.target);
    const { selector, stable } = selectorFor(c);
    showHover(c.getBoundingClientRect(), `${annType} → ${selector}`, stable ? '#e35f2a' : '#c0392b');
  }

  function pickRegion(x, y, c) {
    const hits = regionsAt(x, y);
    if (hits.length) {
      send({ type: 'region', region: hits[0].name, clip: null });
    } else {
      const { selector, stable } = selectorFor(c);
      send({ type: 'region', region: 'control', clip: selector, stable });
    }
    setMode('pause');
  }

  // --------------------------------------------------------------- annotating
  function pickAnchor(c) {
    const { selector, stable } = selectorFor(c);
    const a = { type: annType };
    if (annType === 'arrow') Object.assign(a, { to: selector, from: annFrom, length: 110 });
    if (annType === 'ring' || annType === 'box') a.around = selector;
    if (annType === 'label') Object.assign(a, { at: selector, from: annFrom });
    if (annType === 'number') Object.assign(a, { at: selector, from: annFrom, index: (state?.annotate?.length ?? 0) + 1 });
    if (annType === 'arrow' || annType === 'label') {
      const text = window.prompt(annType === 'label' ? 'Label text:' : 'Caption at the arrow tail (blank for none):', '');
      if (text === null) return;
      if (text) a.text = text;
    }
    send({ type: 'annotation', annotation: a, stable });
  }

  // ---------------------------------------------------------------- highlight
  function ensureLayer() {
    if (!layerEl) {
      layerEl = el('div', { id: `${ID}_layer`, popover: 'manual', style: {
        position: 'fixed', inset: '0', width: '100vw', height: '100vh', margin: '0', padding: '0', border: '0',
        background: 'transparent', pointerEvents: 'none', overflow: 'visible',
      } });
    }
    if (!layerEl.isConnected) reparentIntoDialog();
    return layerEl;
  }
  function showHover(r, text, colour) {
    const layer = ensureLayer();
    if (!hoverBox) {
      hoverBox = el('div', { style: { position: 'absolute', border: '2px solid', borderRadius: '4px', boxSizing: 'border-box', pointerEvents: 'none' } },
        el('span', { style: { position: 'absolute', left: '0', top: '-22px', font: '12px/18px -apple-system, sans-serif', color: '#fff', padding: '0 6px', borderRadius: '3px', whiteSpace: 'nowrap', maxWidth: '70vw', overflow: 'hidden', textOverflow: 'ellipsis' } }));
      layer.appendChild(hoverBox);
    }
    Object.assign(hoverBox.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px', borderColor: colour, display: 'block' });
    const tag = hoverBox.firstChild;
    tag.textContent = text;
    tag.style.background = colour;
    tag.style.top = r.y < 24 ? r.height + 'px' : '-22px';
  }
  function hideHover() { if (hoverBox) hoverBox.style.display = 'none'; }

  // ------------------------------------------------------------------ toolbar
  /** Drag the panel by its header. Clamped to the viewport; position saved to Node on release. */
  function startDrag(e) {
    if (e.target.closest('button')) return; // the collapse button lives in the header
    const bar = barEl;
    const r = bar.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    bar.style.right = 'auto';
    const move = (ev) => {
      const x = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx));
      const y = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy));
      bar.style.left = x + 'px';
      bar.style.top = y + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      const rr = bar.getBoundingClientRect();
      send({ type: 'ui', ui: { pos: { x: Math.round(rr.left), y: Math.round(rr.top) } } });
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    e.preventDefault();
  }

  function setMode(m) {
    if (mode === 'record' && m !== 'record') flushFill();
    mode = m;
    hideHover();
    render();
  }

  /**
   * Keep the panel INSIDE the topmost open dialog.
   *
   * Apps close a modal when a pointer event lands outside it - typically
   * `if (!dialog.contains(e.target)) close()`. The panel floats above the
   * dialog but used to live under <body>, so clicking Region or Save closed
   * the very modal being captured. Parenting the panel into the dialog makes
   * that containment check pass in every event phase. It moves back to <body>
   * when the dialog closes or is unmounted. Re-parenting drops a popover out of
   * the top layer, so it is re-shown after each move.
   */
  function hostForPanels() {
    const dialogs = [...document.querySelectorAll('dialog[open]')].filter((d) => !d.closest(OURS));
    return dialogs.at(-1) || document.body;
  }
  function reparentIntoDialog() {
    const host = hostForPanels();
    for (const node of [layerEl, barEl]) { // layer first so the bar ends up on top
      if (!node) continue;
      if (!node.isConnected || node.parentElement !== host) {
        host.appendChild(node);
        try { node.showPopover(); } catch { /* already open or unsupported */ }
      }
    }
  }
  let reparentQueued = false;
  const observer = new MutationObserver(() => {
    if (reparentQueued) return;
    reparentQueued = true;
    requestAnimationFrame(() => { reparentQueued = false; reparentIntoDialog(); });
  });

  function render() {
    if (!barEl) {
      barEl = el('div', { id: `${ID}_bar`, popover: 'manual', style: {
        position: 'fixed', top: '12px', right: '12px', left: 'auto', bottom: 'auto', margin: '0', width: '340px', maxHeight: '90vh', overflow: 'auto',
        background: '#1f2328', color: '#e6e6e6', font: '12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif',
        borderRadius: '10px', boxShadow: '0 8px 30px rgba(0,0,0,.45)', padding: '10px', border: '0', pointerEvents: 'auto',
      } });
      // Belt and braces: bubble-phase listeners on document must never see a
      // panel interaction as a click "outside" whatever the app has open.
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend']) {
        barEl.addEventListener(type, (e) => e.stopPropagation());
      }
    }
    const bar = barEl;
    // First render, or the hosting dialog was unmounted from under us.
    if (!bar.isConnected) reparentIntoDialog();
    bar.replaceChildren();
    const s = state || {};
    const ui = s.ui || {};
    // Position is owned by Node so it survives a navigation; the default
    // top-right only applies until the user has dragged it once.
    if (ui.pos) Object.assign(bar.style, { left: ui.pos.x + 'px', top: ui.pos.y + 'px', right: 'auto' });

    // type=button matters now that the panel can live inside a dialog's <form>:
    // a bare <button> defaults to submit and would post the app's form.
    const btn = (text, on, active, colour) => el('button', {
      type: 'button',
      onclick: on,
      style: { font: 'inherit', padding: '4px 8px', borderRadius: '6px', border: '1px solid #444', cursor: 'pointer',
        background: active ? (colour || '#2f6fed') : '#2b3138', color: active ? '#fff' : '#ddd', marginRight: '4px', marginBottom: '4px' },
    }, text);
    const row = (...kids) => el('div', { style: { margin: '6px 0' } }, ...kids);
    const h = (t) => el('div', { style: { fontWeight: '600', margin: '10px 0 4px', color: '#9ab' } }, t);
    const code = (t, ok = true) => el('code', { style: { color: ok ? '#9fe3a5' : '#ff9c8a', wordBreak: 'break-all' } }, t);

    bar.append(
      el('div', { onpointerdown: startDrag, title: 'Drag to move',
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'move', userSelect: 'none', margin: '-4px -4px 4px', padding: '4px' } },
        el('strong', {}, '⠿ Screenshot recorder'),
        el('span', {},
          el('span', { style: { color: '#9ab', marginRight: '8px' } }, mode.toUpperCase()),
          btn(ui.collapsed ? '＋' : '－', () => send({ type: 'ui', ui: { collapsed: !ui.collapsed } }), false))),
    );
    if (ui.collapsed) return;

    const HINT = {
      record: 'Use the app - clicks and typing are being recorded as steps.',
      region: 'Hover the page: regions light up with their names. Click to choose. Esc cancels.',
      annotate: 'Pick a type and direction below, then click the element to anchor to. Esc cancels.',
      pause: 'Nothing is recorded. Use this to get the app into position.',
    };
    bar.append(
      row(
        btn('● Record', () => setMode('record'), mode === 'record', '#c0392b'),
        btn('▭ Region', () => setMode('region'), mode === 'region'),
        btn('➚ Annotate', () => setMode('annotate'), mode === 'annotate', '#e35f2a'),
        btn('❚❚ Pause', () => setMode('pause'), mode === 'pause', '#555')),
      row(el('em', { style: { color: '#9ab' } }, HINT[mode])),
      row(el('span', { style: { color: '#789', fontSize: '11px' } },
        'Keys: Ctrl+Alt+R record · G region · A annotate · P pause · S save — use these while a menu or dialog is open')),
    );

    bar.append(h('Shot'),
      row(el('label', {}, 'id ', el('input', { value: s.id || '', placeholder: 'e.g. patient-search',
        oninput: (e) => { clearTimeout(bar._t); bar._t = setTimeout(() => send({ type: 'id', id: e.target.value }), 400); },
        style: { font: 'inherit', width: '220px', background: '#0f1216', color: '#fff', border: '1px solid #444', borderRadius: '4px', padding: '2px 6px' } }))),
      row('route: ', code(s.route || '?'), s.store ? el('span', {}, '  store: ', code(s.store)) : ''),
    );

    bar.append(h('Region'),
      row(s.region ? code(s.region) : el('em', { style: { color: '#888' } }, 'not chosen - click Region, then click the screen'),
        s.clip ? el('div', {}, 'clip: ', code(s.clip, s.clipStable !== false)) : ''),
      s.region ? row('pad ', el('input', { type: 'number', value: s.pad ?? '', placeholder: 'auto', style: { width: '60px', font: 'inherit', background: '#0f1216', color: '#fff', border: '1px solid #444', borderRadius: '4px' },
        onchange: (e) => send({ type: 'pad', pad: e.target.value === '' ? null : Number(e.target.value) }) })) : '');

    bar.append(h(`Steps (${(s.steps || []).length})`));
    (s.steps || []).forEach((st, i) => bar.append(row(
      btn('×', () => send({ type: 'removeStep', index: i }), false),
      code(JSON.stringify(st.step), st.stable !== false),
      st.auto ? el('span', { style: { color: '#9ab' } }, '  (auto)') : '')));
    if (s.openFirstRow) bar.append(row(code('openFirstRow: true')));

    bar.append(h(`Annotations (${(s.annotate || []).length})`));
    if (mode === 'annotate') {
      bar.append(row(...['arrow', 'ring', 'box', 'label', 'number'].map((t) => btn(t, () => { annType = t; render(); }, annType === t, '#e35f2a'))));
      if (annType !== 'ring' && annType !== 'box') {
        bar.append(row(el('span', { style: { color: '#9ab' } }, 'from: '),
          ...['above-left', 'above', 'above-right', 'left', 'right', 'below-left', 'below', 'below-right'].map((d) =>
            btn(d, () => { annFrom = d; render(); }, annFrom === d, '#e35f2a'))));
      }
      bar.append(row(el('em', { style: { color: '#888' } }, 'now click the element to anchor to')));
    }
    (s.annotate || []).forEach((a, i) => bar.append(row(
      btn('×', () => send({ type: 'removeAnnotation', index: i }), false),
      code(JSON.stringify(a)))));

    bar.append(h('Output'),
      row(btn('💾 Save shot', () => send({ type: 'save' }), true, '#2e8b57'),
        btn(s.closeArmed ? '⚠ Close and discard' : 'Close recorder', () => send({ type: 'done' }), false, s.closeArmed ? '#c0392b' : undefined)),
      s.savedTo ? row(el('span', { style: { color: '#9fe3a5' } }, 'saved → ' + s.savedTo)) : '',
      s.error ? row(el('span', { style: { color: '#ff9c8a' } }, s.error)) : '');
  }

  // -------------------------------------------------------------------- boot
  function boot() {
    window.addEventListener('click', onCapture, true);
    window.addEventListener('pointerdown', onCapture, true);
    window.addEventListener('mousedown', onCapture, true);
    window.addEventListener('input', onCapture, true);
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('mousemove', onMove, true);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    window.__oms = { setMode, setAnnotationType: (t) => { annType = t; }, setFrom: (d) => { annFrom = d; }, pickAt: (x, y) => pickRegion(x, y, controlFor(document.elementFromPoint(x, y))), selectorFor, getMode: () => mode };
    window.__omsGetState().then((s) => { state = s; render(); if (s?.annotate?.length && window.__omsRender) window.__omsRender({ annotations: s.annotate, style: cfg.style }); });
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
}
