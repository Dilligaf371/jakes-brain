// Two small single-series SVG charts: barChart (workouts per week) and lineChart (an
// exercise's best per workout). One hue (the app colour), recessive axis, a tap/hover
// readout above the plot instead of numbers on every mark.
import { el } from '../../kit.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

function frame(title, summary) {
  const readout = el('div', { class: 'wo-chart-readout', text: summary });
  const box = el('div', { class: 'wo-chart' },
    el('div', { class: 'wo-chart-head' }, el('div', { class: 'wo-chart-title', text: title }), readout));
  return { box, readout };
}

// points: [{ label, value, text }] oldest first. `summary` shows when nothing is selected.
export function barChart({ title, points, summary }) {
  const { box, readout } = frame(title, summary);
  const W = 340;
  const H = 120;
  const pad = { l: 4, r: 4, t: 6, b: 20 };
  const max = Math.max(1, ...points.map((p) => p.value));
  const slot = (W - pad.l - pad.r) / points.length;
  const bw = Math.min(26, slot - 8);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'wo-chart-svg', role: 'img', 'aria-label': `${title}: ${summary}` });
  svg.append(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: H - pad.b + 0.5, y2: H - pad.b + 0.5, class: 'wo-axis' }));
  const bars = [];
  points.forEach((p, i) => {
    const cx = pad.l + slot * i + slot / 2;
    const h = p.value ? Math.max(4, ((H - pad.t - pad.b) * p.value) / max) : 0;
    const y = H - pad.b - h;
    const g = svgEl('g', { class: 'wo-bar' });
    // Rounded top, square base anchored on the axis.
    if (h) {
      const r = Math.min(4, h, bw / 2);
      const x0 = cx - bw / 2;
      const x1 = cx + bw / 2;
      g.append(svgEl('path', {
        class: 'wo-bar-fill',
        d: `M${x0},${H - pad.b} V${y + r} Q${x0},${y} ${x0 + r},${y} H${x1 - r} Q${x1},${y} ${x1},${y + r} V${H - pad.b} Z`,
      }));
    }
    const label = svgEl('text', { x: cx, y: H - 6, class: 'wo-tick', 'text-anchor': 'middle' });
    label.textContent = p.label;
    g.append(label);
    // Hit target: the whole column.
    g.append(svgEl('rect', { x: cx - slot / 2, y: 0, width: slot, height: H, class: 'wo-hit' }));
    g.addEventListener('pointerenter', () => select(i));
    g.addEventListener('click', () => select(i));
    bars.push(g);
    svg.append(g);
  });
  let selected = -1;
  function select(i) {
    selected = selected === i && matchMedia('(hover: none)').matches ? -1 : i;
    bars.forEach((b, j) => b.classList.toggle('dim', selected !== -1 && j !== selected));
    readout.textContent = selected === -1 ? summary : points[selected].text;
  }
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    selected = -1;
    readout.textContent = summary;
    bars.forEach((b) => b.classList.remove('dim'));
  });
  box.append(svg);
  return box;
}

// points: [{ value, text }] oldest first; at least 1.
export function lineChart({ title, points, summary, format }) {
  const { box, readout } = frame(title, summary);
  const W = 340;
  const H = 150;
  const pad = { l: 6, r: 6, t: 12, b: 22 };
  const vals = points.map((p) => p.value);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi === lo) { hi += 1; lo = Math.max(0, lo - 1); }
  const span = hi - lo;
  lo = Math.max(0, lo - span * 0.15);
  hi += span * 0.15;
  const x = (i) => (points.length === 1 ? W / 2 : pad.l + 6 + ((W - pad.l - pad.r - 12) * i) / (points.length - 1));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'wo-chart-svg', role: 'img', 'aria-label': `${title}: ${summary}` });
  for (const v of [lo, (lo + hi) / 2, hi]) {
    svg.append(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'wo-grid' }));
  }
  const loText = svgEl('text', { x: pad.l, y: H - 6, class: 'wo-tick' });
  loText.textContent = format(lo);
  const hiText = svgEl('text', { x: pad.l, y: pad.t - 2, class: 'wo-tick' });
  hiText.textContent = format(hi);
  svg.append(loText, hiText);
  if (points.length > 1) {
    svg.append(svgEl('polyline', { class: 'wo-line', points: points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ') }));
  }
  const cross = svgEl('line', { y1: pad.t, y2: H - pad.b, class: 'wo-cross', visibility: 'hidden' });
  svg.append(cross);
  const dots = points.map((p, i) => {
    const c = svgEl('circle', { cx: x(i), cy: y(p.value), r: points.length > 24 ? 3 : 4.5, class: 'wo-dot' });
    svg.append(c);
    return c;
  });
  const pick = (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    points.forEach((p, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
    dots.forEach((d, i) => d.classList.toggle('on', i === best));
    cross.setAttribute('x1', x(best));
    cross.setAttribute('x2', x(best));
    cross.setAttribute('visibility', 'visible');
    readout.textContent = points[best].text;
  };
  const clear = () => {
    dots.forEach((d) => d.classList.remove('on'));
    cross.setAttribute('visibility', 'hidden');
    readout.textContent = summary;
  };
  svg.addEventListener('pointermove', pick);
  svg.addEventListener('pointerdown', pick);
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') clear(); });
  box.append(svg);
  return box;
}
