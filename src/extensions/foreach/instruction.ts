/**
 * Instruction classification and per-item task building for `/foreach`.
 *
 * The command's first input is freeform: either an instruction written out in
 * full, or a `/skill-name` reference to an installed workflow skill. This
 * module tells the two apart and builds the message each per-item subagent
 * receives, so a skill (which already carries its own instructions) is handed
 * just the item, while a freeform instruction is paired with the item inline.
 */

/** An instruction classified as freeform text, run with no skill loaded. */
export interface FreeformInstruction {
  kind: 'freeform'
  text: string
}

/** An instruction classified as a reference to an installed skill. */
export interface SkillInstruction {
  kind: 'skill'
  name: string
}

export type ParsedInstruction = FreeformInstruction | SkillInstruction

/**
 * Classify a `/foreach` instruction argument.
 *
 * A leading `/` marks a skill reference — the remainder, trimmed, is the skill
 * name. Anything else is freeform instruction text, used verbatim.
 *
 * @param instruction - The raw instruction token(s) from {@link parseForeachArgs}.
 * @returns The classified instruction.
 */
export function parseInstruction (instruction: string): ParsedInstruction {
  if (instruction.startsWith('/')) {
    return { kind: 'skill', name: instruction.slice(1).trim() }
  }
  return { kind: 'freeform', text: instruction }
}

/**
 * Build the message a single item's subagent receives.
 *
 * A skill already supplies its own instructions via `--skill`, so its subagent
 * is given just the item as its task. A freeform instruction has no such
 * context, so the item is appended beneath it, framed as what to apply the
 * instruction to.
 *
 * @param instruction - The classified instruction.
 * @param item - The list item this run applies to.
 * @returns The task text to hand to the subagent.
 */
export function buildItemTask (instruction: ParsedInstruction, item: string): string {
  if (instruction.kind === 'skill') {
    return item
  }
  return `${instruction.text}\n\nApply the instruction above to the following item:\n\n${item}`
}
