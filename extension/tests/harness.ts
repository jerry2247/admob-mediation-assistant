// Test harness: expose the real dom.ts actuation engine on window so a Playwright
// page can drive it against a synthetic AngularDart-like DOM (no backend, no model).
import { execDirective, runDirectives, resolveTarget, readContext, readGroups, clearHighlights } from "../src/content/dom";
(window as unknown as { DOMH: unknown }).DOMH = {
  execDirective, runDirectives, resolveTarget, readContext, readGroups, clearHighlights,
};
