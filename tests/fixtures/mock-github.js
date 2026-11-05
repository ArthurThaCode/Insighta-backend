// Replaces the GitHub and profile enrichment HTTP calls made through axios.
const axios = require("axios");

const USERS = {
  "gh-admin": { id: 101, login: "test-admin", email: "admin@example.test", avatar_url: "" },
  "gh-analyst": { id: 102, login: "test-analyst", email: "analyst@example.test", avatar_url: "" },
};

function installFakeGithub() {
  const exchanges = [];

  axios.post = async (url, body) => {
    if (!url.includes("github.com/login/oauth/access_token")) throw new Error(`Unexpected POST ${url}`);
    exchanges.push(body);
    return { data: USERS[body.code] ? { access_token: `github-token:${body.code}` } : { error: "bad_verification_code" } };
  };

  axios.get = async (url, config) => {
    if (url.startsWith("https://api.github.com/user/emails")) return { data: [] };
    if (url.startsWith("https://api.github.com/user")) return { data: USERS[config.headers.Authorization.split("github-token:")[1]] };
    if (url.startsWith("https://api.genderize.io")) return { data: { gender: "female", probability: 0.97, count: 500 } };
    if (url.startsWith("https://api.agify.io")) return { data: { age: 31 } };
    if (url.startsWith("https://api.nationalize.io")) return { data: { country: [{ country_id: "NG", probability: 0.6 }] } };
    throw new Error(`Unexpected GET ${url}`);
  };

  return { exchanges };
}

module.exports = { installFakeGithub };
