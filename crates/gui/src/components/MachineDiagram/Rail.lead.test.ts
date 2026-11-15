import { describe, expect, it } from "vitest";
import { mechanismPieces } from "./Rail";
import type { Point } from "./route";

const Y = 200;
/** A 200×100 frame from x 200 to 400, ports W (200,200), E (400,200), N (300,150). */
const frame = [200, 150, 200, 100] as const;
const ports = [
  [200, Y],
  [400, Y],
  [300, 150],
] as const;
const pieces = (points: Point[]) => mechanismPieces(points, ports, frame);

describe("gallery rails inside a flow", () => {
  it("drops leads to the west and east edges of the cell", () => {
    expect(
      pieces([
        [24, Y],
        [200, Y],
      ])
    ).toEqual([]);
    expect(
      pieces([
        [400, Y],
        [616, Y],
      ])
    ).toEqual([]);
  });

  it("keeps a track inside the frame and a link to something drawn in the cell", () => {
    const track: Point[] = [
      [220, Y],
      [380, Y],
    ];
    const link: Point[] = [
      [400, Y],
      [520, Y],
    ];
    expect(pieces(track)).toEqual([track]);
    expect(pieces(link)).toEqual([link]);
  });

  it("cuts a rail through the part back to the frame on the side that reaches an edge", () => {
    expect(
      pieces([
        [24, Y],
        [546, Y],
      ])
    ).toEqual([
      [
        [200, Y],
        [546, Y],
      ],
    ]);
    expect(
      pieces([
        [24, Y],
        [616, Y],
      ])
    ).toEqual([
      [
        [200, Y],
        [400, Y],
      ],
    ]);
  });

  it("drops a lead to a north port that comes from an edge", () => {
    expect(
      pieces([
        [600, 96],
        [300, 96],
        [300, 150],
      ])
    ).toEqual([]);
  });

  it("draws nothing without the part's ports and frame", () => {
    expect(
      mechanismPieces(
        [
          [220, Y],
          [380, Y],
        ],
        undefined,
        frame
      )
    ).toEqual([]);
  });
});
