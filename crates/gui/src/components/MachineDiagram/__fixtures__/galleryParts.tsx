/* eslint-disable react-refresh/only-export-components -- part definitions and their fixtures are shared as data */
/** Gallery parity, strip and performance fixtures use the production parts. */
import {
  MACHINE_PARTS,
  type MachinePartDef,
  type PartScenario,
} from "../parts";
export type FixtureScenario<E> = PartScenario<E>;
export type GalleryPartFixture<E = unknown> = Omit<
  MachinePartDef<E>,
  "family" | "footprint"
>;
export const sourceFixture = MACHINE_PARTS.source;
export const workerFixture = MACHINE_PARTS.worker;
export const splitterFixture = MACHINE_PARTS.splitter;
export const twoPhaseFixture = MACHINE_PARTS["two-phase commit"];
export const GALLERY_FIXTURES = MACHINE_PARTS;
