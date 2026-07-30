export const BYOK_REQUIRED_EVENT = "anvil:byok-required";

export function notifyByokRequired(code: unknown): void {
  if ((code === "byok_required" || code === "configuration") && typeof window !== "undefined") {
    window.dispatchEvent(new Event(BYOK_REQUIRED_EVENT));
  }
}
