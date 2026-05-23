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

  // localStorage keys (shared with the Golden Gate planner)
  const STORAGE_KEY = 'assemblybench:design';

  // 1×1 transparent PNG, used to replace the browser's default drag image so
  // our custom follower is the only visible "ghost" while dragging.
  const TRANSPARENT_PNG = (() => {
    const img = new Image();
    img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    return img;
  })();

  // Custom drag-follower (a styled "ghost chip" that tracks the cursor).
  const follower = {
    el: null,
    offsetX: 12,
    offsetY: 12,
    show(html, kind) {
      if (!this.el) {
        this.el = document.createElement('div');
        this.el.className = 'drag-follower';
        document.body.appendChild(this.el);
      }
      this.el.innerHTML = html;
      this.el.dataset.kind = kind || 'part';
      this.el.classList.add('is-visible');
    },
    move(x, y) {
      if (!this.el) return;
      this.el.style.left = (x + this.offsetX) + 'px';
      this.el.style.top  = (y + this.offsetY) + 'px';
    },
    hide() {
      if (this.el) this.el.classList.remove('is-visible');
    },
  };

  // Render the inner HTML of a "ghost chip" for a part — matches the look of
  // a track-part so it's immediately recognizable while flying around.
  function followerHTMLForPart(p) {
    const c = meta[p.type]?.color || '#94a3b8';
    return `
      <div class="track-part-ghost" style="--c:${c}">
        <span class="tp-type">${escapeHTML(meta[p.type]?.label || p.type)}</span>
        <span class="tp-name">${escapeHTML(p.name)}</span>
        <span class="tp-bp">${(p.sequence || '').length} bp</span>
      </div>
    `;
  }

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
    return `${n.toLocaleString()} bp`;
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
      li.draggable = true;
      li.dataset.libraryId = part.id;
      const c = meta[part.type]?.color || '#94a3b8';
      li.innerHTML = `
        <div class="li-row">
          <span class="li-swatch" style="--c:${c}"></span>
          <span class="li-text">
            <span class="li-name">${escapeHTML(part.name)}</span>
            <span class="li-meta">${meta[part.type]?.label || part.type} · ${part.sequence.length} bp</span>
          </span>
          <button type="button" class="li-info" data-info="${part.id}" aria-label="Show details" title="Show details">i</button>
          <button type="button" data-add="${part.id}" title="Add to assembly">+ Add</button>
        </div>
        <div class="li-summary" hidden>
          <p>${escapeHTML(part.summary || 'No description available.')}</p>
          <p class="muted small">${meta[part.type]?.label || part.type} · ${part.sequence.length} bp · ID <code>${escapeHTML(part.id)}</code></p>
        </div>
      `;
      li.addEventListener('dragstart', (e) => {
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/library-id', part.id);
        // Replace the browser's default drag image with our own follower.
        try { e.dataTransfer.setDragImage(TRANSPARENT_PNG, 0, 0); } catch (_) {}
        startDrag('new', part);
        follower.show(followerHTMLForPart(part), 'new');
        follower.move(e.clientX, e.clientY);
      });
      li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        follower.hide();
        endDrag();
      });
      list.appendChild(li);
    }
  }

  // ------- Track rendering -------
  function renderTrack() {
    const track = $('#track');
    track.innerHTML = '';
    if (assembly.length === 0) {
      track.dataset.empty = 'true';
      const p = document.createElement('p');
      p.className = 'track-empty';
      p.innerHTML = 'Your assembly is empty. Drag a part from the library on the left, or click <strong>+ Add</strong> to begin.';
      track.appendChild(p);
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
    persistAssembly();
  }

  // Persist the design so it survives reloads and Golden Gate hand-offs.
  function persistAssembly() {
    try {
      const payload = {
        name: $('#plasmidName')?.value || 'pMyConstruct',
        parts: assembly.map(({ uid, id, type, name, sequence, summary }) => ({
          uid, id, type, name, sequence, summary,
        })),
        savedAt: Date.now(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) { /* storage disabled — ignore */ }
  }

  // Restore a previously persisted design (e.g. user came back from Golden Gate).
  function restoreAssembly() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.parts) || parsed.parts.length === 0) return false;
      assembly = parsed.parts
        .filter((p) => p && typeof p.sequence === 'string')
        .map((p) => ({
          uid: p.uid || uid(),
          id: p.id,
          type: p.type || 'other',
          name: p.name || 'Untitled',
          sequence: cleanSequence(p.sequence),
          summary: p.summary,
        }));
      const nameEl = $('#plasmidName');
      if (nameEl && typeof parsed.name === 'string' && parsed.name.trim()) {
        nameEl.value = parsed.name;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  // Forget the persisted design when the user explicitly clears the bench.
  function forgetPersisted() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }

  // Briefly show a status message under the workspace head.
  function flashNotice(message) {
    const host = $('#benchNotice');
    if (!host) return;
    host.textContent = message;
    host.classList.add('is-visible');
    clearTimeout(flashNotice._t);
    flashNotice._t = setTimeout(() => host.classList.remove('is-visible'), 4000);
  }

  function handoffToGoldenGate() {
    persistAssembly();
    if (assembly.length === 0) {
      if (!confirm('Your track is empty. Load the example before going to the Golden Gate planner?')) return;
      loadExample();
      persistAssembly();
    }
    window.location.href = 'goldengate.html';
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
      try { e.dataTransfer.setDragImage(TRANSPARENT_PNG, 0, 0); } catch (_) {}
      startDrag('reorder', p, p.uid);
      follower.show(followerHTMLForPart(p), 'reorder');
      follower.move(e.clientX, e.clientY);
      $('#discardZone')?.classList.add('is-active');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      follower.hide();
      endDrag();
      $('#discardZone')?.classList.remove('is-active', 'is-drop-target');
    });

    return el;
  }

  // Active drag state. A "placeholder" is a chip-shaped, dimmed ghost that
  // lives inside the track's flex layout at the cursor's projected drop
  // position. It shifts other parts to make room as the cursor moves.
  let dragState = null;
  // {
  //   kind: 'new' | 'reorder',
  //   part: { type, name, sequence },
  //   sourceUid?: string,
  //   placeholder: HTMLElement,
  //   sourceEl?: HTMLElement,   // hidden while reordering
  // }

  function makePlaceholder(part) {
    const c = meta[part.type]?.color || '#94a3b8';
    const ph = document.createElement('div');
    ph.className = 'track-part-placeholder';
    ph.style.setProperty('--c', c);
    ph.innerHTML = `
      <span class="tp-type">${escapeHTML(meta[part.type]?.label || part.type)}</span>
      <span class="tp-name">${escapeHTML(part.name)}</span>
      <span class="tp-bp">${(part.sequence || '').length} bp</span>
    `;
    return ph;
  }

  function startDrag(kind, part, sourceUid) {
    const placeholder = makePlaceholder(part);
    let sourceEl = null;
    if (kind === 'reorder' && sourceUid) {
      sourceEl = document.querySelector(`.track-part[data-uid="${sourceUid}"]`);
      if (sourceEl) sourceEl.classList.add('is-source-hidden');
    }
    dragState = { kind, part, sourceUid, placeholder, sourceEl };
  }

  function endDrag() {
    if (!dragState) return;
    const { placeholder, sourceEl } = dragState;
    if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
    if (sourceEl) sourceEl.classList.remove('is-source-hidden');
    dragState = null;
  }

  // Compute the visual insertion index for a cursor coordinate. The track is a
  // wrapping flex container, so parts can appear on multiple rows — we need to
  // pick the row the cursor is over (or nearest to) before doing the x-check,
  // otherwise the placeholder would jump to the wrong row whenever the parts
  // wrap to a second line.
  function insertionIndexFor(clientX, clientY, excludeUid) {
    const track = $('#track');
    const parts = $$('.track-part', track).filter((el) =>
      el.dataset.uid !== excludeUid && !el.classList.contains('is-source-hidden')
    );
    if (parts.length === 0) return 0;

    const rects = parts.map((el) => el.getBoundingClientRect());

    // Pick the row whose vertical range contains the cursor, or the closest.
    let rowIdx = rects.findIndex((r) => clientY >= r.top && clientY <= r.bottom);
    if (rowIdx === -1) {
      let best = Infinity;
      rects.forEach((r, i) => {
        const dy = clientY < r.top ? r.top - clientY : clientY - r.bottom;
        if (dy < best) { best = dy; rowIdx = i; }
      });
    }
    const rowTop = rects[rowIdx].top;
    const rowBottom = rects[rowIdx].bottom;
    const sameRow = (r) => r.bottom >= rowTop && r.top <= rowBottom;

    // Within the row, the first part whose horizontal center is past the cursor.
    for (let i = 0; i < parts.length; i++) {
      if (!sameRow(rects[i])) continue;
      if (clientX < rects[i].left + rects[i].width / 2) return i;
    }
    // Cursor is past the last part on this row — insert right after it
    // (== before the first part on the next row, if any).
    for (let i = 0; i < parts.length; i++) {
      if (rects[i].top > rowBottom) return i;
    }
    return parts.length;
  }

  // Slot the chip-shaped placeholder into the track at the projected drop
  // index so other parts visibly shift to make room.
  function showInsertionMarker(index, excludeUid) {
    if (!dragState) return;
    const track = $('#track');
    const ph = dragState.placeholder;
    const parts = $$('.track-part', track).filter((el) =>
      el.dataset.uid !== excludeUid && !el.classList.contains('is-source-hidden')
    );

    if (index >= parts.length) {
      // Append at the end — make sure ph isn't already at the very end
      if (track.lastElementChild !== ph) track.appendChild(ph);
    } else {
      const target = parts[index];
      if (ph.nextSibling !== target) track.insertBefore(ph, target);
    }
    ph.classList.add('is-visible');
  }

  function hideInsertionMarker() {
    if (dragState && dragState.placeholder && dragState.placeholder.parentNode) {
      dragState.placeholder.parentNode.removeChild(dragState.placeholder);
    }
  }

  // Drag a track-part onto this zone to remove it from the design.
  function setupDiscardZone() {
    const zone = $('#discardZone');
    if (!zone) return;
    const hasType = (dt, t) => {
      const types = dt.types || [];
      if (typeof types.contains === 'function') return types.contains(t);
      return Array.from(types).indexOf(t) !== -1;
    };
    zone.addEventListener('dragover', (e) => {
      // Only accept track-part (reorder) drags — library drags can't discard
      // a part that isn't on the design yet.
      if (!hasType(e.dataTransfer, 'text/uid')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      zone.classList.add('is-drop-target');
      // The cursor is over the discard zone, so the in-track placeholder
      // shouldn't be promising a drop position.
      hideInsertionMarker();
      const track = $('#track');
      if (track) track.classList.remove('is-drop-target');
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) {
        zone.classList.remove('is-drop-target');
      }
    });
    zone.addEventListener('drop', (e) => {
      if (!hasType(e.dataTransfer, 'text/uid')) return;
      e.preventDefault();
      zone.classList.remove('is-drop-target', 'is-active');
      const draggedUid = e.dataTransfer.getData('text/uid');
      if (!draggedUid) return;
      assembly = assembly.filter((p) => p.uid !== draggedUid);
      renderTrack();
    });
  }

  function setupTrackDnD() {
    const track = $('#track');

    const hasType = (dt, t) => {
      const types = dt.types || [];
      // DOMStringList vs Array — handle both.
      if (typeof types.contains === 'function') return types.contains(t);
      return Array.from(types).indexOf(t) !== -1;
    };
    track.addEventListener('dragover', (e) => {
      // Allow drops from either the library (new part) or within the track (reorder).
      const isUid = hasType(e.dataTransfer, 'text/uid');
      const isLib = hasType(e.dataTransfer, 'text/library-id');
      if (!isUid && !isLib) return;
      e.preventDefault();
      track.classList.add('is-drop-target');
      const draggedUid = isUid
        ? track.querySelector('.track-part.dragging')?.dataset.uid
        : null;
      e.dataTransfer.dropEffect = draggedUid ? 'move' : 'copy';
      const idx = insertionIndexFor(e.clientX, e.clientY, draggedUid);
      showInsertionMarker(idx, draggedUid);
    });
    track.addEventListener('dragleave', (e) => {
      if (e.target === track || !track.contains(e.relatedTarget)) {
        track.classList.remove('is-drop-target');
        hideInsertionMarker();
      }
    });
    track.addEventListener('drop', (e) => {
      e.preventDefault();
      track.classList.remove('is-drop-target');
      hideInsertionMarker();

      const draggedUid = e.dataTransfer.getData('text/uid');
      const libraryId = e.dataTransfer.getData('text/library-id');

      // Case 1: dropped a library part onto the track — insert a new copy.
      if (libraryId) {
        const src = library.find((p) => p.id === libraryId);
        if (!src) return;
        const idx = insertionIndexFor(e.clientX, e.clientY, null);
        const newPart = {
          uid: uid(),
          id: src.id,
          type: src.type,
          name: src.name,
          sequence: src.sequence,
          summary: src.summary,
        };
        assembly = assembly.slice(0, idx).concat([newPart]).concat(assembly.slice(idx));
        renderTrack();
        return;
      }

      // Case 2: reorder an existing track part.
      if (!draggedUid) return;
      const draggedIdx = assembly.findIndex((p) => p.uid === draggedUid);
      if (draggedIdx === -1) return;

      const idx = insertionIndexFor(e.clientX, e.clientY, draggedUid);
      const [moved] = assembly.splice(draggedIdx, 1);
      assembly = assembly.slice(0, idx).concat([moved]).concat(assembly.slice(idx));
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
    forgetPersisted();
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
    // Library add / info buttons (event delegation)
    $('#libraryList').addEventListener('click', (e) => {
      const addBtn = e.target.closest('button[data-add]');
      if (addBtn) { addLibraryPart(addBtn.dataset.add); return; }
      const infoBtn = e.target.closest('button[data-info]');
      if (infoBtn) {
        const li = infoBtn.closest('.library-item');
        const summary = li?.querySelector('.li-summary');
        if (summary) {
          const open = !summary.hasAttribute('hidden') ? false : true;
          if (open) summary.removeAttribute('hidden'); else summary.setAttribute('hidden', '');
          li.classList.toggle('is-expanded', open);
          infoBtn.setAttribute('aria-expanded', String(open));
        }
      }
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
    $('#planGGBtn')?.addEventListener('click', handoffToGoldenGate);

    // Plasmid name change updates circular view label and persisted state
    $('#plasmidName').addEventListener('input', () => {
      if (currentView === 'circular') renderCircular();
      persistAssembly();
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
    setupDiscardZone();

    // Global cursor follower: dragover bubbles up to document with clientX/Y,
    // so we can keep the ghost chip glued to the cursor wherever it goes.
    document.addEventListener('dragover', (e) => {
      if (!follower.el || !follower.el.classList.contains('is-visible')) return;
      follower.move(e.clientX, e.clientY);
    });
    document.addEventListener('drop',    () => { follower.hide(); endDrag(); });
    document.addEventListener('dragend', () => { follower.hide(); endDrag(); });
  }

  // ------- Boot -------
  document.addEventListener('DOMContentLoaded', () => {
    bind();
    renderLibrary();
    const restored = restoreAssembly();
    renderTrack();
    if (restored && assembly.length > 0) {
      flashNotice(`Restored your last design — ${assembly.length} part${assembly.length === 1 ? '' : 's'} loaded. Use Clear to start over.`);
    }
  });
})();
