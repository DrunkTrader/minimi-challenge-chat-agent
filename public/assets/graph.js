/**
 * Memory graph: an Obsidian-style force layout of what the agent remembers.
 *   chat  (accent)  one conversation; click to open it
 *   topic (warm)    an entity a chat touched (planner entities + extracted facts); shared topics link chats
 *   day   (ring)    the day a chat happened; days sit left → right in date order, a timeline spine
 * No library: ~O(n²) repulsion + springs, fine for the few hundred nodes a personal memory has.
 */
export class MemoryGraph {
  constructor(root, { onOpen, dayLabel, dayKey }) {
    root.__graph = this; // handy in devtools
    this.root = root; this.onOpen = onOpen; this.dayLabel = dayLabel; this.dayKey = dayKey;
    this.canvas = root.querySelector("canvas"); this.ctx = this.canvas.getContext("2d");
    this.tip = root.querySelector(".graph__tip"); this.summary = root.ownerDocument.getElementById("graph-summary");
    this.nodes = []; this.links = []; this.byId = new Map();
    this.w = 0; this.h = 0; this.alpha = 0; this.hover = null; this.drag = null; this.raf = 0;
    this.still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    new ResizeObserver(() => this.resize()).observe(root);
    this.bindPointer();
  }

  async load() {
    let data;
    try { data = await (await fetch("/api/graph")).json(); } catch { return; }
    const old = this.byId, nodes = [], links = [], byId = new Map();
    const add = (n) => { const o = old.get(n.id); Object.assign(n, o ? { x: o.x, y: o.y, vx: 0, vy: 0 } : { x: NaN, y: NaN, vx: 0, vy: 0 }); n.deg = 0; nodes.push(n); byId.set(n.id, n); return n; };
    const link = (a, b, len, k) => { links.push({ a, b, len, k }); a.deg++; b.deg++; };

    // days, oldest first
    const days = [...new Set(data.chats.map((c) => this.dayKey(c.started)))].sort();
    days.forEach((d, i) => add({ id: `d:${d}`, kind: "day", label: this.dayLabel(data.chats.find((c) => this.dayKey(c.started) === d).started), order: i, of: days.length }));
    for (let i = 1; i < days.length; i++) link(byId.get(`d:${days[i - 1]}`), byId.get(`d:${days[i]}`), 70, 0.05);
    for (const c of data.chats) link(add({ id: c.id, kind: "chat", label: c.label || "…", started: c.started }), byId.get(`d:${this.dayKey(c.started)}`), 42, 0.06);
    const topics = data.topics.filter((t) => t.chats.some((c) => byId.has(c))).sort((a, b) => b.chats.length - a.chats.length).slice(0, 60);
    for (const t of topics) { const n = add({ id: t.id, kind: "topic", label: t.label }); for (const c of t.chats) if (byId.has(c)) link(n, byId.get(c), 54, 0.05); }

    for (const n of nodes) n.r = n.kind === "day" ? 4.5 : n.kind === "chat" ? 6.5 : Math.min(10, 3 + n.deg * 1.6);
    this.nodes = nodes; this.links = links; this.byId = byId;
    if (!this.w) this.resize(); // the observer can fire before layout settles
    this.place();
    const chats = data.chats.length;
    this.summary.textContent = chats ? `${chats} chat${chats > 1 ? "s" : ""} · ${topics.length} topics · ${days.length} days` : "empty: ask something";
    this.heat(1);
  }

  /** New nodes start near what they attach to; days along the timeline. */
  place() {
    const { w, h } = this; if (!w) return;
    for (const n of this.nodes) {
      if (!Number.isNaN(n.x)) continue;
      if (n.kind === "day") { n.x = this.dayX(n); n.y = h / 2 + (Math.random() - 0.5) * 20; continue; }
      const nb = this.links.find((l) => (l.a === n && !Number.isNaN(l.b.x)) || (l.b === n && !Number.isNaN(l.a.x)));
      const at = nb ? (nb.a === n ? nb.b : nb.a) : { x: w / 2, y: h / 2 };
      n.x = at.x + (Math.random() - 0.5) * 60; n.y = at.y + (Math.random() - 0.5) * 60;
    }
  }
  dayX(n) { const pad = Math.min(90, this.w * 0.16); return n.of > 1 ? pad + (this.w - 2 * pad) * (n.order / (n.of - 1)) : this.w / 2; }

  resize() {
    const r = this.root.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    if (!r.width) return;
    const sx = this.w ? r.width / this.w : 1, sy = this.h ? r.height / this.h : 1;
    for (const n of this.nodes) { n.x *= sx; n.y *= sy; }
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr);
    this.place(); this.heat(0.3);
  }

  heat(a) {
    this.alpha = Math.max(this.alpha, a);
    if (this.still) { for (let i = 0; i < 300 && this.alpha > 0.004; i++) this.tick(); this.draw(); return; }
    if (!this.raf) { const loop = () => { this.tick(); this.draw(); this.raf = this.alpha > 0.004 || this.drag ? requestAnimationFrame(loop) : 0; }; this.raf = requestAnimationFrame(loop); }
  }

  tick() {
    const { nodes, links, w, h } = this, a = this.alpha, scale = Math.min(w, h) / 500;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const p = nodes[i], q = nodes[j]; let dx = q.x - p.x, dy = q.y - p.y; let d2 = dx * dx + dy * dy || 0.01;
      if (d2 > 90000) continue;
      const f = (700 * scale * a) / d2, d = Math.sqrt(d2); dx /= d; dy /= d;
      p.vx -= dx * f; p.vy -= dy * f; q.vx += dx * f; q.vy += dy * f;
    }
    for (const l of links) {
      let dx = l.b.x - l.a.x, dy = l.b.y - l.a.y; const d = Math.hypot(dx, dy) || 0.01;
      const f = (d - l.len * scale) * l.k * a; dx /= d; dy /= d;
      l.a.vx += dx * f; l.a.vy += dy * f; l.b.vx -= dx * f; l.b.vy -= dy * f;
    }
    for (const n of nodes) {
      n.vx += (w / 2 - n.x) * 0.004 * a; n.vy += (h / 2 - n.y) * 0.006 * a;
      if (n.kind === "day") n.vx += (this.dayX(n) - n.x) * 0.06 * a; // keep the timeline in date order
      if (n === this.drag?.node) { n.vx = n.vy = 0; continue; }
      n.vx *= 0.78; n.vy *= 0.78; n.x += n.vx; n.y += n.vy;
      const m = 22; n.x = Math.max(m, Math.min(w - m, n.x)); n.y = Math.max(m + 18, Math.min(h - m - 14, n.y));
    }
    this.alpha *= 0.985;
  }

  colors() {
    const s = getComputedStyle(this.root);
    const v = (k) => s.getPropertyValue(k).trim();
    return { accent: v("--accent"), warm: v("--warm"), muted: v("--muted"), faint: v("--faint"), edge: v("--edge"), bg: v("--surface"), ink: v("--ink-2"), mono: v("--mono") || "monospace" };
  }
  redraw() { this.draw(); }

  draw() {
    const { ctx, w, h, dpr } = this; if (!w) return;
    const c = this.colors(), hv = this.hover;
    const near = hv ? new Set([hv, ...this.links.filter((l) => l.a === hv || l.b === hv).map((l) => (l.a === hv ? l.b : l.a))]) : null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    for (const l of this.links) {
      const on = hv && (l.a === hv || l.b === hv), spine = l.a.kind === "day" && l.b.kind === "day";
      ctx.globalAlpha = hv ? (on ? 0.9 : 0.12) : spine ? 0.9 : 0.75;
      ctx.strokeStyle = on ? c.accent : c.edge; ctx.lineWidth = spine ? 1.4 : 1;
      ctx.setLineDash(spine ? [3, 4] : []);
      ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const n of this.nodes) {
      ctx.globalAlpha = near && !near.has(n) ? 0.25 : 1;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + (n === hv ? 2 : 0), 0, Math.PI * 2);
      if (n.kind === "day") { ctx.fillStyle = c.bg; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = c.muted; ctx.stroke(); }
      else {
        ctx.fillStyle = n.kind === "chat" ? c.accent : c.warm;
        if (n === hv || (n.kind === "chat" && !hv)) { ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = n === hv ? 18 : 8; }
        ctx.fill(); ctx.shadowBlur = 0;
      }
    }
    // labels: days always, shared topics always, everything next to the hovered node
    // labels by priority (hovered neighbourhood, days, most-shared topics); one that would overlap is skipped
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    const rank = (n) => (near?.has(n) ? 0 : n.kind === "day" ? 1 : 2 + 1 / (n.deg + 1));
    const want = this.nodes.filter((n) => n.kind === "day" || (n.kind === "topic" && (n.deg > 1 || near?.has(n))) || (near?.has(n) && n.kind !== "chat"));
    const boxes = [];
    for (const n of want.sort((a, b) => rank(a) - rank(b))) {
      ctx.font = n.kind === "day" ? `500 10px ${c.mono}` : `500 11px Inter, system-ui, sans-serif`;
      const text = n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label;
      const tw = ctx.measureText(text).width, x = n.x - tw / 2 - 2, y = n.y + n.r + 4, bw = tw + 4, bh = 14;
      if (boxes.some((b) => x < b.x + b.w && x + bw > b.x && y < b.y + b.h && y + bh > b.y)) continue;
      boxes.push({ x, y, w: bw, h: bh });
      ctx.globalAlpha = near && !near.has(n) ? 0.2 : 1;
      ctx.fillStyle = n.kind === "day" ? c.muted : c.ink;
      ctx.fillText(text, n.x, y + 1);
    }
    ctx.globalAlpha = 1;
  }

  hit(x, y) { let best = null, bd = 1e9; for (const n of this.nodes) { const d = Math.hypot(n.x - x, n.y - y); if (d < n.r + 8 && d < bd) { bd = d; best = n; } } return best; }

  showTip(n) {
    if (!n) { this.tip.classList.remove("on"); return; }
    const links = this.links.filter((l) => l.a === n || l.b === n), other = (l) => (l.a === n ? l.b : l.a);
    const chats = links.map(other).filter((m) => m.kind === "chat").length, topics = links.map(other).filter((m) => m.kind === "topic").length;
    const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const sub = n.kind === "chat" ? `${this.dayLabel(n.started)} · ${topics} topic${topics === 1 ? "" : "s"} · click to open`
      : n.kind === "topic" ? `in ${chats} chat${chats === 1 ? "" : "s"}` : `${chats} chat${chats === 1 ? "" : "s"}`;
    this.tip.innerHTML = `${esc(n.label)}<small>${esc(sub)}</small>`;
    const tw = 240, x = Math.min(this.w - tw - 8, Math.max(8, n.x + 14)), y = n.y > this.h - 90 ? n.y - 70 : n.y + 14;
    this.tip.style.left = `${x}px`; this.tip.style.top = `${y}px`; this.tip.classList.add("on");
  }

  bindPointer() {
    const pos = (e) => { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    this.canvas.addEventListener("pointermove", (e) => {
      const [x, y] = pos(e);
      if (this.drag) {
        const n = this.drag.node; n.x = x; n.y = y;
        if (Math.hypot(x - this.drag.x0, y - this.drag.y0) > 4) this.drag.moved = true;
        this.heat(0.25); this.showTip(null); return;
      }
      const n = this.hit(x, y);
      if (n !== this.hover) { this.hover = n; this.draw(); this.showTip(n); }
      this.canvas.classList.toggle("is-link", n?.kind === "chat");
    });
    this.canvas.addEventListener("pointerleave", () => { if (!this.drag) { this.hover = null; this.showTip(null); this.draw(); } });
    this.canvas.addEventListener("pointerdown", (e) => {
      const [x, y] = pos(e), n = this.hit(x, y); if (!n) return;
      this.drag = { node: n, x0: x, y0: y, moved: false }; this.canvas.setPointerCapture(e.pointerId); this.canvas.classList.add("is-drag");
    });
    const end = () => {
      if (!this.drag) return;
      const { node, moved } = this.drag; this.drag = null; this.canvas.classList.remove("is-drag");
      if (!moved && node.kind === "chat") this.onOpen(node.id); else this.heat(0.3);
    };
    this.canvas.addEventListener("pointerup", end); this.canvas.addEventListener("pointercancel", end);
  }
}
