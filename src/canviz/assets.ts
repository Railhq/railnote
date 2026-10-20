import { assetResolver, parseSvgStringToNode } from "@canviz-engine";

/**
 * Icon and SVG nodes carry their markup as `asset.data` (or only an iconify `ref`), but the
 * canvas draws `svgPaths`. The site's embed page parses them before playback; this does the
 * same once per asset and patches every copy of the node (base nodes and step snapshots).
 */
export async function resolveSvgAssets(nodeLists: any[][]): Promise<boolean> {
  const parsed = new Map<string, { svgPaths: any; svgViewBox: any } | null>();
  const pending: Promise<void>[] = [];

  for (const list of nodeLists) {
    for (const n of list) {
      const a = n?.asset;
      if (n?.kind !== "svg" || !a || (a.type !== "icon" && a.type !== "svg")) continue;
      if (n.svgPaths?.length) continue;
      const key = a.ref ? `${a.source}:${a.ref}` : `node:${n.id}`;
      if (parsed.has(key)) continue;
      parsed.set(key, null);
      pending.push((async () => {
        try {
          const svg = typeof a.data === "string" ? a.data : (await assetResolver.resolve(a)).data;
          if (typeof svg !== "string") return;
          const node = parseSvgStringToNode(svg, n.x, n.y);
          if (node?.svgPaths) parsed.set(key, { svgPaths: node.svgPaths, svgViewBox: node.svgViewBox });
        } catch {
          // Unreachable icon: the node draws as its plain shape, same as on the site.
        }
      })());
    }
  }
  if (pending.length === 0) return false;
  await Promise.all(pending);

  let patched = false;
  for (const list of nodeLists) {
    for (const n of list) {
      const a = n?.asset;
      if (n?.kind !== "svg" || !a || n.svgPaths?.length) continue;
      const hit = parsed.get(a.ref ? `${a.source}:${a.ref}` : `node:${n.id}`);
      if (hit) { Object.assign(n, hit); patched = true; }
    }
  }
  return patched;
}
