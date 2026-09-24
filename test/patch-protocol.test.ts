import { describe, expect, it } from "@rstest/core";
import { Op, OP_ARITY, PROTOCOL_VERSION, forEachOp, pushOp } from "../src/patch-protocol.js";

// M8: OP_ARITY is the "single source of truth" for walking a flat op array,
// but apply-patch.js re-implements the arity inline in its own switch. These
// tests lock the two to each other: every opcode must have an arity entry
// (no gap → no silent desync in forEachOp/list-cell), and the version prefix
// must never collide with a real opcode.
describe("patch-protocol OP_ARITY completeness", () => {
	it("has an arity entry for every opcode in Op", () => {
		const opcodes = Object.values(Op) as number[];
		expect(opcodes.length).toBeGreaterThan(0);
		for (const opcode of opcodes) {
			expect(OP_ARITY[opcode], `OP_ARITY is missing opcode ${opcode}`).toBeDefined();
		}
	});

	it("PROTOCOL_VERSION does not collide with any opcode value", () => {
		for (const opcode of Object.values(Op) as number[]) {
			expect(opcode).not.toBe(PROTOCOL_VERSION);
		}
	});

	it("forEachOp walks a flat array built by pushOp without desyncing", () => {
		const ops: unknown[] = [];
		pushOp(ops, Op.CreateElement, "view", 1);
		pushOp(ops, Op.SetText, 1, "hi");
		pushOp(ops, Op.InsertBefore, 0, 1, -1);

		const seen: number[] = [];
		forEachOp(ops, (opcode, args) => {
			seen.push(opcode);
			if (opcode === Op.InsertBefore) expect(args).toEqual([0, 1, -1]);
		});
		expect(seen).toEqual([Op.CreateElement, Op.SetText, Op.InsertBefore]);
	});

	it("forEachOp throws on an unknown opcode instead of silently desyncing", () => {
		expect(() => forEachOp([999], () => {})).toThrow(/Unknown patch opcode/);
	});
});
