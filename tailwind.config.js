// =============================================================
// tailwind.config.js — Design tokens del tema "placard industriale"
// =============================================================
tailwind.config = {
  theme: {
    extend: {
      colors: {
        graphite: {
          950: '#0f1114',
          900: '#14161a',
          800: '#1c1f24',
          700: '#262a31',
          600: '#343940',
          500: '#4a4f58',
          400: '#6b7078',
          200: '#c7c9cd',
          100: '#e8e6e1',
        },
        amber: {
          300: '#ffc266',
          400: '#ff9f1c',
          500: '#f57c00',
        },
      },
      fontFamily: {
        display: ['"Barlow Condensed"', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      boxShadow: {
        lift: '0 8px 30px -6px rgba(0,0,0,0.5)',
      },
      borderRadius: {
        xl: '0.85rem',
      },
    },
  },
};
