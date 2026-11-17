// The route lands in its own chunk, in a different directory from the entry.
export const loadEcho = () => import("./echo/route.rs");
