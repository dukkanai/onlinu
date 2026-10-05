import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { currencyMinorDigits, useLocale } from "../i18n";
import { formatMinorInput, parseMinor } from "./helpers";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  const controlID = `${id}-control`, labelID = `${id}-label`, hintID = `${id}-hint`;
  // A field can wrap a native control in an icon container. Keep the visible
  // label and hint separate from the control's content, including select options.
  const associate = (nodes: ReactNode): ReactNode => Children.map(nodes, child => {
    if (!isValidElement<{ children?: ReactNode; "aria-describedby"?: string }>(child)) return child;
    if (typeof child.type === "string" && ["input", "select", "textarea"].includes(child.type)) {
      return cloneElement(child, {
        ...{ id: controlID, "aria-labelledby": labelID },
        "aria-describedby": [child.props["aria-describedby"], hint ? hintID : ""].filter(Boolean).join(" ") || undefined,
      });
    }
    return child.props.children ? cloneElement(child, { children: associate(child.props.children) }) : child;
  });
  return <div className="ra-field"><label id={labelID} htmlFor={controlID}>{label}</label>{associate(children)}{hint && <small id={hintID}>{hint}</small>}</div>;
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="ra-check"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>;
}

export function MoneyInput({ value, currency, onChange, label }: { value: number; currency: string; onChange: (minor: number) => void; label: string }) {
  const { t } = useLocale();
  const digits = currencyMinorDigits(currency);
  const [text, setText] = useState(() => formatMinorInput(value, digits));
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const emitted = useRef({ value, digits });
  useEffect(() => {
    if (value !== emitted.current.value || digits !== emitted.current.digits) {
      setText(formatMinorInput(value, digits)); setInvalid(false); emitted.current = { value, digits };
      input.current?.setCustomValidity("");
    }
  }, [value, digits]);
  return <Field label={label} hint={t("admin.priceHint", { currency })}>
    <input ref={input} type="text" dir="ltr" inputMode="decimal" value={text} aria-invalid={invalid} required
      onChange={event => {
        const raw = event.target.value;
        setText(raw);
        const minor = parseMinor(raw, digits);
        setInvalid(minor === null);
        event.target.setCustomValidity(minor === null ? t("admin.validation") : "");
        if (minor !== null) { emitted.current = { value: minor, digits }; onChange(minor); }
      }}
      onBlur={event => {
        const minor = parseMinor(event.target.value, digits);
        if (minor !== null) { onChange(minor); setText(formatMinorInput(minor, digits)); }
      }} />
  </Field>;
}
