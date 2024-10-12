const express = require("express");
const dotenv = require("dotenv");
const fetch = require("node-fetch");

dotenv.config();

const app = express();
app.use(express.json());

const FLOWISE_API_URL = process.env.FLOWISE_API_URL || "";

function logger(...params) {
  console.error("[Teams Integration]", ...params);
}

// Query Flowise API
async function queryFlowise(question, sessionId) {
  const data = {
    question: question,
    overrideConfig: {
      sessionId: sessionId,
    },
  };

  try {
    const response = await fetch(FLOWISE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const result = await response.json();

    if (result.text) {
      return result.text;
    }

    throw new Error("Invalid response from Flowise API");
  } catch (error) {
    logger("Error querying Flowise API:", error);
    throw error;
  }
}

// Handle Microsoft Teams incoming requests
app.post("/teams-webhook", async (req, res) => {
  const { text, sessionId, messageId } = req.body;

  try {
    const answer = await queryFlowise(text, sessionId);
    res.json({ message: answer });
  } catch (error) {
    logger("Error handling Teams webhook:", error);
    res.status(500).json({ error: "Error processing request" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Teams webhook server running on port ${port}`);
});
