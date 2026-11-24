'use strict';

// Pinbin logo: "pb" (mark) and "pinbin" (wordmark) built on a perfboard.
// Copper pads on a grid are joined by solder bridges; free pads are open rings.
// The drawing is one colour (currentColor). It sits on a tile in the chosen
// logo colour, and is black or white, whichever reads better on that tile.
// The same code makes the header logo, the live favicon and the static icon
// files (scripts: see README, "Logo files").
(function (root) {
  // Tile colours offered in Settings, in display order. Keep in sync with
  // ALLOWED_LOGO_COLORS in app/db.py.
  const LOGO_COLORS = [
    { value: '#00e676', name: 'Green' },
    { value: '#ffcc00', name: 'Yellow' },
    { value: '#111111', name: 'Black' },
    { value: '#ffffff', name: 'White' },
    { value: '#c0392b', name: 'Brick' },
    { value: '#6c3cff', name: 'Violet' },
    { value: '#2962ff', name: 'Blue' },
    { value: '#ff2d55', name: 'Pink' },
    { value: '#ff3b30', name: 'Red' },
    { value: '#ff69b4', name: 'Hot pink' },
  ];
  const DEFAULT_LOGO_COLOR = '#00e676';

  // Black or white on the tile: the one with the higher contrast ratio.
  function luminance(hex) {
    const v = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function inkFor(hex) {
    const L = luminance(hex);
    return 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? '#ffffff' : '#111111';
  }

  // Glyphs on a grid. Rows 0-1: ascender, rows 2-4: x-height, row 5: descender.
  const GLYPHS = {
    p: { w: 3, cells: [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [2, 2], [2, 3], [2, 4], [1, 4]] },
    b: { w: 3, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [2, 2], [2, 3], [2, 4], [1, 4]] },
    i: { w: 1, cells: [[0, 0], [0, 2], [0, 3], [0, 4]] },
    n: { w: 3, cells: [[0, 2], [0, 3], [0, 4], [1, 2], [2, 2], [2, 3], [2, 4]] },
  };

  function layout(word) {
    const used = new Set();
    let x = 0;
    for (const ch of word) {
      const g = GLYPHS[ch];
      g.cells.forEach(([c, r]) => used.add(`${x + c},${r}`));
      x += g.w + 1;
    }
    return { used, cols: x - 1 };
  }

  const n = (v) => Math.round(v * 1000) / 1000;

  // o: { pitch, padR, bridge, freeR, freeW, showFree, extraCols }
  function board(word, o, ox, oy) {
    const { used, cols } = layout(word);
    const has = (c, r) => used.has(`${c},${r}`);
    const extra = o.extraCols || 0;
    let out = '';
    for (let c = -extra; c < cols + extra; c++) {
      for (let r = 0; r < 6; r++) {
        const x = ox + c * o.pitch;
        const y = oy + r * o.pitch;
        if (has(c, r)) {
          out += `<circle cx="${n(x)}" cy="${n(y)}" r="${o.padR}"/>`;
          if (has(c + 1, r)) out += `<rect x="${n(x)}" y="${n(y - o.bridge / 2)}" width="${o.pitch}" height="${o.bridge}"/>`;
          if (has(c, r + 1)) out += `<rect x="${n(x - o.bridge / 2)}" y="${n(y)}" width="${o.bridge}" height="${o.pitch}"/>`;
        } else if (o.showFree) {
          const rr = o.freeR - o.freeW / 2;
          out += `<circle cx="${n(x)}" cy="${n(y)}" r="${n(rr)}" fill="none" stroke="currentColor" stroke-width="${o.freeW}"/>`;
        }
      }
    }
    return `<g fill="currentColor">${out}</g>`;
  }

  // The "pb" mark on a 32 x 32 grid. small = the 16 px version (no free pads,
  // heavier pads and bridges).
  const MARK_FULL = { pitch: 4.4, padR: 1.75, bridge: 2.3, freeR: 1.3, freeW: 0.65, showFree: true };
  const MARK_SMALL = { pitch: 4.4, padR: 2.2, bridge: 3.4, showFree: false };
  function markBody(small) {
    return board('pb', small ? MARK_SMALL : MARK_FULL, 2.8, 5);
  }
  function markSvg(size, { small = false } = {}) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">${markBody(small)}</svg>`;
  }

  // The "pinbin" wordmark: the whole name on a strip of board.
  const WORD = { pitch: 4, padR: 1.55, bridge: 2.1, freeR: 1.15, freeW: 0.55, showFree: true, extraCols: 1 };
  const WORD_COLS = layout('pinbin').cols + WORD.extraCols * 2;
  const WORD_VIEW = { w: WORD_COLS * WORD.pitch, h: 6 * WORD.pitch };
  function wordBody() {
    return board('pinbin', WORD, WORD.pitch * (WORD.extraCols + 0.5), WORD.pitch / 2);
  }
  function wordSvg(height) {
    const w = n((height * WORD_VIEW.w) / WORD_VIEW.h);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="0 0 ${WORD_VIEW.w} ${WORD_VIEW.h}" role="img" aria-label="Pinbin">${wordBody()}</svg>`;
  }

  // Favicon: rounded tile in the logo colour with the small mark.
  function faviconSvg(tile) {
    const ink = inkFor(tile);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">`
      + `<rect width="32" height="32" rx="6" fill="${tile}"/>`
      + `<g color="${ink}" transform="translate(16 16) scale(0.84) translate(-16 -16)">${markBody(true)}</g></svg>`;
  }

  // App icon (home screen): square tile, full mark. The phone rounds the corners.
  function appIconSvg(tile, size = 180) {
    const ink = inkFor(tile);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">`
      + `<rect width="32" height="32" fill="${tile}"/>`
      + `<g color="${ink}" transform="translate(16 16) scale(0.66) translate(-16 -16)">${markBody(false)}</g></svg>`;
  }

  root.PinbinBrand = {
    LOGO_COLORS,
    DEFAULT_LOGO_COLOR,
    inkFor,
    markSvg,
    wordSvg,
    faviconSvg,
    appIconSvg,
  };
})(typeof window !== 'undefined' ? window : globalThis);
