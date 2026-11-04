/**
 * Seed script for the profiles database.
 * Loads profiles from seed_profiles.json and upserts them into Supabase on the unique name.
 * Re-running this script updates existing rows and keeps their id and created_at.
 * The data file is not part of this repository: see "Seeding" in the README.
 * 
 * Usage: node seed.js
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { v7: uuidv7 } = require("uuid");

const SEED_FILE = path.join(__dirname, "seed_profiles.json");
if (!fs.existsSync(SEED_FILE)) {
  console.error('seed_profiles.json not found. Add it at the project root: { "profiles": [ ... ] }. See "Seeding" in the README.');
  process.exit(1);
}
const seedData = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function seed() {
  console.log(`Starting seed with ${seedData.profiles.length} profiles...`);

  // Insert in batches: existing names keep their id and created_at
  const BATCH_SIZE = 200;
  let saved = 0;

  for (let i = 0; i < seedData.profiles.length; i += BATCH_SIZE) {
    const batch = seedData.profiles.slice(i, i + BATCH_SIZE);
    const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

    const { data: existing, error: selectError } = await supabase
      .from("profiles")
      .select("id, name, created_at")
      .in("name", batch.map((p) => p.name));

    if (selectError) {
      console.error(`Error reading batch ${batchNumber}:`, selectError.message);
      process.exitCode = 1;
      continue;
    }

    const existingByName = new Map(existing.map((row) => [row.name, row]));
    const rows = batch.map((p) => {
      const current = existingByName.get(p.name);
      return {
        id: current ? current.id : uuidv7(),
        name: p.name,
        gender: p.gender,
        gender_probability: p.gender_probability,
        age: p.age,
        age_group: p.age_group,
        country_id: p.country_id,
        country_name: p.country_name,
        country_probability: p.country_probability,
        created_at: current ? current.created_at : new Date().toISOString(),
      };
    });

    const { data, error } = await supabase.from("profiles").upsert(rows, { onConflict: "name" }).select("id");

    if (error) {
      console.error(`Error saving batch ${batchNumber}:`, error.message);
      process.exitCode = 1;
      continue;
    }

    saved += data.length;
    console.log(`Batch ${batchNumber}: ${data.length} profiles saved`);
  }

  console.log(`\nSaved ${saved} profiles.`);

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
