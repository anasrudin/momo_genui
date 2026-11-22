"use client";

import React, { useId } from "react";
import { motion } from "motion/react";
import type { ModelBrandId, ReasoningEffort } from "@/lib/modelCatalog";

export const ModelBrandIcon: React.FC<{
  brand: ModelBrandId;
  size?: number;
  active?: boolean;
}> = ({ brand, size = 16, active = false }) => {
  const uid = useId().replace(/[:]/g, "");
  const geminiGradId = `momo-gemini-grad-${uid}`;
  switch (brand) {
    case "nvidia":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          style={{
            color: active ? "#76b900" : "currentColor",
            transition: "color 0.2s ease",
            flexShrink: 0,
          }}
        >
          <path
            fill="currentColor"
            d="M8.948 8.798v-1.43a6.7 6.7 0 0 1 .424-.018c3.922-.124 6.493 3.374 6.493 3.374s-2.774 3.851-5.75 3.851c-.398 0-.787-.062-1.158-.185v-4.346c1.528.185 1.837.857 2.747 2.385l2.04-1.714s-1.492-1.952-4-1.952a6.016 6.016 0 0 0-.796.035m0-4.735v2.138l.424-.027c5.45-.185 9.01 4.47 9.01 4.47s-4.08 4.964-8.33 4.964c-.37 0-.733-.035-1.095-.097v1.325c.3.035.61.062.91.062 3.957 0 6.82-2.023 9.593-4.408.459.371 2.34 1.263 2.73 1.652-2.633 2.208-8.772 3.984-12.253 3.984-.335 0-.653-.018-.971-.053v1.864H24V4.063zm0 10.326v1.131c-3.657-.654-4.673-4.46-4.673-4.46s1.758-1.944 4.673-2.262v1.237H8.94c-1.528-.186-2.73 1.245-2.73 1.245s.68 2.412 2.739 3.11M2.456 10.9s2.164-3.197 6.5-3.533V6.201C4.153 6.59 0 10.653 0 10.653s2.35 6.802 8.948 7.42v-1.237c-4.84-.6-6.492-5.936-6.492-5.936z"
          />
        </svg>
      );

    case "google": {
      const greenGrad = `${geminiGradId}-g`;
      const redGrad = `${geminiGradId}-r`;
      const yellowGrad = `${geminiGradId}-y`;
      const sparkPath =
        "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z";
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          style={{
            flexShrink: 0,
            opacity: active ? 1 : 0.78,
            filter: active
              ? "drop-shadow(0 1px 2px rgba(49, 134, 255, 0.28))"
              : "saturate(0.75)",
            transition: "opacity 0.2s ease, filter 0.2s ease",
          }}
        >
          <defs>
            <linearGradient
              id={greenGrad}
              x1="7"
              y1="15.5"
              x2="11"
              y2="12"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#08B962" />
              <stop offset="1" stopColor="#08B962" stopOpacity="0" />
            </linearGradient>
            <linearGradient
              id={redGrad}
              x1="8"
              y1="5.5"
              x2="11.5"
              y2="11"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#F94543" />
              <stop offset="1" stopColor="#F94543" stopOpacity="0" />
            </linearGradient>
            <linearGradient
              id={yellowGrad}
              x1="3.5"
              y1="13.5"
              x2="17.5"
              y2="12"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#FABC12" />
              <stop offset="0.46" stopColor="#FABC12" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={sparkPath} fill="#3186FF" />
          <path d={sparkPath} fill={`url(#${greenGrad})`} />
          <path d={sparkPath} fill={`url(#${redGrad})`} />
          <path d={sparkPath} fill={`url(#${yellowGrad})`} />
        </svg>
      );
    }

    case "deepseek":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          style={{
            color: active ? "#4d6bfe" : "currentColor",
            transition: "color 0.2s ease",
            flexShrink: 0,
          }}
        >
          <path
            fill="currentColor"
            d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 2.163 4.108 4.417 4.671 2.253.563 4.607-.07 6.278-1.631 1.67-1.561 2.56-3.834 2.375-6.096-.15-1.838-1.144-3.486-2.68-4.508-.152-.102-.191-.235-.113-.371.191-.336.387-.668.582-.997.078-.133.203-.18.352-.113.883.391 1.653.961 2.345 1.649.883.887 1.583 1.91 2.51 2.766 1.477 1.36 3.197 1.95 5.174 1.348.813-.246 1.485-.758 1.977-1.45.492-.692.68-1.512.512-2.348-.125-.633-.465-1.16-.91-1.617z"
          />
        </svg>
      );

    case "openai":
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          style={{
            color: active ? "var(--ink)" : "currentColor",
            transition: "color 0.2s ease",
            flexShrink: 0,
          }}
        >
          <path
            fill="currentColor"
            d="M22.282 9.821a6 6 0 0 0-.516-4.91a6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9a6.05 6.05 0 0 0 .743 7.097a5.98 5.98 0 0 0 .51 4.911a6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206a6 6 0 0 0 3.997-2.9a6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081l4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085l4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354l-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085l-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365l2.602-1.5l2.607 1.5v2.999l-2.597 1.5l-2.607-1.5Z"
          />
        </svg>
      );

    case "anthropic":
      // a plain eight-ray burst, not a trademark
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          style={{
            color: active ? "#c96442" : "currentColor",
            transition: "color 0.2s ease",
            flexShrink: 0,
          }}
        >
          <path
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"
          />
        </svg>
      );
  }
};

/**
 * Modern neural cognition thinking glyph for reasoning models & levels.
 * Clean, lightweight brain & synapse motif without any clunky containers.
 */
export const ReasoningMotionIcon: React.FC<{
  effort?: ReasoningEffort;
  size?: number;
}> = ({ effort = "off", size = 15 }) => {
  const active = effort !== "off";
  const isMed = effort === "medium";
  const isHigh = effort === "high";

  const strokeWidth = isHigh ? 2.05 : isMed ? 1.9 : active ? 1.8 : 1.65;
  const pulseScale = isHigh
    ? [0.84, 1.52, 0.84]
    : isMed
      ? [0.88, 1.35, 0.88]
      : [0.92, 1.18, 0.92];
  const pulseDuration = isHigh ? 0.78 : isMed ? 1.25 : 2.0;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        color: active
          ? "var(--momo-reason-fg, var(--crest-role-accent, var(--accent)))"
          : "var(--mute)",
        flexShrink: 0,
        transition: "color 0.22s ease, filter 0.22s ease",
        filter: isHigh
          ? "drop-shadow(0 0 5px var(--crest-role-accent, var(--accent)))"
          : isMed
            ? "drop-shadow(0 0 2.5px color-mix(in srgb, var(--crest-role-accent, var(--accent)) 60%, transparent))"
            : undefined,
      }}
    >
      {/* Sleek dual hemisphere brain outline */}
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.002 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.875a4 4 0 0 0 .717 1.5" />
      <path d="M19.806 12.375a4 4 0 0 0 .717-1.5" />

      {/* Expanding outer synaptic ripple ring for med & high */}
      {(isMed || isHigh) && (
        <motion.circle
          cx="12"
          cy="9"
          r={isHigh ? 3.2 : 2.6}
          fill="none"
          stroke="currentColor"
          strokeWidth={isHigh ? 1.4 : 1.1}
          style={{ transformOrigin: "12px 9px" }}
          animate={{
            scale: isHigh ? [0.65, 1.65] : [0.85, 1.35],
            opacity: isHigh ? [0.75, 0] : [0.45, 0],
          }}
          transition={{
            duration: isHigh ? 0.9 : 1.45,
            repeat: Infinity,
            ease: "easeOut",
          }}
        />
      )}

      {/* Living pulse nucleus on active thinking */}
      {active && (
        <motion.circle
          cx="12"
          cy="9"
          r="1.8"
          fill="currentColor"
          stroke="none"
          style={{ transformOrigin: "12px 9px" }}
          animate={{
            scale: pulseScale,
            opacity: isHigh ? [0.75, 1, 0.75] : [0.65, 1, 0.65],
          }}
          transition={{
            duration: pulseDuration,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        />
      )}
    </svg>
  );
};
