import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

interface Breadcrumb {
  label: string;
  href?: string;
}

/**
 * Page header used across the app. Optional breadcrumbs, title, supporting
 * description, and right-aligned actions slot. Keeps every page visually
 * aligned without each one reinventing the layout.
 */
export function PageHeader({
  breadcrumbs,
  title,
  description,
  badge,
  actions,
}: {
  breadcrumbs?: Breadcrumb[];
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="pb-8">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="flex items-center gap-1 text-xs text-ink-muted mb-3">
          {breadcrumbs.map((b, i) => (
            <span key={i} className="flex items-center gap-1">
              {b.href ? (
                <Link
                  href={b.href}
                  className="hover:text-ink transition-colors"
                >
                  {b.label}
                </Link>
              ) : (
                <span>{b.label}</span>
              )}
              {i < breadcrumbs.length - 1 && (
                <ChevronRight size={12} className="opacity-60" />
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="heading-xl">{title}</h1>
            {badge}
          </div>
          {description && (
            <p className="text-ink-secondary max-w-2xl">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        )}
      </div>
    </header>
  );
}
