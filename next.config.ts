import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Baileys 7 is ESM-only ("type": "module"), pulls a WASM/native helper
  // (whatsapp-rust-bridge) and reads files at runtime. Bundling it into the
  // server build is exactly the class of thing serverExternalPackages exists
  // for; leave it to Node's own resolver.
  serverExternalPackages: ["@whiskeysockets/baileys"],
};

export default nextConfig;
