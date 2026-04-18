require('dotenv').config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { v7: uuidv7 } = require("uuid");

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

// Fonction pour déterminer le groupe d'âge
function getAgeGroup(age) {
  if (age <= 12) return "child";
  if (age <= 19) return "teenager";
  if (age <= 59) return "adult";
  return "senior";
}

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
      .select("*")
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
      return res.status(502).json({ status: "502", message: "Genderize returned an invalid response" });
    }

    const age = agify.age;
    
    if (age === null) {
      return res.status(502).json({ status: "502", message: "Agify returned an invalid response" });
    }
    
    const age_group = getAgeGroup(age);

    const countries = nationalize.country || [];
    
    if (countries.length === 0) {
      return res.status(502).json({ status: "502", message: "Nationalize returned an invalid response" });
    }
    
    const topCountry = countries.sort((a, b) => b.probability - a.probability)[0];
    const country_id = topCountry ? topCountry.country_id : null;
    const country_probability = topCountry ? topCountry.probability : null;

    // Créer le profil
    const id = uuidv7();
    const created_at = new Date().toISOString();

    const profile = {
      id,
      name: name.trim(),
      gender,
      gender_probability,
      sample_size,
      age,
      age_group,
      country_id,
      country_probability,
      created_at,
    };

    // Insérer dans Supabase
    const { data, error: insertError } = await supabase
      .from("profiles")
      .insert([profile])
      .select();

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

// GET /api/profiles/{id}
app.get("/api/profiles/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
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

// GET /api/profiles
app.get("/api/profiles", async (req, res) => {
  try {
    let query = supabase.from("profiles").select("*");

    const { gender, country_id, age_group } = req.query;

    if (gender) {
      query = query.ilike("gender", gender);
    }
    if (country_id) {
      query = query.ilike("country_id", country_id);
    }
    if (age_group) {
      query = query.ilike("age_group", age_group);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return res.status(200).json({
      status: "success",
      count: data.length,
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