import { assertEquals } from "jsr:@std/assert";
import { parseRoster, rosterOrFilter } from "./roster.ts";

Deno.test("parseRoster splits, trims, drops empties", () => {
  assertEquals(parseRoster(" a , b ,,c "), ["a", "b", "c"]);
  assertEquals(parseRoster(undefined), []);
});

Deno.test("rosterOrFilter builds a PostgREST OR over tenant_id + user_id", () => {
  assertEquals(
    rosterOrFilter(["u1", "u2"]),
    "tenant_id.in.(u1,u2),user_id.in.(u1,u2)",
  );
  assertEquals(rosterOrFilter([]), "");
});
