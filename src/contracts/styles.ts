// Reusable style profiles.
//
// *** WHY THIS IS SEPARATE FROM THE PROMPT ***
// Without this separation, every call would have Claude re-copy the whole
// style description. Two bad consequences: (1) one mistyped word and the
// artifact drifts off-brand without anyone noticing; (2) changing the
// palette would require editing every conversation that already has the
// description pasted in — i.e. it couldn't actually be changed.
//
// With a profile, Claude only sends `style.reference: "tinyorbit-cloud-v1"`,
// and the style content itself is the source of truth living here, in git.
//
// Adding a new profile = adding an entry to STYLE_PROFILES. Editing an
// existing profile affects EVERY artifact generated AFTER the change —
// existing artifacts stay as they are because they're immutable, and their
// metadata records which profile name was used.

export interface StyleProfile {
  name: string;
  description: string;
  /** Text block embedded into the Codex prompt. */
  prompt: string;
}

const TINYORBIT_CLOUD_V1: StyleProfile = {
  name: "tinyorbit-cloud-v1",
  description: "TinyOrbit Cloud's 3D claymorphism brand identity",
  prompt: [
    "3D illustration",
    "claymorphism",
    "soft rounded edges",
    "matte clay / frosted-plastic surfaces",
    "no glossy metallic reflections",
    "",
    "palette:",
    "#000055",
    "#2E5BFF",
    "#CFE3FF",
    "#FFFFFF",
    "",
    "cyan accent:",
    "#46C3D8",
    "",
    "lighting:",
    "soft studio key from upper-left",
    "",
    "camera:",
    "front 3/4 view",
    "mild perspective",
    "",
    "web artifact:",
    "transparent background",
    "no ground shadow",
    "isolated subject",
    "12% minimum safe padding",
  ].join("\n"),
};

export const STYLE_PROFILES: Record<string, StyleProfile> = {
  [TINYORBIT_CLOUD_V1.name]: TINYORBIT_CLOUD_V1,
};

export function listStyleProfiles(): string[] {
  return Object.keys(STYLE_PROFILES);
}

/**
 * Assembles the final style section.
 *
 * The order MATTERS: profile first, caller's extra instructions after —
 * so a single request can fine-tune the profile without dropping the
 * brand identity altogether.
 *
 * Returns an empty string when there's nothing; the caller decides whether
 * to skip this section in the prompt.
 */
export function resolveStyle(
  reference: string | undefined,
  extraPrompt: string | undefined,
): { prompt: string; reference: string | null } {
  const parts: string[] = [];
  let resolved: string | null = null;

  if (reference) {
    const profile = STYLE_PROFILES[reference];
    if (!profile) {
      throw new Error(
        `No style profile "${reference}". Available: ${listStyleProfiles().join(", ")}`,
      );
    }
    parts.push(profile.prompt);
    resolved = profile.name;
  }

  if (extraPrompt) parts.push(extraPrompt);

  return { prompt: parts.join("\n\n"), reference: resolved };
}
