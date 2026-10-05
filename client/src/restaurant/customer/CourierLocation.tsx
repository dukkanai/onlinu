import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { useLocale } from "../i18n";
import type { Order } from "../types";
import { activeLocationOrder, validMapPoint } from "./location";

// A watch is created only by the explicit button, never by mounting a job.
// The server fences Stop by advancing the order version. A late POST cannot
// recreate the point; every new explicit consent first refreshes that version.
export function CourierLocation({order, enabled, activate, deactivate}: {order: Order; enabled: boolean; activate: () => void; deactivate: () => void}) {
  const {t, date} = useLocale();
  const latest = useRef(order); latest.current = order;
  const knownVersion = useRef(order.version); knownVersion.current = Math.max(knownVersion.current, order.version);
  const watch = useRef<number | null>(null), generation = useRef(0), posting = useRef<Promise<unknown> | null>(null), lastSent = useRef(0);
  const consented = useRef(false), stopping = useRef<Promise<void> | null>(null);
  const postController = useRef<AbortController|null>(null);
  const [error, setError] = useState(""), [updated, setUpdated] = useState(""), [sharing, setSharing] = useState(false);
  const stopWatch = () => { generation.current++; if (watch.current !== null) navigator.geolocation.clearWatch(watch.current); watch.current = null; postController.current?.abort(); };
  const removePoint = async (keepalive = false) => {
    try {
      const response = await fetch(`/courier-api/orders/${encodeURIComponent(order.number)}/location`, {method:"DELETE", headers:{"Content-Type":"application/json"}, body:JSON.stringify({version:latest.current.version}), credentials:"same-origin", cache:"no-store", redirect:"error", keepalive});
      if (!response.ok) throw new Error("location");
    } catch { if (!keepalive) setError("location.failed"); }
  };
  const endSharing = (keepalive = false) => {
    stopWatch();
    if (!consented.current) return;
    consented.current = false;
    const removal = removePoint(keepalive).finally(() => {if(stopping.current === removal) stopping.current = null;});
    stopping.current = removal;
  };
  const stop = () => {endSharing(); setSharing(false); deactivate();};
  useEffect(() => {
    if (!enabled) { stopWatch(); setSharing(false); return; }
    void start();
    return () => { endSharing(true); };
  }, [enabled, order.number]);
  useEffect(() => {
    const pagehide = () => { endSharing(true); setSharing(false); deactivate(); };
    window.addEventListener("pagehide", pagehide);
    return () => window.removeEventListener("pagehide", pagehide);
  }, [order.number]);
  const start = async () => {
    if (!activeLocationOrder(latest.current)) return;
    if (!navigator.geolocation) { setError("location.denied"); deactivate(); return; }
    stopWatch(); setSharing(true); setError(""); setUpdated(""); lastSent.current = 0;
    const current = generation.current;
    consented.current = true;
    await stopping.current;
    if(current !== generation.current) return;
    try {
      const response = await fetch("/courier-api/orders",{credentials:"same-origin",cache:"no-store",redirect:"error"});
      if(!response.ok) throw new Error("location");
      const result = await response.json() as {orders:Order[]};
      if(current !== generation.current) return;
      const job = result.orders.find(entry => entry.number === order.number && activeLocationOrder(entry));
      if(!job) throw new Error("location");
      knownVersion.current = job.version;
    }catch{if(current === generation.current){setError("location.failed");stop();}return;}
    if(current !== generation.current) return;
    watch.current = navigator.geolocation.watchPosition(position => {
      if (current !== generation.current || !activeLocationOrder(latest.current) || posting.current || Date.now() - lastSent.current < 15000) return;
      if (!validMapPoint(position.coords) || !Number.isFinite(position.coords.accuracy) || position.coords.accuracy > 5000) return;
      lastSent.current = Date.now();
      const controller = new AbortController();postController.current=controller;
      const timeout = window.setTimeout(()=>controller.abort(),20000);
      const work = fetch(`/courier-api/orders/${encodeURIComponent(order.number)}/location`, {method:"POST", signal:controller.signal, credentials:"same-origin", cache:"no-store", redirect:"error", headers:{"Content-Type":"application/json"}, body: JSON.stringify({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy,capturedAt:new Date(position.timestamp).toISOString(),version:knownVersion.current})})
        .then(response => {if (!response.ok) throw new Error(String(response.status)); if (current === generation.current) {setUpdated(new Date().toISOString());setError("");}})
        .catch(error => {if (current === generation.current) {setError("location.failed"); if (["401","404"].includes(error.message)) stop();}})
        .finally(() => {clearTimeout(timeout);if (posting.current === work) posting.current = null;if(postController.current===controller)postController.current=null;});
      posting.current = work;
    }, error => {if (current === generation.current) {setError(error.code === 1 ? "location.denied" : "location.failed"); if (error.code === 1) stop();}}, {enableHighAccuracy:false,maximumAge:10000,timeout:20000});
  };
  return <div className="rs-location-consent rs-spaced">
    <h3><MapPin size={18}/>{t("location.title")}</h3><p>{t("location.consent")}</p><p className="rs-muted">{t("location.limit")}</p>
    <p role="status">{t(sharing && enabled ? "location.sharing" : "location.stopped")}{updated && sharing && enabled ? ` · ${t("location.updated")}: ${date(updated)}` : ""}</p>
    {error && <p className="rs-notice rs-notice-error" role="alert">{t(error)}</p>}
    <button type="button" className="rs-button rs-button-outline" onClick={enabled ? stop : activate}>{t(enabled ? "location.stop" : "location.start")}</button>
  </div>;
}
