import { describe, expect, it } from "vitest";
import {
  nationsWithBrains,
  resolveBrainNations,
} from "../../src/client/utilities/GameConfigHelpers";
import { applyGameConfigPatch } from "../../src/server/ConfigPatch";

const MAP = ["United States", "Canada", "Mexico", "France"];

describe("resolveBrainNations", () => {
  it("takes the first N map nations when no names are typed", () => {
    expect(resolveBrainNations(2, "", MAP)).toEqual({
      names: ["United States", "Canada"],
      unknown: [],
    });
    expect(resolveBrainNations(0, "  ", MAP).names).toEqual([]);
    expect(resolveBrainNations(99, "", MAP).names).toHaveLength(4);
  });

  it("matches typed names to the map's spelling and reports the rest", () => {
    expect(
      resolveBrainNations(5, " france , CANADA, Atlantis, france", MAP),
    ).toEqual({
      names: ["France", "Canada"],
      unknown: ["Atlantis"],
    });
  });
});

describe("nationsWithBrains", () => {
  it("is the ordinary rule without LLM nations", () => {
    expect(nationsWithBrains(0, 60, 0)).toBe("disabled");
    expect(nationsWithBrains(60, 60, 0)).toBe("default");
    expect(nationsWithBrains(10, 60, 0)).toBe(10);
  });

  it("adds LLM nations on top of the ordinary count", () => {
    expect(nationsWithBrains(10, 60, 2)).toBe(12);
    expect(nationsWithBrains(0, 60, 2)).toBe(2);
    expect(nationsWithBrains(399, 60, 5)).toBe(400);
  });

  it("keeps every map nation at the default, LLM ones included", () => {
    expect(nationsWithBrains(60, 60, 2)).toBe("default");
  });
});

describe("host config patch", () => {
  const base = () => ({ nations: "default" }) as any;

  it("sets, de-duplicates and clears brainNations", () => {
    const c = base();
    applyGameConfigPatch(c, { brainNations: ["Canada", "Canada", "France"] });
    expect(c.brainNations).toEqual(["Canada", "France"]);
    applyGameConfigPatch(c, {});
    expect(c.brainNations).toEqual(["Canada", "France"]);
    applyGameConfigPatch(c, { brainNations: [] });
    expect(c.brainNations).toEqual([]);
  });
});
