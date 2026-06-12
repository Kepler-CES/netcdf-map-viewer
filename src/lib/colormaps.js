// Compact analytic colormaps returning [r,g,b] in 0..255 for t in [0,1].

// Google "Turbo" colormap — polynomial approximation (Anton Mikhailov).
const TURBO_R = [0.13572138, 4.61539260, -42.66032258, 132.13108234, -152.94239396, 59.28637943];
const TURBO_G = [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604];
const TURBO_B = [0.10667330, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973];

function poly(c, x) {
  return c[0] + x * (c[1] + x * (c[2] + x * (c[3] + x * (c[4] + x * c[5]))));
}

function turbo(t) {
  const x = Math.min(1, Math.max(0, t));
  return [
    Math.round(255 * Math.min(1, Math.max(0, poly(TURBO_R, x)))),
    Math.round(255 * Math.min(1, Math.max(0, poly(TURBO_G, x)))),
    Math.round(255 * Math.min(1, Math.max(0, poly(TURBO_B, x)))),
  ];
}

// Viridis via control-point interpolation.
const VIRIDIS = [
  [68, 1, 84], [72, 40, 120], [62, 73, 137], [49, 104, 142],
  [38, 130, 142], [31, 158, 137], [53, 183, 121], [110, 206, 88],
  [181, 222, 43], [253, 231, 37],
];
function lerpStops(stops, t) {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x), f = x - i;
  const a = stops[i], b = stops[Math.min(stops.length - 1, i + 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

const JET = [
  [0, 0, 131], [0, 60, 170], [5, 255, 255], [255, 255, 0], [250, 0, 0], [128, 0, 0],
];

export const COLORMAPS = {
  turbo: { label: "Turbo", fn: turbo },
  viridis: { label: "Viridis", fn: (t) => lerpStops(VIRIDIS, t) },
  jet: { label: "Jet", fn: (t) => lerpStops(JET, t) },
};

// Build a CSS linear-gradient string for a legend bar.
export function gradientCss(name) {
  const fn = COLORMAPS[name].fn;
  const stops = [];
  for (let i = 0; i <= 10; i++) {
    const [r, g, b] = fn(i / 10);
    stops.push(`rgb(${r},${g},${b}) ${i * 10}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}
