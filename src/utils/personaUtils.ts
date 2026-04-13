/**
 * Canonical persona name-matching utilities.
 * All persona name checks across the codebase should use these.
 */

/** Returns lowercased name + alias list for a persona. */
export function getPersonaNames(persona: { name: string; aliases: string[] }): string[] {
  return [persona.name, ...persona.aliases].map(n => n.toLowerCase().trim());
}

/** Returns true if `text` contains the persona's name or any alias (case-insensitive). */
export function matchesPersona(
  text: string,
  persona: { name: string; aliases: string[] },
): boolean {
  if (!text) return false;
  const needle = text.toLowerCase();
  return getPersonaNames(persona).some(n => needle.includes(n));
}

/** Returns true if `owner` exactly matches a persona name or alias (case-insensitive, trimmed). */
export function ownerMatchesPersona(
  owner: string | null | undefined,
  persona: { name: string; aliases: string[] },
): boolean {
  if (!owner) return false;
  const o = owner.toLowerCase().trim();
  return getPersonaNames(persona).some(n => o === n);
}
