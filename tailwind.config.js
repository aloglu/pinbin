// Build config for app/static/tailwind.css (see README, "Styles").
// Every colour reads a CSS variable from app/static/styles.css, so one class works in both themes.
const tok = (v) => `rgb(var(--${v}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./app/static/index.html', './app/static/*.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Archivo', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        mat: tok('mat'),
        paper: tok('paper'),
        well: tok('well'),
        line: tok('line'),
        ink: { DEFAULT: tok('ink'), 2: tok('ink-2') },
        muted: tok('muted'),
        go: tok('go'),
        stop: tok('stop'),
        tape: tok('tape'),
        canvas: { light: tok('mat'), dark: tok('mat') },
        surface: { light: tok('paper'), dark: tok('paper') },
        matte: { light: tok('well'), dark: tok('well') },
        hairline: { light: tok('line'), dark: tok('line') },
        accent: { DEFAULT: tok('accent'), hover: tok('accent') },
      },
    },
  },
};
