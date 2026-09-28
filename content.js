(() => {
  'use strict';

  // An extension reload leaves the old copy of this script orphaned but still listening.
  // Tell any earlier copy to shut down before this one claims ⌘F.
  const TAKEOVER_EVENT = 'safari-find:takeover';
  document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));

  const IS_MAC = /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform);
  const HAS_EXT = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  const MAX_MATCHES = 5000;
  const DIM = 'rgba(0, 0, 0, 0.32)';
  const POP_MS = 340;
  const REINDEX_MS = 400;
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'IFRAME', 'OBJECT', 'EMBED', 'HEAD', 'CANVAS', 'VIDEO', 'AUDIO', 'SAFARI-FIND-OVERLAY',
  ]);
  const INVISIBLE = new Set(['­', '​', '‌', '‍', '⁠', '﻿']);
  const WORD = /[\p{L}\p{N}]/u;
  const MARK = /^\p{M}$/u;

  let ui = null;
  let isOpen = false;
  let mode = 'contains';
  let index = null;
  let matches = [];
  let capped = false;
  let current = -1;
  let overlayVisible = false;
  let popStart = 0;
  let rafId = 0;
  let pollTimer = 0;
  let reindexTimer = 0;
  let hideTimer = 0;
  let observer = null;
  let restoreFocus = null;
  const scratch = document.createRange();

  // ---------------------------------------------------------------------------
  // Text folding: case- and accent-insensitive, one output char per input char
  // so index positions map straight back to DOM offsets.

  const foldCache = new Map();
  function fold(c) {
    const code = c.charCodeAt(0);
    if (code < 128) return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : c;
    let f = foldCache.get(c);
    if (f === undefined) {
      if (MARK.test(c)) f = '';
      else {
        let lower = c.toLowerCase();
        if (lower.length !== 1) lower = c;
        f = lower.normalize('NFD')[0] || lower;
      }
      foldCache.set(c, f);
    }
    return f;
  }

  const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ' ' || (c > '\u007f' && /\s/.test(c));

  function foldQuery(q) {
    let out = '';
    let space = false;
    for (const c of q) {
      if (INVISIBLE.has(c)) continue;
      if (isSpace(c)) {
        if (!space) out += ' ';
        space = true;
        continue;
      }
      for (const unit of c) out += fold(unit);
      space = false;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Index: the page's visible text in flat-tree order (shadow DOM included),
  // whitespace collapsed, with a hard break at every block boundary.

  function buildIndex() {
    const parts = [];
    const nodeOf = [];
    const offOf = [];
    const nodes = [];
    let space = true;

    const brk = () => {
      if (parts.length && nodeOf[nodeOf.length - 1] !== -1) {
        parts.push('\n');
        nodeOf.push(-1);
        offOf.push(0);
      }
      space = true;
    };

    const addText = (node) => {
      const data = node.data;
      let ni = -1;
      for (let i = 0; i < data.length; i++) {
        const c = data[i];
        if (INVISIBLE.has(c)) continue;
        let f;
        if (isSpace(c)) {
          if (space) continue;
          space = true;
          f = ' ';
        } else {
          f = fold(c);
          if (!f) continue;
          space = false;
        }
        if (ni < 0) ni = nodes.push(node) - 1;
        parts.push(f);
        nodeOf.push(ni);
        offOf.push(i);
      }
    };

    const visitChildren = (parent, visibility) => {
      for (let n = parent.firstChild; n; n = n.nextSibling) visit(n, visibility);
    };

    const visit = (n, visibility) => {
      if (n.nodeType === Node.TEXT_NODE) {
        if (visibility === 'visible' && n.data) addText(n);
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const el = n;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (el.tagName === 'BR') return brk();
      const cs = getComputedStyle(el);
      const display = cs.display;
      if (display === 'none') return;
      // Visually-hidden "sr-only" text: absolutely positioned, clipped to ~1px.
      if ((cs.position === 'absolute' || cs.position === 'fixed') &&
          (cs.clip !== 'auto' || cs.clipPath !== 'none' || cs.overflow === 'hidden')) {
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) return;
      }
      const inline = display === 'inline' || display === 'contents' || display.startsWith('ruby');
      if (!inline) brk();
      if (cs.contentVisibility !== 'hidden') {
        if (el.shadowRoot) visitChildren(el.shadowRoot, cs.visibility);
        else if (el.tagName === 'SLOT') {
          const assigned = el.assignedNodes({ flatten: true });
          if (assigned.length) assigned.forEach((a) => visit(a, cs.visibility));
          else visitChildren(el, cs.visibility);
        } else visitChildren(el, cs.visibility);
      }
      if (!inline) brk();
    };

    visit(document.body || document.documentElement, 'visible');
    return { text: parts.join(''), nodeOf, offOf, nodes };
  }

  // ---------------------------------------------------------------------------
  // Search

  function toSegments(start, end) {
    const { nodeOf, offOf, nodes } = index;
    const segs = [];
    let seg = null;
    for (let k = start; k < end; k++) {
      const ni = nodeOf[k];
      if (ni < 0) continue;
      if (seg && seg.ni === ni) seg.end = offOf[k] + 1;
      else {
        seg = { ni, node: nodes[ni], start: offOf[k], end: offOf[k] + 1, info: null };
        segs.push(seg);
      }
    }
    return segs;
  }

  function segRects(seg, start = seg.start, end = seg.end) {
    scratch.setStart(seg.node, start);
    scratch.setEnd(seg.node, end);
    const out = [];
    for (const r of scratch.getClientRects()) if (r.width > 0.5 && r.height > 0.5) out.push(r);
    return out;
  }

  function firstRect(match) {
    for (const seg of match.segs) {
      if (!seg.node.isConnected) continue;
      const rects = segRects(seg);
      if (rects.length) return rects[0];
    }
    return null;
  }

  // Drop matches that have no box, or that sit off-page (left: -9999px tricks).
  function isRendered(match) {
    const r = firstRect(match);
    return !!r && r.right + scrollX > 0 && r.bottom + scrollY > 0;
  }

  function search(q) {
    const needle = foldQuery(q);
    if (!needle.trim()) return { list: [], capped: false };
    const text = index.text;
    const list = [];
    let from = 0;
    let hitCap = false;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      from = at + 1;
      if (mode === 'begins' && at > 0 && WORD.test(text[at - 1])) continue;
      const match = { start: at, end: at + needle.length, segs: toSegments(at, at + needle.length) };
      if (!match.segs.length || !isRendered(match)) continue;
      list.push(match);
      from = match.end;
      if (list.length >= MAX_MATCHES) {
        hitCap = true;
        break;
      }
    }
    return { list, capped: hitCap };
  }

  function runSearch() {
    if (!ui) return;
    const q = ui.input.value;
    if (!index) index = buildIndex();
    const anchor = matches[current]?.start;
    const res = q ? search(q) : { list: [], capped: false };
    matches = res.list;
    capped = res.capped;
    current = -1;
    if (matches.length) {
      // Refining the query keeps you where you were, like Safari.
      if (anchor != null) current = matches.findIndex((m) => m.start >= anchor);
      if (current < 0) current = firstInView();
      overlayVisible = true;
      popStart = performance.now();
      revealCurrent();
    }
    updateBar();
    requestDraw();
  }

  // Page changed under us: rebuild, and try to stay on the same match.
  function refresh() {
    reindexTimer = 0;
    if (!isOpen || !ui) return;
    if (!ui.input.value.trim()) {
      index = null;
      return;
    }
    const old = matches[current]?.segs[0];
    index = buildIndex();
    const res = search(ui.input.value);
    matches = res.list;
    capped = res.capped;
    let idx = -1;
    if (old) {
      idx = matches.findIndex((m) => m.segs[0].node === old.node && m.segs[0].start === old.start);
      if (idx < 0 && old.node.isConnected) {
        idx = matches.findIndex((m) => old.node.compareDocumentPosition(m.segs[0].node) & Node.DOCUMENT_POSITION_FOLLOWING);
      }
    }
    current = matches.length ? (idx >= 0 ? idx : Math.min(Math.max(current, 0), matches.length - 1)) : -1;
    updateBar();
    requestDraw();
  }

  function scheduleReindex(records) {
    if (reindexTimer || !isOpen) return;
    const ours = records.every((r) => r.target === ui?.host ||
      [...r.addedNodes, ...r.removedNodes].every((n) => n === ui?.host));
    if (ours) return;
    reindexTimer = setTimeout(refresh, REINDEX_MS);
  }

  function barBottom() {
    return ui ? ui.bar.getBoundingClientRect().bottom + 8 : 0;
  }

  function firstInView() {
    for (let i = 0; i < matches.length; i++) {
      const r = firstRect(matches[i]);
      if (r && r.bottom > 0) return i;
    }
    return 0;
  }

  function step(dir) {
    if (!matches.length) return;
    current = (current + dir + matches.length) % matches.length;
    overlayVisible = true;
    popStart = performance.now();
    revealCurrent();
    updateBar();
    requestDraw();
  }

  // Scroll so the current match is visible, centred in its nearest scroller.
  function revealCurrent() {
    const match = matches[current];
    if (!match) return;
    let r = firstRect(match);
    if (!r) return;
    const top = barBottom();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const bar = ui.bar.getBoundingClientRect();
    const underBar = (r) => r.bottom > bar.top && r.top < top && r.right > bar.left && r.left < bar.right;
    if (r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw && !underBar(r)) return;

    const el = match.segs[0].node.parentElement;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    r = firstRect(match);
    if (!r) return;

    const scroller = scrollParent(el);
    if (scroller) {
      const c = scroller.getBoundingClientRect();
      scroller.scrollBy({
        top: r.top + r.height / 2 - (c.top + c.height / 2),
        left: r.left < c.left || r.right > c.right ? r.left + r.width / 2 - (c.left + c.width / 2) : 0,
        behavior: 'instant',
      });
      r = firstRect(match);
      if (!r) return;
    }
    // We had to scroll anyway, so don't leave the match hugging an edge.
    const needY = r.top < 60 || r.bottom > vh - 60 || underBar(r);
    const needX = r.left < 0 || r.right > vw;
    if (needY || needX) {
      window.scrollBy({
        top: needY ? r.top + r.height / 2 - (top + (vh - top) / 2) : 0,
        left: needX ? r.left + r.width / 2 - vw / 2 : 0,
        behavior: 'instant',
      });
    }
  }

  function scrollParent(el) {
    for (let a = el.parentElement || el.getRootNode().host; a; a = a.parentElement || a.getRootNode().host) {
      if (a === document.body || a === document.documentElement) return null;
      const s = getComputedStyle(a);
      const canY = /(auto|scroll|overlay)/.test(s.overflowY) && a.scrollHeight > a.clientHeight + 1;
      const canX = /(auto|scroll|overlay)/.test(s.overflowX) && a.scrollWidth > a.clientWidth + 1;
      if (canY || canX) return a;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Drawing: dim the whole viewport, then paint each match as a white pill
  // with the text re-drawn in black on top (the current one is yellow and pops).

  function requestDraw() {
    if (!rafId) rafId = requestAnimationFrame(draw);
  }

  function segInfo(seg) {
    if (seg.info) return seg.info;
    const el = seg.node.parentElement || seg.node.parentNode?.host || document.documentElement;
    const cs = getComputedStyle(el);
    const clips = [];
    for (let a = el; a; a = a.parentElement || a.getRootNode().host) {
      if (a === document.body || a === document.documentElement) break;
      const s = a === el ? cs : getComputedStyle(a);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') clips.push(a);
      if (s.position === 'fixed') break;
    }
    const caps = cs.fontVariantCaps === 'small-caps' ? 'small-caps ' : '';
    seg.info = {
      el,
      font: `${cs.fontStyle} ${caps}${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
      letterSpacing: cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing,
      transform: cs.textTransform,
      clips,
    };
    return seg.info;
  }

  function segText(seg, info, from, to) {
    const data = seg.node.data;
    let out = '';
    let space = false;
    for (let i = from; i < to; i++) {
      let c = data[i];
      if (INVISIBLE.has(c)) continue;
      if (isSpace(c)) {
        if (!space) out += ' ';
        space = true;
        continue;
      }
      space = false;
      if (info.transform === 'uppercase') c = c.toUpperCase();
      else if (info.transform === 'lowercase') c = c.toLowerCase();
      else if (info.transform === 'capitalize' && (i === 0 || !WORD.test(data[i - 1]))) c = c.toUpperCase();
      out += c;
    }
    return out;
  }

  function collectBoxes(seg, vw, vh, clipCache, out) {
    if (!seg.node.isConnected) return;
    const rects = segRects(seg);
    if (!rects.length) return;
    if (rects.every((r) => r.bottom < -40 || r.top > vh + 40 || r.right < -40 || r.left > vw + 40)) return;

    const info = segInfo(seg);
    let clip = null;
    for (const el of info.clips) {
      let r = clipCache.get(el);
      if (!r) clipCache.set(el, (r = el.getBoundingClientRect()));
      clip = clip ? intersect(clip, r) : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      if (!clip) return;
    }

    const push = (r, text) => {
      if (!text.trim()) return;
      if (isOccluded(r, info.el, vw, vh)) return;
      if (clip && (r.right <= clip.left || r.left >= clip.right || r.bottom <= clip.top || r.top >= clip.bottom)) return;
      const inside = !clip || (r.left >= clip.left && r.right <= clip.right && r.top >= clip.top && r.bottom <= clip.bottom);
      out.push({ x: r.left, y: r.top, w: r.width, h: r.height, text, info, clip: inside ? null : clip });
    };

    if (rects.length === 1) {
      push(rects[0], segText(seg, info, seg.start, seg.end));
      return;
    }

    // The match wraps across lines: split it character by character.
    let line = null;
    const flush = () => {
      if (line) push(line.rect, segText(seg, info, line.from, line.to));
    };
    const data = seg.node.data;
    for (let i = seg.start; i < seg.end; i++) {
      if (isSpace(data[i]) || INVISIBLE.has(data[i])) continue;
      const r = segRects(seg, i, i + 1)[0];
      if (!r) continue;
      if (line && Math.abs(r.top - line.rect.top) > r.height / 2) {
        flush();
        line = null;
      }
      if (!line) line = { from: i, to: i + 1, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } };
      else {
        line.to = i + 1;
        line.rect.left = Math.min(line.rect.left, r.left);
        line.rect.right = Math.max(line.rect.right, r.right);
        line.rect.top = Math.min(line.rect.top, r.top);
        line.rect.bottom = Math.max(line.rect.bottom, r.bottom);
      }
      line.rect.width = line.rect.right - line.rect.left;
      line.rect.height = line.rect.bottom - line.rect.top;
    }
    flush();
  }

  // Is something opaque (a popup, a modal, an image) drawn over this text?
  // Transparent overlays like "stretched link" click targets don't count.
  const OPAQUE_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'PICTURE']);
  function isOccluded(r, el, vw, vh) {
    const x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit || hit === el || el.contains(hit)) return false;
    for (let a = hit; a && !a.contains(el); a = a.parentElement || a.getRootNode().host) {
      if (a === document.body || a === document.documentElement) break;
      if (OPAQUE_TAGS.has(a.tagName)) return true;
      const s = getComputedStyle(a);
      if (s.backgroundImage !== 'none') return true;
      const c = s.backgroundColor.match(/[\d.]+/g);
      if (c && (c.length < 4 ? 1 : +c[3]) > 0.5) return true;
    }
    return false;
  }

  function intersect(a, b) {
    const r = {
      left: Math.max(a.left, b.left),
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom),
    };
    return r.right > r.left && r.bottom > r.top ? r : null;
  }

  // Grow quickly, then settle back — Safari's little "bounce".
  function popScale(t) {
    const peak = 0.3;
    if (t < 0.3) return 1 + peak * Math.sin((t / 0.3) * (Math.PI / 2));
    return 1 + peak * Math.cos(((t - 0.3) / 0.7) * (Math.PI / 2));
  }

  function draw() {
    rafId = 0;
    if (!ui) return;
    const { canvas, ctx } = ui;
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(vw * dpr);
    const ph = Math.round(vh * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    if (!isOpen || !overlayVisible || !matches.length) return;

    ctx.fillStyle = DIM;
    ctx.fillRect(0, 0, vw, vh);

    const clipCache = new Map();
    const others = [];
    let mine = null;
    matches.forEach((m, i) => {
      const boxes = [];
      for (const seg of m.segs) collectBoxes(seg, vw, vh, clipCache, boxes);
      if (!boxes.length) return;
      if (i === current) mine = boxes;
      else others.push(boxes);
    });

    for (const boxes of others) paintMatch(boxes, false, 1, dpr);
    const t = (performance.now() - popStart) / POP_MS;
    if (mine) paintMatch(mine, true, t < 1 ? popScale(t) : 1, dpr);
    if (t < 1) requestDraw();
  }

  // One pill per line of a match, even when it spans several text nodes (Ye<b>lp</b>).
  function pills(boxes) {
    const lines = [];
    for (const b of boxes) {
      const line = lines.find((l) => b.y < l.bottom - b.h / 2 && b.y + b.h > l.top + b.h / 2 &&
        b.x <= l.right + 4 && b.x + b.w >= l.left - 4);
      if (line) {
        line.left = Math.min(line.left, b.x);
        line.right = Math.max(line.right, b.x + b.w);
        line.top = Math.min(line.top, b.y);
        line.bottom = Math.max(line.bottom, b.y + b.h);
        line.clip = line.clip || b.clip;
        line.boxes.push(b);
      } else {
        lines.push({ left: b.x, top: b.y, right: b.x + b.w, bottom: b.y + b.h, clip: b.clip, boxes: [b] });
      }
    }
    return lines;
  }

  function clipTo(ctx, clip) {
    if (!clip) return;
    ctx.beginPath();
    ctx.rect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
    ctx.clip();
  }

  function paintMatch(boxes, isCurrent, scale, dpr) {
    const { ctx } = ui;
    for (const l of pills(boxes)) {
      const h = l.bottom - l.top;
      const padX = Math.max(1.5, h * 0.14);
      const padY = Math.max(1, h * 0.06);
      ctx.save();
      if (scale !== 1) {
        const cx = (l.left + l.right) / 2;
        const cy = (l.top + l.bottom) / 2;
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);
        ctx.translate(-cx, -cy);
      }
      ctx.save();
      clipTo(ctx, l.clip);
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = 4 * dpr * scale;
      ctx.shadowOffsetY = 1 * dpr * scale;
      ctx.fillStyle = isCurrent ? '#ffd60a' : '#ffffff';
      ctx.beginPath();
      ctx.roundRect(l.left - padX, l.top - padY, l.right - l.left + padX * 2, h + padY * 2, Math.min(5, h * 0.22));
      ctx.fill();
      ctx.restore();
      for (const b of l.boxes) {
        ctx.save();
        clipTo(ctx, b.clip);
        paintText(ctx, b);
        ctx.restore();
      }
      ctx.restore();
    }
  }

  function paintText(ctx, b) {
    ctx.font = b.info.font;
    ctx.letterSpacing = b.info.letterSpacing;
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(b.text);
    const asc = m.fontBoundingBoxAscent;
    const desc = m.fontBoundingBoxDescent;
    let sx = m.width > 0 ? b.w / m.width : 1;
    let sy = 1;
    // Big mismatch means the text is CSS-transformed or zoomed: scale uniformly.
    if (sx < 0.8 || sx > 1.25) sy = sx;
    if (!isFinite(sx) || sx <= 0) sx = sy = 1;
    const baseline = b.y + (b.h - (asc + desc) * sy) / 2 + asc * sy;
    ctx.translate(b.x, baseline);
    ctx.scale(sx, sy);
    ctx.fillText(b.text, 0, 0);
  }

  // ---------------------------------------------------------------------------
  // UI (shadow DOM, top layer so nothing on the page can cover it)

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...children);
    return el;
  }

  function icon(paths, { fill = false, size = 16 } = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      if (fill) p.setAttribute('fill', 'currentColor');
      else {
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', 'currentColor');
        p.setAttribute('stroke-width', '2.4');
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
      }
      svg.append(p);
    }
    return svg;
  }

  const CSS = `
    * { box-sizing: border-box; }
    .wrap {
      --bg: rgba(242, 242, 244, 0.88);
      --fg: #1d1d1f;
      --muted: #86868b;
      --field: #ffffff;
      --field-edge: rgba(0, 0, 0, 0.14);
      --btn: rgba(0, 0, 0, 0.06);
      --btn-hover: rgba(0, 0, 0, 0.11);
      --btn-active: rgba(0, 0, 0, 0.17);
      --ring: rgba(0, 122, 255, 0.55);
      --edge: rgba(0, 0, 0, 0.12);
      --danger: rgba(255, 59, 48, 0.14);
      font: 13px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      color: var(--fg);
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      .wrap {
        --bg: rgba(38, 38, 40, 0.86);
        --fg: #f5f5f7;
        --muted: #98989d;
        --field: rgba(255, 255, 255, 0.07);
        --field-edge: rgba(255, 255, 255, 0.12);
        --btn: rgba(255, 255, 255, 0.09);
        --btn-hover: rgba(255, 255, 255, 0.15);
        --btn-active: rgba(255, 255, 255, 0.22);
        --ring: rgba(10, 132, 255, 0.7);
        --edge: rgba(255, 255, 255, 0.1);
        --danger: rgba(255, 69, 58, 0.22);
      }
    }
    canvas {
      position: fixed; inset: 0; width: 100%; height: 100%;
      pointer-events: none; display: block;
    }
    .bar {
      position: fixed; top: 10px; right: 16px;
      width: min(560px, calc(100vw - 20px));
      display: flex; align-items: center; gap: 8px;
      padding: 7px 8px;
      border-radius: 13px;
      background: var(--bg);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      backdrop-filter: blur(24px) saturate(180%);
      box-shadow: 0 0 0 0.5px var(--edge), 0 10px 32px rgba(0, 0, 0, 0.22), 0 2px 6px rgba(0, 0, 0, 0.1);
      transform: translateY(-14px) scale(0.98);
      opacity: 0;
      pointer-events: none;
      transition: opacity 140ms ease, transform 180ms cubic-bezier(.2, .9, .3, 1.2);
    }
    .bar.open { opacity: 1; transform: none; pointer-events: auto; }
    button, select, input { font: inherit; color: inherit; margin: 0; }
    button { cursor: default; }
    .mode { position: relative; flex: none; }
    .mode select {
      appearance: none; -webkit-appearance: none;
      height: 28px; padding: 0 24px 0 10px;
      border: 0; border-radius: 7px;
      background: var(--btn);
      font-weight: 500; outline: none;
    }
    .mode select:hover { background: var(--btn-hover); }
    .mode select:focus-visible { box-shadow: 0 0 0 3px var(--ring); }
    .mode svg { position: absolute; right: 7px; top: 50%; transform: translateY(-50%); pointer-events: none; opacity: 0.7; }
    .field {
      flex: 1; min-width: 0;
      display: flex; align-items: center; gap: 6px;
      height: 28px; padding: 0 6px 0 8px;
      border-radius: 7px;
      background: var(--field);
      box-shadow: inset 0 0 0 1px var(--field-edge);
      transition: box-shadow 120ms ease, background 120ms ease;
    }
    .field:focus-within { box-shadow: inset 0 0 0 1px var(--field-edge), 0 0 0 3px var(--ring); }
    .field.notfound { background: var(--danger); }
    .field > svg { flex: none; color: var(--muted); }
    input {
      flex: 1; min-width: 0; height: 100%;
      border: 0; outline: none; background: transparent; padding: 0;
    }
    input::placeholder { color: var(--muted); }
    .count { flex: none; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
    .clear {
      flex: none; display: grid; place-items: center;
      width: 16px; height: 16px; padding: 0; border: 0; border-radius: 50%;
      background: var(--muted); color: var(--field);
      opacity: 0.85;
    }
    @media (prefers-color-scheme: dark) { .clear { color: #2a2a2c; } }
    .clear:hover { opacity: 1; }
    .clear[hidden] { display: none; }
    .nav { flex: none; display: flex; border-radius: 7px; background: var(--btn); overflow: hidden; }
    .nav button {
      display: grid; place-items: center;
      width: 30px; height: 28px; padding: 0; border: 0; background: transparent;
    }
    .nav .sep { width: 1px; margin: 6px 0; background: var(--edge); }
    .nav button:hover:not(:disabled), .done:hover { background: var(--btn-hover); }
    .nav button:active:not(:disabled), .done:active { background: var(--btn-active); }
    .nav button:disabled { opacity: 0.35; }
    .done {
      flex: none; height: 28px; padding: 0 14px;
      border: 0; border-radius: 7px; background: var(--btn); font-weight: 500;
    }
    @media (max-width: 520px) { .mode { display: none; } }
  `;

  function ensureUI() {
    if (ui) return ui;

    const host = document.createElement('safari-find-overlay');
    host.setAttribute('style', [
      'all: initial', 'position: fixed', 'inset: 0', 'width: auto', 'height: auto',
      'margin: 0', 'padding: 0', 'border: 0', 'background: transparent', 'overflow: visible',
      'pointer-events: none', 'z-index: 2147483647', 'max-width: none', 'max-height: none',
      'color-scheme: normal',
    ].map((d) => d + ' !important').join('; '));
    const topLayer = typeof host.showPopover === 'function';
    if (topLayer) host.setAttribute('popover', 'manual');
    const root = host.attachShadow({ mode: 'open' });

    const canvas = h('canvas');
    const select = h('select', { 'aria-label': 'Match mode' },
      h('option', { value: 'contains' }, 'Contains'),
      h('option', { value: 'begins' }, 'Begins with'));
    select.value = mode;
    const input = h('input', {
      type: 'text', placeholder: 'Find on page', 'aria-label': 'Find on page',
      spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
    });
    const count = h('span', { class: 'count', 'aria-live': 'polite' });
    const clear = h('button', { class: 'clear', title: 'Clear', 'aria-label': 'Clear', hidden: '' },
      icon(['M7 7l10 10M17 7L7 17'], { size: 10 }));
    const field = h('div', { class: 'field' },
      icon(['M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.25 4.24-1.42 1.42-4.24-4.25A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z'], { fill: true, size: 14 }),
      input, count, clear);
    const prev = h('button', { title: 'Previous match (⇧↩)', 'aria-label': 'Previous match' }, icon(['M15 5l-7 7 7 7'], { size: 14 }));
    const next = h('button', { title: 'Next match (↩)', 'aria-label': 'Next match' }, icon(['M9 5l7 7-7 7'], { size: 14 }));
    const done = h('button', { class: 'done' }, 'Done');
    const bar = h('div', { class: 'bar', role: 'search' },
      h('div', { class: 'mode' }, select, icon(['M8 10l4-4 4 4', 'M8 14l4 4 4-4'], { size: 12 })),
      field,
      h('div', { class: 'nav' }, prev, h('span', { class: 'sep' }), next),
      done);
    const style = h('style');
    style.textContent = CSS;
    root.append(style, h('div', { class: 'wrap' }, canvas, bar));

    // Buttons shouldn't steal focus from the search field.
    for (const b of [clear, prev, next]) b.addEventListener('mousedown', (e) => e.preventDefault());

    input.addEventListener('input', () => runSearch());
    input.addEventListener('focus', () => {
      if (matches.length && !overlayVisible) {
        overlayVisible = true;
        requestDraw();
      }
    });
    select.addEventListener('change', () => {
      mode = select.value;
      if (HAS_EXT) chrome.storage?.local.set({ mode }).catch(() => {});
      runSearch();
      input.focus();
    });
    clear.addEventListener('click', () => {
      input.value = '';
      runSearch();
      input.focus();
    });
    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    done.addEventListener('click', () => close());

    ui = { host, canvas, ctx: canvas.getContext('2d'), bar, field, input, count, clear, prev, next, select, topLayer };
    return ui;
  }

  function updateBar() {
    const n = matches.length;
    const q = ui.input.value;
    ui.count.textContent = !q.trim() ? '' : n === 0 ? 'No matches'
      : `${current + 1} of ${n}${capped ? '+' : ''} ${n === 1 && !capped ? 'match' : 'matches'}`;
    ui.clear.hidden = !q;
    ui.field.classList.toggle('notfound', !!q.trim() && n === 0);
    ui.prev.disabled = ui.next.disabled = n === 0;
  }

  // ---------------------------------------------------------------------------
  // Open / close

  function openBar(prefill) {
    ensureUI();
    const { host, bar, input, topLayer } = ui;
    clearTimeout(hideTimer);
    if (!isOpen) {
      const active = deepActiveElement();
      restoreFocus = active && !host.contains(active) ? active : null;
      if (!host.isConnected) document.documentElement.append(host);
      if (topLayer) {
        // Re-show so we're above anything the page put in the top layer (dialogs, popovers).
        if (host.matches(':popover-open')) host.hidePopover();
        host.showPopover();
      }
      isOpen = true;
      index = null;
      matches = [];
      current = -1;
      attachWhileOpen();
      requestAnimationFrame(() => bar.classList.add('open'));
    }
    if (prefill != null) input.value = prefill;
    input.focus({ preventScroll: true });
    input.select();
    if (input.value) runSearch();
    else updateBar();
  }

  function close() {
    if (!isOpen || !ui) return;
    isOpen = false;
    overlayVisible = false;
    detachWhileOpen();
    ui.bar.classList.remove('open');
    requestDraw();

    // Leave the current match selected, like Safari/Chrome do.
    const match = matches[current];
    ui.input.blur();
    if (match && match.segs.every((s) => s.node.isConnected)) {
      try {
        const first = match.segs[0];
        const last = match.segs[match.segs.length - 1];
        const range = document.createRange();
        range.setStart(first.node, first.start);
        range.setEnd(last.node, last.end);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {}
    } else {
      restoreFocus?.focus?.({ preventScroll: true });
    }
    restoreFocus = null;

    hideTimer = setTimeout(() => {
      if (!isOpen && ui?.topLayer && ui.host.matches(':popover-open')) ui.host.hidePopover();
    }, 200);
  }

  function deepActiveElement() {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  const onScroll = () => requestDraw();
  const onPointerDown = (e) => {
    // Clicking the page drops the spotlight but leaves the bar, like Safari.
    if (!e.composedPath().includes(ui.host) && overlayVisible) {
      overlayVisible = false;
      requestDraw();
    }
  };

  function attachWhileOpen() {
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, true);
    // Catch layout shifts that don't scroll or mutate (images loading, animations).
    pollTimer = setInterval(() => overlayVisible && requestDraw(), 250);
    observer = new MutationObserver(scheduleReindex);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function detachWhileOpen() {
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('pointerdown', onPointerDown, true);
    clearInterval(pollTimer);
    clearTimeout(reindexTimer);
    reindexTimer = 0;
    observer?.disconnect();
    observer = null;
  }

  // ---------------------------------------------------------------------------
  // Keyboard

  function consume(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onKeyDown(e) {
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    const key = (e.key || '').toLowerCase();
    const fromUI = !!ui && e.composedPath().includes(ui.host);

    if (mod && !e.altKey && !e.shiftKey && key === 'f') {
      consume(e);
      openBar();
      return;
    }
    // ⌘E: "Use Selection for Find".
    if (IS_MAC && mod && !e.altKey && !e.shiftKey && key === 'e') {
      const sel = String(getSelection() || '').trim();
      if (sel && !fromUI) {
        consume(e);
        openBar(sel.replace(/\s+/g, ' ').slice(0, 300));
      }
      return;
    }
    if (!isOpen) return;
    if (mod && !e.altKey && key === 'g') {
      consume(e);
      step(e.shiftKey ? -1 : 1);
      return;
    }
    if (!fromUI) return;
    if (e.isComposing) {
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === 'Enter') {
      consume(e);
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      consume(e);
      close();
    } else {
      // Typing in the bar must not trigger the page's own shortcuts.
      e.stopImmediatePropagation();
    }
  }

  function onKeyOther(e) {
    if (ui && isOpen && e.composedPath().includes(ui.host)) e.stopImmediatePropagation();
  }

  function onMessage(msg, _sender, sendResponse) {
    if (msg?.type === 'ping') return sendResponse(true);
    if (msg?.type !== 'toggle') return;
    if (isOpen) close();
    else openBar();
  }

  function teardown() {
    try {
      close();
      detachWhileOpen();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyOther, true);
      window.removeEventListener('keypress', onKeyOther, true);
      ui?.host.remove();
      ui = null;
      if (HAS_EXT) chrome.runtime.onMessage.removeListener(onMessage);
    } catch {}
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyOther, true);
  window.addEventListener('keypress', onKeyOther, true);
  document.addEventListener(TAKEOVER_EVENT, teardown, { once: true });

  if (HAS_EXT) {
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.storage?.local.get('mode').then((v) => {
      if (v?.mode === 'contains' || v?.mode === 'begins') {
        mode = v.mode;
        if (ui) ui.select.value = mode;
      }
    }).catch(() => {});
  }
})();
