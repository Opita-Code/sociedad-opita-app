// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// Sociedad Opita — frontend del monumento cultural vivo
// Stack alineado con el ecosistema Opita-Code (www.opitacode.com):
// - Astro 6.3 + React 19 islands
// - Tailwind 4 via @tailwindcss/vite
// - Deploy: AWS S3 + CloudFront (via GitHub Actions)
// - Sin SSR adapter (sitio estatico, S3 lo sirve)
export default defineConfig({
  site: 'https://sociedad.opitacode.com',
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
