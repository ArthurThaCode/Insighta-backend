const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

app.use(cors());

const PORT = 3000;

app.get("/api/classify", async (req, res) => {
  const name = req.query.name;

  if (!name || name.trim() === "") {
    return res.status(400).json({
      status: "error",
      message: "Name is required",
    });
  }

  if (typeof name !== "string") {
    return res.status(422).json({
      status: "error",
      message: "Name must be a string",
    });
  }

  try {
    const response = await axios.get(
      `https://api.genderize.io/?name=${name}`
    );

    const data = response.data;

    if (data.gender === null || data.count === 0) {
      return res.status(422).json({
        status: "error",
        message: "No prediction available for the provided name",
      });
    }

    const gender = data.gender;
    const probability = data.probability;
    const sample_size = data.count;

    const is_confident =
      probability >= 0.7 && sample_size >= 100;

    const processed_at = new Date().toISOString();

    return res.json({
      status: "success",
      data: {
        name,
        gender,
        probability,
        sample_size,
        is_confident,
        processed_at,
      },
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});