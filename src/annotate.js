/**
 * Annotation overlay.
 *
 * The committed documentation screenshots carry hand-drawn arrows, rings and
 * callout labels. Baking those into the PNG means redrawing them by hand every
 * time the app changes, and they land in the wrong place as soon as a control
 * moves or a translation makes a button wider.
 *
 * Instead we anchor every annotation to a selector and draw it as SVG in the
 * page immediately before the capture. The arrow then follows the button it
 * points at - across releases, and across the four languages.
 *
 * The overlay is a `popover` so it enters the top layer: native <dialog>
 * elements also render in the top layer, and a plain z-index div would be
 * painted underneath them.
 */

export const DEFAULT_STYLE = {
  colour: '#e35f2a', // mSupply orange, matches the existing hand-drawn arrows
  width: 4,
  fontSize: 17,
  fontFamily:
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

/**
 * @typedef {object} Annotation
 * @property {'arrow'|'ring'|'box'|'label'|'number'} type
 * @property {string} [to]      arrow: selector of the element to point at
 * @property {string} [around]  ring/box: selector of the element to enclose
 * @property {string} [at]      label/number: selector to place relative to
 * @property {string} [from]    arrow/label placement: left|right|above|below|
 *                              above-left|above-right|below-left|below-right
 * @property {number} [length]  arrow length in CSS px (default 110)
 * @property {number} [pad]     ring/box padding in CSS px (default 6)
 * @property {string} [text]    label text, or number badge content
 * @property {number} [index]   number badge value
 * @property {string} [colour]  override the palette colour
 */

/**
 * Draw annotations and return a handle for removing them again.
 * @param {import('playwright').Page} page
 * @param {Annotation[]} annotations
 * @param {object} style
 */
/**
 * Runs IN THE PAGE. Kept as a plain named function, with no references to
 * module scope, so the recorder can inject this very same code for its live
 * preview - what you see while authoring is exactly what `yarn shoot` draws.
 */
export function renderAnnotations({ annotations, style }) {
      const S = { ...style };
      const NS = 'http://www.w3.org/2000/svg';
      const OVERLAY_ID = '__oms_shot_overlay__';

      document.getElementById(OVERLAY_ID)?.remove();

      const host = document.createElement('div');
      host.id = OVERLAY_ID;
      host.setAttribute('popover', 'manual');
      Object.assign(host.style, {
        position: 'fixed',
        inset: '0',
        width: '100vw',
        height: '100vh',
        margin: '0',
        padding: '0',
        border: '0',
        background: 'transparent',
        overflow: 'visible',
        pointerEvents: 'none',
      });
      document.body.appendChild(host);

      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
      Object.assign(svg.style, { position: 'absolute', inset: '0', overflow: 'visible' });
      host.appendChild(svg);

      const defs = document.createElementNS(NS, 'defs');
      svg.appendChild(defs);

      const headFor = (colour) => {
        const id = `__oms_head_${colour.replace(/[^a-z0-9]/gi, '')}`;
        if (defs.querySelector(`#${id}`)) return id;
        const marker = document.createElementNS(NS, 'marker');
        marker.setAttribute('id', id);
        marker.setAttribute('viewBox', '0 0 10 10');
        marker.setAttribute('refX', '8');
        marker.setAttribute('refY', '5');
        marker.setAttribute('markerWidth', '5');
        marker.setAttribute('markerHeight', '5');
        marker.setAttribute('orient', 'auto-start-reverse');
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
        path.setAttribute('fill', colour);
        marker.appendChild(path);
        defs.appendChild(marker);
        return id;
      };

      const rectOf = (selector) => {
        const el = document.querySelector(selector);
        if (!el) throw new Error(`Annotation anchor not found: ${selector}`);
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      };

      // Where the arrow starts, relative to the target, per `from` direction.
      const OFFSETS = {
        left: [-1, 0],
        right: [1, 0],
        above: [0, -1],
        below: [0, 1],
        'above-left': [-0.85, -0.85],
        'above-right': [0.85, -0.85],
        'below-left': [-0.85, 0.85],
        'below-right': [0.85, 0.85],
      };

      // Point the arrow at the nearest edge of the target, not its centre, so
      // the head sits just outside the control instead of on top of the label.
      const edgePoint = (r, dx, dy) => ({
        x: r.cx + dx * (r.w / 2 + 6),
        y: r.cy + dy * (r.h / 2 + 6),
      });

      for (const a of annotations) {
        const colour = a.colour || S.colour;

        if (a.type === 'arrow') {
          const r = rectOf(a.to);
          const dir = OFFSETS[a.from || 'below-left'] || OFFSETS['below-left'];
          const len = a.length ?? 110;
          const tip = edgePoint(r, dir[0], dir[1]);
          const tail = { x: tip.x + dir[0] * len, y: tip.y + dir[1] * len };
          // Bow the line slightly so it reads as drawn by hand rather than
          // generated - matches the existing screenshots.
          const mid = {
            x: (tip.x + tail.x) / 2 - dir[1] * len * 0.28,
            y: (tip.y + tail.y) / 2 + dir[0] * len * 0.28,
          };
          const path = document.createElementNS(NS, 'path');
          path.setAttribute('d', `M ${tail.x} ${tail.y} Q ${mid.x} ${mid.y} ${tip.x} ${tip.y}`);
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', colour);
          path.setAttribute('stroke-width', String(a.width ?? S.width));
          path.setAttribute('stroke-linecap', 'round');
          path.setAttribute('marker-end', `url(#${headFor(colour)})`);
          svg.appendChild(path);

          if (a.text) {
            const label = document.createElementNS(NS, 'text');
            label.setAttribute('x', String(tail.x + dir[0] * 8));
            label.setAttribute('y', String(tail.y + dir[1] * 8));
            label.setAttribute('fill', colour);
            label.setAttribute('font-family', S.fontFamily);
            label.setAttribute('font-size', String(a.fontSize ?? S.fontSize));
            label.setAttribute('font-weight', '600');
            label.setAttribute('text-anchor', dir[0] > 0 ? 'start' : dir[0] < 0 ? 'end' : 'middle');
            label.setAttribute('dominant-baseline', dir[1] > 0 ? 'hanging' : 'auto');
            label.textContent = a.text;
            svg.appendChild(label);
          }
        }

        if (a.type === 'ring' || a.type === 'box') {
          const r = rectOf(a.around);
          const pad = a.pad ?? 6;
          const shape = document.createElementNS(NS, a.type === 'ring' ? 'ellipse' : 'rect');
          if (a.type === 'ring') {
            shape.setAttribute('cx', String(r.cx));
            shape.setAttribute('cy', String(r.cy));
            shape.setAttribute('rx', String(r.w / 2 + pad + 6));
            shape.setAttribute('ry', String(r.h / 2 + pad + 2));
          } else {
            shape.setAttribute('x', String(r.x - pad));
            shape.setAttribute('y', String(r.y - pad));
            shape.setAttribute('width', String(r.w + pad * 2));
            shape.setAttribute('height', String(r.h + pad * 2));
            shape.setAttribute('rx', String(a.radius ?? 6));
          }
          shape.setAttribute('fill', 'none');
          shape.setAttribute('stroke', colour);
          shape.setAttribute('stroke-width', String(a.width ?? S.width));
          svg.appendChild(shape);
        }

        if (a.type === 'label') {
          const r = rectOf(a.at);
          const dir = OFFSETS[a.from || 'above'] || OFFSETS.above;
          const gap = a.gap ?? 14;
          const text = document.createElementNS(NS, 'text');
          text.setAttribute('x', String(r.cx + dir[0] * (r.w / 2 + gap)));
          text.setAttribute('y', String(r.cy + dir[1] * (r.h / 2 + gap)));
          text.setAttribute('fill', colour);
          text.setAttribute('font-family', S.fontFamily);
          text.setAttribute('font-size', String(a.fontSize ?? S.fontSize));
          text.setAttribute('font-weight', '600');
          text.setAttribute('text-anchor', dir[0] > 0 ? 'start' : dir[0] < 0 ? 'end' : 'middle');
          text.setAttribute('dominant-baseline', dir[1] > 0 ? 'hanging' : 'auto');
          text.textContent = a.text ?? '';
          svg.appendChild(text);
        }

        if (a.type === 'number') {
          const r = rectOf(a.at);
          const rad = a.radius ?? 15;
          const dir = OFFSETS[a.from || 'above-left'] || OFFSETS['above-left'];
          const cx = r.cx + dir[0] * (r.w / 2 + rad);
          const cy = r.cy + dir[1] * (r.h / 2 + rad);
          const circle = document.createElementNS(NS, 'circle');
          circle.setAttribute('cx', String(cx));
          circle.setAttribute('cy', String(cy));
          circle.setAttribute('r', String(rad));
          circle.setAttribute('fill', colour);
          svg.appendChild(circle);
          const text = document.createElementNS(NS, 'text');
          text.setAttribute('x', String(cx));
          text.setAttribute('y', String(cy));
          text.setAttribute('fill', '#fff');
          text.setAttribute('font-family', S.fontFamily);
          text.setAttribute('font-size', String(rad * 1.15));
          text.setAttribute('font-weight', '700');
          text.setAttribute('text-anchor', 'middle');
          text.setAttribute('dominant-baseline', 'central');
          text.textContent = String(a.index ?? a.text ?? '');
          svg.appendChild(text);
        }
      }

      try {
        host.showPopover();
      } catch {
        // Popover unsupported: fall back to a very high z-index. Annotations
        // will sit under an open <dialog>, which is a top-layer element.
        host.removeAttribute('popover');
        host.style.zIndex = '2147483647';
      }
}

export async function drawAnnotations(page, annotations, style = {}) {
  if (!annotations?.length) return;
  await page.evaluate(renderAnnotations, { annotations, style: { ...DEFAULT_STYLE, ...style } });
}

export async function clearAnnotations(page) {
  await page
    .evaluate(() => document.getElementById('__oms_shot_overlay__')?.remove())
    .catch(() => {});
}
