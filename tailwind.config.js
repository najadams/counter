/** @type {import('tailwindcss').Config} */
// Design tokens locked in CLAUDE.md. Do not add colors here without explicit
// discussion. The aesthetic is sharp, dark, gold accent — financial, not SaaS.
export default {
  content: ['./index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          deep: '#0A0C10',
          surface: '#14171D',
          elevated: '#1C2028',
          input: '#0F1218',
        },
        border: {
          DEFAULT: '#2A2F3A',
          strong: '#3A4150',
        },
        text: {
          primary: '#EDE8DF',
          secondary: '#8B91A0',
          tertiary: '#5A6070',
        },
        accent: {
          DEFAULT: '#C9A84C',
          light: '#E2C97E',
          dim: '#8B7637',
        },
        success: '#4A9D6E',
        danger: '#C4623A',
        warning: '#D4A04C',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        // Sharp aesthetic: zero radius on buttons/inputs by default. Override
        // explicitly on the rare element where a curve is intentional.
        none: '0',
        DEFAULT: '0',
      },
    },
  },
  plugins: [],
};
