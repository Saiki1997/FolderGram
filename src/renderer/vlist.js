// A virtual list for the album preview: only rows near the visible area are in the page, so plans with thousands
// of folders stay fast. Rows can have any height; heights are measured after drawing and remembered.
'use strict';

class VirtualList {
  /**
   * container: the scrolling element. top/rows/bottom: spacer, row holder, spacer inside it.
   * render(row) -> HTML string. estimate(row) -> height guess. key(row) -> stable id. after(el, row) runs after drawing.
   */
  constructor({ container, top, rows, bottom, render, estimate, key, after }) {
    Object.assign(this, { container, top, rows, bottom, render, estimate, key, after });
    this.items = [];
    this.heights = new Map();
    this.overscan = 700;
    this.drawn = '';
    this.frame = 0;
    container.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => { this.drawn = ''; this.schedule(); }).observe(container);
  }

  setItems(items, { keepScroll = true } = {}) {
    this.items = items;
    this.drawn = '';
    if (!keepScroll) this.container.scrollTop = 0;
    this.draw();
  }

  /** Redraw everything visible (after an edit). */
  refresh() { this.drawn = ''; this.draw(); }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  heightOf(row) { return this.heights.get(this.key(row)) ?? this.estimate(row); }

  draw() {
    const { items } = this;
    const viewTop = this.container.scrollTop - this.overscan;
    const viewBottom = this.container.scrollTop + this.container.clientHeight + this.overscan;
    let y = 0, first = 0;
    while (first < items.length && y + this.heightOf(items[first]) < viewTop) { y += this.heightOf(items[first]); first++; }
    const topPad = y;
    let last = first;
    while (last < items.length && y < viewBottom) { y += this.heightOf(items[last]); last++; }
    let rest = 0;
    for (let i = last; i < items.length; i++) rest += this.heightOf(items[i]);
    const sig = `${first}:${last}:${items.length}`;
    this.top.style.height = `${topPad}px`;
    this.bottom.style.height = `${rest}px`;
    if (sig === this.drawn) return;
    this.drawn = sig;
    const slice = items.slice(first, last);
    this.rows.innerHTML = slice.map((r) => `<div class="vrow" data-key="${String(this.key(r)).replace(/"/g, '&quot;')}">${this.render(r)}</div>`).join('');
    // Measure what was drawn; if guesses were off, draw once more with the real heights.
    let changed = false;
    [...this.rows.children].forEach((el, i) => {
      const k = this.key(slice[i]);
      const h = el.offsetHeight;
      if (h && Math.abs((this.heights.get(k) ?? -1) - h) > 1) { this.heights.set(k, h); changed = true; }
      if (this.after) this.after(el, slice[i]);
    });
    if (changed) { this.drawn = ''; this.schedule(); }
  }

  /** Scrolls so the row with this key is visible. */
  scrollToKey(k) {
    let y = 0;
    for (const r of this.items) {
      if (this.key(r) === k) { this.container.scrollTop = y; return; }
      y += this.heightOf(r);
    }
  }
}

window.VirtualList = VirtualList;
