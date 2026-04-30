import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Byzantine palette: gold, deep purple (porphyry), parchment, mosaic blue
        byz: {
          gold: "#c9a227",
          goldLight: "#e7c873",
          purple: "#4b1d3f",
          purpleDeep: "#2a0f24",
          parchment: "#f4e9cf",
          parchmentDark: "#d9c79c",
          ink: "#1a1006",
          mosaic: "#3a6b8c",
        },
      },
      fontFamily: {
        display: ["Cinzel", "Trajan Pro", "serif"],
        body: ["Cardo", "Garamond", "serif"],
      },
      boxShadow: {
        card: "0 8px 24px -8px rgba(0,0,0,0.6), 0 0 0 1px rgba(201,162,39,0.3)",
        cardHover: "0 18px 40px -10px rgba(0,0,0,0.8), 0 0 0 1px rgba(231,200,115,0.7)",
      },
    },
  },
  plugins: [],
};

export default config;
