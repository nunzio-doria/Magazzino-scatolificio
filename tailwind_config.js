// =============================================================
// tailwind.config.js — Design tokens tema chiaro "Scatolificio Sarno"
// Palette "graphite" invertita per la modalità chiara (stessi nomi di
// classe usati in tutto il progetto, valori ricalibrati da scuro a
// chiaro). Palette "amber" ririnominata concettualmente in blu del
// logo (stessa chiave per non dover riscrivere ogni classe amber-*).
// =============================================================
tailwind.config = {
  theme: {
    extend: {
      colors: {
        graphite: {
          950: '#0b0d10', // riservato: testo massimo contrasto
          900: '#f4f5f7', // sfondo pagina
          800: '#ffffff', // sfondo card/input
          700: '#e3e5e9', // bordi
          600: '#d3d6db', // bordi più marcati / hover
          500: '#70747c', // testo secondario/muted
          400: '#9a9ea6', // placeholder
          300: '#565a62', // testo secondario più scuro (icone hover)
          200: '#40444c', // testo secondario scuro
          100: '#14161a', // testo principale
        },
        // Chiave "amber" mantenuta per compatibilità con le classi già
        // usate in tutto il progetto (bg-amber-400, text-amber-300, ecc.)
        // ma ricolorata con il blu del logo Scatolificio Sarno.
        amber: {
          300: '#24406f', // blu scuro (testo su sfondo chiaro, hover-darken sui bottoni)
          400: '#2f4f92', // blu primario (bottoni, accent principale)
          500: '#13223f', // blu più profondo (badge/opacità, coerente con lo sfondo del logo)
        },
      },
      fontFamily: {
        display: ['"Barlow Condensed"', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      boxShadow: {
        lift: '0 8px 30px -6px rgba(15,23,42,0.12)',
      },
      borderRadius: {
        xl: '0.85rem',
      },
    },
  },
};
