// server.ts embeds its committed favicon with `with { type: "file" }` —
// that resolves to the file's path at build/run time, which TypeScript
// doesn't know about (same declaration as catalog-server's vendor.d.ts).
declare module "../assets/icons/*" {
  const path: string;
  export default path;
}
