import type { RoomDurableObject } from "./room";

// Hand-written to match wrangler.jsonc's durable_objects.bindings — normally
// `wrangler types` generates this from the config automatically, but that
// needs a real wrangler run (and, for a fully-accurate DurableObjectNamespace
// generic, actually resolving the binding), which this sandbox couldn't do
// without a Cloudflare account. Regenerate with `wrangler types` once one
// exists, and this file can go. The Cloudflare.Env namespace (rather than a
// bare global Env) is current wrangler's own generated convention — the
// `env` import from "cloudflare:workers" in tests is typed against it.
export {};

// Both namespace declarations must live inside one `declare global` block —
// a bare top-level `declare namespace` in a module file (this one is a
// module because of the `export {}` above) is scoped to the module, not
// merged into the real global `Cloudflare` namespace.
declare global {
  namespace Cloudflare {
    interface Env {
      ROOMS: DurableObjectNamespace<RoomDurableObject>;
    }
  }

  interface Env extends Cloudflare.Env {}
}
