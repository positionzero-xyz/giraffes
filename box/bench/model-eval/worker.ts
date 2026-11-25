import { registerHooks } from "node:module";

// The Worker's sources import each other without extensions, as its bundler allows; Node needs the `.ts`.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw err;
    }
  },
});

const APP = "../../../app/src";
export const { AGENT_SYSTEM } = await import(`${APP}/agent/prompt.ts`);
export const { AGENT_TOOLS, planTurn, renderUser } = await import(`${APP}/agent/turn.ts`);
export const { boxTurnAttempt } = await import(`${APP}/access/box-turn.ts`);
export const { readAgentBody } = await import(`${APP}/box/client.ts`);
export const { UNREADABLE_REPLY } = await import(`${APP}/model/client.ts`);
export const { renderPrompt } = await import(`${APP}/model/prompt.ts`);
export const { fromLocal, toLocal, parseTimeZone } = await import(`${APP}/policy/time.ts`);
