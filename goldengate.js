/* ==========================================================
   AssemblyBench — Golden Gate planner
   MoClo-style hierarchical assembly per Lee et al., ACS Synth. Biol., 2015
   ========================================================== */
(function () {
  'use strict';

  // ----- Type IIS enzymes used by the YTK MoClo system -----
  //   BsaI:  GGTCTC(N1)^NNNN  — used at Tier 2 (parts → cassette)
  //   BsmBI: CGTCTC(N1)^NNNN  — used at Tier 3 (cassettes → multigene)
  // The recognition site cuts N1 nt downstream, leaving a 4-nt 5' overhang.
  const ENZYMES = {
    BsaI:  { name: 'BsaI',  site: 'GGTCTC', siteRC: 'GAGACC', tier: 'cassette' },
    BsmBI: { name: 'BsmBI', site: 'CGTCTC', siteRC: 'GAGACG', tier: 'multigene' },
  };

  // ----- YTK 2015 fusion overhangs by junction role -----
  // The canonical YTK system places parts in positions 1..8 (connector, promoter,
  // CDS, terminator, connector, marker, ori, backbone). Each *junction* between
  // adjacent positions has a fixed 4-bp BsaI overhang. We map the bench's
  // category labels onto YTK positions so the planner picks sensible overhangs.
  // The "AATG" overhang is the canonical promoter→CDS junction — those four
  // bases double as the ATG start codon of the CDS.
  const YTK_POSITION = {
    promoter:   2,
    rbs:        2.5,  // not a separate YTK type — fused with promoter / 5'UTR
    cds:        3,
    terminator: 4,
    origin:     7,
    resistance: 6,
    other:      5,    // treat as a downstream connector by default
  };

  // Overhang at each YTK junction (5' overhang revealed after BsaI digestion)
  // Source: YTK kit (Lee 2015). For positions we don't ship as standard YTK
  // types (e.g. RBS), we synthesize a sensible 4-bp overhang.
  const YTK_OVERHANG = {
    '1-2': 'CCCT',
    '2-3': 'AATG',  // start codon
    '3-4': 'GCTT',
    '4-5': 'CGCT',
    '5-6': 'GGTA',
    '6-7': 'CGAG',
    '7-8': 'ACTG',
    '8-1': 'TCGT',
    // Synthetic intermediate (used when an RBS is present between promoter and CDS)
    '2-2.5': 'TACT',
    '2.5-3': 'AATG', // still AATG so the ATG lands at the CDS start
  };

  // Generic orthogonal 4-bp set (cycled by position) — used if the user
  // chooses "Generic orthogonal set" instead of the YTK overhangs.
  const GENERIC_OVERHANGS = [
    'CCCT', 'AATG', 'GCTT', 'CGCT', 'GGTA',
    'CGAG', 'ACTG', 'TCGT', 'TCCG', 'CAAA',
  ];

  // ----- Tier defaults: which enzyme is used at each tier -----
  const TIER_ENZYME = { cassette: 'BsaI', multigene: 'BsmBI' };

  // ----- DOM helpers -----
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ----- State -----
  let design = null;         // { name, parts: [{uid,type,name,sequence}] }
  let enzymeName = 'BsaI';   // current enzyme
  let overhangSet = 'ytk';   // 'ytk' | 'rotate'

  // ====================================================================
  // Sequence utilities
  // ====================================================================
  function revComp(seq) {
    const map = { A: 'T', T: 'A', G: 'C', C: 'G', N: 'N' };
    return seq.toUpperCase().split('').reverse().map((b) => map[b] || 'N').join('');
  }

  function cleanSequence(raw) {
    if (!raw) return '';
    const noHeader = raw.split(/\r?\n/).filter((l) => !l.trim().startsWith('>')).join('');
    return noHeader.toUpperCase().replace(/[^ATGCN]/g, '');
  }

  function findAll(haystack, needle) {
    const out = [];
    let i = haystack.indexOf(needle);
    while (i !== -1) { out.push(i); i = haystack.indexOf(needle, i + 1); }
    return out;
  }

  // Type IIS site count on both strands of a part sequence
  function scanInternalSites(seq, enzyme) {
    const fwd = findAll(seq, enzyme.site);
    const rev = findAll(seq, enzyme.siteRC);
    return { fwd, rev, total: fwd.length + rev.length };
  }

  // ====================================================================
  // Overhang assignment
  // ====================================================================
  // Given the ordered list of parts, produce N+1 overhangs (one per junction,
  // including upstream-of-first and downstream-of-last, which seam into the
  // destination vector backbone).
  function assignOverhangs(parts) {
    if (overhangSet === 'rotate') {
      return parts.concat([{ type: 'backbone' }]).map((_, i) => GENERIC_OVERHANGS[i % GENERIC_OVERHANGS.length]);
    }

    // YTK: walk the position sequence and grab the YTK_OVERHANG for each junction.
    // The "upstream" overhang for the first part comes from position 1→pos(part1).
    // The "downstream" overhang for the last part goes back to position 1 (the
    // backbone's upstream side).
    const positions = parts.map((p) => YTK_POSITION[p.type] ?? 5);
    const seq = [1, ...positions, 1]; // wrap into the backbone on both sides
    const oh = [];
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i], b = seq[i + 1];
      const k1 = `${a}-${b}`;
      const k2 = `${b}-${a}`;
      let v = YTK_OVERHANG[k1] || YTK_OVERHANG[k2];
      if (!v) {
        // Fallback: synthesize from position numbers so junctions stay distinct
        v = GENERIC_OVERHANGS[(Math.round((a + b) * 3)) % GENERIC_OVERHANGS.length];
      }
      oh.push(v);
    }
    // Deduplicate any accidental collisions by rotating colliders through GENERIC
    const seen = new Set();
    for (let i = 0; i < oh.length; i++) {
      let candidate = oh[i];
      let k = 0;
      while (seen.has(candidate) && k < GENERIC_OVERHANGS.length) {
        candidate = GENERIC_OVERHANGS[(i + k) % GENERIC_OVERHANGS.length];
        k++;
      }
      oh[i] = candidate;
      seen.add(candidate);
    }
    return oh;
  }

  // ====================================================================
  // Primer design
  //   Forward: NN [enzyme site] N [4-bp upstream overhang] [first ~20 bp of part]
  //   Reverse: NN [enzyme site] N [revcomp of downstream 4-bp overhang] [revcomp of last ~20 bp]
  // ====================================================================
  const PRIMER_PAD = 'AA';      // protective 5' bases so the enzyme can bind
  const SPACER     = 'A';       // the single N between recognition site and overhang
  const ANNEAL_LEN = 20;

  function designPrimers(parts, overhangs, enzyme) {
    return parts.map((p, i) => {
      const upOh   = overhangs[i];
      const downOh = overhangs[i + 1];
      const seq = p.sequence || '';
      const fwdAnneal = seq.slice(0, Math.min(ANNEAL_LEN, seq.length));
      const revAnneal = revComp(seq.slice(-Math.min(ANNEAL_LEN, seq.length)));
      const fwd = `${PRIMER_PAD}${enzyme.site}${SPACER}${upOh}${fwdAnneal}`;
      const rev = `${PRIMER_PAD}${enzyme.site}${SPACER}${revComp(downOh)}${revAnneal}`;
      return { fwd, rev, fwdLen: fwd.length, revLen: rev.length };
    });
  }

  // ====================================================================
  // Predicted assembled sequence
  //   Each part is amplified with the upstream overhang prepended and the
  //   downstream overhang appended. After digestion the overhangs are sticky
  //   ends; after ligation they form double-stranded 4-bp seams. We model
  //   the post-ligation product by joining parts with each downstream
  //   overhang shared between them. The final overhang seams the construct
  //   into the destination vector — we represent the construct as circular
  //   (joining the last downstream overhang back to the first part).
  // ====================================================================
  function buildAssembledSequence(parts, overhangs) {
    if (!parts.length) return '';
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      const seg = (i === 0 ? overhangs[0] : '') + parts[i].sequence + overhangs[i + 1];
      out += seg;
    }
    return out;
  }

  // ====================================================================
  // Rendering
  // ====================================================================
  function rerender() {
    const empty = !design || !design.parts || design.parts.length === 0;
    $('#ggEmpty').hidden = !empty;
    $('#ggSummarySection').hidden = empty;
    $$('.section').forEach((s) => {
      if (s.contains($('#ggJunctions')) || s.contains($('#ggPrimerTable'))
        || s.contains($('#ggScan')) || s.contains($('#ggProtocol')) || s.contains($('#ggFinalSeq'))) {
        s.hidden = empty;
      }
    });
    if (empty) return;

    const enzyme = ENZYMES[enzymeName];
    const parts = design.parts;
    const overhangs = assignOverhangs(parts);
    const primers = designPrimers(parts, overhangs, enzyme);
    const assembled = buildAssembledSequence(parts, overhangs);

    // Summary
    $('#ggName').textContent = design.name || 'Untitled construct';
    $('#ggStats').textContent = `${parts.length} part${parts.length === 1 ? '' : 's'} · ${parts.reduce((s, p) => s + (p.sequence?.length || 0), 0).toLocaleString()} bp source DNA · assembled ${assembled.length.toLocaleString()} bp`;
    $('#ggEnzymePill').textContent = enzyme.name;
    $('#ggEnzymePill').dataset.enzyme = enzyme.name;

    renderJunctions(parts, overhangs, enzyme);
    renderPrimerTable(parts, primers);
    renderScan(parts, enzyme);
    renderProtocol(parts, enzyme);
    renderFinal(assembled);
  }

  function renderJunctions(parts, overhangs, enzyme) {
    const el = $('#ggJunctions');
    el.innerHTML = '';
    for (let i = 0; i <= parts.length; i++) {
      // junction badge before each part (including the seam back to the backbone)
      const oh = overhangs[i];
      const j = document.createElement('div');
      j.className = 'gg-junction';
      j.innerHTML = `
        <span class="gg-junction-oh">${oh}</span>
        <span class="gg-junction-cap">${i === 0 ? '↓ vector' : i === parts.length ? '↑ vector' : ''}</span>
      `;
      el.appendChild(j);

      if (i === parts.length) break;

      // part block
      const p = parts[i];
      const c = (window.PART_TYPE_META?.[p.type]?.color) || '#94a3b8';
      const scan = scanInternalSites(p.sequence || '', enzyme);
      const block = document.createElement('div');
      block.className = 'gg-jpart' + (scan.total > 0 ? ' has-error' : '');
      block.style.setProperty('--c', c);
      block.innerHTML = `
        <span class="gg-jpart-type">${escapeHTML(window.PART_TYPE_META?.[p.type]?.label || p.type)}</span>
        <strong>${escapeHTML(p.name)}</strong>
        <span class="gg-jpart-bp">${(p.sequence?.length || 0).toLocaleString()} bp</span>
        ${scan.total > 0 ? `<span class="gg-flag" title="Internal ${enzyme.name} site(s) found">⚑ ${scan.total} internal site${scan.total === 1 ? '' : 's'}</span>` : ''}
      `;
      el.appendChild(block);
    }
  }

  function renderPrimerTable(parts, primers) {
    const tbody = $('#ggPrimerTable tbody');
    tbody.innerHTML = '';
    parts.forEach((p, i) => {
      const r = primers[i];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${escapeHTML(p.name)}</td>
        <td>${escapeHTML(window.PART_TYPE_META?.[p.type]?.label || p.type)}</td>
        <td><code>${r.fwd}</code></td>
        <td><code>${r.rev}</code></td>
        <td>${r.fwdLen} / ${r.revLen} nt</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function renderScan(parts, enzyme) {
    const el = $('#ggScan');
    el.innerHTML = '';
    let anyHit = false;
    parts.forEach((p) => {
      const s = scanInternalSites(p.sequence || '', enzyme);
      const row = document.createElement('div');
      const ok = s.total === 0;
      if (!ok) anyHit = true;
      row.className = 'gg-scan-row ' + (ok ? 'is-ok' : 'is-bad');
      row.innerHTML = `
        <span class="gg-scan-ico">${ok ? '✓' : '✕'}</span>
        <span class="gg-scan-name">${escapeHTML(p.name)}</span>
        <span class="gg-scan-msg">${
          ok
            ? `No internal ${enzyme.name} sites.`
            : `${s.total} internal ${enzyme.name} site${s.total === 1 ? '' : 's'} found (fwd: ${s.fwd.length}, rev: ${s.rev.length}). Domesticate this part — replace each site with a silent codon change so the recognition motif is destroyed without changing the protein.`
        }</span>
      `;
      el.appendChild(row);
    });
    if (parts.length === 0) {
      el.innerHTML = '<p class="muted">Nothing to scan.</p>';
    } else if (!anyHit) {
      const summary = document.createElement('div');
      summary.className = 'v-row v-ok';
      summary.innerHTML = `<span class="v-ico">✓</span><span>All parts are clean for ${enzyme.name}. Golden Gate can proceed.</span>`;
      el.prepend(summary);
    }
  }

  function renderProtocol(parts, enzyme) {
    const n = parts.length;
    const massPerPart = 40; // fmol equimolar input
    const vectorFmol = 20;
    const totalUL = 20;
    const html = `
      <div class="gg-protocol-card">
        <h4>Reaction mix (${totalUL} µL)</h4>
        <table class="gg-recipe">
          <tr><td>Destination vector (linear or supercoiled)</td><td><strong>${vectorFmol} fmol</strong></td></tr>
          ${parts.map((p) => `<tr><td>${escapeHTML(p.name)}</td><td><strong>${massPerPart} fmol</strong></td></tr>`).join('')}
          <tr><td>${enzyme.name} (NEB or equivalent)</td><td><strong>10 U</strong></td></tr>
          <tr><td>T4 DNA ligase (high-conc.)</td><td><strong>400 U</strong></td></tr>
          <tr><td>10× T4 ligase buffer (with ATP)</td><td><strong>2 µL</strong></td></tr>
          <tr><td>Nuclease-free water</td><td><strong>to ${totalUL} µL</strong></td></tr>
        </table>
      </div>

      <div class="gg-protocol-card">
        <h4>Thermocycler program</h4>
        <ol class="gg-cycle">
          <li><strong>Digest + ligate cycle</strong> — repeat ${Math.max(20, 15 + n * 2)}×:
            <ul>
              <li>37 °C · 2 min  <span class="muted small">— ${enzyme.name} digestion</span></li>
              <li>16 °C · 5 min  <span class="muted small">— T4 ligation</span></li>
            </ul>
          </li>
          <li><strong>Final digestion:</strong> 60 °C · 10 min  <span class="muted small">— linearize residual destination vector and any incorrect re-ligation</span></li>
          <li><strong>Heat inactivation:</strong> 80 °C · 10 min</li>
          <li><strong>Hold:</strong> 10 °C ∞</li>
        </ol>
      </div>

      <div class="gg-protocol-card">
        <h4>Transformation &amp; selection</h4>
        <ol>
          <li>Transform 2–5 µL into chemically competent <em>E. coli</em> (DH5α / Top10).</li>
          <li>Recover 1 hr in SOC at 37 °C with shaking.</li>
          <li>Plate on LB + the antibiotic carried by the destination vector. Expect dozens to thousands of colonies; a high red/white or fluorescence ratio confirms efficient assembly.</li>
          <li>Colony-PCR or sequence-verify 2–4 colonies before scaling up.</li>
        </ol>
      </div>
    `;
    $('#ggProtocol').innerHTML = html;
  }

  function renderFinal(seq) {
    $('#ggFinalStats').textContent = `${seq.length.toLocaleString()} bp · GC ${gcPercent(seq).toFixed(1)}%`;
    const wrapped = seq.match(/.{1,60}/g)?.join('\n') || '';
    $('#ggFinalSeq').textContent = wrapped;
  }

  function gcPercent(s) {
    if (!s.length) return 0;
    const gc = (s.match(/[GC]/g) || []).length;
    return (gc / s.length) * 100;
  }

  // ====================================================================
  // Copy / download
  // ====================================================================
  function copyPrimersAsTSV() {
    if (!design) return;
    const enzyme = ENZYMES[enzymeName];
    const overhangs = assignOverhangs(design.parts);
    const primers = designPrimers(design.parts, overhangs, enzyme);
    const rows = [
      ['name', 'type', 'direction', 'sequence', 'length'].join('\t'),
      ...design.parts.flatMap((p, i) => [
        [p.name + '_F', p.type, 'fwd', primers[i].fwd, primers[i].fwdLen].join('\t'),
        [p.name + '_R', p.type, 'rev', primers[i].rev, primers[i].revLen].join('\t'),
      ]),
    ].join('\n');
    navigator.clipboard.writeText(rows).then(
      () => flashButton('#ggCopyPrimersBtn', 'Copied ✓'),
      () => alert('Could not access clipboard.')
    );
  }

  function downloadFasta() {
    if (!design) return;
    const enzyme = ENZYMES[enzymeName];
    const overhangs = assignOverhangs(design.parts);
    const seq = buildAssembledSequence(design.parts, overhangs);
    const name = (design.name || 'pAssembly').replace(/\s+/g, '_');
    const header = `>${name}_goldengate_${enzyme.name} | ${design.parts.length} parts | ${seq.length} bp`;
    const wrapped = seq.match(/.{1,60}/g)?.join('\n') || '';
    const blob = new Blob([`${header}\n${wrapped}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${name}_goldengate_${enzyme.name}.fasta`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function flashButton(sel, text) {
    const b = $(sel); if (!b) return;
    const old = b.textContent;
    b.textContent = text;
    setTimeout(() => { b.textContent = old; }, 1500);
  }

  // ====================================================================
  // Loading
  // ====================================================================
  function loadFromStorage() {
    try {
      const raw = localStorage.getItem('assemblybench:design');
      if (!raw) { design = null; return; }
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.parts)) { design = null; return; }
      // Normalize
      design = {
        name: parsed.name || 'pAssembly',
        parts: parsed.parts
          .filter((p) => p && typeof p.sequence === 'string')
          .map((p) => ({
            uid: p.uid || 'p' + Math.random().toString(36).slice(2, 9),
            type: p.type || 'other',
            name: p.name || 'Untitled',
            sequence: cleanSequence(p.sequence),
          })),
      };
    } catch (_) { design = null; }
  }

  function loadExample() {
    const lib = window.PART_LIBRARY || [];
    const ids = window.EXAMPLE_ASSEMBLY || [];
    const parts = ids.map((id) => lib.find((p) => p.id === id)).filter(Boolean)
      .map((p) => ({ uid: 'p' + Math.random().toString(36).slice(2, 9), type: p.type, name: p.name, sequence: p.sequence }));
    design = { name: 'pGFP_demo', parts };
    try { localStorage.setItem('assemblybench:design', JSON.stringify(design)); } catch (_) {}
    rerender();
  }

  // ====================================================================
  // Wiring
  // ====================================================================
  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function bind() {
    $('#ggTier').addEventListener('change', (e) => {
      enzymeName = TIER_ENZYME[e.target.value] || 'BsaI';
      rerender();
    });
    $('#ggOverhangSet').addEventListener('change', (e) => {
      overhangSet = e.target.value;
      rerender();
    });
    $('#ggReloadBtn').addEventListener('click', () => { loadFromStorage(); rerender(); });
    $('#ggExampleBtn').addEventListener('click', loadExample);
    $('#ggExampleBtn2')?.addEventListener('click', loadExample);
    $('#ggCopyPrimersBtn').addEventListener('click', copyPrimersAsTSV);
    $('#ggDownloadFastaBtn').addEventListener('click', downloadFasta);

    // Re-pull from storage if it changes in another tab
    window.addEventListener('storage', (e) => {
      if (e.key === 'assemblybench:design') { loadFromStorage(); rerender(); }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bind();
    loadFromStorage();
    rerender();
  });
})();
