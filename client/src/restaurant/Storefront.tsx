import { useOpeningStatus } from "./customer/useOpeningStatus";
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent, ReactElement, ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ClipboardList,
  Copy,
  MapPin,
  Minus,
  Plus,
  Search,
  ShoppingBag,
  Soup,
  Truck,
  UserRound,
  UtensilsCrossed,
  X,
} from "lucide-react";
import { storefront } from "./api";
import { BrandHero } from "./BrandHero";
import { DishArt } from "./DishArt";
import { effectiveBrand, storefrontTemplate } from "./brand";
import { MenuTemplate } from "./MenuTemplate";
import { MenuProducts } from "./MenuProducts";
import { OrderLocation } from "./customer/OrderLocation";
import { GeographyFields } from "./customer/GeographyFields";
import { deliveryZoneFee, destinationKey, districtPricing } from "./geography";
import { OrderSupportPanel } from "./customer/OrderSupportPanel";
import { LanguagePicker, useLocale } from "./i18n";
import type {
  Address,
  Catalog,
  Customer,
  MenuItem,
  Mode,
  Order,
  OrderInput,
  OrderLineInput,
  OrderStatus,
  PaymentMethod,
  Quote,
  Receipt,
  RestaurantTable,
  Settings,
} from "./types";
import { emptyAddress } from "./types";
import {
  CART_STORAGE_KEY,
  lineKey,
  normalizeCart,
  parseTableCode,
  privateTrackingURL,
  safeMenuImage,
  unitPrice,
} from "./customer/cart";
import "./customer/storefront.css";
import "./brand.css";
import "./templates.css";
import { restaurantCountryName } from "./countries";
import {
  availablePaymentMethods,
  brandVariables,
  deliveryStatuses,
  isSaudiDeliveryAddress,
  paymentStatusKey,
  printOrderReceipt,
  withAddressCountry,
} from "./customer/operations";
import { TaxBreakdown } from "./customer/TaxBreakdown";
import {
  PaymentPanel,
  type PublicPaymentProvider,
} from "./customer/PaymentPanel";
import {
  readPendingSubmission,
  rememberSubmissionReceipt,
  savePendingSubmission,
  sameSubmission,
  type PendingSubmission,
} from "./customer/pending";
import { quoteBinding } from "./customer/quoteBinding";
import { createTrackingReadGuard } from "./customer/trackingRead";
import { clearSubmittedCart, createCheckoutLifetime } from "./customer/checkoutLifetime";

type L10n = ReturnType<typeof useLocale>;
type Navigate = (path: string) => void;
type CartSetter = (
  next: OrderLineInput[] | ((current: OrderLineInput[]) => OrderLineInput[]),
) => void;
const json = (
  body: unknown,
  method = "POST",
  headers: Record<string, string> = {},
) => ({
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const orderStates: OrderStatus[] = [
  "new",
  "accepted",
  "preparing",
  "ready",
  "out_for_delivery",
  "completed",
];
const activeOrder = (order: Order) =>
  !["completed", "cancelled"].includes(order.status);
function errorKey(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  )
    return `errors.${error.code.replace(/^errors\./, "")}`;
  return "common.error";
}
function useError() {
  const [error, setError] = useState("");
  return {
    error,
    setError,
    fail: (value: unknown) => setError(errorKey(value)),
  };
}
function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`rs-notice ${error ? "rs-notice-error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const control =
    isValidElement(children) &&
    typeof children.type === "string" &&
    ["input", "select", "textarea"].includes(children.type)
      ? cloneElement(
          children as ReactElement<{
            "aria-labelledby"?: string;
            "aria-describedby"?: string;
          }>,
          {
            "aria-labelledby": labelId,
            "aria-describedby":
              [
                (children as ReactElement<{ "aria-describedby"?: string }>)
                  .props["aria-describedby"],
                hint ? hintId : undefined,
              ]
                .filter(Boolean)
                .join(" ") || undefined,
          },
        )
      : children;
  return (
    <label className="rs-field">
      <span id={labelId}>{label}</span>
      {control}
      {hint && (
        <small className="rs-muted" id={hintId}>
          {hint}
        </small>
      )}
    </label>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const { t } = useLocale();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node
      ?.querySelector<HTMLElement>("button, input, select, textarea")
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab" || !node) return;
      const focusable = [
        ...node.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]",
        ),
      ];
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="rs-modal-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="rs-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialog}
      >
        <div className="rs-section-head">
          <h2>{title}</h2>
          <button
            className="rs-icon-button"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X size={22} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Quantity({
  quantity,
  onChange,
}: {
  quantity: number;
  onChange: (quantity: number) => void;
}) {
  const { t } = useLocale();
  return (
    <div className="rs-quantity">
      <button
        type="button"
        aria-label={t("store.decrease")}
        onClick={() => onChange(quantity - 1)}
      >
        <Minus size={16} />
      </button>
      <span>{quantity}</span>
      <button
        type="button"
        aria-label={t("store.increase")}
        disabled={quantity >= 99}
        onClick={() => onChange(quantity + 1)}
      >
        <Plus size={16} />
      </button>
    </div>
  );
}
function ItemDialog({
  item,
  currency,
  acceptingOrders,
  onClose,
  onAdd,
}: {
  item: MenuItem;
  currency: string;
  acceptingOrders: boolean;
  onClose: () => void;
  onAdd: (line: OrderLineInput) => void;
}) {
  const { t, money } = useLocale();
  const [quantity, setQuantity] = useState(1);
  const [options, setOptions] = useState<string[]>([]);
  const image = safeMenuImage(item.imageUrl);
  return (
    <Modal title={item.name} onClose={onClose}>
      <div className="rs-dialog-food">
        {image ? (
          <img src={image} alt="" referrerPolicy="no-referrer" />
        ) : (
          <DishArt variant={-1} />
        )}
      </div>
      <p className="rs-muted">{item.description}</p>
      {item.options.some((option) => option.available) && (
        <fieldset className="rs-options">
          <legend>{t("store.extras")}</legend>
          {item.options
            .filter((option) => option.available)
            .map((option) => (
              <label key={option.id}>
                <input
                  type="checkbox"
                  checked={options.includes(option.id)}
                  onChange={(event) =>
                    setOptions((old) =>
                      event.target.checked
                        ? [...old, option.id]
                        : old.filter((id) => id !== option.id),
                    )
                  }
                />
                <span>{option.name}</span>
                <strong>{money(option.priceMinor, currency)}</strong>
              </label>
            ))}
        </fieldset>
      )}
      <div className="rs-dialog-actions">
        <Quantity
          quantity={quantity}
          onChange={(value) => setQuantity(Math.max(1, value))}
        />
        <button
          className="rs-button"
          disabled={!acceptingOrders || !item.available}
          onClick={() => {
            if (!acceptingOrders || !item.available) return;
            onAdd({ itemId: item.id, quantity, optionIds: options });
            onClose();
          }}
        >
          {t("store.addToCart")} ·{" "}
          {money(unitPrice(item, options) * quantity, currency)}
        </button>
      </div>
    </Modal>
  );
}
function CartSummary({
  cart,
  catalog,
  setCart,
  quote,
  checkout,
  navigate,
}: {
  cart: OrderLineInput[];
  catalog: Catalog;
  setCart?: CartSetter;
  quote?: Quote | null;
  checkout?: boolean;
  navigate?: Navigate;
}) {
  const { t, money } = useLocale();
  const currency = quote?.currency ?? catalog.settings.currency;
  const subtotal = cart.reduce((sum, line) => {
    const item = catalog.items.find((entry) => entry.id === line.itemId);
    return sum + (item ? unitPrice(item, line.optionIds) * line.quantity : 0);
  }, 0);
  return (
    <section className="rs-panel rs-cart">
      <div className="rs-section-head">
        <h2>
          <ShoppingBag size={21} />
          {t("store.cart")}
        </h2>
        <span className="rs-count">
          {(quote?.items ?? cart).reduce((sum, line) => sum + line.quantity, 0)}
        </span>
      </div>
      {!(quote?.items ?? cart).length ? (
        <div className="rs-empty">
          <Soup size={42} strokeWidth={1.3} />
          <h3>{t("store.emptyCart")}</h3>
          <p>{t("store.emptyCartHint")}</p>
        </div>
      ) : (
        <>
          <div className="rs-cart-lines">
            {quote
              ? quote.items.map((line, index) => (
                  <div key={`${line.itemId}-${index}`} className="rs-cart-line">
                    <div>
                      <strong>{line.name}</strong>
                      <p>
                        {line.options.map((option) => option.name).join(" · ")}
                      </p>
                      <small>× {line.quantity}</small>
                    </div>
                    <strong>{money(line.totalMinor, currency)}</strong>
                  </div>
                ))
              : cart.map((line) => {
                  const item = catalog.items.find(
                    (entry) => entry.id === line.itemId,
                  );
                  if (!item) return null;
                  return (
                    <div key={lineKey(line)} className="rs-cart-line">
                      <div>
                        <strong>{item.name}</strong>
                        <p>
                          {item.options
                            .filter((option) =>
                              line.optionIds.includes(option.id),
                            )
                            .map((option) => option.name)
                            .join(" · ")}
                        </p>
                        {setCart ? (
                          <Quantity
                            quantity={line.quantity}
                            onChange={(quantity) =>
                              setCart((previous) =>
                                previous.flatMap((candidate) =>
                                  lineKey(candidate) !== lineKey(line)
                                    ? [candidate]
                                    : quantity > 0
                                      ? [{ ...candidate, quantity }]
                                      : [],
                                ),
                              )
                            }
                          />
                        ) : (
                          <small>× {line.quantity}</small>
                        )}
                      </div>
                      <strong>
                        {money(
                          unitPrice(item, line.optionIds) * line.quantity,
                          currency,
                        )}
                      </strong>
                    </div>
                  );
                })}
          </div>
          <div className="rs-totals">
            <div>
              <span>{t("store.subtotal")}</span>
              <span>{money(quote?.subtotalMinor ?? subtotal, currency)}</span>
            </div>
            {quote && (
              <div>
                <span>{t("store.deliveryFee")}</span>
                <span>{money(quote.deliveryFeeMinor, currency)}</span>
              </div>
            )}
            <div className="rs-total">
              <strong>{t("store.total")}</strong>
              <strong>{money(quote?.totalMinor ?? subtotal, currency)}</strong>
            </div>
          </div>
          <TaxBreakdown tax={quote?.tax} currency={currency} />
          {checkout && (
            <button
              className="rs-button rs-full"
              disabled={!catalog.settings.acceptingOrders}
              onClick={() => navigate?.("/order" + window.location.search)}
            >
              {t("store.checkout")}
              <ArrowUpRight size={19} />
            </button>
          )}
        </>
      )}
    </section>
  );
}
function MenuPage({
  catalog,
  cart,
  setCart,
  navigate,
  table,
}: {
  catalog: Catalog;
  cart: OrderLineInput[];
  setCart: CartSetter;
  navigate: Navigate;
  table: RestaurantTable | null;
}) {
  const { t, money } = useLocale();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [selected, setSelected] = useState<MenuItem | null>(null);
  const [added, setAdded] = useState(false);
  const template = storefrontTemplate(effectiveBrand(catalog.settings));
  useEffect(() => {
    if (!added) return;
    const timer = window.setTimeout(() => setAdded(false), 2200);
    return () => clearTimeout(timer);
  }, [added]);
  const items = catalog.items
    .filter(
      (item) =>
        (!category || item.categoryId === category) &&
        `${item.name} ${item.description}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase()),
    )
    .sort((a, b) => a.sort - b.sort);
  return (
    <>
      <MenuTemplate template={template}
      hero={<BrandHero settings={catalog.settings} fallbackArt={<DishArt variant={2}/>} />}
      table={table && (
        <div className="rs-table-banner">
          <UtensilsCrossed size={24} />
          <div>
            <strong>{t("store.tableWelcome", { table: table.name })}</strong>
            <p>{t("store.tableHint")}</p>
          </div>
          <button
            className="rs-button rs-button-soft"
            onClick={() =>
              navigate(`/track?table=${encodeURIComponent(table.code)}`)
            }
          >
            {t("store.moveExisting")}
          </button>
        </div>
      )}
      heading={<div className="rs-section-head rs-menu-heading">
            <div>
              <h2>{t("store.menu")}</h2>
            </div>
            <label className="rs-search">
              <Search size={18} />
              <input
                aria-label={t("store.search")}
                placeholder={t("store.search")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>}
      categories={<div className="rs-categories" aria-label={t("store.menu")}>
            <button
              className={!category ? "active" : ""}
              aria-pressed={!category}
              onClick={() => setCategory("")}
            >
              {t("store.all")}
            </button>
            {[...catalog.categories]
              .sort((a, b) => a.sort - b.sort)
              .map((entry) => (
                <button
                  key={entry.id}
                  className={category === entry.id ? "active" : ""}
                  aria-pressed={category === entry.id}
                  onClick={() => setCategory(entry.id)}
                >
                  {entry.name}
                </button>
              ))}
          </div>}
      notice={catalog.settings.taxEnabled && (
            <p className="rs-menu-language">{t("tax.inclusive")}</p>
          )}
      content={!items.length ? (
            <div className="rs-empty rs-panel">
              <Search size={32} />
              <h3>{t("store.noItems")}</h3>
              <p>{t("store.noItemsHint")}</p>
            </div>
          ) : (
            <MenuProducts template={template} items={items} categories={catalog.categories} renderItem={(item, index) => {
                const image = safeMenuImage(item.imageUrl);
                return (
                  <article className="rs-food-card" key={item.id}>
                    <button
                      className={`rs-food-image rs-food-tone-${index % 4}`}
                      onClick={() => setSelected(item)}
                      disabled={!item.available}
                      aria-label={item.name}
                    >
                      {image ? (
                        <img
                          src={image}
                          alt={item.name}
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <DishArt variant={-1} />
                      )}
                    </button>
                    <div className="rs-food-content">
                      {template === "editorial" ? <h4>{item.name}</h4> : <h3>{item.name}</h3>}
                      {item.description && <p>{item.description}</p>}
                      <div>
                        <strong>
                          {money(item.priceMinor, catalog.settings.currency)}
                        </strong>
                        <button
                          className="rs-add-item"
                          disabled={!item.available}
                          onClick={() => setSelected(item)}
                          aria-label={`${t("common.add")} ${item.name}`}
                        >
                          {item.available ? (
                            <Plus size={21} />
                          ) : (
                            <span>{t("store.unavailable")}</span>
                          )}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              }} />
          )}
      sidebar={<>
          <CartSummary
            cart={cart}
            catalog={catalog}
            setCart={setCart}
            checkout
            navigate={navigate}
          />
          {catalog.settings.openingHours && (
            <div className="rs-info-line">
              <Clock3 size={18} />
              <p>{catalog.settings.openingHours}</p>
            </div>
          )}
          {catalog.settings.address && (
            <div className="rs-info-line">
              <MapPin size={18} />
              <p>{catalog.settings.address}</p>
            </div>
          )}
      </>} />
      {selected && (
        <ItemDialog
          item={selected}
          currency={catalog.settings.currency}
          acceptingOrders={catalog.settings.acceptingOrders}
          onClose={() => setSelected(null)}
          onAdd={(line) => {
            if (!catalog.settings.acceptingOrders) return;
            setCart((old) => normalizeCart([...old, line], catalog));
            setAdded(true);
          }}
        />
      )}
      {added && (
        <div className="rs-toast" role="status">
          <CheckCircle2 size={19} />
          {t("store.added")}
        </div>
      )}
      {cart.length > 0 && (
        <button
          className="rs-mobile-cart rs-button"
          onClick={() => navigate("/order" + window.location.search)}
        >
          <ShoppingBag size={20} />
          <span>{t("store.checkout")}</span>
          <strong>
            {money(
              cart.reduce((sum, line) => {
                const item = catalog.items.find(
                  (entry) => entry.id === line.itemId,
                );
                return (
                  sum +
                  (item ? unitPrice(item, line.optionIds) * line.quantity : 0)
                );
              }, 0),
              catalog.settings.currency,
            )}
          </strong>
        </button>
      )}
    </>
  );
}

function AddressFields({
  value,
  onChange,
  areas = [],
  withLabel = false,
  settings,
  coverageOnly = false,
}: {
  value: Address;
  onChange: (address: Address) => void;
  areas?: string[];
  withLabel?: boolean;
  settings?: Settings;
  coverageOnly?: boolean;
}) {
  const { t, locale } = useLocale();
  const fields = [
    "street",
    "building",
    "postalCode",
    "additionalNumber",
  ] as const;
  return (
    <div className="rs-fields">
      <Field label={t("address.country")}>
        <input
          value={restaurantCountryName(value.country || "SA", locale)}
          readOnly
          autoComplete="country-name"
        />
      </Field>
      {withLabel && (
        <Field label={t("address.label")}>
          <input
            maxLength={60}
            value={value.label ?? ""}
            onChange={(event) =>
              onChange({ ...value, label: event.target.value })
            }
          />
        </Field>
      )}
      <GeographyFields value={value} onChange={onChange} settings={settings} coverageOnly={coverageOnly} />
      {(!value.country || value.country === "SA") && (
        <div className="rs-field-wide">
          <Field
            label={t("address.nationalAddress")}
            hint={t("deliveryGeo.shortHint")}
          >
            <input
              maxLength={200}
              value={value.nationalAddress}
              onChange={(event) =>
                onChange({ ...value, nationalAddress: event.target.value })
              }
            />
          </Field>
        </div>
      )}
      {fields
        .filter(
          (key) =>
            key !== "additionalNumber" ||
            !value.country ||
            value.country === "SA",
        )
        .map((key) => (
          <Field key={key} label={t(`address.${key}`)}>
            <input
              maxLength={
                key === "building" ||
                key === "postalCode" ||
                key === "additionalNumber"
                  ? 20
                  : 120
              }
              autoComplete={
                key === "postalCode"
                      ? "postal-code"
                      : undefined
              }
              value={value[key]}
              onChange={(event) =>
                onChange({ ...value, [key]: event.target.value })
              }
            />
          </Field>
        ))}
      {areas.length > 0 && !districtPricing(settings) && !value.regionId && !value.cityId && !value.districtId && (
        <Field label={t("address.area")}>
          <select
            value={value.area}
            onChange={(event) =>
              onChange({ ...value, area: event.target.value })
            }
          >
            <option value="">—</option>
            {areas.map((area) => (
              <option key={area} value={area}>
                {area}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="rs-field-wide">
        <Field label={t("address.addressLine")}>
          <textarea
            maxLength={500}
            rows={2}
            value={value.addressLine}
            onChange={(event) =>
              onChange({ ...value, addressLine: event.target.value })
            }
          />
        </Field>
      </div>
    </div>
  );
}
function CheckoutPage({
  catalog,
  cart,
  setCart,
  table,
  customer,
  navigate,
  onReceipt,
  refreshCatalog,
  onSubmissionStateChange,
  onSessionExpired,
}: {
  catalog: Catalog;
  cart: OrderLineInput[];
  setCart: CartSetter;
  table: RestaurantTable | null;
  customer: Customer | null;
  navigate: Navigate;
  onReceipt: (receipt: Receipt) => void;
  refreshCatalog: () => Promise<void>;
  onSubmissionStateChange: (locked: boolean) => void;
  onSessionExpired: () => void;
}) {
  const { t, money } = useLocale();
  const settings = catalog.settings;
  const [recovery] = useState(readPendingSubmission);
  const modes = (["delivery", "pickup", "table"] as Mode[]).filter(
    (mode) => settings[`${mode}Enabled`],
  );
  const [mode, setMode] = useState<Mode>(
    recovery?.input.mode ??
      (table && settings.tableEnabled ? "table" : (modes[0] ?? "pickup")),
  );
  const [name, setName] = useState(
    recovery?.input.customerName ?? customer?.displayName ?? "",
  );
  const [phone, setPhone] = useState(
    recovery?.input.phone ?? customer?.phone ?? "",
  );
  const [address, setAddress] = useState<Address>(
    recovery?.input.address ?? emptyAddress(),
  );
  const deliveryAddresses = customer?.addresses.filter(isSaudiDeliveryAddress) ?? [];
  const [tableCode, setTableCode] = useState(
    recovery?.input.tableCode ?? table?.code ?? "",
  );
  const [notes, setNotes] = useState(recovery?.input.notes ?? "");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    recovery?.input.paymentMethod ??
      availablePaymentMethods(settings, mode)[0] ??
      "card",
  );
  const [paymentProvider, setPaymentProvider] = useState(
    recovery?.input.paymentProvider ?? "",
  );
  const [providers, setProviders] = useState<PublicPaymentProvider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const methods = availablePaymentMethods(settings, mode);
  const [quote, setQuote] = useState<Quote | null>(recovery?.quote ?? null);
  const [quoteHash, setQuoteHash] = useState(recovery?.input.expectedQuoteHash ?? "");
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [uncertain, setUncertain] = useState(!!recovery);
  const { error, setError, fail } = useError();
  const submission = useRef<PendingSubmission | null>(recovery);
  const mutation = useRef(false);
  const lifetime = useRef(createCheckoutLifetime()).current;
  useEffect(() => {
    const dispose = lifetime.mount();
    mutation.current = false;
    setBusy(false);
    if (submission.current) setUncertain(true);
    return dispose;
  }, [lifetime, customer?.id]);
  useEffect(() => {
    let active = true;
    setProvidersLoading(true);
    void storefront<{ providers: PublicPaymentProvider[] }>(
      `/payments?currency=${encodeURIComponent(settings.currency)}`,
    )
      .then((result) => {
        if (active) {
          const eligible = result.providers.filter(
            (provider) => provider.mode === (settings.demo ? "test" : "live"),
          );
          setProviders(eligible);
          setPaymentProvider((old) =>
            submission.current ||
            eligible.some((provider) => provider.id === old)
              ? old
              : eligible[0]?.id || "",
          );
        }
      })
      .catch(() => {
        if (active) setProviders([]);
      })
      .finally(() => {
        if (active) setProvidersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [settings.currency, settings.demo]);
  useEffect(() => {
    if (
      !submission.current &&
      !availablePaymentMethods(settings, mode).includes(paymentMethod)
    )
      setPaymentMethod(availablePaymentMethods(settings, mode)[0] ?? "card");
  }, [mode, settings.paymentMethods, paymentMethod]);
  useEffect(() => {
    onSubmissionStateChange(busy || uncertain);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (busy || uncertain) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      onSubmissionStateChange(false);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [busy, uncertain, onSubmissionStateChange]);
  useEffect(() => {
    if (table && settings.tableEnabled && !submission.current) {
      setMode("table");
      setTableCode(table.code);
    }
  }, [table, settings.tableEnabled]);
  useEffect(() => {
    if (!submission.current) setQuote(null);
  }, [
    mode,
    name,
    phone,
    address,
    tableCode,
    notes,
    cart,
    paymentMethod,
    paymentProvider,
    catalog.version,
  ]);
  const buildInput = (): OrderInput => ({
    mode,
    customerName: name.trim(),
    phone: phone.trim(),
    address:
      mode === "delivery"
        ? withAddressCountry(
            address,
            address.country || "SA",
          )
        : emptyAddress(),
    tableCode:
      mode === "table" ? parseTableCode(tableCode, window.location.origin) : "",
    notes: notes.trim(),
    items: cart,
    expectedTotalMinor: quote?.totalMinor ?? 0,
    ...(quote && quoteHash ? { expectedQuoteHash: quoteHash } : {}),
    paymentMethod,
    paymentProvider: paymentMethod === "card" ? paymentProvider : "",
  });
  const review = async (event: FormEvent) => {
    event.preventDefault();
    if (mutation.current || !cart.length || locating) return;
    if (mode === "delivery" && !isSaudiDeliveryAddress(address)) {
      setError("errors.country_required");
      return;
    }
    if (mode === "delivery" && districtPricing(settings) && (!address.regionId || !address.cityId || !address.districtId || deliveryZoneFee(settings, address.districtId) === null)) {
      setError("errors.district_required");
      return;
    }
    if (
      paymentMethod === "card" &&
      !providers.some((provider) => provider.id === paymentProvider)
    ) {
      setError("payment.noProviders");
      return;
    }
    mutation.current = true;
    const current = lifetime.capture();
    setBusy(true);
    setError("");
    try {
      const result = await storefront<Quote>("/quote", json(buildInput()));
      const binding = await quoteBinding(result);
      if (!current()) return;
      setQuoteHash(binding);
      setQuote(result);
      submission.current = null;
    } catch (error) {
      if (!current()) return;
      fail(error);
      if (
        errorKey(error) === "errors.item_unavailable" ||
        errorKey(error) === "errors.invalid_option"
      ) {
        await refreshCatalog();
      }
    } finally {
      if (current()) {
        mutation.current = false;
        setBusy(false);
      }
    }
  };
  const confirm = async () => {
    if (mutation.current || !quote) return;
    // Only an unchanged persisted retry may omit the binding. A new order must
    // never silently fall back to the legacy total-only confirmation contract.
    if (!submission.current && !/^[0-9a-f]{64}$/.test(quoteHash)) {
      setQuote(null);
      setError("errors.quote_changed");
      return;
    }
    if (
      submission.current &&
      submission.current.customerId !== (customer?.id ?? "")
    ) {
      setError("account.sessionExpired");
      return;
    }
    mutation.current = true;
    const current = lifetime.capture();
    setBusy(true);
    setError("");
    if (!submission.current) {
      submission.current = {
        key: crypto.randomUUID(),
        input: buildInput(),
        quote,
        customerId: customer?.id ?? "",
        createdAt: Date.now(),
      };
      savePendingSubmission(submission.current);
    }
    // Another checkout view may have learned this request succeeded while this
    // view was open. Resolve its known receipt instead of replaying a POST.
    const saved = readPendingSubmission();
    if (sameSubmission(saved, submission.current) && saved?.receipt) submission.current = saved;
    const request = submission.current;
    try {
      const receipt: Receipt = request.receipt ? {
        order: await storefront<Order>(`/orders/${encodeURIComponent(request.receipt.number)}`, {
          headers: { "X-Order-Token": request.receipt.trackingToken },
        }),
        trackingToken: request.receipt.trackingToken, accessCode: request.receipt.accessCode,
      } : await storefront<Receipt>("/orders", json(request.input, "POST", {
        "Idempotency-Key": request.key,
      }));
      rememberSubmissionReceipt(request, receipt);
      if (!current()) return;
      setCart(cart => clearSubmittedCart(cart, request.input.items));
      onReceipt(receipt);
      if (sameSubmission(readPendingSubmission(), request)) savePendingSubmission(null);
      submission.current = null;
    } catch (error) {
      if (!current()) return;
      fail(error);
      // A failed read cannot turn a confirmed order back into a new checkout.
      if (request.receipt) return;
      const status =
        error && typeof error === "object" && "status" in error
          ? Number(error.status)
          : 0;
      const ambiguous =
        uncertain ||
        !status ||
        status >= 500 ||
        status === 429 ||
        status === 401;
      setUncertain(ambiguous);
      if (status === 401) onSessionExpired();
      if (!ambiguous) {
        submission.current = null;
        savePendingSubmission(null);
        setQuote(null);
        if (
          [
            "errors.price_changed",
            "errors.quote_changed",
            "errors.item_unavailable",
            "errors.invalid_option",
          ].includes(errorKey(error))
        ) {
          await refreshCatalog();
        }
      }
    } finally {
      if (current()) {
        mutation.current = false;
        setBusy(false);
      }
    }
  };
  const locate = () => {
    if (!navigator.geolocation) {
      setError("order.locationError");
      return;
    }
    setLocating(true);
    setError("");
    const requestedDestination = destinationKey(address);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setAddress((old) => destinationKey(old) !== requestedDestination ? old : ({
          ...old,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }));
        setLocating(false);
      },
      () => {
        setError("order.locationError");
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 },
    );
  };
  if (!cart.length && !submission.current)
    return (
      <div className="rs-narrow">
        <section className="rs-panel rs-empty">
          <ShoppingBag size={42} />
          <h1>{t("store.emptyCart")}</h1>
          <p>{t("store.emptyCartHint")}</p>
          <button className="rs-button" onClick={() => navigate("/")}>
            {t("store.browse")}
          </button>
        </section>
      </div>
    );
  return (
    <>
      <div className="rs-page-heading">
        <span className="rs-eyebrow">{catalog.settings.name}</span>
        <h1>{t("order.checkout")}</h1>
        <p>{t("order.noAccount")}</p>
      </div>
      <div className="rs-checkout-layout">
        <form onSubmit={review} className="rs-form-stack">
          {error && <Notice error>{t(error)}</Notice>}
          {uncertain && (
            <Notice>
              {t(submission.current?.receipt ? "order.confirmedRecovery" : "order.networkRetry")}
              {submission.current?.customerId !== (customer?.id ?? "") && (
                <button
                  type="button"
                  className="rs-link-button"
                  onClick={() => navigate("/account")}
                >
                  {t("account.login")}
                </button>
              )}
            </Notice>
          )}
          <fieldset
            disabled={busy || uncertain || !!quote}
            className="rs-form-stack rs-reset-fieldset"
          >
            <section className="rs-panel">
              <h2>{t("payment.chooseMethod")}</h2>
              {mode === "pickup" && (
                <p className="rs-muted">{t("payment.pickupCardOnly")}</p>
              )}
              <div className="rs-payment-methods">
                {methods.map((method) => (
                  <label key={method}>
                    <input
                      type="radio"
                      name="paymentMethod"
                      value={method}
                      checked={paymentMethod === method}
                      onChange={() => setPaymentMethod(method)}
                    />
                    <span>{t(`payment.method.${method}`)}</span>
                  </label>
                ))}
              </div>
              {paymentMethod === "card" && (
                <>
                  <Field label={t("payment.chooseProvider")}>
                    <select
                      value={paymentProvider}
                      required
                      disabled={providersLoading}
                      onChange={(event) =>
                        setPaymentProvider(event.target.value)
                      }
                    >
                      <option value="">—</option>
                      {providers.map((provider) => (
                        <option value={provider.id} key={provider.id}>
                          {provider.name}
                          {provider.mode === "test"
                            ? ` · ${t("payment.testMode")}`
                            : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {!providersLoading && !providers.length && (
                    <p className="rs-notice rs-spaced">
                      {t("payment.noProviders")}
                    </p>
                  )}
                  {providers.find((provider) => provider.id === paymentProvider)
                    ?.mode === "test" && (
                    <p className="rs-notice rs-spaced">
                      {t("payment.testMode")}
                    </p>
                  )}
                </>
              )}
            </section>
            <section className="rs-panel">
              <h2>
                <span className="rs-step">1</span>
                {t("order.how")}
              </h2>
              {!modes.length && (
                <Notice error>{t("order.unavailableMode")}</Notice>
              )}
              <div className="rs-mode-options">
                {modes.map((candidate) => {
                  const Icon =
                    candidate === "delivery"
                      ? Truck
                      : candidate === "table"
                        ? UtensilsCrossed
                        : ShoppingBag;
                  return (
                    <label
                      key={candidate}
                      className={mode === candidate ? "active" : ""}
                    >
                      <input
                        type="radio"
                        name="mode"
                        value={candidate}
                        checked={mode === candidate}
                        onChange={() => setMode(candidate)}
                      />
                      <Icon size={24} />
                      <span>{t(`order.${candidate}`)}</span>
                      {mode === candidate && <Check size={15} />}
                    </label>
                  );
                })}
              </div>
              {mode === "table" && (
                <div className="rs-spaced">
                  <Field
                    label={t("order.tableCode")}
                    hint={t("order.tableHelp")}
                  >
                    <input
                      value={tableCode}
                      maxLength={500}
                      required
                      onChange={(event) => setTableCode(event.target.value)}
                    />
                  </Field>
                  {table && table.code === tableCode && (
                    <p className="rs-highlight">{table.name}</p>
                  )}
                </div>
              )}
              {mode === "pickup" && settings.pickupInstructions && (
                <p className="rs-muted rs-spaced">
                  {settings.pickupInstructions}
                </p>
              )}
            </section>
            <section className="rs-panel">
              <h2>
                <span className="rs-step">2</span>
                {t("order.contact")}
              </h2>
              <div className="rs-fields">
                <Field label={t("order.name")}>
                  <input
                    autoComplete="name"
                    required={paymentMethod === "card" && paymentProvider === "paylink"}
                    maxLength={100}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <Field label={t("order.phone")}>
                  <input
                    type="tel"
                    autoComplete="tel"
                    dir="ltr"
                    maxLength={30}
                    required={
                      mode !== "table" ||
                      (paymentMethod === "card" && ["geidea", "paylink"].includes(paymentProvider))
                    }
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                  />
                </Field>
              </div>
            </section>
            {mode === "delivery" && (
              <section className="rs-panel">
                <h2>
                  <MapPin size={21} />
                  {t("address.title")}
                </h2>
                {deliveryAddresses.length > 0 && (
                  <Field label={t("address.saved")}>
                    <select
                      defaultValue=""
                      onChange={(event) =>
                        setAddress(
                          event.target.value === ""
                            ? emptyAddress()
                            : withAddressCountry(
                                deliveryAddresses[Number(event.target.value)],
                                deliveryAddresses[Number(event.target.value)]
                                  .country || "SA",
                              ),
                        )
                      }
                    >
                      <option value="">{t("address.manual")}</option>
                      {deliveryAddresses.map((entry, index) => (
                        <option key={entry.id ?? index} value={index}>
                          {entry.label || `${entry.city} · ${entry.district}`}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <AddressFields
                  value={address}
                  onChange={setAddress}
                  areas={settings.deliveryAreas}
                  settings={settings}
                  coverageOnly
                />
                <div className="rs-location">
                  <button
                    type="button"
                    className="rs-button rs-button-soft"
                    disabled={locating}
                    onClick={locate}
                  >
                    <MapPin size={17} />
                    {locating ? t("common.loading") : t("order.location")}
                  </button>
                  {address.latitude !== null && address.longitude !== null && (
                    <span>
                      <CheckCircle2 size={16} />
                      {t("order.locationSet")}
                    </span>
                  )}
                </div>
                {settings.requireDeliveryLocation && (
                  <small className="rs-muted">
                    {t("order.locationRequired")}
                  </small>
                )}
                {settings.deliveryMinimumMinor > 0 && (
                  <p className="rs-muted rs-spaced">
                    {t("order.deliveryMinimum", {
                      amount: money(
                        settings.deliveryMinimumMinor,
                        settings.currency,
                      ),
                    })}
                  </p>
                )}
              </section>
            )}
            <section className="rs-panel">
              <Field label={`${t("order.notes")} · ${t("common.optional")}`}>
                <textarea
                  rows={3}
                  maxLength={1000}
                  placeholder={t("order.notesHint")}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
              </Field>
            </section>
          </fieldset>
          <div className="rs-notice rs-spaced"><p>{t("support.policy")}</p><p>{t("support.stockHint")}</p></div>
          {quote ? (
            <section className="rs-panel rs-confirm-panel">
              <h2>
                <CheckCircle2 size={21} />
                {t("order.review")}
              </h2>
              <p>{t("payment.reviewHint")}</p>
              {quote.tableName && (
                <p>
                  {t("order.table")}: <strong>{quote.tableName}</strong>
                </p>
              )}
              {settings.paymentInstructions && (
                <p>{settings.paymentInstructions}</p>
              )}
              <div className="rs-dialog-actions">
                {!uncertain && (
                  <button
                    type="button"
                    className="rs-button rs-button-outline"
                    disabled={busy}
                    onClick={() => setQuote(null)}
                  >
                    {t("order.edit")}
                  </button>
                )}
                <button
                  type="button"
                  className="rs-button"
                  disabled={busy || (!uncertain && !settings.acceptingOrders)}
                  onClick={confirm}
                >
                  {busy
                    ? t("order.submitting")
                    : submission.current?.receipt
                      ? t("order.tracking")
                    : uncertain
                      ? t("common.retry")
                      : `${t("order.confirm")} · ${money(quote.totalMinor, quote.currency)}`}
                </button>
              </div>
            </section>
          ) : (
            <button
              className="rs-button rs-full rs-large-button"
              type="submit"
              disabled={
                busy ||
                locating ||
                !modes.length ||
                !settings.acceptingOrders ||
                (paymentMethod === "card" &&
                  (providersLoading ||
                    !providers.some(
                      (provider) => provider.id === paymentProvider,
                    )))
              }
            >
              {busy ? t("common.loading") : t("order.review")}
              <ArrowUpRight size={19} />
            </button>
          )}
        </form>
        <aside>
          <CartSummary
            catalog={catalog}
            cart={cart}
            setCart={!quote && !busy ? setCart : undefined}
            quote={quote}
          />
        </aside>
      </div>
    </>
  );
}

function OrderDetails({ order }: { order: Order }) {
  const { t, money, date } = useLocale();
  const stages = orderStates.filter(
    (state) => state !== "out_for_delivery" || order.mode === "delivery",
  );
  const step = stages.indexOf(order.status);
  return (
    <div className="rs-print-receipt">
      <section className="rs-panel">
        <div className="rs-section-head">
          <h2>
            {t("order.number")} <bdi>{order.number}</bdi>
          </h2>
          <span className={`rs-status rs-status-${order.status}`}>
            {t(`order.status.${order.status}`)}
          </span>
        </div>
        <TaxBreakdown tax={order.tax} currency={order.currency} />
        <div className="rs-order-payment-summary">
          <strong>{t("payment.title")}</strong>
          <span>
            {order.payment?.method
              ? t(`payment.method.${order.payment.method}`)
              : t("payment.legacy")}
          </span>
          <span className="rs-status">
            {t(paymentStatusKey(order.payment?.status))}
          </span>
        </div>
        {order.demo && <Notice>{t("store.demo")}</Notice>}
        {order.status !== "cancelled" && (
          <ol className="rs-progress">
            {stages.map((status, index) => (
              <li key={status} className={index <= step ? "active" : ""}>
                <span>{index < step ? <Check size={14} /> : index + 1}</span>
                <small>{t(`order.status.${status}`)}</small>
              </li>
            ))}
          </ol>
        )}
        <div className="rs-order-meta">
          <span>
            {t(`order.${order.mode}`)}
            {order.tableName ? ` · ${order.tableName}` : ""}
          </span>
          <span>
            {t("order.updated")}: {date(order.updatedAt)}
          </span>
        </div>
      </section>
      <section className="rs-panel">
        <h2>
          <ClipboardList size={21} />
          {t("order.details")}
        </h2>
        {order.items.map((item, index) => (
          <div className="rs-cart-line" key={`${item.itemId}-${index}`}>
            <div>
              <strong>
                {item.quantity} × {item.name}
              </strong>
              <p>{item.options.map((option) => option.name).join(" · ")}</p>
            </div>
            <strong>{money(item.totalMinor, order.currency)}</strong>
          </div>
        ))}
        <div className="rs-totals">
          <div>
            <span>{t("store.subtotal")}</span>
            <span>{money(order.subtotalMinor, order.currency)}</span>
          </div>
          <div>
            <span>{t("store.deliveryFee")}</span>
            <span>{money(order.deliveryFeeMinor, order.currency)}</span>
          </div>
          <div className="rs-total">
            <strong>{t("store.total")}</strong>
            <strong>{money(order.totalMinor, order.currency)}</strong>
          </div>
        </div>
        {order.notes && (
          <p className="rs-spaced">
            <strong>{t("order.notes")}: </strong>
            {order.notes}
          </p>
        )}
        {order.mode === "delivery" && (
          <div className="rs-address-summary">
            <h3>{t("address.title")}</h3>
            <p>
              {[
                order.address.city,
                order.address.district,
                order.address.street,
                order.address.building,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {(!order.address.country || order.address.country === "SA") && (
              <p>{order.address.nationalAddress}</p>
            )}
            <p>{order.address.addressLine}</p>
          </div>
        )}
      </section>
      <p className="rs-receipt-disclaimer">{t("receipt.notFiscal")}</p>
    </div>
  );
}
function TrackPage({
  initialReceipt,
  table,
  navigate,
  customerId,
}: {
  initialReceipt: Receipt | null;
  table: RestaurantTable | null;
  navigate: Navigate;
  customerId: string;
}) {
  const { t, date } = useLocale();
  const params = new URLSearchParams(window.location.search);
  const [number, setNumber] = useState(
    initialReceipt?.order.number ?? params.get("order") ?? "",
  );
  const [accessCode, setAccessCode] = useState("");
  const [token, setToken] = useState(
    initialReceipt?.trackingToken ??
      new URLSearchParams(window.location.hash.slice(1)).get("token") ??
      "",
  );
  const [order, setOrder] = useState<Order | null>(
    initialReceipt?.order ?? null,
  );
  const [receiptCode, setReceiptCode] = useState(
    initialReceipt?.accessCode ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [newTable, setNewTable] = useState(table?.code ?? "");
  const [copied, setCopied] = useState(false);
  const [moved, setMoved] = useState(false);
  const { error, setError, fail } = useError();
  const reads = useRef(createTrackingReadGuard()).current;
  const lookupBusy = useRef(false);
  const orderNumber = order?.number ?? params.get("order") ?? "";
  useEffect(() => {
    if (table) setNewTable(table.code);
  }, [table]);
  const fetchOrder = useCallback(async () => {
    if (!orderNumber) return;
    const request = reads.begin();
    if (!request) return;
    try {
      const result = await storefront<Order>(
        `/orders/${encodeURIComponent(orderNumber)}`,
        { signal: request.signal, headers: token ? { "X-Order-Token": token } : {} },
      );
      if (request.current()) {
        setOrder(current => current?.number === result.number && current.version > result.version ? current : result);
        setError("");
      }
    } catch (error) {
      if (request.current()) fail(error);
    } finally {
      request.finish();
    }
  }, [orderNumber, token, reads]);
  useEffect(() => {
    if (orderNumber) void fetchOrder();
    const timer = window.setInterval(() => {
      if (!document.hidden) void fetchOrder();
    }, 10000);
    return () => { clearInterval(timer); reads.invalidate(); };
  }, [fetchOrder, orderNumber, reads]);
  const lookup = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || lookupBusy.current) return;
    lookupBusy.current = true;
    reads.invalidate();
    const request = reads.begin()!;
    setBusy(true);
    setError("");
    try {
      const receipt = await storefront<Receipt>(
        "/orders/lookup",
        { ...json({ number: number.trim(), accessCode: accessCode.trim() }), signal: request.signal },
      );
      if (!request.current()) return;
      setOrder(receipt.order);
      setToken(receipt.trackingToken);
      setReceiptCode(receipt.accessCode);
      setAccessCode("");
      const target = new URL(
        privateTrackingURL(
          window.location.origin,
          receipt.order.number,
          receipt.trackingToken,
        ),
      );
      if (table) target.searchParams.set("table", table.code);
      window.history.replaceState(
        {},
        "",
        target.pathname + target.search + target.hash,
      );
    } catch (error) {
      if (request.current()) fail(error);
    } finally {
      lookupBusy.current = false;
      if (request.current()) setBusy(false);
      request.finish();
    }
  };
  const changeTable = async (event: FormEvent) => {
    event.preventDefault();
    if (!order || busy) return;
    setBusy(true);
    setError("");
    setMoved(false);
    const code = parseTableCode(newTable, window.location.origin);
    if (!code) {
      setError("errors.table_not_found");
      setBusy(false);
      return;
    }
    try {
      setOrder(
        await storefront<Order>(
          `/orders/${encodeURIComponent(order.number)}/table`,
          json(
            { tableCode: code },
            "POST",
            token ? { "X-Order-Token": token } : {},
          ),
        ),
      );
      setMoved(true);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const copyLink = async () => {
    if (!order) return;
    try {
      await navigator.clipboard.writeText(
        privateTrackingURL(window.location.origin, order.number, token),
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setError("common.error");
    }
  };
  return (
    <div className="rs-tracking rs-narrow">
      <div className="rs-page-heading">
        <span className="rs-eyebrow">{t("order.tracking")}</span>
        <h1>{initialReceipt ? t("order.success") : t("store.track")}</h1>
        <p>{initialReceipt ? t("order.successText") : t("order.trackHint")}</p>
      </div>
      {error && <Notice error>{t(error)}</Notice>}
      {!order ? (
        <form className="rs-panel rs-form-stack" onSubmit={lookup}>
          <Field label={t("order.number")}>
            <input
              autoComplete="off"
              dir="ltr"
              value={number}
              maxLength={40}
              required
              onChange={(event) => setNumber(event.target.value)}
            />
          </Field>
          <Field label={t("order.accessCode")}>
            <input
              autoComplete="off"
              dir="ltr"
              value={accessCode}
              maxLength={40}
              required
              onChange={(event) => setAccessCode(event.target.value)}
            />
          </Field>
          {table && (
            <Notice>{t("order.moveToTable", { table: table.name })}</Notice>
          )}
          <button className="rs-button" disabled={busy}>
            {busy ? t("common.loading") : t("order.find")}
          </button>
        </form>
      ) : (
        <>
          <OrderDetails order={order} />
          <div className="rs-print-actions">
            <button
              className="rs-button rs-button-outline"
              onClick={printOrderReceipt}
            >
              {t("receipt.print")}
            </button>
          </div>
          <PaymentPanel order={order} token={token} onUpdated={setOrder} />
          <OrderLocation order={order} token={token}/>
          {(token || customerId) && <OrderSupportPanel key={`${order.number}-${customerId}`} order={order} token={token} customerId={customerId} onUpdated={setOrder}/>}
          {order.mode === "delivery" && (
            <section className="rs-panel">
              <h2>{t("delivery.title")}</h2>
              {order.courierName && (
                <p>
                  {t("delivery.courier")}: {order.courierName}
                </p>
              )}
              {!order.deliveryStatus ? (
                <p className="rs-muted">{t("delivery.noAssignment")}</p>
              ) : (
                <ol className="rs-delivery-timeline">
                  {(order.deliveryEvents ?? [])
                    .filter((event) =>
                      deliveryStatuses.includes(
                        event.status as (typeof deliveryStatuses)[number],
                      ),
                    )
                    .map((event, index) => (
                      <li key={`${event.at}-${index}`}>
                        <CheckCircle2 size={17} />
                        <span>
                          {t(`delivery.status.${event.status}`)}
                          <small>{date(event.at)}</small>
                        </span>
                      </li>
                    ))}
                </ol>
              )}
            </section>
          )}
          {token && (
            <section className="rs-panel rs-receipt-secret">
              {receiptCode && (
                <div>
                  <span>{t("order.accessCode")}</span>
                  <strong>
                    <bdi>{receiptCode}</bdi>
                  </strong>
                </div>
              )}
              <button className="rs-button rs-button-soft" onClick={copyLink}>
                {copied ? <Check size={17} /> : <Copy size={17} />}
                {t(copied ? "common.copied" : "order.privateLink")}
              </button>
              <p>{t("order.privateWarning")}</p>
            </section>
          )}
          {order.mode === "table" && activeOrder(order) && (
            <form className="rs-panel rs-form-stack" onSubmit={changeTable}>
              <h2>
                <UtensilsCrossed size={21} />
                {t("order.changeTable")}
              </h2>
              <p className="rs-muted">{t("order.changeTableHint")}</p>
              <Field label={t("order.newTable")} hint={t("order.tableHelp")}>
                <input
                  required
                  value={newTable}
                  maxLength={500}
                  onChange={(event) => setNewTable(event.target.value)}
                />
              </Field>
              {moved && <Notice>{t("order.tableChanged")}</Notice>}
              <button className="rs-button" disabled={busy}>
                {busy
                  ? t("common.loading")
                  : table && newTable === table.code
                    ? t("order.moveToTable", { table: table.name })
                    : t("order.changeTable")}
              </button>
            </form>
          )}
          <div className="rs-dialog-actions">
            <button
              className="rs-button rs-button-outline"
              onClick={fetchOrder}
            >
              {t("common.refresh")}
            </button>
            <button
              className="rs-button"
              onClick={() =>
                navigate(
                  table ? `/?table=${encodeURIComponent(table.code)}` : "/",
                )
              }
            >
              {t("order.newOrder")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AccountPage({
  customer,
  settings,
  setCustomer,
  navigate,
}: {
  customer: Customer | null;
  settings: Settings;
  setCustomer: (value: Customer | null) => void;
  navigate: Navigate;
}) {
  const { t, money, date } = useLocale();
  const [register, setRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState(customer?.displayName ?? "");
  const [phone, setPhone] = useState(customer?.phone ?? "");
  const [addresses, setAddresses] = useState<Address[]>(
    customer?.addresses ?? [],
  );
  const [orders, setOrders] = useState<Order[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const { error, setError, fail } = useError();
  const accountFail = (error: unknown) => {
    fail(error);
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 401
    ) {
      setCustomer(null);
      setOrders([]);
      setAddresses([]);
      setDisplayName("");
      setPhone("");
      setPassword("");
      setError("account.sessionExpired");
    }
  };
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setOrders([]);
    if (customer) {
      setDisplayName(customer.displayName);
      setPhone(customer.phone);
      setAddresses(customer.addresses);
      void storefront<{ orders: Order[] }>("/account/orders", {
        signal: controller.signal,
      })
        .then((result) => {
          if (active) setOrders(result.orders);
        })
        .catch((error) => {
          if (active) accountFail(error);
        });
    }
    return () => {
      active = false;
      controller.abort();
    };
  }, [customer]);
  const auth = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await storefront<{ customer: Customer }>(
        register ? "/account/register" : "/account/login",
        json({ username, password, ...(register ? { displayName } : {}) }),
      );
      setCustomer(result.customer);
      setPassword("");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (addresses.some((address) => !isSaudiDeliveryAddress(address))) {
      setError("errors.country_required");
      return;
    }
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const result = await storefront<{ customer: Customer }>(
        "/account",
        json(
          {
            displayName,
            phone,
            addresses: addresses.map((address) =>
              withAddressCountry(address, address.country || "SA"),
            ),
          },
          "PUT",
        ),
      );
      setCustomer(result.customer);
      setSaved(true);
    } catch (error) {
      accountFail(error);
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await storefront<void>("/account/logout", json({}));
      setCustomer(null);
      setOrders([]);
      setAddresses([]);
      setDisplayName("");
      setPhone("");
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rs-narrow">
      <div className="rs-page-heading">
        <span className="rs-eyebrow">{t("account.title")}</span>
        <h1>
          {customer
            ? customer.displayName || customer.username
            : t(register ? "account.register" : "account.login")}
        </h1>
        <p>{t("account.optional")}</p>
      </div>
      {error && <Notice error>{t(error)}</Notice>}
      {!customer ? (
        <form className="rs-panel rs-form-stack" onSubmit={auth}>
          <div className="rs-auth-tabs">
            <button
              type="button"
              className={!register ? "active" : ""}
              onClick={() => {
                setRegister(false);
                setError("");
              }}
            >
              {t("account.login")}
            </button>
            <button
              type="button"
              className={register ? "active" : ""}
              onClick={() => {
                setRegister(true);
                setError("");
              }}
            >
              {t("account.register")}
            </button>
          </div>
          <Field
            label={t("account.username")}
            hint={register ? t("account.usernameHint") : undefined}
          >
            <input
              autoComplete="username"
              dir="ltr"
              minLength={register ? 3 : undefined}
              maxLength={40}
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field
            label={t("account.password")}
            hint={register ? t("account.passwordHint") : undefined}
          >
            <input
              type="password"
              autoComplete={register ? "new-password" : "current-password"}
              minLength={register ? 10 : undefined}
              maxLength={128}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {register && (
            <>
              <Field label={t("account.displayName")}>
                <input
                  autoComplete="name"
                  maxLength={100}
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Field>
              <Notice>{t("account.noRecovery")}</Notice>
            </>
          )}
          <button className="rs-button" disabled={busy}>
            {busy
              ? t("common.loading")
              : t(register ? "account.register" : "account.login")}
          </button>
        </form>
      ) : (
        <>
          <form className="rs-form-stack" onSubmit={save}>
            <fieldset
              className="rs-form-stack rs-reset-fieldset"
              disabled={busy}
            >
              <section className="rs-panel">
                <div className="rs-section-head">
                  <h2>
                    <UserRound size={21} />
                    {t("account.profile")}
                  </h2>
                  <button
                    type="button"
                    className="rs-link-button"
                    disabled={busy}
                    onClick={logout}
                  >
                    {t("account.logout")}
                  </button>
                </div>
                <div className="rs-fields">
                  <Field label={t("account.displayName")}>
                    <input
                      autoComplete="name"
                      maxLength={100}
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                    />
                  </Field>
                  <Field label={t("order.phone")}>
                    <input
                      type="tel"
                      autoComplete="tel"
                      dir="ltr"
                      maxLength={30}
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                    />
                  </Field>
                </div>
              </section>
              <section className="rs-panel">
                <div className="rs-section-head">
                  <h2>
                    <MapPin size={21} />
                    {t("account.addresses")}
                  </h2>
                  <button
                    type="button"
                    className="rs-button rs-button-soft rs-small-button"
                    disabled={addresses.length >= 5}
                    onClick={() =>
                      setAddresses((old) => [
                        ...old,
                        { ...emptyAddress(), id: crypto.randomUUID() },
                      ])
                    }
                  >
                    <Plus size={16} />
                    {t("account.addAddress")}
                  </button>
                </div>
                {addresses.length >= 5 && (
                  <p className="rs-muted">{t("account.addressLimit")}</p>
                )}
                {addresses.map((address, index) => (
                  <div className="rs-address-editor" key={address.id ?? index}>
                    <div className="rs-section-head">
                      <h3>
                        {address.label || `${t("address.title")} ${index + 1}`}
                      </h3>
                      <button
                        type="button"
                        className="rs-link-button"
                        onClick={() =>
                          setAddresses((old) =>
                            old.filter((_, candidate) => index !== candidate),
                          )
                        }
                      >
                        {t("common.remove")}
                      </button>
                    </div>
                    {!isSaudiDeliveryAddress(address) && (
                      <Notice error>{t("errors.country_required")}</Notice>
                    )}
                    <fieldset disabled={!isSaudiDeliveryAddress(address)}>
                      <AddressFields
                        withLabel
                        value={address}
                        settings={settings}
                        onChange={(next) =>
                          setAddresses((old) =>
                            old.map((entry, candidate) =>
                              candidate === index ? next : entry,
                            ),
                          )
                        }
                      />
                    </fieldset>
                  </div>
                ))}
              </section>
              {saved && <Notice>{t("common.saved")}</Notice>}
              <button className="rs-button" disabled={busy}>
                {busy ? t("common.loading") : t("common.save")}
              </button>
            </fieldset>
          </form>
          <section className="rs-panel rs-spaced">
            <h2>
              <ClipboardList size={21} />
              {t("account.orders")}
            </h2>
            <p className="rs-muted">{t("account.orderHistoryNote")}</p>
            {!orders.length ? (
              <p className="rs-empty">{t("account.noOrders")}</p>
            ) : (
              <div className="rs-account-orders">
                {orders.map((order) => (
                  <button
                    key={order.number}
                    onClick={() =>
                      navigate(
                        `/track?order=${encodeURIComponent(order.number)}`,
                      )
                    }
                  >
                    <div>
                      <strong>
                        <bdi>{order.number}</bdi>
                      </strong>
                      <span>{date(order.createdAt)}</span>
                    </div>
                    <div>
                      <span className={`rs-status rs-status-${order.status}`}>
                        {t(`order.status.${order.status}`)}
                      </span>
                      <strong>{money(order.totalMinor, order.currency)}</strong>
                    </div>
                    <ChevronLeft size={18} className="rs-rtl-icon" />
                    <ChevronRight size={18} className="rs-ltr-icon" />
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export function Storefront() {
  const locale: L10n = useLocale();
  const { t, dir, applyDefaultLocale } = locale;
  const [rawCatalog, setCatalog] = useState<Catalog | null>(null);
  const {status: openingStatus, refresh: refreshOpening} = useOpeningStatus();
  const catalog = useMemo(() => rawCatalog ? {
    ...rawCatalog,
    settings: {...rawCatalog.settings, acceptingOrders: openingStatus?.acceptingOrders === true},
  } : null, [rawCatalog, openingStatus]);
  const [cart, setCart] = useState<OrderLineInput[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [accountReady, setAccountReady] = useState(false);
  const [table, setTable] = useState<RestaurantTable | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [path, setPath] = useState(window.location.pathname);
  const [locationKey, setLocationKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [cartChanged, setCartChanged] = useState(false);
  const { error, setError, fail } = useError();
  const loaded = useRef(false);
  useEffect(() => {
    if (catalog) applyDefaultLocale(catalog.settings.defaultLanguage);
  }, [catalog?.settings.defaultLanguage, applyDefaultLocale]);
  const navigationLocked = useRef(false);
  const setNavigationLocked = useCallback((locked: boolean) => {
    navigationLocked.current = locked;
  }, []);
  const navigationWarning = useRef(t("order.networkRetry"));
  navigationWarning.current = t("order.networkRetry");
  const navigate: Navigate = useCallback((next) => {
    if (navigationLocked.current && !window.confirm(navigationWarning.current))
      return;
    window.history.pushState({}, "", next);
    setPath(window.location.pathname);
    setLocationKey((old) => old + 1);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await storefront<Catalog>("/catalog");
      setCatalog(result);
      if (!loaded.current) {
        let raw: unknown = [];
        try {
          raw = JSON.parse(localStorage.getItem(CART_STORAGE_KEY) ?? "[]");
        } catch {
          /* Storage is optional. */
        }
        const clean = normalizeCart(raw, result);
        setCart(clean);
        if (
          Array.isArray(raw) &&
          raw.length &&
          JSON.stringify(raw) !== JSON.stringify(clean)
        )
          setCartChanged(true);
        loaded.current = true;
      } else {
        setCart((current) => normalizeCart(current, result));
      }
    } catch (error) {
      fail(error);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    void storefront<{ customer: Customer | null }>("/account")
      .then((result) => {
        setCustomer(result.customer);
        setAccountReady(true);
      })
      .catch(() => {
        // Browsing can continue; do not guess the idempotency owner of a
        // checkout while customer-session detection is unavailable.
        setError("common.error");
      });
  }, [load]);
  useEffect(() => {
    if (loaded.current) {
      try {
        localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
      } catch {
        /* Continue without persistent basket. */
      }
    }
  }, [cart]);
  useEffect(() => {
    const listener = () => {
      setPath(window.location.pathname);
      setLocationKey((old) => old + 1);
    };
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  useEffect(() => {
    let active = true;
    const raw = new URLSearchParams(window.location.search).get("table");
    if (!raw) {
      setTable(null);
      return;
    }
    const code = parseTableCode(raw, window.location.origin);
    if (!code) {
      setTable(null);
      setError("errors.table_not_found");
      return;
    }
    void storefront<RestaurantTable>(`/tables/${encodeURIComponent(code)}`)
      .then((result) => {
        if (active) setTable(result);
      })
      .catch((error) => {
        if (active) {
          setTable(null);
          fail(error);
        }
      });
    return () => {
      active = false;
    };
  }, [locationKey]);
  const quantity = useMemo(
    () => cart.reduce((sum, line) => sum + line.quantity, 0),
    [cart],
  );
  const acceptReceipt = (next: Receipt) => {
    navigationLocked.current = false;
    setReceipt(next);
    const url = new URL(
      privateTrackingURL(
        window.location.origin,
        next.order.number,
        next.trackingToken,
      ),
    );
    if (table) url.searchParams.set("table", table.code);
    navigate(url.pathname + url.search + url.hash);
  };
  return (
    <div
      className="restaurant-storefront"
      dir={dir}
      style={catalog ? brandVariables(catalog.settings) : undefined}
    >
      <header className="rs-header">
        <div className="rs-header-inner">
          <a
            className="rs-brand"
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigate("/");
            }}
          >
            <span className="rs-brand-icon">
              {safeMenuImage(catalog ? effectiveBrand(catalog.settings).logoUrl : "") ? (
                <img
                  src={safeMenuImage(catalog ? effectiveBrand(catalog.settings).logoUrl : "")}
                  alt=""
                  referrerPolicy="no-referrer"
                />
              ) : (
                <UtensilsCrossed size={23} />
              )}
            </span>
            <span>{catalog?.settings.name || t("store.menu")}</span>
          </a>
          <nav aria-label={t("store.menu")}>
            <a
              className={path === "/" ? "active" : ""}
              href="/"
              onClick={(event) => {
                event.preventDefault();
                navigate("/");
              }}
            >
              {t("store.menu")}
            </a>
            <a
              className={path === "/track" ? "active" : ""}
              href="/track"
              onClick={(event) => {
                event.preventDefault();
                setReceipt(null);
                navigate("/track");
              }}
            >
              {t("store.track")}
            </a>
          </nav>
          <div className="rs-header-actions">
            <LanguagePicker />
            <button
              className="rs-header-account"
              onClick={() => navigate("/account")}
              aria-label={t("store.account")}
            >
              <UserRound size={20} />
              <span>{t("store.account")}</span>
            </button>
            <button
              className="rs-header-cart"
              onClick={() => navigate("/order" + window.location.search)}
              aria-label={t("store.cart")}
            >
              <ShoppingBag size={20} />
              <span>{quantity}</span>
            </button>
          </div>
        </div>
      </header>
      {catalog?.settings.demo && (
        <div className="rs-demo-banner">{t("store.demo")}</div>
      )}
      <main className="rs-main">
        {error && (
          <Notice error>
            {t(error)}{" "}
            {!catalog && (
              <button className="rs-link-button" onClick={load}>
                {t("common.retry")}
              </button>
            )}
          </Notice>
        )}
        {cartChanged && (
          <Notice>
            {t("store.cartUpdated")}
            <button
              className="rs-icon-button"
              onClick={() => setCartChanged(false)}
              aria-label={t("common.close")}
            >
              <X size={16} />
            </button>
          </Notice>
        )}
        {loading && !catalog ? (
          <div className="rs-loading" role="status">
            <span className="rs-spinner" />
            {t("common.loading")}
          </div>
        ) : (
          catalog && (
            <>
              {openingStatus === null ? (
                <Notice>
                  <span>{t("store.availabilityUnknown")}</span>
                  <button type="button" className="rs-link-button" onClick={refreshOpening}>{t("common.retry")}</button>
                </Notice>
              ) : !catalog.settings.acceptingOrders ? (
                <Notice>{t("store.closed")}</Notice>
              ) : null}
              {path === "/order" && !accountReady ? (
                <div className="rs-loading">
                  <button
                    className="rs-button"
                    onClick={() => window.location.reload()}
                  >
                    {t("common.retry")}
                  </button>
                </div>
              ) : path === "/order" ? (
                <CheckoutPage
                  key={`checkout-${locationKey}`}
                  catalog={catalog}
                  cart={cart}
                  setCart={setCart}
                  customer={customer}
                  table={table}
                  navigate={navigate}
                  onReceipt={acceptReceipt}
                  refreshCatalog={load}
                  onSubmissionStateChange={setNavigationLocked}
                  onSessionExpired={() => setCustomer(null)}
                />
              ) : path === "/track" ? (
                <TrackPage
                  key={`track-${locationKey}`}
                  customerId={customer?.id ?? ""}
                  initialReceipt={
                    receipt &&
                    receipt.order.number ===
                      new URLSearchParams(window.location.search).get("order")
                      ? receipt
                      : null
                  }
                  table={table}
                  navigate={navigate}
                />
              ) : path === "/account" ? (
                <AccountPage
                  customer={customer}
                  settings={catalog.settings}
                  setCustomer={(value) => {
                    setCustomer(value);
                    setAccountReady(true);
                  }}
                  navigate={navigate}
                />
              ) : (
                <MenuPage
                  catalog={catalog}
                  cart={cart}
                  setCart={setCart}
                  navigate={navigate}
                  table={table}
                />
              )}
            </>
          )
        )}
      </main>
      <footer className="rs-footer">
        <div className="rs-brand">
          <UtensilsCrossed size={18} />
          <span>{catalog?.settings.name || t("store.menu")}</span>
        </div>
        {catalog?.settings.phone && (
          <a
            href={`tel:${catalog.settings.phone.replace(/[^+\d]/g, "")}`}
            dir="ltr"
          >
            {catalog.settings.phone}
          </a>
        )}
      </footer>
    </div>
  );
}

export default Storefront;
