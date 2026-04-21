import {
  Sprout,
  Layers,
  Gem,
  Hammer,
  Flame,
  Ghost,
  Grid3x3,
  ScrollText,
  Package,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { ModrinthMark, CurseForgeMark } from "./brand-icons";

/**
 * Metadata for each supported Minecraft server type/source. The UI uses
 * this to render consistent iconography + brand-like gradients. Colours
 * are picked to evoke the real project palette without pretending to be
 * their official mark.
 */
export type ServerTypeKey =
  | "VANILLA"
  | "PAPER"
  | "PURPUR"
  | "FABRIC"
  | "FORGE"
  | "NEOFORGE"
  | "MOHIST"
  | "QUILT"
  | "MODRINTH"
  | "CURSEFORGE";

interface Meta {
  label: string;
  description: string;
  from: string;
  to: string;
  Icon: LucideIcon | React.FC<{ size?: number; className?: string }>;
  isSource?: boolean;
}

export const SERVER_TYPE_META: Record<ServerTypeKey, Meta> = {
  VANILLA: {
    label: "Vanilla",
    description: "Mojang's official server. No mods, no plugins.",
    from: "#14532d",
    to: "#22c55e",
    Icon: Sprout,
  },
  PAPER: {
    label: "Paper",
    description: "High-performance Bukkit fork. Best for plugins.",
    from: "#1e293b",
    to: "#94a3b8",
    Icon: ScrollText,
  },
  PURPUR: {
    label: "Purpur",
    description: "Paper fork with extra gameplay-tuning features.",
    from: "#3b0764",
    to: "#a855f7",
    Icon: Gem,
  },
  FABRIC: {
    label: "Fabric",
    description: "Lightweight mod loader; fast-moving, modern.",
    from: "#713f12",
    to: "#fbbf24",
    Icon: Layers,
  },
  FORGE: {
    label: "Forge",
    description: "Classic mod loader; widest mod library.",
    from: "#1f2937",
    to: "#64748b",
    Icon: Hammer,
  },
  NEOFORGE: {
    label: "NeoForge",
    description: "Actively maintained Forge fork.",
    from: "#451a03",
    to: "#f97316",
    Icon: Flame,
  },
  MOHIST: {
    label: "Mohist",
    description: "Forge + Bukkit hybrid — mods and plugins together.",
    from: "#450a0a",
    to: "#ef4444",
    Icon: Ghost,
  },
  QUILT: {
    label: "Quilt",
    description: "Fabric-compatible fork with extra APIs.",
    from: "#78350f",
    to: "#f59e0b",
    Icon: Grid3x3,
  },
  MODRINTH: {
    label: "Modrinth pack",
    description: "Import a modpack from Modrinth — server detects loader + version automatically.",
    from: "#064e3b",
    to: "#1bd96a",
    Icon: ModrinthMark,
    isSource: true,
  },
  CURSEFORGE: {
    label: "CurseForge pack",
    description: "Import a modpack from CurseForge. Requires API key in Integrations.",
    from: "#7c2d12",
    to: "#f59e0b",
    Icon: CurseForgeMark,
    isSource: true,
  },
};

export function getServerMeta(type: string): Meta {
  return (
    SERVER_TYPE_META[type as ServerTypeKey] ?? {
      label: type,
      description: "Custom runtime",
      from: "#0f172a",
      to: "#475569",
      Icon: Package,
    }
  );
}

/**
 * Square server-type icon with gradient background + glyph. Used as the
 * server tile hero, on the server detail header, and in the wizard.
 */
export function ServerTypeIcon({
  type,
  size = 56,
  className,
}: {
  type: string;
  size?: number;
  className?: string;
}): JSX.Element {
  const meta = getServerMeta(type);
  const Icon = meta.Icon;
  const iconSize = Math.max(14, Math.floor(size * 0.45));
  return (
    <span
      className={cn(
        "relative grid place-items-center text-white shrink-0 overflow-hidden",
        className
      )}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(6, size * 0.18),
        background: `linear-gradient(135deg, ${meta.from}, ${meta.to})`,
        boxShadow: `inset 0 1px 0 rgb(255 255 255 / 0.14), 0 1px 2px rgb(0 0 0 / 0.15)`,
      }}
      aria-hidden="true"
    >
      <Icon size={iconSize} />
      <span className="absolute inset-0 bg-grid-pattern opacity-20 pointer-events-none" />
    </span>
  );
}

/** Large hero banner used on server cards and detail pages. */
export function ServerTypeHero({
  type,
  glyphSize = 90,
  height = 144,
  children,
}: {
  type: string;
  glyphSize?: number;
  height?: number;
  children?: React.ReactNode;
}): JSX.Element {
  const meta = getServerMeta(type);
  const Icon = meta.Icon;
  return (
    <div
      className="relative flex items-center justify-center text-white overflow-hidden"
      style={{
        height,
        background: `linear-gradient(135deg, ${meta.from}, ${meta.to})`,
      }}
    >
      <span className="absolute inset-0 bg-grid-pattern opacity-25" />
      <Icon size={glyphSize} className="relative opacity-90" strokeWidth={1.5} />
      {children}
    </div>
  );
}

export function useServerTypes() {
  return SERVER_TYPE_META;
}
