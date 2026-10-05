import { useLocale } from "../i18n";
import type { Catalog, Mode, PaymentMethod, Settings } from "../types";
import { restaurantCountryName } from "../countries";
import { Check, Field, MoneyInput } from "./Fields";
import type { CatalogUpdate } from "./MenuEditor";
import { parseMinor } from "./helpers";
import { DeliveryZonesEditor } from "./DeliveryZonesEditor";
import { LanguageSettings } from "./LanguageSettings";

const currencies = ["SAR", "AED", "USD", "EUR", "GBP", "TRY", "AFN", "IRR", "RUB", "UAH", "XOF", "KES", "NGN", "PKR", "INR", "JPY", "KWD", "BHD", "OMR", "QAR"];

export function SettingsEditor({ catalog, update }: { catalog: Catalog; update: CatalogUpdate }) {
  const { t, locale } = useLocale();
  const s = catalog.settings;
  const patch = (change: Partial<Settings>) => update(current => ({ ...current, settings: { ...current.settings, ...change } }));
  const methods: Record<Mode, PaymentMethod[]> = { table: ["cash_before", "cash_after", "card"], delivery: ["cash_on_delivery", "card"], pickup: ["card"] };
  const policy = s.paymentMethods ?? methods;
  return <div className="ra-settings-grid">
    <section className="ra-card">
      <h2>{t("admin.settings")}</h2>
      <Field label={t("admin.restaurantName")}><input value={s.name} required maxLength={120} onChange={event => patch({ name: event.target.value })} /></Field>
      <Field label={t("admin.description")}><textarea value={s.description} maxLength={2000} rows={3} onChange={event => patch({ description: event.target.value })} /></Field>
      <Field label={t("admin.restaurantAddress")}><textarea value={s.address} maxLength={1000} rows={2} onChange={event => patch({ address: event.target.value })} /></Field>
      <div className="ra-form-grid">
        <Field label={t("adminNext.country")}><input value={restaurantCountryName(s.country || "SA", locale)} readOnly /></Field>
        <Field label={t("admin.restaurantPhone")}><input type="tel" value={s.phone} dir="ltr" maxLength={40} onChange={event => patch({ phone: event.target.value })} /></Field>
        <Field label={t("admin.currency")}><select value={s.currency} dir="ltr" required onChange={event => patch({ currency: event.target.value })}>{currencies.map(currency => <option key={currency} value={currency}>{currency}</option>)}</select></Field>
        <LanguageSettings settings={s} onChange={patch} />
      </div>
      <Field label={t("admin.openingHours")}><textarea value={s.openingHours} maxLength={1000} rows={2} onChange={event => patch({ openingHours: event.target.value })} /></Field>
      <Field label={t("admin.pickupInstructions")}><textarea value={s.pickupInstructions} maxLength={2000} rows={2} onChange={event => patch({ pickupInstructions: event.target.value })} /></Field>
      <Field label={t("admin.paymentInstructions")}><textarea value={s.paymentInstructions} maxLength={2000} rows={2} onChange={event => patch({ paymentInstructions: event.target.value })} /></Field>
    </section>
    <div className="ra-settings-side">
      <section className="ra-card"><h2>{t("adminNext.tax")}</h2><p className="ra-muted">{t("adminNext.taxHint")}</p>
        <Check label={t("adminNext.taxEnabled")} checked={s.taxEnabled ?? false} onChange={taxEnabled => patch({ taxEnabled })} />
        <div className="ra-form-grid"><Field label={t("adminNext.taxRate")}><input type="number" dir="ltr" min={0} max={100} step="0.01" value={(s.taxRateBps ?? 1500) / 100} onChange={event => {
          const basisPoints = parseMinor(event.target.value, 2);
          event.target.setCustomValidity(basisPoints === null || basisPoints > 10000 ? t("admin.validation") : "");
          if (basisPoints !== null && basisPoints <= 10000) patch({ taxRateBps: basisPoints });
        }} /></Field><Field label={t("adminNext.taxNumber")}><input value={s.taxNumber ?? ""} maxLength={80} required={s.taxEnabled} onChange={event => patch({ taxNumber: event.target.value })} /></Field></div>
        <p className="ra-warning">{t("adminNext.taxCompliance")}</p>
      </section>
      <section className="ra-card"><h2>{t("adminNext.paymentPolicy")}</h2><p className="ra-muted">{t("adminNext.paymentPolicyHint")}</p>
        {(Object.keys(methods) as Mode[]).map(mode => <fieldset className="ra-policy-group" key={mode}><legend>{t(`order.${mode}`)}</legend>{methods[mode].map(method => <Check key={method} label={t(`payment.method.${method}`)} checked={policy[mode]?.includes(method) ?? false} onChange={enabled => {
          const current = policy[mode] ?? [];
          patch({ paymentMethods: { ...policy, [mode]: enabled ? [...new Set([...current, method])] : current.filter(value => value !== method) } });
        }} />)}{mode === "pickup" && <small>{t("adminNext.pickupCardOnly")}</small>}</fieldset>)}
      </section>
      <section className="ra-card"><h2>{t("admin.orderModes")}</h2>
        <Check label={t("admin.acceptingOrders")} checked={s.acceptingOrders} onChange={acceptingOrders => patch({ acceptingOrders })} />
        <Check label={t("order.delivery")} checked={s.deliveryEnabled} onChange={deliveryEnabled => patch({ deliveryEnabled })} />
        <Check label={t("order.pickup")} checked={s.pickupEnabled} onChange={pickupEnabled => patch({ pickupEnabled })} />
        <Check label={t("order.table")} checked={s.tableEnabled} onChange={tableEnabled => patch({ tableEnabled })} />
        <hr /><Check label={t("admin.demo")} checked={s.demo} onChange={demo => patch({ demo })} />
      </section>
      <section className="ra-card"><h2>{t("admin.deliverySettings")}</h2>
        <div className="ra-form-grid">{s.deliveryPricingMode !== "district" && <MoneyInput label={t("admin.deliveryFee")} value={s.deliveryFeeMinor} currency={s.currency} onChange={deliveryFeeMinor => patch({ deliveryFeeMinor })} />}<MoneyInput label={t("admin.deliveryMinimum")} value={s.deliveryMinimumMinor} currency={s.currency} onChange={deliveryMinimumMinor => patch({ deliveryMinimumMinor })} /></div>
        <Field label={t("admin.deliveryAreas")}><textarea rows={4} value={s.deliveryAreas.join("\n")} onChange={event => patch({ deliveryAreas: event.target.value.split("\n") })} onBlur={event => patch({ deliveryAreas: [...new Set(event.target.value.split("\n").map(area => area.trim()).filter(Boolean))] })} /></Field>
        <Field label={t("admin.deliveryRadius")} hint={t("admin.radiusHint")}><input type="number" dir="ltr" min={0} max={500} step="any" value={s.deliveryRadiusKm} onChange={event => patch({ deliveryRadiusKm: Number(event.target.value) })} /></Field>
        <div className="ra-form-grid">
          <Field label={t("admin.latitude")}><input type="number" dir="ltr" min={-90} max={90} step="any" value={s.latitude ?? ""} onChange={event => patch({ latitude: event.target.value === "" ? null : Number(event.target.value) })} /></Field>
          <Field label={t("admin.longitude")}><input type="number" dir="ltr" min={-180} max={180} step="any" value={s.longitude ?? ""} onChange={event => patch({ longitude: event.target.value === "" ? null : Number(event.target.value) })} /></Field>
        </div>
        <Check label={t("admin.requireLocation")} checked={s.requireDeliveryLocation} onChange={requireDeliveryLocation => patch({ requireDeliveryLocation })} />
      </section>
      <DeliveryZonesEditor settings={s} onChange={patch} />
    </div>
  </div>;
}
