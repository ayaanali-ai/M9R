import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The one button. Styling lives in `.ol-btn` (globals.css) so existing markup that already uses those
 * classes and this component render identically; new buttons should use this instead of hand-rolling
 * class strings. `primary` is the single brand accent (at most one per view), `danger` belongs inside
 * `.ol-destructive-zone`.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Shows a spinner, sets aria-busy and blocks activation while an async action runs. */
  loading?: boolean;
  children: ReactNode;
}

export function buttonClassName(variant: ButtonVariant = "secondary", size: "sm" | "md" = "md", extra?: string): string {
  return ["ol-btn", `ol-btn--${variant}`, size === "sm" ? "ol-btn--sm" : "", extra ?? ""].filter(Boolean).join(" ");
}

export function Button({ variant = "secondary", size = "md", loading = false, className, disabled, type = "button", children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={buttonClassName(variant, size, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="ol-btn__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> {
  /** Required: an icon-only control has no other accessible name. */
  label: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  loading?: boolean;
  children: ReactNode;
}

export function IconButton({ label, variant = "ghost", size = "sm", loading = false, className, disabled, type = "button", children, ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      className={buttonClassName(variant, size, ["ol-btn--icon", className].filter(Boolean).join(" "))}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="ol-btn__spinner" aria-hidden="true" /> : children}
    </button>
  );
}
