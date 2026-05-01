"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Map as MapIcon, Users, AlertCircle, Loader2 } from "lucide-react";

/**
 * Live server map. Talks to a dynmap (or compatible) HTTP server
 * running inside the Minecraft container, via the panel-API proxy at
 * /servers/:id/map/*. Renders the world's map tiles in a Leaflet view
 * styled to match the panel, and overlays player markers built from
 * dynmap's player JSON + crafatar's skin-face renderer.
 *
 * Architecture:
 *   1. Fetch /standalone/dynmap_config.json for the world/map list.
 *   2. Build a Leaflet view using L.CRS.Simple. Each map gets a
 *      custom Leaflet TileLayer subclass that knows how to translate
 *      Leaflet tile coords into the dynmap tile-name convention
 *      (`{prefix}/<scaledx>_<scaledy>/<zoom>_<x>_<y>.png`).
 *   3. Poll /standalone/dynmap_<world>.json every 2 s for live
 *      player positions.
 *   4. Each online player becomes a divIcon marker showing their
 *      crafatar 3D-head avatar.
 *
 * Dynmap not installed → fall back to a stub with install hint.
 */

// --- Types matching dynmap's JSON schema ---

type MapEntry = {
  name: string;
  title: string;
  prefix: string;
  type: string;
  /** 3×3 "world to map" matrix flattened; first 3 entries are X
   *  (lng), next 3 Y (skipped for the projection), last 3 Z (lat).
   *  Pulled straight from dynmap's HDMapType.fromLocationToLatLng. */
  worldtomap?: number[];
  maptoworld?: number[];
  mapzoomin?: number;
  mapzoomout?: number;
  tilescale?: number;
  "image-format"?: string;
  nightandday?: boolean;
  compassview?: string;
};

type WorldEntry = {
  name: string;
  title: string;
  center: { x: number; y: number; z: number };
  maps: MapEntry[];
  extrazoomout?: number;
};

type DynmapConfig = {
  defaultworld?: string;
  defaultmap?: string;
  worlds: WorldEntry[];
};

type DynmapPlayer = {
  type: string;
  name: string;
  account: string;
  world: string;
  x: number;
  y: number;
  z: number;
  health?: number;
  armor?: number;
  uuid?: string;
};

type DynmapWorldUpdate = {
  servertime: number;
  hasStorm: boolean;
  isThundering: boolean;
  players: DynmapPlayer[];
};

const TILE_SIZE = 128; // dynmap default
const POLL_INTERVAL = 2000;

export function ServerMap({ serverId }: { serverId: string }): JSX.Element {
  // --- Configuration fetch ---
  const {
    data: configData,
    error: configError,
    isLoading: configLoading,
  } = useSWR<DynmapConfig>(
    `/servers/${serverId}/map/standalone/dynmap_config.json`,
    fetcher,
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    }
  );

  if (configLoading) {
    return (
      <div className="tile p-12 text-center">
        <Loader2 className="mx-auto animate-spin text-ink-muted" size={28} />
        <div className="mt-3 text-sm text-ink-muted">
          Connecting to dynmap…
        </div>
      </div>
    );
  }

  if (configError || !configData) {
    return <DynmapMissingNotice />;
  }

  if (!configData.worlds || configData.worlds.length === 0) {
    return (
      <div className="tile p-10 text-center text-ink-muted">
        Dynmap is running, but it hasn't generated any world maps yet.
        Wait for it to finish the initial render.
      </div>
    );
  }

  return <MapView serverId={serverId} config={configData} />;
}

// ============================== MAP VIEW ==============================

function MapView({
  serverId,
  config,
}: {
  serverId: string;
  config: DynmapConfig;
}): JSX.Element {
  // --- World + map selection ---
  const [worldIdx, setWorldIdx] = useState(() => {
    if (config.defaultworld) {
      const i = config.worlds.findIndex((w) => w.name === config.defaultworld);
      if (i >= 0) return i;
    }
    return 0;
  });
  const world = config.worlds[worldIdx]!;
  const [mapIdx, setMapIdx] = useState(() => {
    if (config.defaultmap) {
      const i = world.maps.findIndex((m) => m.name === config.defaultmap);
      if (i >= 0) return i;
    }
    return 0;
  });
  // Reset map selection when the world changes.
  useEffect(() => {
    setMapIdx(0);
  }, [worldIdx]);
  const mapEntry = world.maps[mapIdx];

  // --- Live player feed ---
  const { data: liveData } = useSWR<DynmapWorldUpdate>(
    `/servers/${serverId}/map/standalone/dynmap_${world.name}.json`,
    fetcher,
    {
      refreshInterval: POLL_INTERVAL,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    }
  );

  // --- Leaflet bootstrap ---
  const containerRef = useRef<HTMLDivElement | null>(null);
  const leafletRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const projectionRef = useRef<((p: DynmapPlayer) => L.LatLng) | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !mapEntry) return;
    const proj = makeProjection(mapEntry);
    projectionRef.current = proj;

    const m = L.map(el, {
      crs: L.CRS.Simple,
      minZoom: 0,
      // dynmap counts zoom outward from `mapzoomout` (zoomed all the
      // way out) to `mapzoomin` (zoomed all the way in). Our Leaflet
      // map uses 0…(mapzoomin+mapzoomout) the same way the dynmap
      // client does — see HDMapType.initialize.
      maxZoom: (mapEntry.mapzoomin ?? 2) + (mapEntry.mapzoomout ?? 0),
      zoomSnap: 1,
      zoomControl: true,
      attributionControl: false,
      zoomDelta: 1,
      preferCanvas: false,
    });

    const center = projectWorldToLatLng(mapEntry, world.center.x, world.center.z);
    m.setView(center, mapEntry.mapzoomout ?? 0);

    const tile = makeTileLayer(serverId, world.name, mapEntry);
    tile.addTo(m);
    tileLayerRef.current = tile;

    markerLayerRef.current = L.layerGroup().addTo(m);
    leafletRef.current = m;
    return () => {
      m.remove();
      leafletRef.current = null;
      tileLayerRef.current = null;
      markerLayerRef.current = null;
      projectionRef.current = null;
    };
  }, [serverId, world.name, mapEntry, world.center.x, world.center.z]);

  // --- Player marker updates ---
  useEffect(() => {
    const layer = markerLayerRef.current;
    const proj = projectionRef.current;
    if (!layer || !proj || !liveData) return;
    layer.clearLayers();
    for (const p of liveData.players) {
      // Only show players in the world we're currently viewing.
      // Other-world players still appear in the side panel below.
      if (p.world !== world.name) continue;
      const latlng = proj(p);
      const marker = L.marker(latlng, {
        icon: makePlayerIcon(p),
        keyboard: false,
        title: p.name,
      });
      marker.bindTooltip(
        `<div class="text-xs"><b>${escapeHtml(p.name)}</b><br>` +
          `<span class="opacity-70">${formatCoord(p.x)}, ${formatCoord(p.y)}, ${formatCoord(p.z)}</span></div>`,
        { direction: "top", offset: [0, -16] }
      );
      marker.addTo(layer);
    }
  }, [liveData, world.name]);

  // --- UI ---
  const onlinePlayers = liveData?.players ?? [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
      <div className="space-y-3">
        {/* Toolbar: world / map switcher */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <MapIcon size={14} className="text-ink-muted" />
            <span className="text-xs text-ink-muted">World</span>
            <select
              className="select !py-1.5 !text-sm"
              value={worldIdx}
              onChange={(e) => setWorldIdx(Number(e.target.value))}
            >
              {config.worlds.map((w, i) => (
                <option key={w.name} value={i}>
                  {w.title || w.name}
                </option>
              ))}
            </select>
          </div>
          {world.maps.length > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-muted">Map</span>
              <select
                className="select !py-1.5 !text-sm"
                value={mapIdx}
                onChange={(e) => setMapIdx(Number(e.target.value))}
              >
                {world.maps.map((m, i) => (
                  <option key={m.name} value={i}>
                    {m.title || m.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="flex-1" />
          <div className="text-xs text-ink-muted">
            {liveData ? (
              <>
                Server time: {Math.floor(liveData.servertime)}
                {liveData.hasStorm && " · ⛈️"}
                {liveData.isThundering && " · ⚡"}
              </>
            ) : (
              <Loader2 size={11} className="animate-spin inline mr-1" />
            )}
          </div>
        </div>

        <div
          ref={containerRef}
          className="w-full rounded-lg overflow-hidden border border-line bg-surface-2"
          style={{ height: "560px" }}
        />
      </div>

      {/* Side panel: live player list */}
      <aside className="tile p-4 self-start lg:sticky lg:top-20">
        <header className="flex items-center gap-2 mb-3">
          <Users size={14} className="text-ink-muted" />
          <h3 className="text-sm font-medium">Players online</h3>
          <span className="ml-auto text-[11px] text-ink-muted tabular-nums">
            {onlinePlayers.length}
          </span>
        </header>
        {onlinePlayers.length === 0 ? (
          <p className="text-xs text-ink-muted py-4 text-center">
            No players online
          </p>
        ) : (
          <ul className="space-y-1.5">
            {onlinePlayers.map((p) => (
              <li
                key={p.account}
                className={cn(
                  "flex items-center gap-2.5 rounded-md p-2 text-sm transition-colors",
                  p.world === world.name
                    ? "bg-surface-2 hover:bg-surface-3"
                    : "opacity-60 hover:opacity-90"
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={crafatarUrl(p.account)}
                  alt=""
                  width={28}
                  height={28}
                  className="rounded-md shrink-0"
                  style={{ imageRendering: "pixelated" }}
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-[10px] text-ink-muted tabular-nums truncate">
                    {p.world !== world.name ? `${p.world} · ` : ""}
                    {formatCoord(p.x)}, {formatCoord(p.y)}, {formatCoord(p.z)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

// ============================== HELPERS ==============================

/**
 * Build a worldcoord → LatLng projector, mirroring dynmap's
 * HDProjection.fromLocationToLatLng. We only need the L→LatLng
 * direction for marker placement; tile layout is handled inside
 * `makeTileLayer`.
 */
function makeProjection(
  m: MapEntry
): (p: { x: number; y: number; z: number }) => L.LatLng {
  return (p) => projectWorldToLatLng(m, p.x, p.z, p.y);
}

function projectWorldToLatLng(
  m: MapEntry,
  x: number,
  z: number,
  y = 64
): L.LatLng {
  const wtp = m.worldtomap ?? [0, 0, 1, -1, 0, 0, 0, 0, 0];
  // Sane defaults for a north-up flat map if `worldtomap` is missing
  // — we'll still place markers in the right ballpark.
  const tilescale = m.tilescale ?? 0;
  const mapzoomout = m.mapzoomout ?? 0;
  const lat = wtp[3]! * x + wtp[4]! * y + wtp[5]! * z;
  const lng = wtp[0]! * x + wtp[1]! * y + wtp[2]! * z;
  const denom = 1 << mapzoomout;
  const tileBlocks = TILE_SIZE << tilescale;
  return L.latLng(-((tileBlocks - lat) / denom), lng / denom);
}

/**
 * Custom Leaflet TileLayer that builds dynmap-style tile URLs:
 *   {prefix}{nightday}/{scaledx}_{scaledy}/{zoom}{x}_{y}.{fmt}
 *
 * Y is inverted vs. Leaflet because dynmap counts tiles upward from
 * the equator (south is positive Z, but Leaflet draws south as
 * positive Y).
 */
function makeTileLayer(
  serverId: string,
  worldName: string,
  m: MapEntry
): L.TileLayer {
  const fmt = m["image-format"] ?? "png";
  const mapzoomin = m.mapzoomin ?? 2;
  const mapzoomout = m.mapzoomout ?? 0;
  const tilescale = m.tilescale ?? 0;
  const baseUrl = `/api/servers/${encodeURIComponent(
    serverId
  )}/map/tiles/${encodeURIComponent(worldName)}/`;

  const Layer = L.TileLayer.extend({
    getTileUrl(coords: L.Coords) {
      const izoom = (this as any)._getZoomForUrl();
      const zoomout = Math.max(0, izoom - mapzoomin);
      const scale = 1 << zoomout;
      const x = scale * coords.x;
      const y = -scale * coords.y; // dynmap inverts Y for HD-style maps
      const scaledx = x >> 5;
      const scaledy = y >> 5;
      const zoomprefix = zoomout === 0 ? "" : `${"z".repeat(zoomout)}_`;
      return (
        `${baseUrl}${m.prefix}/${scaledx}_${scaledy}/${zoomprefix}${x}_${y}.${fmt}`
      );
    },
  });
  return new (Layer as any)({
    tileSize: TILE_SIZE << tilescale,
    minZoom: 0,
    maxZoom: mapzoomin + mapzoomout,
    maxNativeZoom: mapzoomout,
    noWrap: true,
    errorTileUrl: blankPng(),
    keepBuffer: 1,
  });
}

/**
 * 1×1 transparent PNG, used as the dead-tile fallback so missing
 * tiles don't show the broken-image icon.
 */
function blankPng(): string {
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";
}

/**
 * Build the player marker icon — a divIcon with the player's
 * crafatar 3D-head, framed in an accent border, tiny pixel-art feel.
 * Crafatar is a community proxy that renders /avatars/<uuid> from
 * Mojang's session servers — works without an API key.
 */
function makePlayerIcon(p: DynmapPlayer): L.DivIcon {
  const url = crafatarUrl(p.account, 32);
  const html = `
    <div class="player-marker">
      <img src="${url}" alt="" />
      <span class="player-marker-name">${escapeHtml(p.name)}</span>
    </div>
  `;
  return L.divIcon({
    className: "",
    html,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

/**
 * Crafatar is a well-known free Minecraft skin proxy. Accepts both
 * username and UUID; we use username because dynmap's `account`
 * field is the canonical Minecraft username.
 */
function crafatarUrl(account: string, size = 32): string {
  // mc-heads.net is more lenient with non-Mojang servers (offline-
  // mode players still get a default Steve head) and serves the
  // 3D-head perspective with built-in caching. Falls back to Steve
  // automatically when the username can't be resolved.
  return `https://mc-heads.net/avatar/${encodeURIComponent(account)}/${size}`;
}

function formatCoord(v: number): string {
  return Math.round(v).toString();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================== STUBS ==============================

function DynmapMissingNotice(): JSX.Element {
  return (
    <div className="tile p-10 text-center max-w-2xl mx-auto">
      <span className="inline-grid place-items-center w-12 h-12 rounded-full bg-[rgb(var(--warning-soft))] text-[rgb(var(--warning))] mx-auto">
        <AlertCircle size={22} />
      </span>
      <h3 className="heading-md mt-3">Dynmap is not running</h3>
      <p className="text-sm text-ink-secondary mt-2 max-w-md mx-auto leading-relaxed">
        The live map needs the dynmap plugin / mod installed on this
        server, listening on its default port <code className="kbd">8123</code>.
        Install it from the Content tab (search «dynmap»), then come
        back — the map starts rendering automatically.
      </p>
    </div>
  );
}
