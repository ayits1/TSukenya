import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/frontend/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/health': 'http://127.0.0.1:8080',
    },
  },
  build: {
    manifest: true,
    rollupOptions: {
      input: {
        lab: resolve(import.meta.dirname, 'index.html'),
        catalog: resolve(import.meta.dirname, 'src/catalog-entry.tsx'),
        labels: resolve(import.meta.dirname, 'src/labels-entry.tsx'),
        customers: resolve(import.meta.dirname, 'src/customers-entry.tsx'),
        nativeConflict: resolve(import.meta.dirname, 'src/native-conflict-entry.tsx'),
        trading: resolve(import.meta.dirname, 'src/trading-entry.tsx'),
        abc: resolve(import.meta.dirname, 'src/abc-entry.tsx'),
        stock: resolve(import.meta.dirname, 'src/stock-entry.tsx'),
        purchases: resolve(import.meta.dirname, 'src/purchases-entry.tsx'),
        sales: resolve(import.meta.dirname, 'src/sales-entry.tsx'),
        receiptPricing: resolve(import.meta.dirname, 'src/receipt-pricing-entry.tsx'),
      },
    },
    target: ['chrome111', 'safari16.4', 'firefox114'],
    sourcemap: false,
  },
});
