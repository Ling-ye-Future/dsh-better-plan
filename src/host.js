import z from '@deepseek-ai/schemastery';
import { applyPlanGuidance } from './plan-guidance.js';

export const Config = z.object({
  planGuidance: z.boolean().default(true).volatile()
    .description('Inject complexity-tiered Antigravity-style plan structure guidance while Plan Mode is active.'),
  customGuidance: z.string().max(4000).default('').volatile()
    .description('Optional extra plan-structure instructions appended while Plan Mode is active.'),
});

function readVolatile(value, fallback) {
  const resolved = typeof value?.get === 'function' ? value.get() : value;
  return resolved === undefined ? fallback : resolved;
}

export function apply(ctx, rawConfig) {
  const guidanceRef = rawConfig?.planGuidance;
  const customRef = rawConfig?.customGuidance;
  const isEnabled = () => readVolatile(guidanceRef, true) !== false;
  const getCustomGuidance = () => {
    const value = readVolatile(customRef, '');
    return typeof value === 'string' ? value : '';
  };

  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['systemPrompt'], (scope) => {
    if (typeof scope?.on !== 'function') return;
    const dispose = scope.on('system-prompt/assemble', (assembly, _context, next) => {
      applyPlanGuidance(assembly, {
        enabled: isEnabled(),
        customGuidance: getCustomGuidance(),
      });
      return next();
    });
    if (typeof scope.effect === 'function') {
      scope.effect(() => dispose, 'better-plan: graded plan-mode structure guidance');
    }
  });
}
