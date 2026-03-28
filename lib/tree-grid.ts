import treeGridData from "@/data/tree-grid.sample.json";
import type { LatLngLiteral, TreeGridCell, TreeGridData } from "@/lib/types";

let cachedLookup: Map<string, TreeGridCell> | null = null;

export function getTreeGrid(): TreeGridData {
  return treeGridData as unknown as TreeGridData;
}

export function buildCellLookup(grid = getTreeGrid()): Map<string, TreeGridCell> {
  if (!cachedLookup) {
    cachedLookup = new Map(grid.cells.map((cell) => [cell.key, cell]));
  }

  return cachedLookup;
}

export function getGridKey(point: LatLngLiteral, grid = getTreeGrid()): string {
  const latIndex = Math.floor((point.lat - grid.origin.lat) / grid.latStep);
  const lngIndex = Math.floor((point.lng - grid.origin.lng) / grid.lngStep);
  return `${latIndex}:${lngIndex}`;
}

export function lookupTreeCell(point: LatLngLiteral, grid = getTreeGrid()): TreeGridCell | null {
  return buildCellLookup(grid).get(getGridKey(point, grid)) ?? null;
}
