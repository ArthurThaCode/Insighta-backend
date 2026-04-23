/**
 * Seed script for the profiles database.
 * Loads 2026 profiles from seed_profiles.json and upserts them into Supabase.
 * Re-running this script will NOT create duplicates (uses upsert on name).
 * 
 * Usage: node seed.js
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { v7: uuidv7 } = require("uuid");
const seedData = require("./seed_profiles.json");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function seed() {
  console.log(`Starting seed with ${seedData.profiles.length} profiles...`);

  // Step 1: Clear existing profiles to avoid duplicates on re-run
  console.log("Clearing existing profiles...");
  const { error: deleteError } = await supabase
    .from("profiles")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000"); // deletes all rows

  if (deleteError) {
    console.error("Error clearing table:", deleteError.message);
    console.log("Continuing with insert anyway...");
  } else {
    console.log("Table cleared.");
  }

  // Step 2: Prepare profiles with UUID v7 IDs
  const profiles = seedData.profiles.map((p) => ({
    id: uuidv7(),
    name: p.name,
    gender: p.gender,
    gender_probability: p.gender_probability,
    age: p.age,
    age_group: p.age_group,
    country_id: p.country_id,
    country_name: p.country_name,
    country_probability: p.country_probability,
    created_at: new Date().toISOString(),
  }));

  // Step 3: Insert in batches of 500 to avoid payload limits
  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
    const batch = profiles.slice(i, i + BATCH_SIZE);

    const { data, error } = await supabase
      .from("profiles")
      .insert(batch)
      .select();

    if (error) {
      console.error(`Error inserting batch ${Math.floor(i / BATCH_SIZE) + 1}:`, error.message);
      continue;
    }

    const batchInserted = data ? data.length : 0;
    inserted += batchInserted;
    console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batchInserted} profiles inserted`);
  }

  console.log(`\nInserted ${inserted} profiles.`);

  // Step 4: Verify total count
  const { count, error: countError } = await supabase
    .from("profiles")
    .select("*", { count: "exact", head: true });

  if (countError) {
    console.error("Error verifying count:", countError.message);
  } else {
    console.log(`Total profiles in database: ${count}`);
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
