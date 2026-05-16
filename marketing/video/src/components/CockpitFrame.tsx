import React from "react";
import { AbsoluteFill } from "remotion";
import { tokens, fonts } from "../tokens";

/**
 * The cockpit canvas — what every scene composites on top of.
 * Renders the navy void, the left rail outline, the stage head bar, and
 * the bottom composer strip. Scenes render their content inside <Stage/>.
 */

export const CockpitFrame: React.FC<{
  routeTitle: string;
  showLimeLine?: boolean; // true during slice-stop motion
  limeLineProgress?: number; // 0..1 controls trace position
  children: React.ReactNode;
}> = ({ routeTitle, showLimeLine = false, limeLineProgress = 0, children }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: tokens.bg0, fontFamily: fonts.sans }}>
      {/* Slice-stop signature line at the very top */}
      <SliceLine show={showLimeLine} progress={limeLineProgress} />

      {/* Layout: rail + stage */}
      <div style={{ display: "flex", flex: 1, position: "relative" }}>
        <Rail />
        <Stage routeTitle={routeTitle}>{children}</Stage>
      </div>
    </AbsoluteFill>
  );
};

const SliceLine: React.FC<{ show: boolean; progress: number }> = ({ show, progress }) => {
  if (!show) return null;
  // The line traces left → right, ~30 % wide, with a soft glow underneath.
  // progress 0..1 maps the line center across viewport 0..100 % left position.
  const widthPct = 30;
  const center = progress * 100;
  const left = Math.max(0, Math.min(100 - widthPct, center - widthPct / 2));
  const opacity = progress < 0.1 ? progress * 10 : progress > 0.9 ? (1 - progress) * 10 : 1;
  return (
    <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 4, zIndex: 80 }}>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: `${left}%`,
          width: `${widthPct}%`,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${tokens.accent}, transparent)`,
          opacity,
          filter: "blur(3px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: `${left}%`,
          width: `${widthPct}%`,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${tokens.accent}, transparent)`,
          opacity,
        }}
      />
    </div>
  );
};

const Rail: React.FC = () => {
  return (
    <aside
      style={{
        width: 280,
        background: tokens.bg1,
        borderRight: `1px solid ${tokens.lineSoft}`,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Brand mark */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "24px 22px 22px",
          borderBottom: `1px solid ${tokens.lineSoft}`,
        }}
      >
        <div
          style={{ width: 26, height: 26, borderRadius: 4, background: tokens.brand }}
        />
        <span style={{ fontFamily: fonts.cond, fontWeight: 600, color: tokens.fg0, fontSize: 16, letterSpacing: "0.05em" }}>
          MÁDDU
        </span>
      </div>

      <RailGroup label="◆  DECIDE" active>
        <RailLink glyph="◆" glyphColor={tokens.accent2} label="CONDUCTOR" active />
        <RailLink glyph="◆" glyphColor={tokens.accent2} label="BOSS" />
        <RailLink glyph="◇" glyphColor={tokens.fg4} label="QUEUE" />
        <RailLink glyph="◇" glyphColor={tokens.fg4} label="CLAIMS" />
        <RailLink glyph="◇" glyphColor={tokens.fg4} label="APPROVALS" badge="3" />
      </RailGroup>

      <RailGroup label="◈  OPERATE">
        <RailLink glyph="◆" glyphColor={tokens.accent2} label="WORKFLOWS" />
        <RailLink glyph="◇" glyphColor={tokens.fg4} label="AGENTS" />
        <RailLink glyph="◇" glyphColor={tokens.fg4} label="TEAMS" />
      </RailGroup>

      <RailGroup label="⌬  VERIFY">
        <RailLink glyph="◆" glyphColor={tokens.accent2} label="LEARNING" />
        <RailLink glyph="◆" glyphColor={tokens.accent2} label="WIKI" />
        <RailLink glyph="◇" glyphColor={tokens.fg4} label="EVENTS" />
      </RailGroup>

      {/* Rail foot */}
      <div
        style={{
          marginTop: "auto",
          borderTop: `1px solid ${tokens.lineSoft}`,
          padding: "16px 22px 20px",
          fontFamily: fonts.mono,
          fontSize: 11,
          color: tokens.fg3,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <Row label="BRIDGE" value="● online" valueColor={tokens.signal} />
        <Row label="VERSION" value="v0.12.0" />
        <Row label="UPTIME" value="2h 14m" />
      </div>
    </aside>
  );
};

const RailGroup: React.FC<{
  label: string;
  active?: boolean;
  children: React.ReactNode;
}> = ({ label, active = false, children }) => (
  <div style={{ padding: "12px 12px 4px", display: "flex", flexDirection: "column", gap: 2 }}>
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "3px 1fr auto",
        gap: 8,
        alignItems: "center",
        padding: "10px 12px 6px",
      }}
    >
      <div style={{ width: 2, height: 10, background: active ? tokens.accent : "transparent", borderRadius: 1 }} />
      <span
        style={{
          fontFamily: fonts.cond,
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: active ? tokens.fg1 : tokens.fg3,
        }}
      >
        {label}
      </span>
      <span style={{ fontFamily: fonts.mono, fontSize: 11, color: tokens.fg4 }}>⌄</span>
    </div>
    {children}
  </div>
);

const RailLink: React.FC<{
  glyph: string;
  glyphColor: string;
  label: string;
  active?: boolean;
  badge?: string;
}> = ({ glyph, glyphColor, label, active = false, badge }) => (
  <div
    style={{
      display: "grid",
      gridTemplateColumns: "2px 22px 1fr auto",
      alignItems: "center",
      gap: 8,
      padding: "8px 12px",
      background: active ? tokens.bg3 : "transparent",
      borderRadius: 2,
      position: "relative",
    }}
  >
    <div style={{ width: 2, height: 28, background: active ? tokens.accent : "transparent" }} />
    <span style={{ fontFamily: fonts.mono, fontSize: 13, color: active ? tokens.accent : glyphColor, textAlign: "center" }}>
      {glyph}
    </span>
    <span
      style={{
        fontFamily: fonts.cond,
        fontWeight: active ? 600 : 400,
        fontSize: 12.5,
        letterSpacing: "0.05em",
        color: active ? tokens.fg0 : tokens.fg2,
      }}
    >
      {label}
    </span>
    {badge && (
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 10,
          background: tokens.warn,
          color: tokens.bg0,
          padding: "1px 7px",
          borderRadius: 8,
          minWidth: 18,
          textAlign: "center",
        }}
      >
        {badge}
      </span>
    )}
  </div>
);

const Row: React.FC<{ label: string; value: string; valueColor?: string }> = ({ label, value, valueColor }) => (
  <div style={{ display: "flex", justifyContent: "space-between" }}>
    <span style={{ color: tokens.fg4, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
    <span style={{ color: valueColor || tokens.fg1 }}>{value}</span>
  </div>
);

const Stage: React.FC<{ routeTitle: string; children: React.ReactNode }> = ({ routeTitle, children }) => (
  <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
    {/* Stage head */}
    <header
      style={{
        height: 64,
        borderBottom: `1px solid ${tokens.lineSoft}`,
        display: "flex",
        alignItems: "center",
        padding: "0 40px",
        gap: 12,
      }}
    >
      <span style={{ fontFamily: fonts.mono, fontSize: 16, color: tokens.accent }}>◈</span>
      <span style={{ fontFamily: fonts.cond, fontWeight: 600, fontSize: 22, color: tokens.fg0, letterSpacing: "0.04em" }}>
        {routeTitle}
      </span>
      <span style={{ marginLeft: "auto", fontFamily: fonts.mono, fontSize: 11, color: tokens.fg3 }}>
        {routeTitle}
      </span>
    </header>
    {/* Body */}
    <section style={{ flex: 1, padding: 40, overflow: "hidden", position: "relative" }}>
      {children}
    </section>
    {/* Composer */}
    <footer
      style={{
        height: 64,
        padding: "12px 40px",
        borderTop: `1px solid ${tokens.lineSoft}`,
        display: "flex",
        alignItems: "center",
      }}
    >
      <div
        style={{
          flex: 1,
          height: 40,
          background: tokens.bg1,
          border: `1px solid ${tokens.line}`,
          borderRadius: 4,
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "0 16px",
        }}
      >
        <span style={{ fontFamily: fonts.mono, color: tokens.accent, fontSize: 14 }}>▸</span>
        <span style={{ fontFamily: fonts.mono, color: tokens.fg3, fontSize: 12 }}>
          /  to issue a slash-command  ·  Ctrl + K for the palette
        </span>
      </div>
    </footer>
  </main>
);
