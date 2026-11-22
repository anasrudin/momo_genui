import { proposalHistoryLine, type WriteProposalCard } from "./famhub/proposalCard";
import { type MistlineUIBlock } from "./mistlineParse";
import { parseMixedStreamToMistlineBlocks } from "./openui/streamParser";

/**
 * Streaming text helpers for Momo's OpenUI Lang + Markdown pipeline.
 *
 * Generative UI arrives as ```openui-lang blocks inside normal text parts
 * (parsed incrementally via @openuidev/lang-core in src/lib/openui/streamParser.ts),
 * with legacy ```ui blocks still supported for older persisted sessions.
 */

/**
 * Strips consecutive identical lines or paragraphs from LLM text streams to prevent
 * accidental duplicated pre-card intros or echoing sentences.
 */

export function dedupeConsecutiveParagraphs(text: string): string {
  if (!text) return "";

  // Split into fenced / unfenced segments — dedupe must never touch the
  // inside of ``` fences (```ui JSON props can legitimately repeat lines).
  // Lines are accumulated per segment and re-joined with "\n" so the newline
  // at every segment boundary (e.g. fence line → JSON, ``` → following text)
  // is preserved. Joining raw strings here previously glued "```" directly to
  // the next line, which broke fence detection downstream.
  const segments: Array<{ fenced: boolean; text: string }> = [];
  let curLines: string[] | null = null;
  let curFenced = false;
  let inFence = false;
  const flushCur = () => {
    if (curLines) {
      segments.push({ fenced: curFenced, text: curLines.join("\n") });
      curLines = null;
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const isFence = /^\s*`{3,}/.test(line);
    if (
      !curLines ||
      curFenced !== inFence ||
      (isFence && curLines.every((l) => l.trim() === ""))
    ) {
      flushCur();
      curFenced = inFence;
      curLines = [];
    }
    curLines.push(line);
    if (isFence) inFence = !inFence;
  }
  flushCur();

  const dedupeSegment = (seg: string): string => {
    // 1. Dedupe consecutive identical non-empty lines
    const lines = seg.split(/\r?\n/);
    const dedupedLines: string[] = [];
    let prevTrimmed = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && trimmed.length > 12 && trimmed === prevTrimmed) {
        continue;
      }
      if (trimmed) prevTrimmed = trimmed;
      dedupedLines.push(line);
    }
    const joined = dedupedLines.join("\n");

    // 2. Dedupe consecutive multi-newline paragraphs
    const parts = joined.split(/(\r?\n\s*\r?\n)/);
    const out: string[] = [];
    let lastNonSep = "";
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (/^\r?\n\s*\r?\n$/.test(p)) {
        if (out.length > 0 && !/^\r?\n\s*\r?\n$/.test(out[out.length - 1])) {
          out.push(p);
        }
        continue;
      }
      const clean = p.trim();
      if (clean && clean === lastNonSep && clean.length > 12) {
        continue;
      }
      if (clean) lastNonSep = clean;
      out.push(p);
    }
    return out.join("");
  };

  return segments
    .map((seg) => (seg.fenced ? seg.text : dedupeSegment(seg.text)))
    .join("\n");
}

export function serializeMessageForHistory(m: {
  role: string;
  text: string;
  parts?: Array<
    | { kind: "text"; text: string }
    | { kind: "tool"; name?: string; label?: string; summary?: string }
    | {
        kind: "gen_ui";
        title?: string;
        eyebrow?: string;
        tone?: string;
        contained?: boolean;
        outline?: string[];
        css?: string;
        openuiLang?: string;
        blocks?: Array<{ spec?: unknown; html?: string }>;
      }
  >;
  writeProposals?: WriteProposalCard[];
}): string {
  // what became of each FamHub proposal, so the model never has to guess whether one was saved
  const proposalLines = (m.writeProposals ?? []).map((c) => proposalHistoryLine(c));
  if (m.parts && m.parts.length > 0) {
    const segments: string[] = [];
    for (const p of m.parts) {
      if (p.kind === "text") {
        const t = compressUiBlocksForHistory(p.text).trim();
        if (t) segments.push(t);
      } else if (p.kind === "gen_ui") {
        // Legacy gen_ui parts are summarized as prose so history never re-teaches
        // the retired ```openui-lang / ```momo-ui formats.
        const summary = [p.title, p.eyebrow, ...(p.outline || [])]
          .filter((s): s is string => Boolean(s && s.trim()))
          .join(" - ");
        if (summary) segments.push(`[UI: ${summary}]`);
      }
    }
    if (segments.length > 0) {
      return [...segments, ...proposalLines].join("\n\n");
    }
  }
  return [compressUiBlocksForHistory(m.text || ""), ...proposalLines].filter(Boolean).join("\n\n");
}

function summarizeUiBlockForHistory(block: MistlineUIBlock): string {
  const props = block.props || {};
  const strVal = (v: unknown): string =>
    typeof v === "string" && v.trim() ? v.trim() : "";

  const headline =
    strVal(props.title) ||
    strVal(props.question) ||
    strVal(props.heading);

  const aObj =
    props.a && typeof props.a === "object" && !Array.isArray(props.a)
      ? (props.a as Record<string, unknown>)
      : null;
  const bObj =
    props.b && typeof props.b === "object" && !Array.isArray(props.b)
      ? (props.b as Record<string, unknown>)
      : null;
  const vsSummary =
    aObj || bObj
      ? `${strVal(aObj?.label) || "A"} vs ${strVal(bObj?.label) || "B"}`
      : "";

  const listCandidates = [
    props.items,
    props.highlights,
    props.facts,
    props.rows,
    props.events,
    props.checks,
    props.findings,
    props.nodes,
    props.options,
    props.steps,
    props.days,
    props.pins,
    props.hypotheses,
    props.criteria,
    props.controls,
    props.inputs,
    props.metrics,
    props.colors,
  ].find((x) => Array.isArray(x)) as unknown[] | undefined;

  const sampleLabels: string[] = [];
  if (Array.isArray(listCandidates)) {
    for (const entry of listCandidates.slice(0, 18)) {
      if (typeof entry === "string" && entry.trim()) {
        sampleLabels.push(entry.trim().slice(0, 60));
      } else if (Array.isArray(entry) && entry.length > 0) {
        const rowStr = entry
          .slice(0, 3)
          .map((cell) => String(cell ?? "").trim())
          .filter(Boolean)
          .join(" - ");
        if (rowStr) sampleLabels.push(rowStr.slice(0, 60));
      } else if (entry && typeof entry === "object") {
        const rec = entry as Record<string, unknown>;
        const lbl =
          strVal(rec.title) ||
          strVal(rec.label) ||
          strVal(rec.name) ||
          strVal(rec.statement) ||
          strVal(rec.claim) ||
          strVal(rec.text) ||
          strVal(rec.hex);
        if (lbl) sampleLabels.push(lbl.slice(0, 60));
      }
    }
  }

  const parts: string[] = [];
  if (headline) parts.push(headline.slice(0, 70));
  else if (vsSummary) parts.push(vsSummary);
  if (sampleLabels.length > 0) {
    parts.push(sampleLabels.join(", "));
  }
  const summary = parts.join(" · ");
  return `[UI ${block.name}${summary ? `: ${summary}` : ""}]`;
}

/**
 * Strips ```ui / ```genui / component ```json blocks from assistant text
 * (including unclosed/truncated blocks and snake_case Intelligence UI blocks)
 * and replaces them with compact `[UI Component: digest]` lines so history
 * stays tiny and never injects malformed JSON or open fences into next turns.
 */
export function compressUiBlocksForHistory(raw: string): string {
  if (
    !raw ||
    (!raw.includes("```") && !/^root\s*=\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/m.test(raw))
  ) {
    return raw;
  }

  const blocks = parseMixedStreamToMistlineBlocks(raw, { final: true });
  if (blocks.length === 0) return raw;

  const segments: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") {
      const clean = b.text.trim();
      if (clean) segments.push(clean);
    } else {
      segments.push(summarizeUiBlockForHistory(b));
    }
  }
  return segments.join("\n\n");
}

/**
 * Compresses UI JSON blocks and trims long historical turns at clean paragraph
 * or sentence boundaries without ever splitting inside a fenced code block.
 */
export function truncateHistorySafely(text: string, maxChars = 3600): string {
  const compressed = compressUiBlocksForHistory(text || "").trim();
  if (!compressed || compressed.length <= maxChars) {
    return compressed;
  }

  const head = compressed.slice(0, maxChars);
  let cutIdx = head.lastIndexOf("\n\n");
  if (cutIdx < maxChars * 0.45) {
    cutIdx = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(". "));
  }
  let sliced = (cutIdx >= maxChars * 0.35 ? head.slice(0, cutIdx) : head).trimEnd();

  // Never leave an unclosed triple-backtick code fence in conversation history.
  const fenceMatches = sliced.match(/^\s*`{3,}/gm);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    sliced += "\n```";
  }
  return `${sliced} …`;
}

/**
 * The writing rules ban the em dash as prose punctuation and small models still slip.
 * Turn each one into a comma; code, photo lines and number ranges are left alone.
 */
export function replaceProseEmDashes(text: string): string {
  if (!text.includes("—")) return text;
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || line.trimStart().startsWith("![")) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((part) =>
          part.startsWith("`")
            ? part
            : part.replace(/(\d)\s*—\s*(\d)/g, "$1–$2").replace(/\s*—\s*/g, ", "),
        )
        .join("");
    })
    .join("\n");
}
