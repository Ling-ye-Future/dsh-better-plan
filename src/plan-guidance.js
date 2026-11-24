export const PLAN_GUIDANCE_SECTION = 'better-plan:structure';

export const DEFAULT_PLAN_GUIDANCE = [
  'Structure the Markdown passed to `exit_plan_mode` by task complexity so it is fast for the user to review and unambiguous to execute:',
  '',
  '- **Simple / single-point / read-only tasks (L0)**: keep the plan concise (`# Title`, brief summary/goal, flat steps, and concise verification). Omit unnecessary boilerplate headings.',
  '- **Multi-file, architectural, or risky tasks (L1/L2)**: organize the plan with these clear sections:',
  '  1. `# <Title>` followed by `## Goal Description` (scope, objective, and key constraints).',
  '  2. `## User Review Required` and/or `## Open Questions` (when applicable): front-load breaking changes, irreversible actions, risky assumptions, or user-owned decisions using GFM callouts (`> [!CAUTION]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!TIP]`, `> [!NOTE]`).',
  '  3. Include a ```` ```mermaid ```` diagram (`flowchart` or `sequenceDiagram`) when module boundaries, state transitions, or data flows are clearer visually.',
  '  4. `## Proposed Changes`: group by `### <Subsystem>`, and break work down per file with action-prefixed headings such as `#### [MODIFY] [filename](relative/path#L10-L25)`, `#### [NEW] [filename](relative/path)`, or `#### [DELETE] [filename](relative/path)`. Prefer verified workspace-relative paths or workspace `file://` URLs with line anchors when inspected.',
  '  5. `## Verification Plan`: separate `### Automated Tests` (exact commands and expected checks) from `### Manual Verification` (step-by-step acceptance checks).',
  '  6. Use `$...$` / `$$...$$` LaTeX math only for genuine formulas or complexity expressions.',
].join('\n');

export function buildPlanGuidance(customGuidance = '') {
  const extra = typeof customGuidance === 'string' ? customGuidance.trim() : '';
  return extra ? `${DEFAULT_PLAN_GUIDANCE}\n\n${extra}` : DEFAULT_PLAN_GUIDANCE;
}

export function isPlanModeActive(assembly) {
  if (!Array.isArray(assembly?.sections)) return false;
  return assembly.sections.some(
    section => section?.name === 'plan:policy' && typeof section.text === 'string' && section.text.trim() !== '',
  );
}

export function applyPlanGuidance(assembly, { enabled = true, customGuidance = '' } = {}) {
  if (!enabled || !isPlanModeActive(assembly)) return false;
  if (assembly.sections.some(section => section?.name === PLAN_GUIDANCE_SECTION)) return false;
  const text = buildPlanGuidance(customGuidance);
  if (!text) return false;
  const policyIndex = assembly.sections.findIndex(section => section?.name === 'plan:policy');
  const contribution = { name: PLAN_GUIDANCE_SECTION, text, interpolate: false };
  if (policyIndex === -1) assembly.sections.push(contribution);
  else assembly.sections.splice(policyIndex + 1, 0, contribution);
  return true;
}
