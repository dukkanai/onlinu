import { useEffect, useState } from "react";
import { MapPin, Navigation, Truck } from "lucide-react";
import { adminRestaurant, storefront } from "../api";
import { useLocale } from "../i18n";
import type { Order } from "../types";
import { mapURL } from "./operations";
import { activeLocationOrder, mapViewport, recentLocation, validMapPoint, type CourierLocation, type LocationResult } from "./location";
import "./storefront.css";

export function OrderLocation({ order, token, admin = false }: { order: Order; token?: string; admin?: boolean }) {
  const { t, date } = useLocale();
  const [location, setLocation] = useState<CourierLocation | null>(null);
  const [shown, setShown] = useState(false), [failed, setFailed] = useState(false), [zoom, setZoom] = useState<number>();
  const [now, setNow] = useState(Date.now());
  const active = activeLocationOrder(order);
  useEffect(() => {
    setLocation(null); setShown(false); setZoom(undefined); setFailed(false);
    if (!active) return;
    const controller = new AbortController(); let busy = false;
    const refresh = async () => {
      setNow(Date.now());
      if (busy || document.hidden) return;
      busy = true;
      try {
        const result = await (admin ? adminRestaurant : storefront)<LocationResult>(`/orders/${encodeURIComponent(order.number)}/location`, { signal: controller.signal, headers: !admin && token ? { "X-Order-Token": token } : {} });
        if (!controller.signal.aborted) setLocation(result.location);
      } catch { if (!controller.signal.aborted) setLocation(null); }
      finally { busy = false; }
    };
    void refresh(); const timer = window.setInterval(refresh, 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [order.number, order.courierId, active, token, admin]);
  if (!active) return null;
  const point = recentLocation(location, now), destination = validMapPoint(order.address) ? order.address : null;
  const points = [...(point ? [point] : []), ...(destination ? [destination] : [])];
  const viewport = mapViewport(points, 480, 300, zoom), navigation = mapURL(order.address);
  const stale = point && (point.stale || now - Date.parse(point.receivedAt) > 45000);
  return <section className={`rs-panel rs-location ${admin ? "rs-location-admin" : ""}`} aria-label={t("location.title")}>
    <h2><Truck size={21}/>{t("location.title")}</h2>
    {point ? <><p>{t("location.updated")}: <time dateTime={point.receivedAt}>{date(point.receivedAt)}</time></p><p className="rs-muted">{t("location.accuracy", { meters: Math.ceil(point.accuracy) })}</p>{stale && <p role="status" className="rs-notice">{t("location.stale")}</p>}</> : <p className="rs-muted">{t("location.unavailable")}</p>}
    <p className="rs-muted">{t("location.mapPrivacy")}</p>
    <div className="rs-courier-links">
      {viewport && <button type="button" className="rs-button rs-button-outline" onClick={() => {setShown(!shown); setFailed(false);}}><MapPin size={16}/>{t(shown ? "location.hideMap" : "location.showMap")}</button>}
      {navigation && <a className="rs-button rs-button-soft" href={navigation} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><Navigation size={16}/>{t("location.navigate")}</a>}
    </div>
    {shown && viewport && <>
      <div className="rs-map-viewport" role="group" aria-label={t("location.mapLabel")}>
        <div className="rs-map-canvas">
          {viewport.tiles.map(tile => <img key={tile.url} src={tile.url} alt="" width="256" height="256" style={{ left: tile.x, top: tile.y }} referrerPolicy="origin" onError={() => setFailed(true)}/>)}
          {viewport.markers.map((marker, index) => <span key={index} className={`rs-map-marker ${point && index === 0 ? "rs-map-courier" : "rs-map-destination"}`} style={{ left: marker.x, top: marker.y }} title={t(point && index === 0 ? "location.courierMarker" : "location.destination")}>{point && index === 0 ? <Truck size={17}/> : <MapPin size={17}/>}</span>)}
        </div>
        <a className="rs-map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t("location.attribution")}</a>
      </div>
      <div className="rs-map-controls"><button type="button" className="rs-button rs-button-soft" disabled={viewport.zoom >= 18} onClick={() => setZoom(viewport.zoom + 1)}>{t("location.zoomIn")}</button><button type="button" className="rs-button rs-button-soft" disabled={viewport.zoom <= 2} onClick={() => setZoom(viewport.zoom - 1)}>{t("location.zoomOut")}</button></div>
      <p className="rs-muted rs-map-legend"><Truck size={15}/>{t("location.courierMarker")} · <MapPin size={15}/>{t("location.destination")}</p>
      {failed && <p role="status" className="rs-notice">{t("location.mapUnavailable")}</p>}
    </>}
  </section>;
}
