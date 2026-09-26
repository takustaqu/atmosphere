// figure.ts — a foreground figure lit by the sky, from sky.light alone
//
// What another renderer would do with the numbers, done in a 2D canvas so it
// fits in a sample: a silhouette standing in front of the sky, given
//
//   - fill:  the ambient cube, sampled facing back toward the camera — the
//            light from the part of the sky the frame never shows
//   - wrap:  the colors behind it (the frame grid), bled in over its edges
//   - rim:   the key light, from behind, when the sun or moon is ahead of the
//            camera — on the edges that face it on screen
//
// None of it reads the sky canvas's pixels; all of it is sky.light.

import {
  cameraForward, sampleEnvironment,
  type AtmosphereLight, type Camera, type Vec3,
} from '../../src';

const encode = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const css = (lin: Vec3, k = 1) =>
  `rgb(${lin.map((c) => Math.round(Math.min(1, encode(Math.max(0, c * k))) * 255)).join(',')})`;

/** a head-and-shoulders bust filling a w×h box */
function bust(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.30, w * 0.19, 0, Math.PI * 2);
  ctx.moveTo(w * 0.40, h * 0.44);
  ctx.lineTo(w * 0.60, h * 0.44);
  ctx.lineTo(w * 0.62, h * 0.56);
  ctx.bezierCurveTo(w * 0.92, h * 0.60, w * 0.98, h * 0.74, w * 1.0, h * 1.0);
  ctx.lineTo(0, h);
  ctx.bezierCurveTo(w * 0.02, h * 0.74, w * 0.08, h * 0.60, w * 0.38, h * 0.56);
  ctx.closePath();
  ctx.fill();
}

export class Figure {
  private readonly el: HTMLCanvasElement;
  private readonly mask = document.createElement('canvas');
  private readonly work = document.createElement('canvas');
  private readonly grid = document.createElement('canvas');

  constructor(el: HTMLCanvasElement) {
    this.el = el;
  }

  /** redraw for this light. `sky` is the canvas the figure stands in front of */
  draw(light: AtmosphereLight, camera: Camera, sky: HTMLCanvasElement): void {
    const box = this.el.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
    if (!w || !h) return;
    this.el.width = w; this.el.height = h;
    // the figure is cut off by the bottom of its box; carry the mask on past
    // it, or the blurs below would find an edge along the cut and light it
    const pad = Math.ceil(h * 0.1);
    for (const c of [this.mask, this.work]) { c.width = w; c.height = h + pad; }

    const m = this.mask.getContext('2d')!;
    m.fillStyle = '#fff';
    bust(m, w, h);
    m.fillRect(0, h - 1, w, pad + 1);

    const ctx = this.el.getContext('2d')!;
    const env = light.environment;

    // ── fill: the sky behind the camera, brighter overhead than underfoot ──
    // dark clothing: a backlit subject should read darker than the sky behind it
    const albedo = 0.2;
    const back = cameraForward(camera).map((v) => -v) as Vec3;
    const top = env ? sampleEnvironment(env, [back[0], back[1] + 0.5, back[2]]).linear : [0.05, 0.05, 0.06] as Vec3;
    const bottom = env ? sampleEnvironment(env, [back[0], back[1] - 0.5, back[2]]).linear : [0.02, 0.02, 0.02] as Vec3;
    // the key light from the front, when it is behind the camera
    const key = light.key ? light[light.key] : null;
    const front = key ? Math.max(0, -key.view[2]) * key.intensity * 0.6 : 0;
    const lit = (c: Vec3): Vec3 => c.map((v, i) => albedo * (v + (key ? key.color[i] * front : 0))) as Vec3;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, css(lit(top)));
    g.addColorStop(1, css(lit(bottom)));
    ctx.drawImage(this.mask, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // where the figure sits in the sky's frame, 0..1 from the top-left
    const s = sky.getBoundingClientRect();
    const fx = (box.left - s.left) / s.width, fy = (box.top - s.top) / s.height;
    const fw = box.width / s.width, fh = box.height / s.height;

    // ── wrap: the background bleeding over the edges ──
    if (light.frame) {
      const grid = light.frame.grid;
      this.grid.width = grid.cols; this.grid.height = grid.rows;
      const gc = this.grid.getContext('2d')!;
      const img = gc.createImageData(grid.cols, grid.rows);
      grid.cells.forEach((cell, i) => {
        img.data.set([...cell.srgb.map((v) => Math.round(v * 255)), 255], i * 4);
      });
      gc.putImageData(img, 0, 0);
      const wk = this.work.getContext('2d')!;
      wk.imageSmoothingEnabled = true;
      // the grid stretched over the whole sky, cropped to where the figure stands
      wk.drawImage(this.grid, -fx / fw * w, -fy / fh * h, w / fw, h / fh);
      this.band(wk, 0, 0, 0.05 * w);
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.85;
      ctx.drawImage(this.work, 0, 0);
      ctx.globalAlpha = 1;
    }

    // ── rim: the key light from behind, on the edges that face it ──
    if (key && key.view[2] > 0 && key.intensity > 0) {
      // toward the light on screen, from the figure's head
      const hx = fx + fw * 0.5, hy = fy + fh * 0.3;
      let dx = key.screen.x - hx, dy = key.screen.y - hy;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const back = key.view[2] * key.intensity;
      const wk = this.work.getContext('2d')!;
      wk.globalCompositeOperation = 'copy';
      wk.fillStyle = css(key.color, 1.4);
      wk.fillRect(0, 0, w, h + pad);
      this.band(wk, dx, dy, 0.035 * w);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, back * 1.2);
      ctx.drawImage(this.work, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Keep only a soft band just inside the silhouette's edge: mask × (1 − blur(mask)).
   * With (dx, dy) the blurred mask is slid that way first, so only the edges
   * facing that direction survive — a rim instead of an outline.
   */
  private band(wk: CanvasRenderingContext2D, dx: number, dy: number, r: number): void {
    wk.globalCompositeOperation = 'destination-in';
    wk.drawImage(this.mask, 0, 0);
    wk.globalCompositeOperation = 'destination-out';
    wk.filter = `blur(${r}px)`;
    wk.drawImage(this.mask, -dx * r * 1.6, -dy * r * 1.6);
    wk.filter = 'none';
    wk.globalCompositeOperation = 'source-over';
  }
}
