// Quick sanity check: pull top 20 from new priority view, show what kind of
// papers float to the top (institution, ABS, SMS, year, citations).
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: top, error } = await supabase
  .from("works_priority_view")
  .select("id, priority_score")
  .order("priority_score", { ascending: false })
  .limit(20);
if (error) throw error;

console.log(`Top ${top.length} papers by new priority_score:`);
console.log("score   inst       sms abs   yr   cites  title");
console.log("------  ---------  --- ----- ----- ------ -----");

for (const row of top) {
  const { data: w } = await supabase
    .from("works")
    .select("title, year, citation_count, sms_level, abs_rating, raw_data")
    .eq("id", row.id)
    .single();
  const inst = (w?.raw_data?.institution ?? "-").padEnd(9).slice(0, 9);
  const sms = (w?.sms_level ?? "·").toString().padEnd(3);
  const abs = (w?.abs_rating ?? "-").padEnd(5);
  const yr = (w?.year ?? "----").toString().padEnd(5);
  const cites = (w?.citation_count ?? 0).toString().padEnd(6);
  const title = (w?.title ?? "").slice(0, 70);
  console.log(`${row.priority_score.toFixed(2).padEnd(7)} ${inst}  ${sms} ${abs} ${yr} ${cites} ${title}`);
}

const { count: viewCount } = await supabase
  .from("works_priority_view")
  .select("id", { count: "exact", head: true });
console.log(`\nTotal in new view: ${viewCount?.toLocaleString()}`);
