/** Small geometry helpers; each protocol owns its events and outcomes. */
import type { Point, PortSide } from "../../route";
import type { PortDef, PortDirection, VerbContext } from "../registry";
import type { TokenKind } from "../spec";
export function port(
  side: PortSide,
  x: number,
  y: number,
  direction: PortDirection,
  tokens: readonly TokenKind[]
): PortDef {
  return { side, x, y, direction, tokens };
}
export function incoming<P, S>(ctx: VerbContext<P, S>, from: Point, to: Point) {
  if (ctx.card)
    ctx.out.carry([[[from, to], ctx.t, 0.5]], ctx.t, ctx.t + 0.6, {
      role: ctx.card.role,
    });
}
