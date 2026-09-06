// =============================================================
// tailwind.config.js — Design tokens "Industrial Precision".
// Stessa struttura di chiavi di prima (graphite/amber) per non dover
// riscrivere le classi già usate in tutto il progetto: qui cambiano
// solo i VALORI, ricalibrati per un look più deciso, tecnico, "da
// officina di precisione" — meno "template SaaS", più utensile.
// =============================================================
tailwind.config = {
  theme: {
    extend: {
      colors: {
        // Scala neutra fredda (non più grigio piatto: leggera dominante
        // blu-acciaio, coerente col mondo cuscinetti/lamiera lavorata).
        graphite: {
          950: '#05070a', // riservato: testo massimo contrasto
          900: '#eef0f3', // sfondo pagina
          800: '#ffffff', // sfondo card/input
          700: '#dde1e7', // bordi
          600: '#c5cbd3', // bordi più marcati / hover
          500: '#5c6672', // testo secondario/muted
          400: '#8b95a1', // placeholder
          300: '#333c46', // testo secondario più scuro (icone hover)
          200: '#1c222a', // testo secondario scuro
          100: '#0d1117', // testo principale
        },
        // Chiave "amber" mantenuta per compatibilità con le classi già
        // usate in tutto il progetto (bg-amber-400, text-amber-300, ecc.)
        // ma ricolorata con un rame/ambra tecnico — il tono delle vernici
        // e dei nastri di sicurezza da officina, non un blu corporate.
        amber: {
          300: '#7a4607', // rame più scuro (hover-darken sui bottoni)
          400: '#a35f0a', // rame primario (bottoni, accent principale)
          500: '#4a2b05', // rame più profondo (badge/opacità)
        },
      },
      fontFamily: {
        display: ['"Barlow Condensed"', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      boxShadow: {
        lift: '0 10px 34px -8px rgba(13,17,23,0.16)',
        edge: '0 1px 0 rgba(255,255,255,0.7) inset, 0 1px 2px rgba(13,17,23,0.06)',
      },
      letterSpacing: {
        tightish: '-0.01em',
      },
    },
  },
};
