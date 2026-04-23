require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { v7: uuidv7 } = require("uuid");
const { parseNaturalLanguageQuery } = require("./src/services/nlpParser");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Configuration Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) in your environment."
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Stage 2 schema columns (excludes legacy sample_size)
const PROFILE_COLUMNS = "id, name, gender, gender_probability, age, age_group, country_id, country_name, country_probability, created_at";

// Fonction pour déterminer le groupe d'âge
function getAgeGroup(age) {
  if (age <= 12) return "child";
  if (age <= 19) return "teenager";
  if (age <= 59) return "adult";
  return "senior";
}

// ============================================================
// Validation helpers
// ============================================================

const VALID_GENDERS = ["male", "female"];
const VALID_AGE_GROUPS = ["child", "teenager", "adult", "senior"];
const VALID_SORT_BY = ["age", "created_at", "gender_probability"];
const VALID_ORDER = ["asc", "desc"];

/**
 * Validate query parameters for GET /api/profiles.
 * Returns { valid: true } or { valid: false, status, message }.
 */
function validateProfileQueryParams(query) {
  const {
    gender,
    age_group,
    country_id,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
    sort_by,
    order,
    page,
    limit,
  } = query;

  // Validate gender
  if (gender !== undefined) {
    if (gender === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    if (!VALID_GENDERS.includes(gender.toLowerCase()))
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  // Validate age_group
  if (age_group !== undefined) {
    if (age_group === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    if (!VALID_AGE_GROUPS.includes(age_group.toLowerCase()))
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  // Validate country_id
  if (country_id !== undefined) {
    if (country_id === "") return { valid: false, status: 400, message: "Invalid query parameters" };
  }

  // Validate min_age
  if (min_age !== undefined) {
    if (min_age === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    const val = Number(min_age);
    if (isNaN(val) || !Number.isInteger(val) || val < 0)
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  // Validate max_age
  if (max_age !== undefined) {
    if (max_age === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    const val = Number(max_age);
    if (isNaN(val) || !Number.isInteger(val) || val < 0)
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  // Validate min_gender_probability
  if (min_gender_probability !== undefined) {
    if (min_gender_probability === "")
      return { valid: false, status: 400, message: "Invalid query parameters" };
    const val = Number(min_gender_probability);
    if (isNaN(val) || val < 0 || val > 1)
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  // Validate min_country_probability
  if (min_country_probability !== undefined) {
    if (min_country_probability === "")
      return { valid: false, status: 400, message: "Invalid query parameters" };
    const val = Number(min_country_probability);
    if (isNaN(val) || val < 0 || val > 1)
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  // Validate sort_by
  if (sort_by !== undefined) {
    if (sort_by === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    if (!VALID_SORT_BY.includes(sort_by.toLowerCase()))
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  // Validate order
  if (order !== undefined) {
    if (order === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    if (!VALID_ORDER.includes(order.toLowerCase()))
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  // Validate page
  if (page !== undefined) {
    if (page === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    const val = Number(page);
    if (isNaN(val) || !Number.isInteger(val) || val < 1)
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  // Validate limit
  if (limit !== undefined) {
    if (limit === "") return { valid: false, status: 400, message: "Invalid query parameters" };
    const val = Number(limit);
    if (isNaN(val) || !Number.isInteger(val) || val < 1 || val > 50)
      return { valid: false, status: 422, message: "Invalid query parameters" };
  }

  return { valid: true };
}

/**
 * Apply filters, sorting, and pagination to a Supabase query.
 * Returns { query, page, limit } for the data query,
 * and { countQuery } for the total count.
 */
function applyFilters(baseQuery, params) {
  let query = baseQuery;

  const {
    gender,
    age_group,
    country_id,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
  } = params;

  if (gender) query = query.ilike("gender", gender);
  if (age_group) query = query.ilike("age_group", age_group);
  if (country_id) query = query.ilike("country_id", country_id);
  if (min_age !== undefined && min_age !== "") query = query.gte("age", Number(min_age));
  if (max_age !== undefined && max_age !== "") query = query.lte("age", Number(max_age));
  if (min_gender_probability !== undefined && min_gender_probability !== "")
    query = query.gte("gender_probability", Number(min_gender_probability));
  if (min_country_probability !== undefined && min_country_probability !== "")
    query = query.gte("country_probability", Number(min_country_probability));

  return query;
}

// ============================================================
// Routes
// ============================================================

// POST /api/profiles
app.post("/api/profiles", async (req, res) => {
  const { name } = req.body;

  if (name === undefined || name === null) {
    return res.status(400).json({ status: "error", message: "Missing or empty name" });
  }
  if (typeof name !== "string") {
    return res.status(422).json({ status: "error", message: "Invalid type" });
  }
  if (name.trim() === "") {
    return res.status(400).json({ status: "error", message: "Missing or empty name" });
  }

  try {
    // Vérifier si le profil existe déjà
    const { data: existingProfile, error: selectError } = await supabase
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .eq("name", name.trim())
      .single();

    if (selectError && selectError.code !== "PGRST116") {
      throw selectError;
    }

    if (existingProfile) {
      return res.status(200).json({
        status: "success",
        message: "Profile already exists",
        data: existingProfile,
      });
    }

    // Appeler les APIs
    let genderizeRes, agifyRes, nationalizeRes;
    try {
      [genderizeRes, agifyRes, nationalizeRes] = await Promise.all([
        axios.get(`https://api.genderize.io?name=${encodeURIComponent(name.trim())}`),
        axios.get(`https://api.agify.io?name=${encodeURIComponent(name.trim())}`),
        axios.get(`https://api.nationalize.io?name=${encodeURIComponent(name.trim())}`),
      ]);
    } catch (err) {
      return res.status(502).json({ status: "error", message: "Upstream or server failure" });
    }

    const genderize = genderizeRes.data;
    const agify = agifyRes.data;
    const nationalize = nationalizeRes.data;

    // Traiter les données
    const gender = genderize.gender;
    const gender_probability = genderize.probability;
    const sample_size = genderize.count;

    if (!gender || sample_size === 0) {
      return res.status(502).json({ status: "error", message: "Genderize returned an invalid response" });
    }

    const age = agify.age;

    if (age === null) {
      return res.status(502).json({ status: "error", message: "Agify returned an invalid response" });
    }

    const age_group = getAgeGroup(age);

    const countries = nationalize.country || [];

    if (countries.length === 0) {
      return res.status(502).json({ status: "error", message: "Nationalize returned an invalid response" });
    }

    const topCountry = countries.sort((a, b) => b.probability - a.probability)[0];
    const country_id = topCountry ? topCountry.country_id : null;
    const country_probability = topCountry ? topCountry.probability : null;

    // Get country name from our mapping
    const { countryCodeToName } = require("./src/utils/countries");
    const country_name = countryCodeToName[country_id] || null;

    // Créer le profil
    const id = uuidv7();
    const created_at = new Date().toISOString();

    const profile = {
      id,
      name: name.trim(),
      gender,
      gender_probability,
      age,
      age_group,
      country_id,
      country_name,
      country_probability,
      created_at,
    };

    // Insérer dans Supabase
    const { data, error: insertError } = await supabase
      .from("profiles")
      .insert([profile])
      .select(PROFILE_COLUMNS);

    if (insertError) {
      throw insertError;
    }

    return res.status(201).json({
      status: "success",
      data: data[0],
    });
  } catch (error) {
    console.error("ERROR:", error.message);
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

// ============================================================
// GET /api/profiles/search — Natural Language Query
// Must be defined BEFORE GET /api/profiles/:id to avoid route conflicts
// ============================================================
app.get("/api/profiles/search", async (req, res) => {
  const { q, page: rawPage, limit: rawLimit } = req.query;

  // Validate q parameter
  if (q === undefined || q === null || q.trim() === "") {
    return res.status(400).json({ status: "error", message: "Invalid query parameters" });
  }

  // Parse the natural language query
  const result = parseNaturalLanguageQuery(q);

  if (result.error) {
    return res.status(400).json({ status: "error", message: result.error });
  }

  const filters = result.filters;

  // Pagination
  const page = rawPage ? Math.max(1, parseInt(rawPage, 10) || 1) : 1;
  const limit = rawLimit ? Math.min(50, Math.max(1, parseInt(rawLimit, 10) || 10)) : 10;
  const offset = (page - 1) * limit;

  try {
    // Count query
    let countQuery = supabase.from("profiles").select("*", { count: "exact", head: true });
    countQuery = applyFilters(countQuery, filters);
    const { count: total, error: countError } = await countQuery;

    if (countError) throw countError;

    // Data query
    let dataQuery = supabase.from("profiles").select(PROFILE_COLUMNS);
    dataQuery = applyFilters(dataQuery, filters);
    dataQuery = dataQuery.order("created_at", { ascending: true });
    dataQuery = dataQuery.range(offset, offset + limit - 1);

    const { data, error: dataError } = await dataQuery;

    if (dataError) throw dataError;

    return res.status(200).json({
      status: "success",
      page,
      limit,
      total: total || 0,
      data: data || [],
    });
  } catch (error) {
    console.error("ERROR:", error.message);
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

// ============================================================
// GET /api/profiles/:id — Get profile by ID
// ============================================================
app.get("/api/profiles/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .eq("id", id)
      .single();

    if (error) {
      if (error.code === "PGRST116" || error.code === "22P02") {
        return res.status(404).json({
          status: "error",
          message: "Profile not found",
        });
      }
      throw error;
    }

    return res.status(200).json({
      status: "success",
      data,
    });
  } catch (error) {
    console.error("ERROR:", error.message);
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

// ============================================================
// GET /api/profiles — Advanced filtering, sorting, pagination
// ============================================================
app.get("/api/profiles", async (req, res) => {
  // Validate query parameters
  const validation = validateProfileQueryParams(req.query);
  if (!validation.valid) {
    return res
      .status(validation.status)
      .json({ status: "error", message: validation.message });
  }

  const {
    gender,
    age_group,
    country_id,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
    sort_by,
    order,
    page: rawPage,
    limit: rawLimit,
  } = req.query;

  // Pagination defaults
  const page = rawPage ? parseInt(rawPage, 10) : 1;
  const limit = rawLimit ? Math.min(50, parseInt(rawLimit, 10)) : 10;
  const offset = (page - 1) * limit;

  try {
    // Build filter params
    const filterParams = {
      gender,
      age_group,
      country_id,
      min_age,
      max_age,
      min_gender_probability,
      min_country_probability,
    };

    // Count query (for total)
    let countQuery = supabase.from("profiles").select("*", { count: "exact", head: true });
    countQuery = applyFilters(countQuery, filterParams);
    const { count: total, error: countError } = await countQuery;

    if (countError) throw countError;

    // Data query
    let dataQuery = supabase.from("profiles").select(PROFILE_COLUMNS);
    dataQuery = applyFilters(dataQuery, filterParams);

    // Sorting
    const sortField = sort_by || "created_at";
    const ascending = (order || "asc").toLowerCase() === "asc";
    dataQuery = dataQuery.order(sortField, { ascending });

    // Pagination
    dataQuery = dataQuery.range(offset, offset + limit - 1);

    const { data, error: dataError } = await dataQuery;

    if (dataError) throw dataError;

    return res.status(200).json({
      status: "success",
      page,
      limit,
      total: total || 0,
      data: data || [],
    });
  } catch (error) {
    console.error("ERROR:", error.message);
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

// DELETE /api/profiles/{id}
app.delete("/api/profiles/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from("profiles")
      .delete()
      .eq("id", id);

    if (error) {
      throw error;
    }

    return res.status(204).send();
  } catch (error) {
    console.error("ERROR:", error.message);
    return res.status(500).json({
      status: "error",
      message: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});