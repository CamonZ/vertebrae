/**
 * The rejecting side of named arrangements, and the `vtb flow validate`
 * bundle against the source it is built from. Hegel takes a valid generated
 * spec (see arrangementWorlds.ts) and:
 *
 * - plants one arrangement error (an unknown name, a presence its part or
 *   rail rules out, a missing baseline, a duplicate, a shorthand mark): the
 *   spec is rejected with an error at the planted path naming the
 *   arrangement;
 * - puts arbitrary JSON where arrangement names and maps go: compiling
 *   never throws, and returns a spec or errors;
 * - in every case the committed QuickJS bundle, run as vtb runs it, reports
 *   exactly what the source validator reports (oracle).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { world, type World } from "./arrangementWorlds";
import { compileFlow, formatFlowError, type FlowSpec } from "./index";
import { validateFlowSource, type FlowValidation } from "./validatorEntry";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** The committed bundle's entry point, loaded the way vtb loads it. */
const bundled = (() => {
  const sandbox: { vtbValidateFlow?: (s: string) => string } = {};
  runInNewContext(
    readFileSync(resolve("../cli/assets/flow-validator.js"), "utf8"),
    sandbox
  );
  return (source: string) =>
    JSON.parse(sandbox.vtbValidateFlow!(source)) as FlowValidation;
})();

/** The bundle reports what the source reports, error for error. */
function sameAsBundle(source: string): FlowValidation {
  const want = validateFlowSource(source);
  const got = bundled(source);
  const lines = (v: FlowValidation) => v.errors.map((e) => e.line);
  check(
    got.ok === want.ok &&
      JSON.stringify(lines(got)) === JSON.stringify(lines(want)),
    `bundle: ${JSON.stringify(lines(got))}\nsource: ${JSON.stringify(lines(want))}\n${source}`
  );
  return want;
}

/** A spec being broken on purpose: any field may be overwritten. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Draft = any;
const clone = (s: FlowSpec): Draft => structuredClone(s);
/** A name no generated world declares. */
const ZED = "Zed";

interface Planted {
  readonly what: string;
  readonly spec: FlowSpec;
  /** Path the error must be reported at. */
  readonly path: RegExp;
  /** Text the error line must contain (the arrangement it names). */
  readonly names?: string;
}

/** Plant one arrangement error in a valid world, or none when it cannot. */
function plant(tc: hegel.TestCase, w: World): Planted | null {
  const s = clone(w.spec);
  const at = (n: number) =>
    tc.draw(gs.integers({ minValue: 0, maxValue: n - 1 }));
  const outside = (members: ReadonlySet<string>) =>
    w.names.filter((a) => !members.has(a));
  const kind = tc.draw(
    gs.sampledFrom([
      "unknown in",
      "unknown override",
      "unknown caption",
      "rail where a part is absent",
      "step where its part is absent",
      "missing baseline",
      "duplicate name",
      "shorthand mark",
      "band value missing",
    ] as const)
  );
  switch (kind) {
    case "unknown in": {
      const i = at(s.parts.length);
      const listed = [...w.parts.get(`p${i}`)!];
      s.parts[i].in = [...listed, ZED];
      return {
        what: kind,
        spec: s,
        path: new RegExp(`^parts\\[${i}\\]\\.in\\[${listed.length}\\]$`),
        names: ZED,
      };
    }
    case "unknown override": {
      const i = at(s.parts.length);
      s.parts[i].arrangement = { ...s.parts[i].arrangement, [ZED]: {} };
      return {
        what: kind,
        spec: s,
        path: new RegExp(`^parts\\[${i}\\]\\.arrangement\\.${ZED}$`),
        names: ZED,
      };
    }
    case "unknown caption": {
      const b = at(s.story!.length);
      const c = s.story![b].caption;
      s.story![b].caption = { ...(typeof c === "object" ? c : {}), [ZED]: "x" };
      return {
        what: kind,
        spec: s,
        path: new RegExp(`^story\\[${b}\\]\\.caption\\.${ZED}$`),
        names: ZED,
      };
    }
    case "rail where a part is absent": {
      const r = s.rails ?? [];
      if (r.length === 0) return null;
      const k = at(r.length);
      const ends = [r[k].from, r[k].to].map(
        (e) => w.parts.get(e.split(".")[0])!
      );
      const away = outside(
        new Set(w.names.filter((a) => ends.every((e) => e.has(a))))
      );
      if (away.length === 0) return null;
      const a = tc.draw(gs.sampledFrom(away));
      r[k].in = [a];
      return {
        what: kind,
        spec: s,
        path: new RegExp(`^rails\\[${k}\\]\\.in$`),
        names: `"${a}"`,
      };
    }
    case "step where its part is absent": {
      const steps = w.spec.story!.flatMap((beat, b) =>
        (beat.steps ?? []).map((_, k) => [b, k] as const)
      );
      if (steps.length === 0) return null;
      const [b, k] = tc.draw(gs.sampledFrom(steps));
      const step = s.story![b].steps![k];
      const away = outside(w.parts.get(step.part)!);
      if (away.length === 0) return null;
      const a = tc.draw(gs.sampledFrom(away));
      step.in = [a];
      return {
        what: kind,
        spec: s,
        path: new RegExp(`^story\\[${b}\\]\\.steps\\[${k}\\]\\.in$`),
        names: `"${a}"`,
      };
    }
    case "missing baseline":
      s.baseline = ZED;
      return { what: kind, spec: s, path: /^baseline$/, names: ZED };
    case "duplicate name": {
      const a = tc.draw(gs.sampledFrom(w.names));
      s.arrangements = [...s.arrangements!, a];
      return {
        what: kind,
        spec: s,
        path: new RegExp(`^arrangements\\[${w.names.length}\\]$`),
        names: `"${a}"`,
      };
    }
    case "shorthand mark": {
      const i = at(s.parts.length);
      s.parts[i].change = tc.draw(
        gs.sampledFrom(["added", "changed", "removed"] as const)
      );
      return {
        what: kind,
        spec: s,
        path: new RegExp(`^parts\\[${i}\\]\\.change$`),
      };
    }
    case "band value missing": {
      if (w.names.length < 2) return null;
      const a = tc.draw(gs.sampledFrom(w.names));
      const chips = Object.fromEntries(
        w.names.filter((n) => n !== a).map((n) => [n, ["x"]])
      );
      s.band = { rows: [{ name: "row", beats: [s.story![0].id!], chips }] };
      return {
        what: kind,
        spec: s,
        path: new RegExp(`^band\\.rows\\[0\\]\\.chips\\.${a}$`),
        names: a,
      };
    }
  }
}

const SETTINGS = { testCases: 200 };

test("a valid world compiles, and the bundle agrees", () =>
  hegel.test((tc) => {
    const w = tc.draw(world);
    const v = sameAsBundle(JSON.stringify(w.spec));
    check(v.ok, v.errors.map((e) => e.line).join("\n"));
  }, SETTINGS));

test("a planted arrangement error is reported where it was planted, naming the arrangement", () =>
  hegel.test((tc) => {
    const w = tc.draw(world);
    const planted = plant(tc, w);
    tc.assume(planted !== null);
    const { what, spec, path, names } = planted!;
    const r = compileFlow(spec);
    check(!r.ok, `${what}: compiled\n${JSON.stringify(spec)}`);
    const errors = r.ok ? [] : r.errors;
    const hit = errors.find((e) => path.test(e.path));
    const lines = errors.map(formatFlowError).join("\n");
    check(hit !== undefined, `${what}: no error at ${path}\n${lines}`);
    if (names)
      check(
        formatFlowError(hit!).includes(names),
        `${what}: ${formatFlowError(hit!)} does not name ${names}`
      );
    sameAsBundle(JSON.stringify(spec));
  }, SETTINGS));

/** Arbitrary JSON, biased to names, prototype keys and arrangement-shaped maps. */
const junk = (depth: number): gs.Generator<unknown> =>
  depth === 0
    ? gs.oneOf<unknown>(
        gs.sampledFrom<unknown>([
          null,
          true,
          0,
          -1,
          1.5,
          "",
          "A",
          "current",
          "Zed",
          "1x",
          "__proto__",
          "constructor",
        ]),
        gs.text({ maxSize: 6 })
      )
    : gs.oneOf<unknown>(
        junk(0),
        gs.arrays(junk(depth - 1), { maxSize: 3 }),
        gs.composite((tc) => {
          const keys = tc.draw(
            gs.arrays(
              gs.sampledFrom([
                "A",
                "B",
                "current",
                "Zed",
                "__proto__",
                "constructor",
                "toString",
                "name",
                "label",
                "props",
              ]),
              { maxSize: 3 }
            )
          );
          return Object.fromEntries(
            keys.map((k) => [k, tc.draw(junk(depth - 1))])
          );
        })
      );

test("arbitrary values where arrangements go never crash compiling, and the bundle agrees", () =>
  hegel.test((tc) => {
    const w = tc.draw(world);
    const s = clone(w.spec);
    const value = tc.draw(junk(2));
    const where = tc.draw(
      gs.sampledFrom([
        "arrangements",
        "baseline",
        "part in",
        "part arrangement",
        "rail in",
        "step in",
        "caption",
        "band chips",
      ] as const)
    );
    const set = (o: object | undefined, k: string) => {
      tc.assume(o !== undefined);
      (o as Record<string, unknown>)[k] = value;
    };
    const b = w.spec.story!.findIndex((beat) => (beat.steps ?? []).length > 0);
    const step = b < 0 ? undefined : s.story[b].steps[0];
    if (where === "arrangements") set(s, "arrangements");
    else if (where === "baseline") set(s, "baseline");
    else if (where === "part in") set(s.parts[0], "in");
    else if (where === "part arrangement") set(s.parts[0], "arrangement");
    else if (where === "rail in") set(s.rails?.[0], "in");
    else if (where === "step in") set(step, "in");
    else if (where === "caption") set(s.story![0], "caption");
    else
      s.band = {
        rows: [
          { name: "r", beats: [s.story![0].id!], chips: value as string[] },
        ],
      };
    let r: ReturnType<typeof compileFlow>;
    try {
      r = compileFlow(s);
    } catch (e) {
      throw new Error(`${where} = ${JSON.stringify(value)} threw: ${e}`);
    }
    if (!r.ok)
      for (const e of r.errors)
        check(
          typeof e.path === "string" && e.message.length > 0,
          `bad error ${JSON.stringify(e)}`
        );
    sameAsBundle(JSON.stringify(s));
  }, SETTINGS));
