import { resolveHomeTimeZone } from '@shared/primitives/home-time-zone';
import { localTime } from './loop-action-policy';

export const LOOP_ACTION_TIME_ZONE = resolveHomeTimeZone();

const MEAL_NAME_MAX_CHARS = 40;

/** "Pizza margherita" or "Posiłek o 12:30": how a meal is named in pushes, suggestions and meal pickers. */
export function mealLabel(description: string | null, startedAt: string, timeZone = LOOP_ACTION_TIME_ZONE): string {
  const name = description?.replace(/\s+/g, ' ').trim();
  if (!name) return `Posiłek o ${localTime(startedAt, timeZone)}`;
  if (name.length <= MEAL_NAME_MAX_CHARS) return name;
  const cut = name.slice(0, MEAL_NAME_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(/[,;:]$/, '')}…`;
}
