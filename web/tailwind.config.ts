import type { Config } from 'tailwindcss';

/**
 * Obsidian Champagne palette
 * Warm near-black, ivory text, champagne accent (no green, no cold white, no blue)
 */
const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx}', './components/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b0a09',
        paper: '#f2ebe1',
        muted: '#8f877c',
        surface: '#151310',
        border: '#2a241e',
        // Primary accent (kept as "lime" token name for existing classnames)
        lime: '#e0b84a',
        // Secondary warm label accent
        gold: '#c4893f',
        // Optional deeper copper for rare emphasis
        copper: '#a86b3c',
      },
      fontFamily: {
        sans: ['Geist', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'ui-monospace', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(224, 184, 74, 0.12), 0 18px 50px rgba(0, 0, 0, 0.45)',
      },
    },
  },
  plugins: [],
};

export default config;
