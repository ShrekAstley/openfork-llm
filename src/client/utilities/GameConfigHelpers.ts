import { GameMapType, UnitType } from "@openfront/engine-api/game/GameTypes";
import { GameConfig } from "@openfront/engine-api/Schemas";

/**
 * Maps a slider value (0-400) to the nations config value.
 * 0 → "disabled", value === defaultNationCount → "default", otherwise → number.
 */
export function sliderToNationsConfig(
  sliderValue: number,
  defaultNationCount: number,
): GameConfig["nations"] {
  if (sliderValue === 0) return "disabled";
  if (sliderValue === defaultNationCount) return "default";
  return sliderValue;
}

/**
 * The `nations` config for a lobby with LLM-controlled nations. The slider
 * counts ordinary AI nations; the engine keeps the LLM ones in any numeric
 * count, so they are added on top. At the default (every map nation) the
 * LLM nations are already among them.
 */
export function nationsWithBrains(
  sliderValue: number,
  defaultNationCount: number,
  brainCount: number,
): GameConfig["nations"] {
  if (brainCount === 0)
    return sliderToNationsConfig(sliderValue, defaultNationCount);
  if (sliderValue === defaultNationCount && sliderValue > 0) return "default";
  return Math.min(400, sliderValue + brainCount);
}

/**
 * Which map nations the LLM controls. Typed names win (matched to the map's
 * own spelling; the rest are reported as unknown); otherwise the first
 * `count` nations of the map.
 */
export function resolveBrainNations(
  count: number,
  namesText: string,
  mapNames: string[],
): { names: string[]; unknown: string[] } {
  const typed = namesText
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (typed.length === 0)
    return {
      names: mapNames.slice(0, Math.max(0, Math.min(32, Math.floor(count)))),
      unknown: [],
    };
  const names: string[] = [];
  const unknown: string[] = [];
  for (const want of typed) {
    const found = mapNames.find((n) => n.toLowerCase() === want.toLowerCase());
    if (!found) unknown.push(want);
    else if (!names.includes(found)) names.push(found);
  }
  return { names: names.slice(0, 32), unknown };
}

/**
 * Maps a nations config value to a slider-friendly number.
 * "disabled" → 0, "default" → defaultNationCount, number → number.
 */
export function nationsConfigToSlider(
  nations: GameConfig["nations"],
  defaultNationCount: number,
): number {
  if (nations === "disabled") return 0;
  if (nations === "default") return defaultNationCount;
  return nations;
}

export function toOptionalNumber(
  value: number | string | undefined,
): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

export function preventDisallowedKeys(
  e: KeyboardEvent,
  disallowedKeys: string[],
): void {
  if (disallowedKeys.includes(e.key)) {
    e.preventDefault();
  }
}

export function parseBoundedIntegerFromInput(
  input: HTMLInputElement,
  {
    min,
    max,
    stripPattern = /[eE+-]/g,
    radix = 10,
  }: {
    min: number;
    max: number;
    stripPattern?: RegExp;
    radix?: number;
  },
): number | undefined {
  input.value = input.value.replace(stripPattern, "");
  const value = parseInt(input.value, radix);

  if (isNaN(value) || value < min || value > max) {
    return undefined;
  }

  return value;
}

export function parseBoundedFloatFromInput(
  input: HTMLInputElement,
  { min, max }: { min: number; max: number },
): number | undefined {
  const value = parseFloat(input.value);

  if (isNaN(value) || value < min || value > max) {
    return undefined;
  }

  return value;
}

export function getBotsForCompactMap(
  bots: number,
  compactMapEnabled: boolean,
): number {
  if (compactMapEnabled && bots === 400) {
    return 100;
  }

  if (!compactMapEnabled && bots === 100) {
    return 400;
  }

  return bots;
}

export function getNationsForCompactMap(
  nations: number,
  defaultNationCount: number,
  compactMapEnabled: boolean,
): number {
  const compactCount = Math.max(0, Math.floor(defaultNationCount * 0.25));
  if (compactMapEnabled) {
    // Only reduce if at the full default
    if (nations === defaultNationCount) {
      return compactCount;
    }
    return nations;
  }
  // Restoring from compact: if at the compact default, go back to full default
  if (nations === compactCount) {
    return defaultNationCount;
  }
  return nations;
}

export function getRandomMapType(): GameMapType {
  const maps = Object.values(GameMapType);
  const randIdx = Math.floor(Math.random() * maps.length);
  return maps[randIdx] as GameMapType;
}

export function getUpdatedDisabledUnits(
  disabledUnits: UnitType[],
  unit: UnitType,
  checked: boolean,
): UnitType[] {
  return checked
    ? [...disabledUnits, unit]
    : disabledUnits.filter((u) => u !== unit);
}
