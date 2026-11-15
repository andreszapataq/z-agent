import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // `next build` corre ESLint y falla ante cualquier error. El código
      // tiene `any` heredados (respuestas de HubSpot/Meta sin tipar); quedan
      // como aviso para irlos tipando sin bloquear despliegues.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];

export default config;
