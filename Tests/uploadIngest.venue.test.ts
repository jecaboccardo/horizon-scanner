import { assertEquals } from "jsr:@std/assert";
import { venueFromOpenAlex, venueFromCrossref } from "../supabase/functions/_shared/uploadIngest.ts";

Deno.test("venueFromOpenAlex reads primary_location.source.display_name", () => {
  assertEquals(venueFromOpenAlex({ primary_location: { source: { display_name: "Econometrica" } } }), "Econometrica");
  assertEquals(venueFromOpenAlex({}), null);
});
Deno.test("venueFromCrossref reads container-title[0]", () => {
  assertEquals(venueFromCrossref({ "container-title": ["The Economic Journal"] }), "The Economic Journal");
  assertEquals(venueFromCrossref({}), null);
});
