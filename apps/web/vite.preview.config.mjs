const gatewayOrigin = process.env.GATEWAY_ORIGIN || "http://gateway:3000";
const allowedHosts = (process.env.WEB_ALLOWED_HOSTS || "de.minakami-yuki.com")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const proxy = {
  "/api": gatewayOrigin,
  "/healthz": gatewayOrigin,
  "/readyz": gatewayOrigin,
  "/metrics": gatewayOrigin,
  "/docs": gatewayOrigin
};

export default {
  preview: {
    host: "0.0.0.0",
    port: Number(process.env.WEB_PORT || 5173),
    allowedHosts,
    proxy
  }
};
