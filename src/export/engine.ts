// The engine for exported pages. Same modules as the app's, but hand pictures come from the
// page itself: the exporter inlines the ones an explainer uses as window.__HAND_ASSET_URIS.
// @ts-nocheck
export { evaluateAt } from "@engine/utils/animation-utils";
export { drawScene } from "@engine/utils/rendering-utils";
export { normalizeStepsToFullSnapshots } from "@engine/utils/step-resolution";
export { parseSvgStringToNode } from "@engine/utils/svg-utils";
export { assetResolver } from "@engine/assets/AssetResolver";
export const available = true;
