import { useState } from "react";
import { Copy, Plus, Printer, QrCode } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useLocale } from "../i18n";
import type { Catalog, RestaurantTable } from "../types";
import { Check, Field } from "./Fields";
import type { CatalogUpdate } from "./MenuEditor";
import { tableLink } from "./helpers";

export function TablesEditor({ catalog, update, reportError }: { catalog: Catalog; update: CatalogUpdate; reportError: (code: string) => void }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState("");
  const [printTarget, setPrintTarget] = useState<{ name: string; url: string } | null>(null);
  const patch = (id: string, change: Partial<RestaurantTable>) => update(current => ({ ...current, tables: (current.tables ?? []).map(table => table.id === id ? { ...table, ...change } : table) }));
  const link = (code: string) => tableLink(code, window.location.origin);
  const publicLink = new URL("/", window.location.origin).toString();
  const print = (name: string, url: string) => { setPrintTarget({ name, url }); window.setTimeout(() => window.print(), 50); };
  return <section>
    <div className="ra-section-title"><div><h2>{t("admin.tables")}</h2><p className="ra-muted">{t("admin.tableHint")}</p></div><button type="button" className="ra-primary" onClick={() => update(current => ({ ...current, tables: [...(current.tables ?? []), { id: crypto.randomUUID(), name: "", code: "", active: true }] }))}><Plus size={16} />{t("admin.addTable")}</button></div>
    <article className="ra-card ra-public-qr">
      <div className="ra-qr"><QRCodeSVG value={publicLink} size={156} level="M" marginSize={4} title={t("admin.storefront")} /></div>
      <div><h3>{t("admin.storefront")}</h3><Field label={t("store.menu")}><input readOnly dir="ltr" value={publicLink} onFocus={event => event.target.select()} /></Field>
        <div className="ra-row"><button className="ra-secondary" type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(publicLink); setCopied("storefront"); }
          catch { reportError("admin.copyError"); }
        }}><Copy size={16} />{t(copied === "storefront" ? "common.copied" : "common.copy")}</button><button className="ra-secondary" type="button" onClick={() => print(t("store.menu"), publicLink)}><Printer size={16} />{t("admin.printQR")}</button></div>
      </div>
    </article>
    {!(catalog.tables ?? []).length && <div className="ra-card ra-empty"><QrCode size={40} /><p>{t("admin.noTables")}</p></div>}
    <div className="ra-tables">{(catalog.tables ?? []).map(table => <article className="ra-card ra-table" key={table.id}>
      <Field label={t("admin.name")}><input required maxLength={80} value={table.name} onChange={event => patch(table.id, { name: event.target.value })} /></Field>
      <Check label={t("admin.active")} checked={table.active} onChange={active => patch(table.id, { active })} />
      {table.code ? <>
        <div className="ra-qr"><QRCodeSVG value={link(table.code)} size={184} level="M" marginSize={4} title={`${t("admin.scanOrder")}: ${table.name}`} /></div>
        {!table.active && <p className="ra-warning">{t("admin.tableDisabled")}</p>}
        <Field label={t("admin.copyLink")}><input readOnly dir="ltr" value={link(table.code)} onFocus={event => event.target.select()} /></Field>
        <div className="ra-row"><button className="ra-secondary" type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(link(table.code)); setCopied(table.id); }
          catch { reportError("admin.copyError"); }
        }}><Copy size={16} />{t(copied === table.id ? "common.copied" : "admin.copyLink")}</button>
          <button className="ra-secondary" type="button" onClick={() => print(table.name, link(table.code))}><Printer size={16} />{t("admin.printQR")}</button></div>
      </> : <p className="ra-muted ra-empty">{t("admin.saveTableFirst")}</p>}
    </article>)}</div>
    {printTarget && <div className="ra-print-container" role="presentation"><h1>{catalog.settings.name}</h1><h2>{printTarget.name}</h2><QRCodeSVG value={printTarget.url} size={280} level="M" marginSize={4} /><p>{t("admin.scanOrder")}</p><p dir="ltr">{printTarget.url}</p></div>}
  </section>;
}
