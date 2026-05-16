import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { CockpitFrame } from "./components/CockpitFrame";
import { Panel, KpiStrip, NextCommand, ProposalCard, LearningFact, PaletteOverlay, Caption, Pill } from "./components/Pieces";
import { tokens, fonts } from "./tokens";

/**
 * The Máddu cockpit demo — 22 s × 30 fps = 660 frames.
 *
 * Six scenes, each anchored on a frame range. They share one CockpitFrame
 * so transitions feel like the same cockpit moving forward in time — no
 * cross-fades between unrelated screenshots.
 *
 *   0..89     (0–3s)    : COLD COCKPIT      first-run state, empty Conductor
 *   90..209   (3–7s)    : COMMAND PALETTE   Ctrl+K opens, "claim" typed, result highlights
 *   210..359  (7–12s)   : LANE CLAIMED      Conductor fills, claim card lands
 *   360..449  (12–15s)  : BOSS PROPOSAL     Enforcer cites, operator approves
 *   450..569  (15–19s)  : SLICE-STOP        lime line traces, Hindsight populates
 *   570..659  (19–22s)  : CLOSING CARD      brand mark + tagline
 */

const SCENES = {
  cold:     { start: 0,   end: 89 },
  palette:  { start: 90,  end: 209 },
  claimed:  { start: 210, end: 359 },
  proposal: { start: 360, end: 449 },
  slice:    { start: 450, end: 569 },
  close:    { start: 570, end: 659 },
};

export const CockpitDemo: React.FC = () => {
  const frame = useCurrentFrame();

  // The closing card replaces the cockpit entirely; everything else
  // composites over CockpitFrame.
  if (frame >= SCENES.close.start) return <ClosingCard frame={frame - SCENES.close.start} />;

  return <CockpitScenes frame={frame} />;
};

const CockpitScenes: React.FC<{ frame: number }> = ({ frame }) => {
  // Slice-stop line — fires across frames 450..480 (~1s)
  const sliceFrame = frame - SCENES.slice.start;
  const lineActive = sliceFrame >= 0 && sliceFrame <= 30;
  const lineProgress = lineActive ? Math.max(0, Math.min(1, sliceFrame / 30)) : 0;

  return (
    <CockpitFrame routeTitle="CONDUCTOR" showLimeLine={lineActive} limeLineProgress={lineProgress}>
      <ColdLayer frame={frame} />
      <ClaimedLayer frame={frame} />
      <ProposalLayer frame={frame} />
      <SliceLayer frame={frame} />
      <PaletteLayer frame={frame} />
    </CockpitFrame>
  );
};

// ─── Scene 1 — Cold cockpit (first-run banner) ──────────────────────────
const ColdLayer: React.FC<{ frame: number }> = ({ frame }) => {
  // Visible from start until the palette opens (frame 100).
  const visible = frame < 100;
  const opacity = interpolate(frame, [0, 30, 90, 100], [0, 1, 1, 0], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });
  if (!visible && opacity === 0) return null;

  return (
    <div style={{ opacity, position: "absolute", inset: 40 }}>
      {/* First-run banner */}
      <div
        style={{
          background: "rgba(86,184,255,0.04)",
          border: `1px solid ${tokens.accent2}`,
          borderRadius: 6,
          padding: "14px 22px",
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <span style={{ fontSize: 18 }}>👋</span>
        <span style={{ fontFamily: fonts.sans, fontSize: 14, color: tokens.fg0 }}>
          First time here? <span style={{ color: tokens.accent2 }}>Take the five-minute tour →</span>
        </span>
      </div>

      {/* Empty KPI strip */}
      <KpiStrip
        tiles={[
          { value: "0", label: "Active claims", sub: "—", tone: "accent" },
          { value: "0", label: "Parked gates", sub: "—", tone: "warn" },
          { value: "0", label: "Open approvals", sub: "—", tone: "blue" },
          { value: "—", label: "Since last slice", sub: "no slice-stops yet", tone: "ok" },
        ]}
        style={{ marginBottom: 24 }}
      />

      <Panel
        title="NOW · NEXT · WAITING · DONE"
        aside="empty"
        style={{ marginBottom: 0 }}
      >
        <div style={{ padding: "32px 12px", textAlign: "center" }}>
          <div style={{ fontFamily: fonts.mono, fontSize: 36, color: tokens.accent, opacity: 0.55, marginBottom: 12 }}>◌</div>
          <div style={{ fontFamily: fonts.cond, fontWeight: 600, fontSize: 14, color: tokens.fg1, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            No work in flight
          </div>
          <div style={{ fontFamily: fonts.sans, fontSize: 13, color: tokens.fg3, marginTop: 8 }}>
            Register a session and claim a lane to start your first slice.
          </div>
        </div>
      </Panel>
    </div>
  );
};

// ─── Scene 2 — Command palette opens, "claim" typed, result highlights ──
const PaletteLayer: React.FC<{ frame: number }> = ({ frame }) => {
  const sceneFrame = frame - SCENES.palette.start;
  if (sceneFrame < 0 || sceneFrame > SCENES.palette.end - SCENES.palette.start + 10) return null;

  // Fade in 0..15, hold, fade out 100..120.
  const opacity = interpolate(sceneFrame, [0, 15, 100, 115], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (opacity === 0) return null;

  // Cursor types "claim" between frames 20 and 70
  const query = (() => {
    if (sceneFrame < 20) return "";
    if (sceneFrame >= 70) return "claim";
    const idx = Math.floor(((sceneFrame - 20) / 50) * 5);
    return "claim".slice(0, idx);
  })();

  return (
    <PaletteOverlay
      opacity={opacity}
      query={query || "·"}
      rows={[
        {
          kind: "route",
          title: "CLAIMS",
          description: "Active claims by lane — who is holding what, lease state, heartbeat age.",
          group: "DECIDE",
          active: query.length >= 1,
        },
        {
          kind: "action",
          title: "CLAIM A LANE",
          description: "Open the Claims route with a focus on the lane picker.",
          group: "DECIDE",
          matchedHint: "action",
        },
        {
          kind: "route",
          title: "CONDUCTOR",
          description: "Command-control: what is safe to do next?",
          group: "DECIDE",
        },
      ]}
    />
  );
};

// ─── Scene 3 — Lane claimed: Conductor populates ────────────────────────
const ClaimedLayer: React.FC<{ frame: number }> = ({ frame }) => {
  const visible = frame >= SCENES.claimed.start && frame < SCENES.proposal.start + 30;
  if (!visible) return null;
  const sceneFrame = frame - SCENES.claimed.start;

  // KPI count-up from 0 → 1 active claim
  const claims = interpolate(sceneFrame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  const claimsStr = Math.round(claims).toString();

  // Fade KPI panels in
  const opacityKpi = interpolate(sceneFrame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  const opacityNext = interpolate(sceneFrame, [40, 70], [0, 1], { extrapolateRight: "clamp", extrapolateLeft: "clamp" });

  return (
    <div style={{ position: "absolute", inset: 40 }}>
      <div style={{ opacity: opacityKpi, marginBottom: 24 }}>
        <KpiStrip
          tiles={[
            { value: claimsStr, label: "Active claims", sub: "cockpit-shell", tone: "accent" },
            { value: "0", label: "Parked gates", sub: "—", tone: "warn" },
            { value: "0", label: "Open approvals", sub: "—", tone: "blue" },
            { value: "live", label: "Since last slice", sub: "first slice in progress", tone: "ok" },
          ]}
        />
      </div>

      <div style={{ opacity: opacityNext, marginBottom: 24 }}>
        <NextCommand
          text={
            <>
              Run <span style={{ color: tokens.accent }}>slice-stop</span> when you finish the polish pass on{" "}
              <span style={{ fontFamily: fonts.mono, color: tokens.accent2, fontSize: 16 }}>cockpit-shell</span>
            </>
          }
        />
      </div>
    </div>
  );
};

// ─── Scene 4 — BOSS proposal lands; Enforcer cites; operator approves ──
const ProposalLayer: React.FC<{ frame: number }> = ({ frame }) => {
  const sceneFrame = frame - SCENES.proposal.start;
  if (sceneFrame < 0 || frame >= SCENES.slice.start + 30) return null;

  // Card slides up + fades in 0..30
  const opacity = interpolate(sceneFrame, [0, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const translateY = interpolate(sceneFrame, [0, 30], [16, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // Show "APPROVED" badge after frame 60
  const approved = sceneFrame > 60;

  return (
    <div
      style={{
        position: "absolute",
        right: 40,
        bottom: 40,
        width: 680,
        opacity,
        transform: `translateY(${translateY}px)`,
      }}
    >
      <Caption style={{ marginBottom: 10 }}>BOSS · 14:22:09</Caption>
      <ProposalCard
        variant="allowed"
        riskLabel="LOW RISK"
        proposalId="prop_mp75n059_0t8r"
        body={<>claim-lane "cockpit-shell" → ses_20260517_174b16</>}
        preconditions="preconditions: lane is free · session is active · holder has heartbeat < 15s"
        decision={approved ? "approved" : "open"}
      />
    </div>
  );
};

// ─── Scene 5 — Slice-stop fires; Hindsight learning row pops in ─────────
const SliceLayer: React.FC<{ frame: number }> = ({ frame }) => {
  const sceneFrame = frame - SCENES.slice.start;
  if (sceneFrame < 0 || frame >= SCENES.close.start + 30) return null;

  // Learning fact appears at frame 40, springs in
  const factSceneFrame = sceneFrame - 40;
  const factSpring = factSceneFrame > 0 ? Math.min(1, factSceneFrame / 20) : 0;
  const factOpacity = factSpring;
  const factTranslateY = (1 - factSpring) * 12;

  if (factSpring === 0) return null;

  return (
    <div
      style={{
        position: "absolute",
        left: 40,
        bottom: 40,
        width: 720,
        opacity: factOpacity,
        transform: `translateY(${factTranslateY}px)`,
      }}
    >
      <Caption style={{ marginBottom: 10 }}>HINDSIGHT · just now</Caption>
      <LearningFact
        kind="rule"
        text="every integration must be off by default and refuse to enable until the allowlist is non-empty."
        lane="cockpit-shell"
        ts="14:25"
        tags="lane:cockpit-shell · actor:ses_20260517 · ext:mjs"
      />
    </div>
  );
};

// ─── Scene 6 — Closing card ─────────────────────────────────────────────
const ClosingCard: React.FC<{ frame: number }> = ({ frame }) => {
  const { fps } = useVideoConfig();
  const fadeIn = spring({ frame, fps, config: { damping: 20, stiffness: 100 } });

  return (
    <AbsoluteFill
      style={{
        background: tokens.bg0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        gap: 28,
        opacity: fadeIn,
      }}
    >
      {/* Brand mark */}
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div style={{ width: 64, height: 64, borderRadius: 12, background: tokens.brand }} />
        <span style={{ fontFamily: fonts.cond, fontWeight: 600, fontSize: 56, color: tokens.fg0, letterSpacing: "0.06em" }}>
          MÁDDU
        </span>
      </div>

      <div style={{ fontFamily: fonts.sans, fontSize: 22, color: tokens.fg2, letterSpacing: "0.02em" }}>
        The Source of local truth.
      </div>

      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 14,
          color: tokens.fg3,
          marginTop: 40,
          letterSpacing: "0.06em",
        }}
      >
        npx github:frdyx/maddu init
      </div>

      <div style={{ display: "flex", gap: 24, marginTop: 12 }}>
        <Pill tone="accent">files-only</Pill>
        <Pill tone="blue">no cloud</Pill>
        <Pill tone="ok">8 hard rules</Pill>
      </div>
    </AbsoluteFill>
  );
};
