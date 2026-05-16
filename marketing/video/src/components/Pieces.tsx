import React from "react";
import { tokens, fonts, panel as panelChrome } from "../tokens";

/**
 * Stage-content pieces — composable in any scene. Each one is a faithful
 * port of the cockpit's component CSS to inline styles.
 */

export const Panel: React.FC<{
  title?: string;
  aside?: string;
  borderColor?: string;
  background?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}> = ({ title, aside, borderColor, background, style, children }) => (
  <div
    style={{
      background: background || tokens.bg1,
      border: `${panelChrome.borderWidth}px solid ${borderColor || panelChrome.borderColor}`,
      borderRadius: panelChrome.radius,
      padding: 18,
      ...style,
    }}
  >
    {(title || aside) && (
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 }}>
        {title && (
          <span
            style={{
              fontFamily: fonts.cond,
              fontWeight: 600,
              fontSize: 13,
              color: tokens.fg0,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            {title}
          </span>
        )}
        {aside && (
          <span style={{ fontFamily: fonts.mono, fontSize: 10, color: tokens.fg3 }}>{aside}</span>
        )}
      </div>
    )}
    {children}
  </div>
);

export const KpiTile: React.FC<{
  value: string;
  label: string;
  sub?: string;
  tone?: "accent" | "blue" | "warn" | "ok";
}> = ({ value, label, sub, tone = "accent" }) => {
  const toneColor = {
    accent: tokens.accent,
    blue: tokens.accent2,
    warn: tokens.warn,
    ok: tokens.ok,
  }[tone];
  return (
    <div
      style={{
        flex: 1,
        background: tokens.bg1,
        border: `1px solid ${toneColor}`,
        borderRadius: 8,
        padding: "18px 20px",
      }}
    >
      <div style={{ fontFamily: fonts.cond, fontWeight: 600, fontSize: 36, color: toneColor, lineHeight: 1.1 }}>
        {value}
      </div>
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 10,
          color: tokens.fg3,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          marginTop: 8,
        }}
      >
        {label}
      </div>
      {sub && (
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: tokens.fg2, marginTop: 4 }}>{sub}</div>
      )}
    </div>
  );
};

export const KpiStrip: React.FC<{ tiles: Array<React.ComponentProps<typeof KpiTile>>; style?: React.CSSProperties }> = ({
  tiles,
  style,
}) => (
  <div style={{ display: "flex", gap: 16, ...style }}>
    {tiles.map((t, i) => (
      <KpiTile key={i} {...t} />
    ))}
  </div>
);

export const Pill: React.FC<{
  tone: "accent" | "blue" | "warn" | "ok" | "danger";
  children: React.ReactNode;
}> = ({ tone, children }) => {
  const toneColor = {
    accent: tokens.accent,
    blue: tokens.accent2,
    warn: tokens.warn,
    ok: tokens.ok,
    danger: tokens.danger,
  }[tone];
  const bg = {
    accent: "rgba(208,255,0,0.10)",
    blue: "rgba(86,184,255,0.10)",
    warn: "rgba(242,189,92,0.10)",
    ok: "rgba(111,168,162,0.10)",
    danger: "rgba(255,94,122,0.10)",
  }[tone];
  return (
    <span
      style={{
        fontFamily: fonts.mono,
        fontSize: 9,
        color: toneColor,
        background: bg,
        border: `0.7px solid ${toneColor}`,
        borderRadius: 2,
        padding: "2px 8px",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
};

export const NextCommand: React.FC<{ text: React.ReactNode; ctaLabel?: string; visible?: boolean }> = ({
  text,
  ctaLabel = "DISPATCH",
  visible = true,
}) => (
  <div
    style={{
      background: tokens.bg1,
      border: `1px solid ${tokens.accent}`,
      borderRadius: 6,
      padding: "16px 22px",
      display: "flex",
      alignItems: "center",
      gap: 16,
      opacity: visible ? 1 : 0,
      transition: `opacity 200ms ${tokens.accent}`,
    }}
  >
    <div style={{ flex: 1 }}>
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 10,
          color: tokens.fg3,
          letterSpacing: "0.10em",
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        NEXT COMMAND · SAFE TO RUN
      </div>
      <div style={{ fontFamily: fonts.cond, fontWeight: 600, fontSize: 20, color: tokens.fg0 }}>
        ▸ {text}
      </div>
    </div>
    <div
      style={{
        background: tokens.accent,
        color: tokens.bg0,
        fontFamily: fonts.cond,
        fontWeight: 600,
        fontSize: 12,
        letterSpacing: "0.10em",
        padding: "10px 20px",
        borderRadius: 4,
      }}
    >
      {ctaLabel}
    </div>
  </div>
);

export const ProposalCard: React.FC<{
  variant: "allowed" | "refused";
  riskLabel: string;
  proposalId: string;
  body: React.ReactNode;
  preconditions?: React.ReactNode;
  enforcerReason?: React.ReactNode;
  citedRule?: string;
  decision?: "approved" | "open" | "refused";
}> = ({ variant, riskLabel, proposalId, body, preconditions, enforcerReason, citedRule, decision = "open" }) => {
  const isAllowed = variant === "allowed";
  return (
    <div
      style={{
        background: isAllowed ? "rgba(111,168,162,0.06)" : "rgba(255,94,122,0.06)",
        border: `1px solid ${isAllowed ? tokens.ok : tokens.danger}`,
        borderRadius: 6,
        padding: "18px 20px",
      }}
    >
      <div
        style={{
          fontFamily: fonts.cond,
          fontWeight: 600,
          fontSize: 10,
          letterSpacing: "0.14em",
          color: isAllowed ? tokens.ok : tokens.danger,
          textTransform: "uppercase",
          marginBottom: 12,
        }}
      >
        PROPOSAL · {proposalId} · {riskLabel}
      </div>
      <div style={{ fontFamily: fonts.cond, fontWeight: 600, fontSize: 15, color: tokens.fg0, marginBottom: 8 }}>
        {body}
      </div>
      {preconditions && (
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: tokens.fg3, marginBottom: 10 }}>
          {preconditions}
        </div>
      )}
      {enforcerReason && (
        <div style={{ fontFamily: fonts.sans, fontSize: 12, color: tokens.fg1, marginBottom: 6 }}>{enforcerReason}</div>
      )}
      {citedRule && (
        <div style={{ fontFamily: fonts.mono, fontSize: 10, color: tokens.fg3 }}>
          cites: <span style={{ color: tokens.accent2 }}>{citedRule}</span>
        </div>
      )}
      {isAllowed && decision === "approved" && (
        <div style={{ marginTop: 12 }}>
          <span
            style={{
              fontFamily: fonts.cond,
              fontWeight: 600,
              fontSize: 11,
              color: tokens.bg0,
              background: tokens.accent,
              padding: "6px 14px",
              borderRadius: 3,
              letterSpacing: "0.08em",
            }}
          >
            APPROVED
          </span>
        </div>
      )}
    </div>
  );
};

export const LearningFact: React.FC<{
  kind: "rule" | "discovery" | "constraint" | "summary" | "followup";
  text: string;
  lane?: string;
  ts?: string;
  tags?: string;
}> = ({ kind, text, lane, ts, tags }) => {
  const tone: Record<typeof kind, "accent" | "blue" | "warn" | "ok"> = {
    rule: "accent",
    discovery: "blue",
    constraint: "warn",
    summary: "accent",
    followup: "ok",
  };
  return (
    <div
      style={{
        background: tokens.bg1,
        border: `1px solid ${panelChrome.borderColor}`,
        borderRadius: 8,
        padding: "14px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <Pill tone={tone[kind]}>{kind}</Pill>
        {lane && <span style={{ fontFamily: fonts.mono, fontSize: 10, color: tokens.fg3 }}>{lane}</span>}
        {ts && (
          <span style={{ marginLeft: "auto", fontFamily: fonts.mono, fontSize: 10, color: tokens.fg3 }}>
            {ts}
          </span>
        )}
      </div>
      <div style={{ fontFamily: fonts.sans, fontSize: 14, color: tokens.fg0, lineHeight: 1.5 }}>{text}</div>
      {tags && (
        <div style={{ fontFamily: fonts.mono, fontSize: 10, color: tokens.fg4, marginTop: 8 }}>{tags}</div>
      )}
    </div>
  );
};

export const PaletteOverlay: React.FC<{
  query: string;
  rows: Array<{
    kind: "route" | "sub" | "action";
    title: string;
    description: string;
    group: string;
    active?: boolean;
    matchedHint?: string;
  }>;
  opacity: number;
}> = ({ query, rows, opacity }) => {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(2,6,14,0.72)",
        backdropFilter: "blur(2px)",
        opacity,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: 140,
        zIndex: 100,
      }}
    >
      <div
        style={{
          width: 720,
          background: tokens.bg1,
          border: `1px solid ${tokens.line}`,
          borderRadius: 10,
          boxShadow: "0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(208,255,0,0.04)",
          overflow: "hidden",
          transform: `translateY(${(1 - opacity) * -8}px)`,
        }}
      >
        {/* Head */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "32px 1fr auto",
            gap: 12,
            alignItems: "center",
            padding: "20px 22px",
            borderBottom: `1px solid ${tokens.lineSoft}`,
          }}
        >
          <span style={{ fontFamily: fonts.mono, fontSize: 18, color: tokens.accent, textAlign: "center" }}>⌕</span>
          <span style={{ fontFamily: fonts.cond, fontWeight: 600, fontSize: 17, color: tokens.fg0 }}>{query}</span>
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 10,
              background: tokens.bg2,
              border: `1px solid ${panelChrome.borderColor}`,
              color: tokens.fg3,
              padding: "3px 9px",
              borderRadius: 3,
            }}
          >
            esc
          </span>
        </div>
        {/* Rows */}
        <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {rows.map((r, i) => (
            <PaletteRow key={i} {...r} />
          ))}
        </div>
        {/* Foot */}
        <div
          style={{
            padding: "10px 18px",
            borderTop: `1px solid ${tokens.lineSoft}`,
            display: "flex",
            gap: 18,
            fontFamily: fonts.mono,
            fontSize: 10,
            color: tokens.fg4,
          }}
        >
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span style={{ marginLeft: "auto", color: tokens.fg2 }}>
            → {rows.find((r) => r.active)?.title || rows[0]?.title || ""}
          </span>
        </div>
      </div>
    </div>
  );
};

const PaletteRow: React.FC<{
  kind: "route" | "sub" | "action";
  title: string;
  description: string;
  group: string;
  active?: boolean;
  matchedHint?: string;
}> = ({ kind, title, description, group, active = false, matchedHint }) => {
  const glyph = kind === "action" ? "▷" : kind === "sub" ? "▸" : "◇";
  const glyphColor = kind === "action" ? tokens.accent2 : kind === "sub" ? tokens.accent : tokens.fg3;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "28px 1fr auto",
        gap: 14,
        alignItems: "center",
        padding: "12px 14px",
        background: active ? "#11203C" : "transparent",
        border: `1px solid ${active ? tokens.accent : "transparent"}`,
        borderRadius: 6,
      }}
    >
      <span style={{ fontFamily: fonts.mono, fontSize: 16, color: glyphColor, fontWeight: kind !== "route" ? 600 : 400, textAlign: "center" }}>
        {glyph}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: fonts.cond, fontWeight: 600, fontSize: 14, color: tokens.fg0, letterSpacing: "0.04em" }}>
          {title}
          {matchedHint && (
            <span style={{ fontFamily: fonts.mono, fontSize: 10, color: tokens.accent2, marginLeft: 8, opacity: 0.85 }}>
              · {matchedHint}
            </span>
          )}
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: tokens.fg3, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {description}
        </div>
      </div>
      <span style={{ fontFamily: fonts.mono, fontSize: 9, color: tokens.fg4, letterSpacing: "0.12em" }}>{group}</span>
    </div>
  );
};

export const Caption: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div
    style={{
      fontFamily: fonts.cond,
      fontSize: 11,
      color: tokens.fg3,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
      ...style,
    }}
  >
    {children}
  </div>
);
