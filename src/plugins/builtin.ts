import type { BuiltinPlugin } from "./api";
import { canvizPlugin } from "./canviz";

/** Ship with the app and are on until switched off in Settings. */
export const builtinPlugins: BuiltinPlugin[] = [canvizPlugin];
