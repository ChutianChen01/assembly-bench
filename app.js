/* ==========================================================
   AssemblyBench — interactive logic
   ========================================================== */
(function () {
  'use strict';

  // ------- State -------
  /** @type {Array<{uid:string,id?:string,type:string,name:string,sequence:string,summary?:string}>} */
  let assembly = [];
  let activeFilter = 'all';
  let currentView = 'linear'; // 'linear' | 'circular'
  let editingUid = null; // uid of part being edited, or '__new__' for a brand-new custom part

  const meta = window.PART_TYPE_META;
  const library = window.PART_LIBRARY;
  const example = window.EXAMPLE_ASSEMBLY;

  // ------- Utilities -------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const uid = () => 'p' + Math.random().toString(36).slice(2, 9);

  /** Strip everything that isn't A/T/G/C/N from a pasted blob; also strip FASTA headers. */
  function cleanSequence(raw) {
    if (!raw) return '';
    // Remove FASTA header lines
    const noHeader = raw
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('>'))
      .join('');
    return noHeader.toUpperCase().replace(/[^ATGCN]/g, '');
  }

  function totalBp() {
    return assembly.reduce((sum, p) => sum + p.sequence.length, 0);
  }

  function formatBp(n) {
    if (n < 1000) return `${n} bp`;
    return `${(n / 1000).toFixed(2)} kb`;
  }

  // ------- Library rendering -------
  function renderLibrary() {
    const list = $('#libraryList');
    list.innerHTML = '';
    const items = library.filter((p) => activeFilter === 'all' || p.type === activeFilter);

    if (items.length === 0) {
      list.innerHTML = '<li class="muted small" style="padding:8px 4px;">No parts in this category yet.</li>';
      return;
    }

    for (const part of items) {
      const li = document.createElement('li');
      li.className = 'library-item';
      const c = meta[part.type]?.color || '#94a3b8';
      li.innerHTML = `
        <span class="li-swatch" style="--c:${c}"></span>
        <span class="li-text">
          <span class="li-name">${escapeHTML(part.name)}</span>
          <span class="li-meta">${meta[part.type]?.label || part.type} · ${part.sequence.length} bp</span>
        </span>
        <button type="button" data-add="${part.id}" title="Add to assembly">+ Add</button>
      `;
      attachTooltip(li, () => `<strong>${escapeHTML(part.name)}</strong><br>${escapeHTML(part.summary || '')}`);
      list.appendChild(li);
    }
  }

  // ------- Track rendering -------
  function renderTrack() {
    const track = $('#track');
    track.innerHTML = '';
    if (assembly.length === 0) {
      track.dataset.empty = 'true';
      track.innerHTML = '<p class="track-empty">Your assembly is empty. Add parts from the library on the left to begin.</p>';
    } else {
      track.dataset.empty = 'false';
      assembly.forEach((p, i) => {
        if (i > 0) {
          const sep = document.createElement('div');
          sep.className = 'track-divider';
          track.appendChild(sep);
        }
        track.appendChild(buildTrackPart(p));
      });
    }
    updateStats();
    renderCircular();
    runValidation();
  }

  function buildTrackPart(p) {
    const el = document.createElement('div');
    el.className = 'track-part';
    el.draggable = true;
    el.dataset.uid = p.uid;
    const c = meta[p.type]?.color || '#94a3b8';
    el.style.setProperty('--c', c);
    el.innerHTML = `
      <span class="tp-type">${escapeHTML(meta[p.type]?.label || p.type)}</span>
      <span class="tp-name">${escapeHTML(p.name)}</span>
      <span class="tp-bp">${p.sequence.length} bp</span>
      <span class="tp-arrow" aria-hidden="true"></span>
    `;
    el.title = 'Click to edit · drag to reorder';

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditor(p.uid);
    });

    // Drag to reorder
    el.addEventListener('dragstart', (e) => {
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/uid', p.uid);
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));

    attachTooltip(el, () => {
      const m = meta[p.type];
      return `<strong>${escapeHTML(p.name)}</strong><br>${escapeHTML(m?.tip || '')}`;
    });

    return el;
  }

  function setupTrackDnD() {
    const track = $('#track');

    track.addEventListener('dragover', (e) => {
      e.preventDefault();
      track.classList.add('is-drop-target');
      e.dataTransfer.dropEffect = 'move';
    });
    track.addEventListener('dragleave', (e) => {
      if (e.target === track) track.classList.remove('is-drop-target');
    });
    track.addEventListener('drop', (e) => {
      e.preventDefault();
      track.classList.remove('is-drop-target');
      const draggedUid = e.dataTransfer.getData('text/uid');
      if (!draggedUid) return;
      const draggedIdx = assembly.findIndex((p) => p.uid === draggedUid);
      if (draggedIdx === -1) return;

      // Figure out where to insert based on cursor position
      const parts = $$('.track-part', track).filter((el) => el.dataset.uid !== draggedUid);
      let insertBefore = parts.length; // default: end
      for (let i = 0; i < parts.length; i++) {
        const r = parts[i].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) { insertBefore = i; break; }
      }

      const [moved] = assembly.splice(draggedIdx, 1);
      // Recompute insertion index relative to the trimmed array
      const others = assembly; // already without dragged
      // insertBefore is an index in the visual order of `others`
      assembly = others.slice(0, insertBefore).concat([moved]).concat(others.slice(insertBefore));
      renderTrack();
    });
  }

  // ------- Stats / validation -------
  function updateStats() {
    $('#plasmidStats').textContent = `${assembly.length} part${assembly.length === 1 ? '' : 's'} · ${formatBp(totalBp())}`;
  }

  function runValidation() {
    const v = $('#validator');
    v.innerHTML = '';

    if (assembly.length === 0) {
      addValidationRow(v, 'info', 'ℹ', 'Add parts from the library to start designing your plasmid.');
      return;
    }

    const types = assembly.map((p) => p.type);
    const has = (t) => types.includes(t);

    // Required parts for a working plasmid
    if (!has('origin'))     addValidationRow(v, 'err',  '✕', 'No origin of replication. Without an origin, the plasmid won\'t replicate in the host.');
    if (!has('resistance')) addValidationRow(v, 'err',  '✕', 'No resistance marker. You won\'t be able to select transformed cells.');
    if (!has('promoter'))   addValidationRow(v, 'warn', '!', 'No promoter detected. The gene won\'t be transcribed without one.');
    if (!has('cds'))        addValidationRow(v, 'warn', '!', 'No coding sequence (CDS). There\'s nothing here for the cell to express.');
    if (!has('terminator')) addValidationRow(v, 'warn', '!', 'No terminator. Transcription may run on into other parts of the plasmid.');
    if (!has('rbs') && has('cds') && has('promoter')) {
      addValidationRow(v, 'warn', '!', 'No RBS between your promoter and CDS. The ribosome may not bind efficiently.');
    }

    // Order checks (within a transcriptional unit)
    const order = ['promoter', 'rbs', 'cds', 'terminator'];
    const indices = order.map((t) => types.indexOf(t)).filter((i) => i >= 0);
    const sortedIndices = [...indices].sort((a, b) => a - b);
    if (indices.length >= 2 && indices.join(',') !== sortedIndices.join(',')) {
      addValidationRow(v, 'warn', '!', 'The order of your transcription parts looks unusual. The typical order is: promoter → RBS → CDS → terminator.');
    }

    // All good?
    if (v.children.length === 0) {
      addValidationRow(v, 'ok', '✓', 'Looks good! Your plasmid has all the essential parts in a sensible order.');
    }
  }

  function addValidationRow(parent, kind, icon, message) {
    const row = document.createElement('div');
    row.className = `v-row v-${kind}`;
    row.innerHTML = `<span class="v-ico">${icon}</span><span>${escapeHTML(message)}</span>`;
    parent.appendChild(row);
  }

  // ------- Circular view -------
  function renderCircular() {
    const svg = $('#circularSvg');
    svg.innerHTML = '';
    const R_OUTER = 130, R_INNER = 112, R_LABEL = 152;

    // Background circle
    const bg = svgEl('circle', { cx: 0, cy: 0, r: R_OUTER - 5, fill: '#f8fafc', stroke: '#e2e8f0', 'stroke-width': 1 });
    svg.appendChild(bg);

    if (assembly.length === 0) {
      const t = svgEl('text', { x: 0, y: 0, 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: '#94a3b8', 'font-family': 'Inter', 'font-size': 13 });
      t.textContent = 'Add parts to see a circular view';
      svg.appendChild(t);
      return;
    }

    const total = totalBp() || 1;
    let cursor = -Math.PI / 2; // start at the top
    const gapRad = assembly.length > 1 ? 0.015 : 0;

    assembly.forEach((p) => {
      const frac = p.sequence.length / total;
      const sweep = frac * Math.PI * 2 - gapRad;
      const start = cursor;
      const end = cursor + sweep;
      const color = meta[p.type]?.color || '#94a3b8';

      const path = svgEl('path', {
        d: annularArc(0, 0, R_INNER, R_OUTER, start, end),
        fill: color,
        opacity: 0.92,
        stroke: '#fff',
        'stroke-width': 1,
      });
      path.style.cursor = 'pointer';
      path.addEventListener('click', () => openEditor(p.uid));
      attachTooltip(path, () => `<strong>${escapeHTML(p.name)}</strong><br>${escapeHTML(meta[p.type]?.label || p.type)} · ${p.sequence.length} bp`);
      svg.appendChild(path);

      // Label
      if (frac > 0.04) {
        const mid = (start + end) / 2;
        const lx = Math.cos(mid) * R_LABEL;
        const ly = Math.sin(mid) * R_LABEL;
        const anchor = Math.cos(mid) > 0.2 ? 'start' : Math.cos(mid) < -0.2 ? 'end' : 'middle';
        const t = svgEl('text', {
          x: lx, y: ly,
          'text-anchor': anchor,
          'dominant-baseline': 'middle',
          'font-family': 'Inter',
          'font-size': 11,
          fill: '#111827',
        });
        t.textContent = p.name.length > 16 ? p.name.slice(0, 14) + '…' : p.name;
        svg.appendChild(t);
      }

      cursor = end + gapRad;
    });

    // Center label
    const name = $('#plasmidName').value || 'pPlasmid';
    const c1 = svgEl('text', { x: 0, y: -6, 'text-anchor': 'middle', 'font-family': 'Inter', 'font-weight': 700, 'font-size': 16, fill: '#111827' });
    c1.textContent = name;
    svg.appendChild(c1);
    const c2 = svgEl('text', { x: 0, y: 14, 'text-anchor': 'middle', 'font-family': 'JetBrains Mono', 'font-size': 11, fill: '#64748b' });
    c2.textContent = formatBp(total);
    svg.appendChild(c2);
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function annularArc(cx, cy, rIn, rOut, startAngle, endAngle) {
    const large = endAngle - startAngle > Math.PI ? 1 : 0;
    const x1 = cx + rOut * Math.cos(startAngle);
    const y1 = cy + rOut * Math.sin(startAngle);
    const x2 = cx + rOut * Math.cos(endAngle);
    const y2 = cy + rOut * Math.sin(endAngle);
    const x3 = cx + rIn  * Math.cos(endAngle);
    const y3 = cy + rIn  * Math.sin(endAngle);
    const x4 = cx + rIn  * Math.cos(startAngle);
    const y4 = cy + rIn  * Math.sin(startAngle);
    return [
      `M ${x1} ${y1}`,
      `A ${rOut} ${rOut} 0 ${large} 1 ${x2} ${y2}`,
      `L ${x3} ${y3}`,
      `A ${rIn} ${rIn} 0 ${large} 0 ${x4} ${y4}`,
      'Z',
    ].join(' ');
  }

  // ------- Editor dialog -------
  function openEditor(uidOrNew) {
    editingUid = uidOrNew;
    const dlg = $('#partDialog');
    const isNew = uidOrNew === '__new__';
    const p = isNew
      ? { uid: '__new__', type: 'cds', name: 'My custom part', sequence: '' }
      : assembly.find((x) => x.uid === uidOrNew);
    if (!p) return;
    $('#dialogTitle').textContent = isNew ? 'Add a custom part' : 'Edit part';
    $('#dialogName').value = p.name;
    $('#dialogType').value = p.type;
    $('#dialogSeq').value = p.sequence;
    updateSeqHint(p.sequence);
    $('#dialogDelete').style.display = isNew ? 'none' : '';
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => $('#dialogName').focus(), 50);
  }

  function closeEditor() {
    const dlg = $('#partDialog');
    if (dlg.open && typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
    editingUid = null;
  }

  function saveEditor() {
    const name = $('#dialogName').value.trim() || 'Untitled part';
    const type = $('#dialogType').value;
    const sequence = cleanSequence($('#dialogSeq').value);

    if (editingUid === '__new__') {
      assembly.push({ uid: uid(), type, name, sequence });
    } else {
      const p = assembly.find((x) => x.uid === editingUid);
      if (p) { p.name = name; p.type = type; p.sequence = sequence; }
    }
    closeEditor();
    renderTrack();
  }

  function deleteFromEditor() {
    if (editingUid && editingUid !== '__new__') {
      assembly = assembly.filter((x) => x.uid !== editingUid);
    }
    closeEditor();
    renderTrack();
  }

  function updateSeqHint(raw) {
    const cleaned = cleanSequence(raw);
    const stripped = raw.length - cleaned.length;
    $('#dialogSeqHint').textContent =
      `${cleaned.length} bp${stripped > 0 ? ` · ${stripped} non-ATGC character${stripped === 1 ? '' : 's'} will be ignored` : ''}`;
  }

  // ------- Add / clear / load example -------
  function addLibraryPart(id) {
    const src = library.find((p) => p.id === id);
    if (!src) return;
    assembly.push({
      uid: uid(),
      id: src.id,
      type: src.type,
      name: src.name,
      sequence: src.sequence,
      summary: src.summary,
    });
    renderTrack();
    // Briefly highlight the new last part
    requestAnimationFrame(() => {
      const last = $('#track .track-part:last-of-type');
      if (last) {
        last.animate(
          [{ transform: 'scale(1.08)' }, { transform: 'scale(1)' }],
          { duration: 220, easing: 'ease-out' }
        );
      }
    });
  }

  function loadExample() {
    assembly = example
      .map((id) => library.find((p) => p.id === id))
      .filter(Boolean)
      .map((p) => ({ uid: uid(), id: p.id, type: p.type, name: p.name, sequence: p.sequence, summary: p.summary }));
    $('#plasmidName').value = 'pGFP_demo';
    renderTrack();
  }

  function clearAll() {
    if (assembly.length === 0) return;
    if (!confirm('Clear the assembly track? This can\'t be undone.')) return;
    assembly = [];
    renderTrack();
  }

  // ------- Export -------
  function exportFASTA() {
    const name = ($('#plasmidName').value || 'pPlasmid').replace(/\s+/g, '_');
    if (assembly.length === 0) {
      alert('Add some parts before exporting.');
      return;
    }
    const fullSeq = assembly.map((p) => p.sequence).join('');
    const partList = assembly.map((p, i) => `Part ${i + 1}: ${p.name} (${meta[p.type]?.label || p.type}, ${p.sequence.length} bp)`).join('; ');

    const header = `>${name} | ${assembly.length} parts | ${fullSeq.length} bp | ${partList}`;
    const wrapped = fullSeq.match(/.{1,60}/g)?.join('\n') || '';
    const text = `${header}\n${wrapped}\n`;

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.fasta`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ------- View switching -------
  function setView(view) {
    currentView = view;
    $$('.view-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
    $('#trackWrap').hidden    = view !== 'linear';
    $('#circularWrap').hidden = view !== 'circular';
    if (view === 'circular') renderCircular();
  }

  // ------- Filter -------
  function setFilter(f) {
    activeFilter = f;
    $$('.chip').forEach((c) => c.classList.toggle('is-active', c.dataset.filter === f));
    renderLibrary();
  }

  // ------- Nav -------
  function setupNav() {
    // Mobile toggle
    const toggle = $('#navToggle');
    const links = $('.nav-links');
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    $$('.nav-links a, a[data-nav]').forEach((a) => {
      a.addEventListener('click', () => links.classList.remove('is-open'));
    });

    // Section spy
    const sections = ['intro', 'bench', 'find', 'grab']
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    const setActive = (id) => {
      $$('.nav-links a').forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === `#${id}`));
    };
    const obs = new IntersectionObserver(
      (entries) => {
        entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)
          .slice(0, 1)
          .forEach((e) => setActive(e.target.id));
      },
      { rootMargin: '-40% 0px -50% 0px', threshold: [0, 0.25, 0.5, 1] }
    );
    sections.forEach((s) => obs.observe(s));
  }

  // ------- Tooltip system -------
  const tip = {
    el: null,
    show(html, target) {
      if (!this.el) this.el = $('#tooltip');
      this.el.innerHTML = html;
      this.el.classList.add('is-visible');
      this.position(target);
    },
    position(target) {
      if (!this.el || !target) return;
      const r = target.getBoundingClientRect();
      const tr = this.el.getBoundingClientRect();
      let x = r.left + r.width / 2 - tr.width / 2;
      let y = r.top - tr.height - 10;
      if (y < 8) y = r.bottom + 10; // flip below
      x = Math.max(8, Math.min(window.innerWidth - tr.width - 8, x));
      this.el.style.left = x + 'px';
      this.el.style.top  = y + 'px';
    },
    hide() {
      if (this.el) this.el.classList.remove('is-visible');
    },
  };

  function attachTooltip(el, htmlFn) {
    el.addEventListener('mouseenter', () => tip.show(htmlFn(), el));
    el.addEventListener('mouseleave', () => tip.hide());
    el.addEventListener('focus', () => tip.show(htmlFn(), el));
    el.addEventListener('blur', () => tip.hide());
  }

  // ------- Helpers -------
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ------- Event wiring -------
  function bind() {
    // Library add buttons (event delegation)
    $('#libraryList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-add]');
      if (btn) addLibraryPart(btn.dataset.add);
    });

    // Filter chips
    $$('.chip').forEach((c) => c.addEventListener('click', () => setFilter(c.dataset.filter)));

    // View tabs
    $$('.view-tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

    // Workspace actions
    $('#loadExampleBtn').addEventListener('click', loadExample);
    $('#clearBtn').addEventListener('click', clearAll);
    $('#exportBtn').addEventListener('click', exportFASTA);
    $('#addCustomBtn').addEventListener('click', () => openEditor('__new__'));

    // Plasmid name change updates circular view label
    $('#plasmidName').addEventListener('input', () => {
      if (currentView === 'circular') renderCircular();
    });

    // Dialog buttons
    $('#dialogSave').addEventListener('click', saveEditor);
    $('#dialogCancel').addEventListener('click', closeEditor);
    $('#dialogClose').addEventListener('click', closeEditor);
    $('#dialogDelete').addEventListener('click', deleteFromEditor);
    $('#dialogSeq').addEventListener('input', (e) => updateSeqHint(e.target.value));
    $('#partDialog').addEventListener('cancel', (e) => { e.preventDefault(); closeEditor(); });

    // Track DnD
    setupTrackDnD();

    // Nav
    setupNav();
  }

  // ------- Boot -------
  document.addEventListener('DOMContentLoaded', () => {
    bind();
    renderLibrary();
    renderTrack();
  });
})();
