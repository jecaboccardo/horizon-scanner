import { assert, assertEquals } from "jsr:@std/assert";
import { isAlreadyInPlan } from "../supabase/functions/_shared/uploadIngest.ts";

const plan = { curatedWorkIds: ["10.1/x", "10.2/y"], removedWorkIds: ["10.2/y"], uploads: [{ doi: "10.9/z", title: "Z" }] };
Deno.test("matched workId still curated => true", () => {
  assert(isAlreadyInPlan(plan as any, { matchedWorkId: "10.1/x", doi: null, title: "A" } as any));
});
Deno.test("matched workId but removed => false", () => {
  assertEquals(isAlreadyInPlan(plan as any, { matchedWorkId: "10.2/y", doi: null, title: "A" } as any), false);
});
Deno.test("doi matches an existing upload => true", () => {
  assert(isAlreadyInPlan(plan as any, { matchedWorkId: null, doi: "10.9/z", title: "Z" } as any));
});
