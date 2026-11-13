/** Every part is drawn in its own 640×400 logical space, rail centre Y = 200 (VL-01). */
export const PART_WIDTH = 640;

export const PART_HEIGHT = 400;

export const RAIL_Y = 200;

/** Composition footprints: S 0.5, M 0.75, L 1 (catalogue "Footprint"). */
export const FOOTPRINT_SCALE = { S: 0.5, M: 0.75, L: 1 } as const;

export type Footprint = keyof typeof FOOTPRINT_SCALE;
