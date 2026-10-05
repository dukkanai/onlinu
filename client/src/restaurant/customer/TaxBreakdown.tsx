import { useLocale } from "../i18n";
import type { TaxSummary } from "../types";

export function TaxBreakdown({
  tax,
  currency,
}: {
  tax?: TaxSummary;
  currency: string;
}) {
  const { t, money, locale } = useLocale();
  if (!tax?.enabled) return null;
  return (
    <div className="rs-tax-breakdown">
      <p>{t("tax.inclusive")}</p>
      <div>
        <span>{t("tax.net")}</span>
        <span>{money(tax.netMinor, currency)}</span>
      </div>
      <div>
        <span>
          {t("tax.amount", {
            rate: new Intl.NumberFormat(locale, {
              maximumFractionDigits: 2,
            }).format(tax.rateBps / 100),
          })}
        </span>
        <span>{money(tax.taxMinor, currency)}</span>
      </div>
      {tax.number && (
        <div>
          <span>{t("tax.number")}</span>
          <bdi>{tax.number}</bdi>
        </div>
      )}
    </div>
  );
}
