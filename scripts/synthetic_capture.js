/**
 * scripts/synthetic_capture.js
 * Phone-like synthetic captures of a card with known border widths, for the
 * verify scripts. 2× supersampled render, cubic downsample, sensor noise,
 * JPEG q90, and a detector quad a few px off the true corners.
 */
'use strict';

const sharp = require('sharp');
const cq = require('../services/card_quad');

const CARD_W_MM = 63.5;
const CARD_H_MM = 88.9;
const PHOTO_W = 1400;
const PHOTO_H = 1900;
const SUPER = 2;
const BACKGROUND = [226, 80, 150];

function rng(seed) {
  let x = seed >>> 0;
  return function () {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/**
 * @param {number} seed
 * @param {{ borderMm?: object, outsideBand?: { edge: string, mm: number, color: number[] } }} [opts]
 *   outsideBand: a strip just outside one cut (sleeve lip, shadow, second edge)
 * @returns {Promise<{ jpeg: Buffer, cardQuad: string, photoWidth: number, photoHeight: number }>}
 */
async function capture(seed, opts) {
  const o = opts || {};
  const border = o.borderMm || { left: 4.0, right: 3.0, top: 3.0, bottom: 3.5 };
  const band = o.outsideBand || null;
  const r = rng(seed);
  const cx = PHOTO_W / 2 + (r() - 0.5) * 30;
  const cy = PHOTO_H / 2 + (r() - 0.5) * 30;
  const hPx = 1580 + (r() - 0.5) * 40;
  const wPx = hPx * CARD_W_MM / CARD_H_MM;
  const rot = (r() - 0.5) * 0.8 * Math.PI / 180;
  const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(function (c) {
    const x = c[0] * wPx;
    const y = c[1] * hPx;
    return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)];
  });
  const Hm = cq.computeHomography(
    corners.map(function (p) { return [p[0] * SUPER, p[1] * SUPER]; }),
    [[0, 0], [CARD_W_MM, 0], [CARD_W_MM, CARD_H_MM], [0, CARD_H_MM]]
  );
  function color(u, v) {
    if (u < 0 || v < 0 || u > CARD_W_MM || v > CARD_H_MM) {
      if (band) {
        const inV = v >= 0 && v <= CARD_H_MM;
        const inU = u >= 0 && u <= CARD_W_MM;
        if (band.edge === 'right' && inV && u > CARD_W_MM && u <= CARD_W_MM + band.mm) return band.color;
        if (band.edge === 'left' && inV && u < 0 && u >= -band.mm) return band.color;
        if (band.edge === 'top' && inU && v < 0 && v >= -band.mm) return band.color;
        if (band.edge === 'bottom' && inU && v > CARD_H_MM && v <= CARD_H_MM + band.mm) return band.color;
      }
      return BACKGROUND;
    }
    const inBorder = u < border.left || u > CARD_W_MM - border.right || v < border.top || v > CARD_H_MM - border.bottom;
    return inBorder ? [246, 246, 243] : [52, 60, 84];
  }
  const W2 = PHOTO_W * SUPER;
  const H2 = PHOTO_H * SUPER;
  const data = Buffer.alloc(W2 * H2 * 3);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      const m = cq.applyHomography(Hm, x + 0.5, y + 0.5);
      const c = color(m[0], m[1]);
      const i = (y * W2 + x) * 3;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2];
    }
  }
  const img = await sharp(data, { raw: { width: W2, height: H2, channels: 3 } })
    .resize(PHOTO_W, PHOTO_H, { kernel: 'cubic' }).raw().toBuffer();
  const noisy = Buffer.from(img);
  for (let k = 0; k < noisy.length; k++) {
    noisy[k] = Math.max(0, Math.min(255, Math.round(noisy[k] + (r() + r() + r() - 1.5) * 6)));
  }
  const jpeg = await sharp(noisy, { raw: { width: PHOTO_W, height: PHOTO_H, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  const off = function (p) { return [p[0] + (r() - 0.5) * 4, p[1] + (r() - 0.5) * 4]; };
  const quad = { tl: off(corners[0]), tr: off(corners[1]), br: off(corners[2]), bl: off(corners[3]) };
  return { jpeg: jpeg, cardQuad: JSON.stringify(quad), photoWidth: PHOTO_W, photoHeight: PHOTO_H };
}

module.exports = { capture, CARD_W_MM, CARD_H_MM, PHOTO_W, PHOTO_H };
