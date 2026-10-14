// Public facade: the core has no dependency on a host transport implementation.
export { phone, twilioSignature, type PhoneOptions } from "./core.ts";
export type { PhoneSocket } from "./transport.ts";
