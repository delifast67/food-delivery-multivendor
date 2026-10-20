import { describe, expect, it } from "vitest";
import { buildSchema, parse, specifiedRules, validate } from "graphql";
import { complexityRule } from "../src/graphql-complexity.js";

const schema = buildSchema(`
  type Query { node: Node }
  type Node { id: ID, next: Node }
`);
const errors = (query: string) => validate(schema, parse(query), [...specifiedRules, complexityRule]);
const complex = (query: string) => errors(query).some((e) => e.extensions.code === "QUERY_TOO_COMPLEX");

describe("expanded GraphQL operation limits", () => {
  it("allows normal named and inline fragments", () => {
    expect(errors(`query { node { ...Identity ... on Node { next { ...Identity } } } } fragment Identity on Node { id }`)).toEqual([]);
  });

  it("counts fields at each use of a named fragment", () => {
    const fields = Array.from({ length: 40 }, (_, i) => `n${i}:node{...Details}`).join(" ");
    expect(complex(`{${fields}} fragment Details on Node { id next { id } }`)).toBe(true);
  });

  it("counts depth across named fragments", () => {
    const fragments = Array.from({ length: 11 }, (_, i) => `fragment F${i} on Node { next { ${i === 10 ? "id" : `...F${i + 1}`} } }`).join(" ");
    expect(complex(`{node{...F0}} ${fragments}`)).toBe(true);
  });

  it("counts inline fragment fields and depth", () => {
    const fields = Array.from({ length: 101 }, (_, i) => `n${i}:id`).join(" ");
    expect(complex(`{node{...on Node{${fields}}}}`)).toBe(true);
  });

  it("bounds repeated fragment expansion even when all leaves merge", () => {
    const fragments = Array.from({ length: 20 }, (_, i) => `fragment F${i} on Node { ${i === 19 ? "id" : `...F${i + 1} ...F${i + 1}`} }`).join(" ");
    expect(complex(`{node{...F0}} ${fragments}`)).toBe(true);
  });

  it("terminates on cyclic and missing fragments without hiding schema validation", () => {
    expect(errors(`{node{...A}} fragment A on Node{...B} fragment B on Node{...A}`)).not.toHaveLength(0);
    expect(errors(`{node{...Missing}}`).some((e) => e.message.includes('Unknown fragment'))).toBe(true);
  });

  it("retains the single-operation restriction", () => {
    expect(complex(`query A{node{id}} query B{node{id}}`)).toBe(true);
  });

  it("accepts exactly the configured field boundary", () => {
    expect(errors(`{node{${Array.from({ length: 99 }, (_, i) => `n${i}:id`).join(" ")}}}`)).toEqual([]);
    expect(complex(`{node{${Array.from({ length: 100 }, (_, i) => `n${i}:id`).join(" ")}}}`)).toBe(true);
  });
});
