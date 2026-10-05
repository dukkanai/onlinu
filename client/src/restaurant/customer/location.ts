import type { Order } from "../types";

export interface CourierLocation {
  latitude: number; longitude: number; accuracy: number;
  capturedAt: string; receivedAt: string; expiresAt: string; stale: boolean;
}
export interface LocationResult { location: CourierLocation | null }
export interface MapPoint { latitude: number; longitude: number }
export const activeLocationOrder = (order: Order): boolean => order.mode === "delivery" && !!order.courierId && !["completed", "cancelled"].includes(order.status) && order.deliveryStatus !== "delivered";
export function validMapPoint(value: { latitude?: unknown; longitude?: unknown }): value is MapPoint {
  return typeof value.latitude === "number" && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 && typeof value.longitude === "number" && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180;
}
export function recentLocation(value: CourierLocation | null, now = Date.now()): CourierLocation | null {
  return value && validMapPoint(value) && Number.isFinite(value.accuracy) && value.accuracy >= 0 && value.accuracy <= 5000 && Date.parse(value.expiresAt) > now ? value : null;
}
// OSM tile requests contain only integer tile indices. Exact markers and the
// destination remain in this browser; no order identifier enters tile URLs.
export function worldPoint(point: MapPoint, zoom: number) {
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.latitude));
  const radians = latitude * Math.PI / 180, size = 256 * 2 ** zoom;
  return { x: (point.longitude + 180) / 360 * size, y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * size };
}
export function mapViewport(points: MapPoint[], width = 480, height = 300, forcedZoom?: number) {
  const safe = points.filter(validMapPoint);
  if (!safe.length) return null;
  let zoom = forcedZoom === undefined ? 16 : Math.max(2, Math.min(18, Math.round(forcedZoom)));
  let projected = safe.map((point) => worldPoint(point, zoom));
  const bounds = () => ({ minX: Math.min(...projected.map(p => p.x)), maxX: Math.max(...projected.map(p => p.x)), minY: Math.min(...projected.map(p => p.y)), maxY: Math.max(...projected.map(p => p.y)) });
  let box = bounds();
  while (forcedZoom === undefined && zoom > 2 && (box.maxX - box.minX > width - 96 || box.maxY - box.minY > height - 96)) { zoom--; projected = safe.map(p => worldPoint(p, zoom)); box = bounds(); }
  const left = (box.minX + box.maxX - width) / 2, top = (box.minY + box.maxY - height) / 2, count = 2 ** zoom;
  const tiles: { url: string; x: number; y: number }[] = [];
  for (let y = Math.floor(top / 256); y <= Math.floor((top + height - 1) / 256); y++) for (let x = Math.floor(left / 256); x <= Math.floor((left + width - 1) / 256); x++) {
    if (y >= 0 && y < count) tiles.push({ url: `https://tile.openstreetmap.org/${zoom}/${((x % count) + count) % count}/${y}.png`, x: x * 256 - left, y: y * 256 - top });
  }
  return { zoom, tiles, markers: projected.map(p => ({ x: p.x - left, y: p.y - top })) };
}
