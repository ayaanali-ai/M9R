/**
 * Runtime guard for modules that read credentials or perform privileged
 * service-to-service work. Keep this import at the top of every such module.
 */
if (typeof window !== "undefined") {
  throw new Error("A server-only M9R module was imported by browser code.");
}

export {};
