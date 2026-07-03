import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const devGatewayOrigin = process.env.GATEWAY_ORIGIN ?? "http://localhost:3000";
const previewGatewayOrigin = process.env.GATEWAY_ORIGIN ?? "http://gateway:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": devGatewayOrigin,
      "/healthz": devGatewayOrigin,
      "/readyz": devGatewayOrigin,
      "/metrics": devGatewayOrigin,
      "/docs": devGatewayOrigin
    }
  },
  preview: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      "/api": previewGatewayOrigin,
      "/healthz": previewGatewayOrigin,
      "/readyz": previewGatewayOrigin,
      "/metrics": previewGatewayOrigin,
      "/docs": previewGatewayOrigin
    }
  }
});
