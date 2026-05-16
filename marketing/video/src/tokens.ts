// Brand tokens — mirror of cockpit.css. When the cockpit changes, mirror
// the change here. The marketing video reads ONLY from this file; do not
// hex-code brand values inside components.
//
// Source of truth: ../../template/maddu/cockpit/cockpit.css

export const tokens = {
  // Canvas + shell
  bg0: "#050B17",
  bg1Rgba: "rgba(0,8,18,0.54)",
  bg2Rgba: "rgba(3,14,30,0.28)",
  bg3Rgba: "rgba(4,18,38,0.34)",
  // Solid approximations for compositing on bg0 (avoid alpha math in
  // child components):
  bg1: "#0A1224",
  bg2: "#0C1428",
  bg3: "#0E1730",
  trueBlack: "#000000",

  // Foreground
  fg0: "#E8E6E3",
  fg1: "#B8B2AA",
  fg2: "#8A8A8A",
  fg3: "#6A7079",
  fg4: "#3A3E45",

  // Lines
  line: "rgba(80,113,149,0.36)",
  lineSoft: "rgba(80,113,149,0.18)",

  // Accents
  accent: "#D0FF00",   // lime — interactive, active
  accent2: "#56B8FF",  // electric blue — info, BOSS
  accentDim: "rgba(208,255,0,0.45)",
  brand: "#F04E23",    // orange — brand mark only

  // State
  ok: "#6FA8A2",
  warn: "#F2BD5C",
  danger: "#FF5E7A",
  signal: "#6FA8A2",

  // Tinted backgrounds
  warnBg: "rgba(242,189,92,0.10)",
  warnBorder: "rgba(242,189,92,0.38)",
  dangerBg: "rgba(255,94,122,0.10)",
  dangerBorder: "rgba(255,94,122,0.40)",
  accentGlowBg: "rgba(208,255,0,0.05)",
  accent2GlowBg: "rgba(86,184,255,0.06)",
} as const;

export const fonts = {
  cond:
    "'IBM Plex Sans Condensed', 'Inter', 'Helvetica Neue', sans-serif",
  sans: "'IBM Plex Sans', 'Inter', sans-serif",
  mono: "'IBM Plex Mono', 'JetBrains Mono', 'Consolas', monospace",
};

// Easings (match cockpit.css)
export const easings = {
  emphasis: "cubic-bezier(0.2, 0.7, 0.2, 1)",
  linear: "linear",
};

// Standard panel chrome
export const panel = {
  radius: 6,
  borderColor: "rgba(80,113,149,0.30)",
  borderWidth: 1,
};
