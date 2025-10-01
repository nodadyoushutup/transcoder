import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.FRONTEND_PORT || 5173),
    host: process.env.FRONTEND_HOST || '0.0.0.0',
  },
});
