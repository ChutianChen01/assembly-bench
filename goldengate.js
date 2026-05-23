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

  // ----- Thermodynamics -----
  // SantaLucia 1998 unified nearest-neighbor parameters for DNA/DNA duplexes.
  //   ΔH in kcal/mol, ΔS in cal/(mol·K). Initiation and salt correction below.
  const NN_DH = {
    AA: -7.9, AT: -7.2, AG: -7.8, AC: -8.4,
    TA: -7.2, TT: -7.9, TG: -8.5, TC: -8.2,
    GA: -8.2, GT: -8.4, GG: -8.0, GC: -9.8,
    CA: -8.5, CT: -7.8, CG: -10.6, CC: -8.0,
  };
  const NN_DS = {
    AA: -22.2, AT: -20.4, AG: -21.0, AC: -22.4,
    TA: -21.3, TT: -22.2, TG: -22.7, TC: -22.2,
    GA: -22.2, GT: -22.4, GG: -19.9, GC: -24.4,
    CA: -22.7, CT: -21.0, CG: -27.2, CC: -19.9,
  };

  // Primer Tm using nearest-neighbor at standard primer/PCR conditions:
  //   [primer] = 250 nM, [Na+] ≈ 50 mM (approximating typical NEB buffer salt).
  // The annealing portion (3' end of the primer, after any added tails) drives
  // priming, but for educational purposes we report Tm of the full primer.
  // Caller can pass `annealOnly` to compute Tm of just the 3'-anneal segment.
  function primerTm(seq, opts = {}) {
    const s = (seq || '').toUpperCase().replace(/[^ATGC]/g, '');
    if (s.length < 8) return null;
    const primerConc = opts.primerConc ?? 250e-9; // 250 nM
    const naConc = opts.naConc ?? 0.05;           // 50 mM Na+

    let dH = 0, dS = 0;
    for (let i = 0; i < s.length - 1; i++) {
      const di = s.slice(i, i + 2);
      if (NN_DH[di] === undefined) return null;
      dH += NN_DH[di];
      dS += NN_DS[di];
    }
    // Initiation parameters (SantaLucia 1998): symmetric terminal A·T penalty.
    const endA = (s[0] === 'A' || s[0] === 'T') ? 1 : 0;
    const endZ = (s[s.length - 1] === 'A' || s[s.length - 1] === 'T') ? 1 : 0;
    dH += 0.1 * (endA + endZ) + 2.3 * (endA + endZ === 0 ? 1 : 0); // simplified
    dS += -2.8 * (endA + endZ === 0 ? 1 : 0) + 4.1 * (endA + endZ);

    const R = 1.987; // cal/(mol·K)
    // For non-self-complementary primers, Tm = ΔH / (ΔS + R·ln([P]/4)) − 273.15
    const tmK = (dH * 1000) / (dS + R * Math.log(primerConc / 4));
    let tmC = tmK - 273.15;
    // Salt correction (Owczarzy 2004 simplified): +16.6 log10([Na+]/1.0)
    tmC += 16.6 * Math.log10(naConc);
    if (!Number.isFinite(tmC)) return null;
    return tmC;
  }

  // Hairpin / secondary-structure Tm estimate. We look for the longest stem
  // (inverted repeat) the primer can fold back on itself with a loop ≥ 3 nt,
  // then estimate the duplex Tm of that stem using the same NN parameters.
  // Returns { tm, stem, loop } or null if no plausible hairpin found.
  function hairpinTm(seq) {
    const s = (seq || '').toUpperCase().replace(/[^ATGC]/g, '');
    const n = s.length;
    if (n < 10) return null;

    const comp = { A: 'T', T: 'A', G: 'C', C: 'G' };
    let best = null;
    // For each loop midpoint, walk outward checking complementarity.
    // Loop must be ≥ 3 nt. Stem must be ≥ 4 bp to be biologically meaningful.
    for (let i = 0; i < n - 7; i++) {
      for (let j = i + 7; j < n; j++) {
        // i..j is the candidate hairpin region; stem starts pairing inward
        let stem = 0;
        while (
          i + stem < j - stem &&
          (j - stem) - (i + stem) >= 4 && // keep loop ≥ 3
          comp[s[i + stem]] === s[j - stem]
        ) { stem++; }
        if (stem >= 4) {
          const loopLen = (j - stem) - (i + stem) - 1;
          if (loopLen >= 3) {
            const stem5 = s.slice(i, i + stem);
            if (!best || stem > best.stemLen ||
                (stem === best.stemLen && loopLen < best.loopLen)) {
              const tm = primerTm(stem5);
              if (tm !== null) {
                // Loop entropy penalty (Jacobson–Stockmayer style approximation)
                const penalty = 2.44 * Math.log(loopLen);
                best = {
                  tm: tm - penalty,
                  stemLen: stem,
                  loopLen,
                  stem5,
                };
              }
            }
          }
        }
      }
    }
    if (!best) return null;
    return { tm: best.tm, stemLen: best.stemLen, loopLen: best.loopLen, stem5: best.stem5 };
  }

  function formatTm(tm) {
    if (tm === null || tm === undefined || !Number.isFinite(tm)) return '—';
    return `${tm.toFixed(1)} °C`;
  }

  // ====================================================================
  // Internal Type IIS site substitution helper
  // ====================================================================
  // Standard genetic code (DNA codons).
  const CODON_TABLE = {
    TTT: 'F', TTC: 'F', TTA: 'L', TTG: 'L',
    CTT: 'L', CTC: 'L', CTA: 'L', CTG: 'L',
    ATT: 'I', ATC: 'I', ATA: 'I', ATG: 'M',
    GTT: 'V', GTC: 'V', GTA: 'V', GTG: 'V',
    TCT: 'S', TCC: 'S', TCA: 'S', TCG: 'S',
    CCT: 'P', CCC: 'P', CCA: 'P', CCG: 'P',
    ACT: 'T', ACC: 'T', ACA: 'T', ACG: 'T',
    GCT: 'A', GCC: 'A', GCA: 'A', GCG: 'A',
    TAT: 'Y', TAC: 'Y', TAA: '*', TAG: '*',
    CAT: 'H', CAC: 'H', CAA: 'Q', CAG: 'Q',
    AAT: 'N', AAC: 'N', AAA: 'K', AAG: 'K',
    GAT: 'D', GAC: 'D', GAA: 'E', GAG: 'E',
    TGT: 'C', TGC: 'C', TGA: '*', TGG: 'W',
    CGT: 'R', CGC: 'R', CGA: 'R', CGG: 'R',
    AGT: 'S', AGC: 'S', AGA: 'R', AGG: 'R',
    GGT: 'G', GGC: 'G', GGA: 'G', GGG: 'G',
  };

  // For each amino acid, the list of codons that encode it (used to find a
  // synonymous codon that breaks a recognition site).
  const SYNONYMS = (() => {
    const out = {};
    for (const [codon, aa] of Object.entries(CODON_TABLE)) {
      (out[aa] = out[aa] || []).push(codon);
    }
    return out;
  })();

  // Find all matches of `pattern` in `seq` (forward strand only).
  function findMatches(seq, pattern) {
    const out = [];
    let i = seq.indexOf(pattern);
    while (i !== -1) { out.push(i); i = seq.indexOf(pattern, i + 1); }
    return out;
  }

  // Try to destroy a recognition site at position `hitPos` (length `hitLen`)
  // inside `seq` by swapping one codon for a synonym. Returns
  //   { pos, oldCodon, newCodon, frame, strategy: 'silent', warning?: string }
  // or, if no silent swap is possible (e.g. non-CDS context), a single-base
  // mutation that breaks the site:
  //   { pos, old, replacement, strategy: 'point', warning?: string }
  function suggestSubstitution(seq, hitPos, hitLen, partType, enzyme) {
    const isCDS = partType === 'cds';
    const reSite = enzyme.site;
    const reSiteRC = enzyme.siteRC;

    if (isCDS) {
      // CDS frame is assumed to start at position 0.
      for (let codonStart = Math.max(0, Math.floor((hitPos) / 3) * 3);
           codonStart < hitPos + hitLen && codonStart + 3 <= seq.length;
           codonStart += 3) {
        const codon = seq.slice(codonStart, codonStart + 3);
        if (!/^[ATGC]{3}$/.test(codon)) continue;
        const aa = CODON_TABLE[codon];
        if (!aa) continue;
        const synonyms = (SYNONYMS[aa] || []).filter((c) => c !== codon);
        for (const alt of synonyms) {
          const newSeq = seq.slice(0, codonStart) + alt + seq.slice(codonStart + 3);
          // Verify the recognition site (both strands) is gone from this window
          // AND we haven't created a new one nearby.
          const windowStart = Math.max(0, codonStart - 7);
          const windowEnd   = Math.min(newSeq.length, codonStart + 3 + 7);
          const before = seq.slice(windowStart, windowEnd);
          const after  = newSeq.slice(windowStart, windowEnd);
          const beforeHits = countSiteOccurrences(before, reSite, reSiteRC);
          const afterHits  = countSiteOccurrences(after, reSite, reSiteRC);
          if (afterHits < beforeHits) {
            return {
              strategy: 'silent',
              codonStart, oldCodon: codon, newCodon: alt, aa,
              hitPos, hitLen,
            };
          }
        }
      }
      // No silent fix in this hit window — fall through to point change.
    }

    // Non-CDS or no silent fix: find the single base swap inside the site that
    // breaks the recognition motif with the smallest impact.
    for (let p = hitPos; p < hitPos + hitLen; p++) {
      const old = seq[p];
      for (const alt of ['A', 'T', 'G', 'C']) {
        if (alt === old) continue;
        const newSeq = seq.slice(0, p) + alt + seq.slice(p + 1);
        const windowStart = Math.max(0, p - 7);
        const windowEnd   = Math.min(newSeq.length, p + 7);
        const beforeHits = countSiteOccurrences(seq.slice(windowStart, windowEnd), reSite, reSiteRC);
        const afterHits  = countSiteOccurrences(newSeq.slice(windowStart, windowEnd), reSite, reSiteRC);
        if (afterHits < beforeHits) {
          return {
            strategy: 'point',
            pos: p, oldBase: old, newBase: alt,
            hitPos, hitLen,
            warning: isCDS ? 'Could not find a silent swap — this base change may alter the protein.' : null,
          };
        }
      }
    }
    return null;
  }

  function countSiteOccurrences(s, site, siteRC) {
    let n = 0;
    let i = s.indexOf(site);
    while (i !== -1) { n++; i = s.indexOf(site, i + 1); }
    i = s.indexOf(siteRC);
    while (i !== -1) { n++; i = s.indexOf(siteRC, i + 1); }
    return n;
  }

  // Apply a suggestion to a part's sequence and return the new sequence.
  function applySuggestion(seq, suggestion) {
    if (suggestion.strategy === 'silent') {
      return seq.slice(0, suggestion.codonStart)
        + suggestion.newCodon
        + seq.slice(suggestion.codonStart + 3);
    }
    if (suggestion.strategy === 'point') {
      return seq.slice(0, suggestion.pos)
        + suggestion.newBase
        + seq.slice(suggestion.pos + 1);
    }
    return seq;
  }

  // Build a list of suggestions covering every internal hit on either strand.
  // We iterate by re-scanning after each suggestion so subsequent hits know
  // the current state.
  function planDomestication(seq, partType, enzyme) {
    let work = seq;
    const plan = [];
    let guard = 0;
    while (guard++ < 50) {
      const fwd = findMatches(work, enzyme.site);
      const rev = findMatches(work, enzyme.siteRC);
      if (!fwd.length && !rev.length) break;
      const next = fwd.length
        ? { pos: fwd[0], strand: '+' }
        : { pos: rev[0], strand: '−' };
      const suggestion = suggestSubstitution(work, next.pos, enzyme.site.length, partType, enzyme);
      if (!suggestion) break;
      suggestion.strand = next.strand;
      const before = work;
      work = applySuggestion(work, suggestion);
      suggestion.before = before;
      suggestion.after = work;
      plan.push(suggestion);
    }
    return { plan, finalSeq: work, clean: countSiteOccurrences(work, enzyme.site, enzyme.siteRC) === 0 };
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
      // Tm reported for the annealing portion (the part that actually templates
      // off the part DNA in the first PCR cycle). Hairpin Tm uses the whole
      // primer since 5' tails can fold back.
      const fwdTm        = primerTm(fwdAnneal);
      const revTm        = primerTm(revAnneal);
      const fwdHairpin   = hairpinTm(fwd);
      const revHairpin   = hairpinTm(rev);
      return {
        fwd, rev,
        fwdLen: fwd.length, revLen: rev.length,
        fwdTm, revTm,
        fwdAnnealTm: fwdTm, revAnnealTm: revTm,
        fwdHairpin, revHairpin,
        fwdAnneal, revAnneal,
      };
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
      const typeLabel = escapeHTML(window.PART_TYPE_META?.[p.type]?.label || p.type);
      const fwdHairpinCell = r.fwdHairpin
        ? `${formatTm(r.fwdHairpin.tm)} <span class="muted small">(${r.fwdHairpin.stemLen}-bp stem, ${r.fwdHairpin.loopLen}-nt loop)</span>`
        : '<span class="muted small">none detected</span>';
      const revHairpinCell = r.revHairpin
        ? `${formatTm(r.revHairpin.tm)} <span class="muted small">(${r.revHairpin.stemLen}-bp stem, ${r.revHairpin.loopLen}-nt loop)</span>`
        : '<span class="muted small">none detected</span>';

      const fwdRow = document.createElement('tr');
      fwdRow.className = 'gg-primer-row';
      fwdRow.innerHTML = `
        <td rowspan="2" class="gg-primer-idx">${i + 1}</td>
        <td rowspan="2" class="gg-primer-name">
          <strong>${escapeHTML(p.name)}</strong>
          <div class="muted small">${typeLabel}</div>
        </td>
        <td><span class="gg-dir gg-dir-fwd">fwd →</span></td>
        <td><code class="gg-primer-seq">${r.fwd}</code></td>
        <td class="gg-primer-len">${r.fwdLen} nt</td>
        <td class="gg-primer-tm">${formatTm(r.fwdAnnealTm)}</td>
        <td class="gg-primer-hp">${fwdHairpinCell}</td>
      `;
      tbody.appendChild(fwdRow);

      const revRow = document.createElement('tr');
      revRow.className = 'gg-primer-row';
      revRow.innerHTML = `
        <td><span class="gg-dir gg-dir-rev">← rev</span></td>
        <td><code class="gg-primer-seq">${r.rev}</code></td>
        <td class="gg-primer-len">${r.revLen} nt</td>
        <td class="gg-primer-tm">${formatTm(r.revAnnealTm)}</td>
        <td class="gg-primer-hp">${revHairpinCell}</td>
      `;
      tbody.appendChild(revRow);
    });
  }

  function renderScan(parts, enzyme) {
    const el = $('#ggScan');
    el.innerHTML = '';
    let anyHit = false;
    parts.forEach((p) => {
      const s = scanInternalSites(p.sequence || '', enzyme);
      const ok = s.total === 0;
      if (!ok) anyHit = true;
      const row = document.createElement('div');
      row.className = 'gg-scan-row ' + (ok ? 'is-ok' : 'is-bad');

      if (ok) {
        row.innerHTML = `
          <span class="gg-scan-ico">✓</span>
          <span class="gg-scan-name">${escapeHTML(p.name)}</span>
          <span class="gg-scan-msg">No internal ${enzyme.name} sites — this part is ready.</span>
        `;
        el.appendChild(row);
        return;
      }

      // For parts with hits, build a domestication plan and render each
      // suggestion as an actionable card.
      const plan = planDomestication(p.sequence || '', p.type, enzyme);

      const head = document.createElement('div');
      head.className = 'gg-scan-row is-bad';
      head.innerHTML = `
        <span class="gg-scan-ico">✕</span>
        <span class="gg-scan-name">${escapeHTML(p.name)}</span>
        <span class="gg-scan-msg">${s.total} internal ${enzyme.name} site${s.total === 1 ? '' : 's'} (fwd: ${s.fwd.length}, rev: ${s.rev.length}). ${
          plan.clean
            ? `<strong>Helper found a ${plan.plan.length}-step fix below.</strong>`
            : '<strong>Helper could not fully domesticate this part automatically.</strong> Try a manual edit on the Bench.'
        }</span>
      `;
      el.appendChild(head);

      const helper = document.createElement('div');
      helper.className = 'gg-domestication';
      helper.innerHTML = plan.plan.map((sug, idx) => renderSuggestion(sug, idx, p, enzyme)).join('');
      if (plan.plan.length > 0) {
        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn btn-primary btn-block-sm';
        applyBtn.dataset.applyUid = p.uid;
        applyBtn.dataset.applySeq = plan.finalSeq;
        applyBtn.textContent = plan.clean
          ? `Apply all ${plan.plan.length} suggestion${plan.plan.length === 1 ? '' : 's'} to “${p.name}”`
          : `Apply ${plan.plan.length} partial suggestion${plan.plan.length === 1 ? '' : 's'} to “${p.name}”`;
        helper.appendChild(applyBtn);
      }
      el.appendChild(helper);
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

  // Render a single suggestion as a card with context, before/after, and
  // an explanation of what changes.
  function renderSuggestion(sug, idx, part, enzyme) {
    const seq = sug.before;
    const newSeq = sug.after;
    const hitPos = sug.hitPos;
    const hitLen = sug.hitLen;
    const ctxStart = Math.max(0, hitPos - 8);
    const ctxEnd   = Math.min(seq.length, hitPos + hitLen + 8);

    const highlight = (s, mutPositions) => {
      const out = [];
      for (let i = 0; i < s.length; i++) {
        const abs = ctxStart + i;
        const inSite = abs >= hitPos && abs < hitPos + hitLen;
        const mut = mutPositions.has(abs);
        const cls = mut ? 'mut' : inSite ? 'site' : '';
        out.push(cls ? `<span class="${cls}">${s[i]}</span>` : s[i]);
      }
      return out.join('');
    };

    let mutPositions = new Set();
    let label = '';
    if (sug.strategy === 'silent') {
      for (let i = 0; i < 3; i++) {
        if (sug.oldCodon[i] !== sug.newCodon[i]) mutPositions.add(sug.codonStart + i);
      }
      label = `Silent codon swap: <code>${sug.oldCodon}</code> → <code>${sug.newCodon}</code> (both code for <strong>${sug.aa}</strong>). Position ${sug.codonStart + 1}–${sug.codonStart + 3}.`;
    } else if (sug.strategy === 'point') {
      mutPositions.add(sug.pos);
      label = `Single-base swap at position ${sug.pos + 1}: <code>${sug.oldBase}</code> → <code>${sug.newBase}</code>. ${sug.warning ? `<em class="muted">${sug.warning}</em>` : ''}`;
    }

    const before = highlight(seq.slice(ctxStart, ctxEnd), new Set());
    const after  = highlight(newSeq.slice(ctxStart, ctxEnd), mutPositions);
    const strandLabel = sug.strand === '+' ? 'forward strand' : 'reverse strand';

    return `
      <div class="gg-suggest">
        <div class="gg-suggest-head">
          <span class="gg-suggest-num">#${idx + 1}</span>
          <span class="gg-suggest-loc">${enzyme.name} site on the <strong>${strandLabel}</strong> at position ${hitPos + 1}</span>
        </div>
        <div class="gg-suggest-body">
          <div>${label}</div>
          <div class="gg-suggest-seq">
            <span class="gg-suggest-tag">before</span><code>…${before}…</code>
          </div>
          <div class="gg-suggest-seq">
            <span class="gg-suggest-tag">after</span><code>…${after}…</code>
          </div>
        </div>
      </div>
    `;
  }

  // Apply a domestication plan to a part and rerender. Also persists the
  // updated design so the Bench picks up the fix on next visit.
  function applyDomestication(uid, newSeq) {
    if (!design) return;
    const part = design.parts.find((p) => p.uid === uid);
    if (!part) return;
    part.sequence = newSeq;
    try { localStorage.setItem('assemblybench:design', JSON.stringify(design)); } catch (_) {}
    rerender();
  }

  function renderProtocol(parts, enzyme) {
    const n = parts.length;
    const fmolPerPart = 40;   // equimolar input per part
    const vectorFmol  = 20;
    const totalUL     = 20;

    // Stock concentrations (typical lab / NEB defaults). Per-stock volumes are
    // computed for a single 20 µL reaction. Part / vector volumes assume each
    // is supplied as a 20 fmol/µL working stock — adjust if your prep differs.
    const STOCKS = [
      {
        label: 'Destination vector working stock',
        stock: '20 fmol/µL',
        per20: vectorFmol / 20,
        prep: 'Dilute the destination plasmid in nuclease-free water so 1 µL = 20 fmol. For a 5 kb plasmid that\'s ≈66 ng/µL.',
        amount: `${vectorFmol} fmol`,
      },
      ...parts.map((p) => {
        const bp = p.sequence?.length || 0;
        // ng/µL needed in the 20 fmol/µL working stock = (bp × 650 × 20) / 1e6
        const ngPerUL = (bp * 650 * 20) / 1e6;
        return {
          label: `${p.name} working stock`,
          stock: '20 fmol/µL',
          per20: fmolPerPart / 20,
          prep: bp > 0
            ? `1 µL = 20 fmol ≈ ${ngPerUL.toFixed(1)} ng/µL for ${bp.toLocaleString()} bp. Dilute the PCR or gBlock with nuclease-free water.`
            : 'Set 1 µL = 20 fmol after quantifying the PCR product.',
          amount: `${fmolPerPart} fmol`,
        };
      }),
      {
        label: `${enzyme.name}`,
        stock: '10 U/µL (NEB)',
        per20: 1.0,
        prep: `Keep on ice. Vortex briefly; if frozen aliquots are colder than −20 °C, thaw on ice. Add last to the master mix.`,
        amount: '10 U',
      },
      {
        label: 'T4 DNA ligase (high-conc.)',
        stock: '400 U/µL (NEB M0202M)',
        per20: 1.0,
        prep: 'Use the high-concentration form (HC ligase). 1 µL = 400 U.',
        amount: '400 U',
      },
      {
        label: '10× T4 ligase buffer (with ATP)',
        stock: '10×',
        per20: 2.0,
        prep: 'Thaw at room temperature, mix well — ATP precipitates at the bottom of the tube on repeated freeze/thaw. Make single-use aliquots if possible.',
        amount: '1× final',
      },
    ];
    const usedUL = STOCKS.reduce((s, x) => s + x.per20, 0);
    const waterUL = Math.max(0, totalUL - usedUL);
    const cyclesN = Math.max(20, 15 + n * 2);

    const html = `
      <div class="gg-protocol-card gg-protocol-mix">
        <h4>Reaction mix &nbsp;<span class="muted small">(${totalUL} µL final volume)</span></h4>
        <table class="gg-recipe">
          <thead>
            <tr>
              <th style="text-align:left;">Component</th>
              <th style="text-align:right;">Stock</th>
              <th style="text-align:right;">µL / 20 µL rxn</th>
              <th style="text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${STOCKS.map((s) => `
              <tr>
                <td>${escapeHTML(s.label)}</td>
                <td style="text-align:right;">${escapeHTML(s.stock)}</td>
                <td>${s.per20.toFixed(2)} µL</td>
                <td>${escapeHTML(s.amount)}</td>
              </tr>
            `).join('')}
            <tr>
              <td>Nuclease-free water</td>
              <td style="text-align:right;">—</td>
              <td>${waterUL.toFixed(2)} µL</td>
              <td>to ${totalUL} µL</td>
            </tr>
            <tr class="gg-recipe-total">
              <td>Total</td>
              <td style="text-align:right;">—</td>
              <td>${totalUL.toFixed(2)} µL</td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
        <p class="muted small" style="margin-top:10px;">Assemble the master mix on ice in the order: water → buffer → DNA parts → ligase → ${enzyme.name}. Spin briefly to collect.</p>
      </div>

      <div class="gg-protocol-card">
        <h4>Stock prep notes</h4>
        <ul class="gg-stock-list">
          ${STOCKS.map((s) => `
            <li>
              <strong>${escapeHTML(s.label)}</strong> <span class="muted small">(${escapeHTML(s.stock)})</span>
              <div class="muted small">${escapeHTML(s.prep)}</div>
            </li>
          `).join('')}
          <li>
            <strong>Nuclease-free water</strong> <span class="muted small">(stock: ultra-pure / molecular biology grade)</span>
            <div class="muted small">Use a fresh aliquot. Avoid pipetting from a shared bottle to keep the stock RNase- and nuclease-free.</div>
          </li>
        </ul>
        <p class="muted small" style="margin-top:6px;">Tip: quantify each PCR / gBlock with a Qubit or NanoDrop, then compute fmol from <code>fmol = ng × 1000 / (bp × 0.65)</code>. Dilute to 20 fmol/µL so 1 µL ≡ 20 fmol — the recipe above does the rest.</p>
      </div>

      <div class="gg-protocol-card">
        <h4>Thermocycler program</h4>
        <ol class="gg-cycle">
          <li><strong>Digest + ligate cycle</strong> — repeat ${cyclesN}×:
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

    // Cache the protocol numbers so the CSV exporter can reuse them.
    rerender._lastProtocol = { stocks: STOCKS, waterUL, totalUL, cyclesN };
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

  // CSV-escape a cell (RFC 4180): wrap in quotes if it contains comma / quote /
  // newline, and double any internal quotes.
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  function csvRow(arr) { return arr.map(csvCell).join(','); }

  function exportExperimentCSV() {
    if (!design || !design.parts.length) {
      alert('Load or build a design first.');
      return;
    }
    const enzyme = ENZYMES[enzymeName];
    const overhangs = assignOverhangs(design.parts);
    const primers = designPrimers(design.parts, overhangs, enzyme);
    const assembled = buildAssembledSequence(design.parts, overhangs);
    const proto = rerender._lastProtocol || {};
    const stocks = proto.stocks || [];

    const lines = [];
    const ts = new Date().toISOString();
    lines.push('# AssemblyBench — Golden Gate experimental design export');
    lines.push(`# Generated: ${ts}`);
    lines.push(`# Construct: ${design.name}`);
    lines.push(`# Enzyme: ${enzyme.name} (site ${enzyme.site}/${enzyme.siteRC})`);
    lines.push(`# Overhang set: ${overhangSet}`);
    lines.push('');

    // --- Section 1: Parts ---
    lines.push('## parts');
    lines.push(csvRow(['index', 'name', 'type', 'length_bp', 'upstream_overhang', 'downstream_overhang', 'internal_sites', 'sequence']));
    design.parts.forEach((p, i) => {
      const scan = scanInternalSites(p.sequence || '', enzyme);
      lines.push(csvRow([
        i + 1,
        p.name,
        window.PART_TYPE_META?.[p.type]?.label || p.type,
        (p.sequence || '').length,
        overhangs[i] || '',
        overhangs[i + 1] || '',
        scan.total,
        p.sequence || '',
      ]));
    });
    lines.push('');

    // --- Section 2: Primers ---
    lines.push('## primers');
    lines.push(csvRow(['part_index', 'part_name', 'direction', 'sequence', 'length_nt', 'anneal_tm_c', 'hairpin_tm_c', 'hairpin_stem_bp', 'hairpin_loop_nt']));
    design.parts.forEach((p, i) => {
      const r = primers[i];
      lines.push(csvRow([
        i + 1, p.name, 'fwd', r.fwd, r.fwdLen,
        r.fwdAnnealTm !== null ? r.fwdAnnealTm.toFixed(1) : '',
        r.fwdHairpin ? r.fwdHairpin.tm.toFixed(1) : '',
        r.fwdHairpin ? r.fwdHairpin.stemLen : '',
        r.fwdHairpin ? r.fwdHairpin.loopLen : '',
      ]));
      lines.push(csvRow([
        i + 1, p.name, 'rev', r.rev, r.revLen,
        r.revAnnealTm !== null ? r.revAnnealTm.toFixed(1) : '',
        r.revHairpin ? r.revHairpin.tm.toFixed(1) : '',
        r.revHairpin ? r.revHairpin.stemLen : '',
        r.revHairpin ? r.revHairpin.loopLen : '',
      ]));
    });
    lines.push('');

    // --- Section 3: Junctions ---
    lines.push('## junctions');
    lines.push(csvRow(['junction_index', 'position', 'overhang_5prime']));
    overhangs.forEach((oh, i) => {
      const pos = i === 0 ? 'vector → first part'
        : i === overhangs.length - 1 ? 'last part → vector'
        : `${design.parts[i - 1].name} → ${design.parts[i].name}`;
      lines.push(csvRow([i + 1, pos, oh]));
    });
    lines.push('');

    // --- Section 4: Reaction mix ---
    lines.push('## reaction_mix_20uL');
    lines.push(csvRow(['component', 'stock', 'volume_uL', 'amount']));
    stocks.forEach((s) => {
      lines.push(csvRow([s.label, s.stock, s.per20.toFixed(2), s.amount]));
    });
    if (proto.waterUL !== undefined) {
      lines.push(csvRow(['Nuclease-free water', '—', proto.waterUL.toFixed(2), `to ${proto.totalUL} µL`]));
      lines.push(csvRow(['Total', '—', proto.totalUL.toFixed(2), '—']));
    }
    lines.push('');

    // --- Section 5: Predicted assembled sequence ---
    lines.push('## assembled_sequence');
    lines.push(csvRow(['name', 'length_bp', 'gc_percent', 'sequence']));
    lines.push(csvRow([
      design.name,
      assembled.length,
      gcPercent(assembled).toFixed(2),
      assembled,
    ]));

    const csv = lines.join('\n') + '\n';
    const name = (design.name || 'pAssembly').replace(/\s+/g, '_');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}_goldengate_${enzyme.name}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    flashButton('#ggExportCsvBtn', 'Downloaded ✓');
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
    $('#ggExportCsvBtn')?.addEventListener('click', exportExperimentCSV);
    $('#ggDownloadFastaBtn').addEventListener('click', downloadFasta);

    // Apply-suggestion buttons (event delegation)
    $('#ggScan').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-apply-uid]');
      if (!btn) return;
      applyDomestication(btn.dataset.applyUid, btn.dataset.applySeq);
    });

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
